'use strict';

/**
 * 网易云账号：扫码登录 + 「我喜欢的音乐」增删。
 *
 * 为什么需要它
 * ------------
 * 搜索 / 歌词 / 封面都是匿名公开接口，但「我喜欢」是账号数据：
 *   - 需要登录态（cookie）
 *   - 写操作走 weapi（AES + RSA 加密），不是普通 GET
 *
 * 所以这里实现两件事：扫码登录（用手机网易云扫一下，不用输密码），
 * 以及 liked 集合的读取与增删。
 *
 * 安全边界
 * --------
 * - cookie 只落在本机 `.cache/netease-account.json`，**不经过网页、不写日志**；
 * - 网页只知道「登录了没 / 昵称」，拿不到 cookie；
 * - 退出登录 = 删掉这个文件（服务端不再持有任何凭据）。
 *
 * 接口脆性
 * --------
 * 这些是网易云网页端的私有接口，可能随对方调整而失效。失败时只影响
 * 「收藏」这一个功能，不影响歌词显示。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NONCE = '0CoJUm6Qyw8W8jud';
const PUBKEY = '010001';
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const IV = Buffer.from('0102030405060708');
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const BASE = 'https://music.163.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// liked 集合的有效期：太久会把别处（手机 App）的改动盖掉，太短又太费请求
const LIKED_TTL_MS = 5 * 60 * 1000;

function aesEncrypt(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), IV);
  return Buffer.concat([c.update(Buffer.from(text)), c.final()]).toString('base64');
}

/** weapi 的 RSA：把 16 字节随机密钥倒序当大整数，做 pubKey 次方的模幂 */
function rsaEncrypt(text) {
  const hex = Buffer.from(text).reverse().toString('hex');
  const m = BigInt('0x' + MODULUS);
  let result = 1n;
  let base = BigInt('0x' + hex) % m;
  let exp = BigInt('0x' + PUBKEY);
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return result.toString(16).padStart(256, '0');
}

function weapi(payload) {
  const secret = Array.from({ length: 16 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  return {
    params: aesEncrypt(aesEncrypt(JSON.stringify(payload), NONCE), secret),
    encSecKey: rsaEncrypt(secret),
  };
}

/** 从 Set-Cookie / cookie 字符串里取出我们要的那几个键 */
function mergeCookie(existing, incoming) {
  const jar = new Map();
  for (const part of String(existing || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const part of String(incoming || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k && v && !/^(Path|Domain|Expires|Max-Age|Secure|HttpOnly|SameSite)$/i.test(k)) jar.set(k, v);
    }
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function cookieValue(jar, key) {
  for (const part of String(jar || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim();
  }
  return '';
}

class NeteaseAccount {
  constructor({ cacheDir, log } = {}) {
    this.log = log || (() => {});
    this.file = path.join(cacheDir || path.resolve(__dirname, '..', '.cache'), 'netease-account.json');
    this.state = {
      cookie: '',
      uid: 0,
      nickname: '',
      likedPid: 0,
      savedAt: 0,
    };
    this.liked = null; // Set<number> | null
    this.likedAt = 0;
    this._loading = null;
    this._qr = new Map(); // key -> createdAt，避免无限增长
    // 收藏状态变化时通知外部（server 用它触发一次广播，页面红心立刻更新）
    this.onChange = null;
    this._load();
  }

  _changed() {
    if (typeof this.onChange === 'function') {
      try { this.onChange(); } catch (e) { /* 回调出错不影响主流程 */ }
    }
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.cookie === 'string') {
        this.state = {
          cookie: raw.cookie,
          uid: Number(raw.uid) || 0,
          nickname: raw.nickname || '',
          likedPid: Number(raw.likedPid) || 0,
          savedAt: Number(raw.savedAt) || 0,
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.log('账号缓存读取失败：' + err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
      // 凭据文件：尽量收紧权限（Windows 上无实际意义，POSIX 上要紧）
      try { fs.chmodSync(this.file, 0o600); } catch (e) { /* ignore */ }
      this._lockFile();
    } catch (err) {
      this.log('账号缓存写入失败：' + err.message);
    }
  }

  /**
   * Windows 上 chmod 是空操作 —— 文件继承的是上层目录的 ACL，
   * 同一台机器上的其他账户（以及以其他身份运行的程序）照样能读。
   * 这里用 icacls 断掉继承、只留当前用户，等价于 POSIX 的 0600。
   * 只需要做一次：文件是原地截断重写，ACL 不会丢。
   */
  _lockFile() {
    if (process.platform !== 'win32' || this._locked) return;
    this._locked = true;
    const user = process.env.USERNAME;
    if (!user) return;
    try {
      require('child_process').execFile(
        'icacls',
        [this.file, '/inheritance:r', '/grant:r', user + ':F'],
        { windowsHide: true, timeout: 5000 },
        (err) => {
          if (err) this.log('凭据文件权限收紧失败（不影响使用）：' + err.message);
        },
      );
    } catch (err) {
      // icacls 不存在 / 盘符不支持 ACL，忽略
    }
  }

  get loggedIn() {
    return !!this.state.cookie;
  }

  /** 给网页看的账号信息 —— 绝不包含 cookie */
  info() {
    return {
      loggedIn: this.loggedIn,
      nickname: this.state.nickname,
      likedKnown: this.liked !== null,
    };
  }

  _headers(extra = {}) {
    return {
      'User-Agent': UA,
      Referer: BASE + '/',
      Origin: BASE,
      Cookie: this.state.cookie || 'appver=2.10.6; os=pc;',
      ...extra,
    };
  }

  async _weapiPost(pathname, payload) {
    const csrf = cookieValue(this.state.cookie, '__csrf');
    const form = new URLSearchParams(weapi({ ...payload, csrf_token: csrf || '' })).toString();
    const res = await fetch(`${BASE}${pathname}?csrf_token=${encodeURIComponent(csrf || '')}`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    return this._json(res);
  }

  async _getJson(url) {
    const res = await fetch(url, { headers: this._headers(), signal: AbortSignal.timeout(9000) });
    return this._json(res);
  }

  async _json(res) {
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`网易云返回了非 JSON（HTTP ${res.status}）`);
    }
    return { data, res };
  }

  // -------------------------------------------------------------------------
  // 扫码登录
  // -------------------------------------------------------------------------

  async createQr() {
    const { data } = await this._weapiPost('/weapi/login/qrcode/unikey', { type: 1 });
    if (!data || data.code !== 200 || !data.unikey) {
      throw new Error((data && data.message) || '获取二维码失败');
    }
    const key = data.unikey;
    this._qr.set(key, Date.now());
    // 只留最近 10 个 key，扫码页刷新几次也不会越攒越多
    if (this._qr.size > 10) {
      const oldest = Array.from(this._qr.entries()).sort((a, b) => a[1] - b[1])[0];
      this._qr.delete(oldest[0]);
    }
    return { key, url: `https://music.163.com/login?codekey=${key}` };
  }

  /**
   * 轮询扫码结果。
   *   800 二维码过期 / 801 等待扫码 / 802 待确认 / 803 成功
   */
  async pollQr(key) {
    if (!key) return { code: 800, message: '缺少 key' };
    const { data, res } = await this._weapiPost('/weapi/login/qrcode/client/login', { key, type: 1 });
    const code = Number(data && data.code) || 800;

    if (code !== 803) {
      return { code, loggedIn: this.loggedIn, nickname: this.state.nickname };
    }

    // 803：把 cookie 收集下来。响应头里的 Set-Cookie 最完整，body 里的 cookie 兜底。
    let jar = '';
    try {
      const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      jar = raw.join('; ');
    } catch (e) { /* 老 Node 没有 getSetCookie */ }
    jar = mergeCookie(jar, data.cookie || '');

    if (!cookieValue(jar, 'MUSIC_U')) {
      return { code: 800, message: '登录成功但没拿到登录态，请重试' };
    }

    this.state.cookie = jar;
    this.state.savedAt = Date.now();
    this.liked = null;
    this.likedAt = 0;
    await this.refreshProfile();
    this._save();
    this._qr.delete(key);
    this.log(`网易云账号已登录：${this.state.nickname || this.state.uid}`);
    return { code: 803, loggedIn: true, nickname: this.state.nickname };
  }

  async refreshProfile() {
    try {
      const { data } = await this._getJson(`${BASE}/api/nuser/account/get`);
      const profile = data && (data.profile || (data.account && data.profile));
      if (profile) {
        this.state.uid = Number(profile.userId) || this.state.uid;
        this.state.nickname = profile.nickname || this.state.nickname;
        this.state.likedPid = await this._findLikedPid(this.state.uid) || this.state.likedPid;
        return true;
      }
      // cookie 失效（MUSIC_U 过期）：清掉，避免一直以为登录着
      if (data && data.code === 200 && !data.profile && this.state.cookie) {
        this.log('登录态已失效，请重新扫码登录');
        this.logout(false);
      }
    } catch (err) {
      this.log('读取账号信息失败：' + err.message);
    }
    return false;
  }

  /** 「我喜欢的音乐」是特殊歌单（specialType=5），它的 id 恰好等于用户 id，但仍以接口为准 */
  async _findLikedPid(uid) {
    try {
      const { data } = await this._getJson(`${BASE}/api/user/playlist?uid=${uid}&limit=200&offset=0`);
      const lists = (data && data.playlist) || [];
      const liked = lists.find((p) => Number(p.specialType) === 5);
      if (liked) return Number(liked.id) || 0;
    } catch (err) { /* 失败就用 uid 兜底 */ }
    return 0;
  }

  logout(save = true) {
    this.state = { cookie: '', uid: 0, nickname: '', likedPid: 0, savedAt: 0 };
    this.liked = null;
    this.likedAt = 0;
    if (save) {
      try { fs.unlinkSync(this.file); } catch (e) { /* 已经不存在 */ }
    }
  }

  // -------------------------------------------------------------------------
  // 我喜欢的音乐
  // -------------------------------------------------------------------------

  get likedPlaylistId() {
    return this.state.likedPid || this.state.uid;
  }

  /** 同步查询（给 snapshot 用）：null = 还不知道 */
  isLikedQuick(songId) {
    const id = Number(songId) || 0;
    if (!this.loggedIn || !id || !this.liked) return null;
    return this.liked.has(id);
  }

  /**
   * 拉全量 liked 集合。`playlist.trackIds` 不受分页影响，是完整的 id 列表
   * （`tracks` 才会被截断），所以用它。
   */
  async refreshLiked(force = false) {
    if (!this.loggedIn) return null;
    if (!force && this.liked && Date.now() - this.likedAt < LIKED_TTL_MS) return this.liked;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      try {
        const pid = this.likedPlaylistId;
        if (!pid) return this.liked;
        const { data } = await this._getJson(`${BASE}/api/v6/playlist/detail?id=${pid}&n=100000&s=0`);
        const pl = data && data.playlist;
        if (!pl || !Array.isArray(pl.trackIds)) return this.liked;
        this.liked = new Set(pl.trackIds.map((t) => Number(t.id) || t.id).filter(Boolean));
        this.likedAt = Date.now();
        this._changed();
        return this.liked;
      } catch (err) {
        this.log('读取「我喜欢的音乐」失败：' + err.message);
        return this.liked;
      } finally {
        this._loading = null;
      }
    })();

    return this._loading;
  }

  /** 立刻刷新（不阻塞调用方），失败也无所谓 —— 下一次 snapshot 会再试 */
  primeLiked() {
    if (!this.loggedIn) return;
    if (this.liked && Date.now() - this.likedAt < LIKED_TTL_MS) return;
    this.refreshLiked().catch(() => {});
  }

  async setLiked(songId, liked) {
    const id = Number(songId) || 0;
    if (!this.loggedIn) throw new Error('还没登录网易云账号');
    if (!id) throw new Error('当前曲目没有匹配到网易云 ID，无法收藏');
    const pid = this.likedPlaylistId;
    if (!pid) throw new Error('拿不到「我喜欢的音乐」歌单 ID，请重新登录');

    const { data } = await this._weapiPost('/weapi/playlist/manipulate/tracks', {
      trackIds: JSON.stringify([id]),
      op: liked ? 'add' : 'del',
      pid,
    });
    const code = Number(data && data.code);
    if (code !== 200 && code !== 201) {
      throw new Error((data && (data.message || data.msg)) || `网易云返回 code=${code || '?'}`);
    }

    // 乐观更新本地集合，页面立刻能变；正式结果以下次刷新为准
    if (!this.liked) this.liked = new Set();
    if (liked) this.liked.add(id);
    else this.liked.delete(id);
    this.likedAt = Date.now();
    this._changed();
    return { songId: id, liked };
  }
}

module.exports = { NeteaseAccount, weapi, mergeCookie, cookieValue };
