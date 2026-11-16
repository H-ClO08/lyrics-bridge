'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

function signatureOf(values) {
  return crypto.createHash('sha1').update([...values].sort().join('\u0001')).digest('hex').slice(0, 16);
}

function textValues(values) {
  return (values || []).filter((v) => v && !/^\d+$/.test(v));
}

/**
 * 这个地址是不是「本机」。
 *
 * 用来区分 /api/push 的两种来源：tools/smtc-push.js 从 127.0.0.1 推，
 * 手机 App 从局域网 IP 推。两者在服务端都表现为 source='push'，
 * 但切歌指令的去向完全相反 —— 判断错就会「手机在放歌，点下一首却没反应」。
 */
function isLoopbackIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return true; // 拿不到地址（同进程调用等）时按本机处理，保持老行为
  return (
    s === '::1' ||
    s === '::ffff:127.0.0.1' ||
    s.startsWith('127.') ||
    s === 'localhost'
  );
}

class Hub extends EventEmitter {
  constructor({ config, resolver, log, account }) {
    super();
    this.config = config;
    this.resolver = resolver;
    this.log = log || (() => {});
    // 网易云账号（扫码登录 / 我喜欢的音乐）。可以为 null —— 没登录时
    // snapshot 里的 liked 就是 null，页面把红心画成空心。
    this.account = account || null;
    this.ws = null;

    this.adbStatus = { available: false, connected: false, error: '', devices: [] };
    this.hash = 'none';
    this._activeSource = 'none';
    this._lastPushAt = 0;
    this._resolveToken = 0;
    this._pin = null;
    // 双源仲裁：记录手机（adb）与电脑（push）各自的播放状态，auto 模式下按
    // 「正在播放的源」自动切换，手机优先。
    this._adbPlaying = false;
    this._adbLastAt = 0;
    this._pushPlaying = false;
    // 最近一次「从局域网推过来」的设备（手机 App）。控制指令要发回它。
    this._pushDevice = null;
    // 第三条来源：手机 App 自己开的 HTTP 接口（走它就不需要 adb 了）
    this._httpPlaying = false;
    this._httpLastAt = 0;
    this._phoneSig = '';

    this.state = {
      rev: 0,
      status: 'idle',
      source: 'none',
      message: '等待手机端开始播放…',
      track: null,
      lyrics: [],
      anchor: null,
      resolving: false,
      at: Date.now(),
    };

    this._ticker = setInterval(() => this.broadcast(), 4000);
    this._ticker.unref?.();
    this._reevaluateSource();
  }

  attachWS(ws) {
    this.ws = ws;
  }

  snapshot() {
    const snap = {
      ...this.state,
      at: Date.now(),
      adb: this.adbStatus,
      receivers: this.ws ? this.ws.size : 0,
      pinned: this._pin ? this._pin.songId : 0,
      // 页面上的控制条要知道两件事：这首歌收藏了没有、当前音源能不能被控制。
      // push=本机 SMTC 或手机推送；http=转发给手机 App（v1.4+）；adb=注入媒体键。三种都能控。
      canControl: this._activeSource === 'push' || this._activeSource === 'http' || this._activeSource === 'adb',
      // 控制指令该往哪发。手机推送过来时，push 源实际代表「手机在放」，
      // 指令必须转回手机，否则会去打电脑上并不存在的会话（按钮点了没反应）。
      controlTarget: this.controlTarget(),
      liked: null,
      account: null,
    };

    if (this.account) {
      // 同步读缓存（null = 还不知道）；需要刷新时后台拉一次，好了会再广播。
      const songId = this.state.track && this.state.track.songId;
      snap.liked = this.account.isLikedQuick(songId);
      snap.account = this.account.info();
      this.account.primeLiked();
    }

    return snap;
  }

  /**
   * 控制指令该发给谁。
   *
   * adb / http 源本来就是手机，不会有歧义。麻烦的是 push 源 —— 它既可能是
   * 本机 SMTC 发布端（tools/smtc-push.js，从 127.0.0.1 推），也可能是手机 App
   * 推过来的（从局域网 IP 推）。两者都落到 source='push'，但控制目标完全不同：
   * 手机在放歌时如果把指令发给本机 SMTC，电脑上根本没有那个会话，按钮就像坏了。
   *
   * 所以按「推送来源是不是回环地址」区分，并把手机地址记下来（手机 IP 变了
   * 也不用改配置，下一次推送就会刷新）。
   */
  controlTarget() {
    const src = this._activeSource;
    if (src === 'http') {
      return { kind: 'phone', base: String(this.config.phoneUrl || '').replace(/\/+$/, '') };
    }
    if (src === 'adb') return { kind: 'phone', base: '' };
    if (src === 'push') {
      const dev = this._pushDevice;
      // 10 分钟内推过才算「这台手机还在」；否则可能是个 DHCP 已经分给别人的旧地址。
      if (dev && Date.now() - dev.at < 10 * 60 * 1000) {
        return { kind: 'phone', base: `http://${dev.ip}:${dev.port}` };
      }
      return { kind: 'pc', base: '' };
    }
    return { kind: 'none', base: '' };
  }

  broadcast() {
    if (!this.ws || this.ws.size === 0) return;
    this.ws.broadcast({ type: 'state', data: this.snapshot() });
  }

  _commit(patch) {
    // 内容完全相同时不提交。否则手机没连上时，每一轮轮询都会把
    // 「未检测到安卓设备」这份一模一样的提示重新广播一遍，
    // 客户端被迫反复重渲染 —— 表现就是网页一直在「刷新」。
    // （track / lyrics 这类每次都是新对象的 patch 依然照常提交。）
    const changed = Object.keys(patch).some((k) => this.state[k] !== patch[k]);
    if (!changed) return;
    this.state = { ...this.state, ...patch, rev: this.state.rev + 1, at: Date.now() };
    this.broadcast();
  }

  // -------------------------------------------------------------------------
  // 来源仲裁：auto 模式下有 adb 设备就用 adb，否则用推送
  // -------------------------------------------------------------------------

  setAdbStatus(status) {
    this.adbStatus = { ...this.adbStatus, ...status };
    this._reevaluateSource();
  }

  _reevaluateSource() {
    const mode = this.config.source || 'auto';
    let next;
    if (mode === 'adb') next = 'adb';
    else if (mode === 'push') next = 'push';
    else if (mode === 'http') next = 'http';
    else if (mode === 'mock') next = 'mock';
    else {
      // auto：手机在放优先（adb 和手机 App 都算手机，adb 更精确），
      // 其次是电脑推送，最后才退到「有设备就算连上」。
      if (this._adbPlaying) next = 'adb';
      else if (this._httpPlaying && Date.now() - this._httpLastAt < 60000) next = 'http';
      else if (this._pushPlaying && Date.now() - this._lastPushAt < 60000) next = 'push';
      else if (this.adbStatus.connected) next = 'adb';
      else next = 'none';
    }

    if (next !== this._activeSource) {
      this._activeSource = next;
      if (next !== 'none') this.log(`生效数据源切换为 ${next}`);
    }
  }

  get activeSource() {
    return this._activeSource;
  }

  // -------------------------------------------------------------------------
  // ADB 事件
  // -------------------------------------------------------------------------

  onAdbEvent(evt) {
    const mode = this.config.source || 'auto';
    if (mode === 'mock' || mode === 'push') return;

    const isPlaying = evt.kind === 'track' && !!evt.playing;
    this._adbPlaying = isPlaying;
    this._adbLastAt = Date.now();

    // auto：电脑正在播放、而手机这一拍不是播放态时，让电脑接管，忽略手机的
    // idle/暂停事件，避免把电脑的播放状态覆盖成「无播放」。
    if (mode === 'auto' && this._pushPlaying && !isPlaying) return;

    this.onTrackEvent(evt, 'adb');
    this._reevaluateSource();
  }

  onTrackEvent(evt, source) {
    if (evt.kind === 'idle') {
      const message =
        evt.reason === 'device'
          ? '未检测到安卓设备（无线调试未连接，或手机 IP 已变）'
          : evt.reason === 'adb-error'
            ? `adb 通信失败：${evt.error || '未知错误'}`
            : '手机上当前没有正在播放的媒体';
      // 「没有设备」不该算故障：auto 模式下你很可能本来就在用电脑推送。
      // 一直标成红色错误会让人以为程序坏了，所以降级为等待态，
      // 只有 adb 真的通信异常才是 error。
      this._commit({
        status: evt.reason === 'adb-error' ? 'error' : 'idle',
        source,
        message,
      });
      return;
    }

    this._applyTrack({
      source,
      values: evt.values,
      duration: evt.duration,
      playing: evt.playing,
      stateCode: evt.stateCode,
      anchor: evt.anchor,
      changed: evt.changed,
      package: evt.package,
    });
  }

  // -------------------------------------------------------------------------
  // 外部推送
  // -------------------------------------------------------------------------

  onPush(payload, meta = {}) {
    this._lastPushAt = Date.now();
    const mode = this.config.source || 'auto';
    const playing = payload.playing !== false;
    this._pushPlaying = playing;

    // 记下「这条推送是从哪来的」。回环 = 本机 SMTC 发布端；局域网 IP = 手机 App。
    // 用途只有一个：/api/control 要据此把切歌指令发回手机而不是发给本机。
    const remote = String(meta.remoteIp || '');
    if (!isLoopbackIp(remote)) {
      this._pushDevice = { ip: remote.replace(/^::ffff:/, ''), port: Number(meta.port) || 8787, at: Date.now() };
    } else {
      // 本机发布端推上来 = 现在这条 push 源代表「电脑在放」，控制指令要打回本机 SMTC。
      this._pushDevice = null;
    }

    // auto：手机正在播放时手机优先，忽略电脑推送（避免电脑抢占手机）
    if (mode === 'auto' && this._adbPlaying) {
      this._reevaluateSource();
      return { ok: true, ignored: true, rev: this.state.rev };
    }

    this._reevaluateSource();

    if (!payload || (!payload.title && !payload.songId && !payload.artist)) {
      return { ok: false, error: '至少需要提供 title / artist / songId 之一' };
    }

    const values = [payload.title, payload.artist, payload.album].filter(Boolean).map(String);
    const now = Date.now();
    const speed = playing ? (Number(payload.speed) > 0 ? Number(payload.speed) : 1) : 0;
    const position = Math.max(0, Number(payload.position) || 0);

    // 推送端可能是在几十毫秒到一秒多之前采到这条进度的（网易云 PC 版大约
    // 每秒才往 Windows 媒体会话里写一次新进度，adb 侧同理）。把「收到的时刻」
    // 当成「进度的时刻」，前端外推出来的播放位置就会整体偏慢 —— 电脑当数据源
    // 时歌词稳定慢约 1 秒，就是这个原因。
    //
    // 所以锚点的时间戳要往回调 positionAgeMs：锚点语义始终是
    // 「position 这个进度值，是在 serverTime 这一刻成立的」。
    const ageMs = Math.max(0, Math.min(10000, Number(payload.positionAgeMs) || 0));
    const anchorAt = now - ageMs;

    // 只有真正换歌才走「重新匹配」。之前这里写死 changed: true，
    // 导致手机每 3 秒一次的推送都会重新匹配一次网易云、并让前端清空重建歌词
    // —— 这正是「歌词页反复刷新」的根因。同一首歌只更新进度即可。
    const sig = signatureOf(values.length ? values : ['push']);
    const changed = sig !== this.hash;

    this._applyTrack({
      source: 'push',
      values,
      duration: Number(payload.duration) || 0,
      playing,
      stateCode: playing ? 3 : 2,
      anchor: { position, serverTime: anchorAt, speed, ageMs, updated: anchorAt, rawPosition: position, stateCode: playing ? 3 : 2 },
      changed,
      package: payload.package || 'push',
      coverHint: payload.cover || '',
      pinnedSongId: Number(payload.songId) || 0,
    });

    return { ok: true, rev: this.state.rev };
  }

  // -------------------------------------------------------------------------
  // 手机 App 的 HTTP 状态
  //
  // 这里**不再重新匹配歌词**：手机已经把封面和歌词都备好了，直接用它的结果，
  // 既省一次网络请求，也避免两边匹配到不同版本导致歌词对不上。
  // 代价小、收益大，所以走「透传」而不是复用 _applyTrack。
  // -------------------------------------------------------------------------

  onPhoneState(msg) {
    const mode = this.config.source || 'auto';
    if (mode !== 'http' && mode !== 'auto') return;

    this._httpLastAt = Date.now();

    if (!msg.ok) {
      this._httpPlaying = false;
      this._reevaluateSource();
      this._commit({
        status: 'idle',
        source: 'http',
        message: `连不上手机（${msg.error}）。请确认手机 App 已点「启动服务」，且与本机在同一 Wi-Fi。`,
      });
      return;
    }

    const d = msg.data || {};
    const t = d.track || {};
    // 手机在空闲时会把 title 占位成「等待手机播放…」，那不是真曲目
    const idle = d.status === 'idle' || !t.title || t.title === '等待手机播放…';
    const playing = d.status === 'playing';
    this._httpPlaying = playing;

    // auto：手机没在放、而电脑在放时，让电脑接管
    if (mode === 'auto' && this._pushPlaying && !playing) {
      this._reevaluateSource();
      return;
    }

    const a = d.anchor || {};
    const offset = Number(msg.offset) || 0;
    // 手机给的 serverTime 用的是**手机的**时钟，换算成本机时钟后
    // 前端才能用本地时间做外推（否则进度会整体平移）。
    const anchor = {
      position: Math.max(0, Number(a.position) || 0),
      serverTime: (Number(a.serverTime) || 0) ? Number(a.serverTime) - offset : Date.now(),
      speed: Number(a.speed) || 0,
    };

    const lyrics = Array.isArray(d.lyrics) ? d.lyrics : [];
    const sig = [Number(t.songId) || 0, t.title || '', t.artist || '', lyrics.length].join('|');

    const patch = {
      status: idle ? 'idle' : playing ? 'playing' : 'paused',
      source: 'http',
      anchor,
      message: idle ? d.message || '等待手机播放…' : d.message || '',
      resolving: !idle && lyrics.length === 0,
    };

    // 曲目和歌词只在真的变了时才带上 —— 否则每秒一次的状态同步都会
    // 塞进几十行歌词，白白占用带宽（客户端也要多做一次比较）。
    if (sig !== this._phoneSig) {
      this._phoneSig = sig;
      patch.track = {
        songId: Number(t.songId) || 0,
        title: idle ? '等待手机播放…' : t.title || '未知曲目',
        artist: idle ? '' : t.artist || '',
        album: idle ? '' : t.album || '',
        duration: idle ? 0 : Number(t.duration) || 0,
        cover: idle ? '' : t.cover || '',
        matched: !idle && !!t.matched,
        hasLyrics: !idle && lyrics.length > 0,
      };
      patch.lyrics = idle ? [] : lyrics;
    }

    this._commit(patch);
    this._reevaluateSource();
  }

  // -------------------------------------------------------------------------
  // 曲目变化 → 走网易云解析
  // -------------------------------------------------------------------------

  _applyTrack(input) {
    const values = textValues(input.values);
    const sig = signatureOf(values.length ? values : [input.package || 'unknown']);

    // ageMs 只是给 /api/state 看的诊断值：这条进度采到的时候已经旧了多少毫秒
    //（推送端算的，不为 0 就说明我们把它补偿回来了）。
    const anchor = input.anchor
      ? { position: input.anchor.position, serverTime: input.anchor.serverTime, speed: input.anchor.speed, ageMs: input.anchor.ageMs || 0 }
      : this.state.anchor;

    if (!input.changed && sig === this.hash) {
      // 同一首歌：只更新锚点，避免重复解析
      this._commit({
        status: input.playing ? 'playing' : 'paused',
        anchor,
        source: input.source,
        message: '',
      });
      return;
    }

    this.hash = sig;
    this._pin = null;
    const token = ++this._resolveToken;

    this._commit({
      status: 'resolving',
      source: input.source,
      resolving: true,
      anchor,
      message: '正在匹配网易云曲目…',
      track: {
        songId: 0,
        title: values[0] || '未知曲目',
        artist: values[1] || '',
        album: values[2] || '',
        duration: input.duration || 0,
        cover: input.coverHint || '',
        matched: false,
        hasLyrics: false,
      },
      lyrics: [],
    });

    this._resolve(values, input.duration, input.pinnedSongId || 0, input.coverHint || '', token);
  }

  async _resolve(values, durationHint, pinnedSongId, coverHint, token) {
    let result = null;
    let error = '';
    try {
      result = await this.resolver.resolve({ values, durationHint, pinnedSongId });
    } catch (err) {
      error = err.message;
    }

    if (token !== this._resolveToken) return; // 已经切歌，丢弃这次结果

    if (!result) {
      this.log('未能匹配到网易云曲目:', values.join(' / '), error || '');
      this._commit({
        resolving: false,
        status: this.state.anchor && this.state.anchor.speed > 0 ? 'playing' : 'paused',
        message: '未匹配到网易云曲目（电台 / 播客 / 本地文件？）可点右上角手动指定',
        track: {
          songId: 0,
          title: values[0] || '未知曲目',
          artist: values[1] || '',
          album: values[2] || '',
          duration: durationHint || 0,
          cover: coverHint || '',
          matched: false,
          hasLyrics: false,
        },
        lyrics: [],
      });
      return;
    }

    this._commit({
      resolving: false,
      status: this.state.anchor && this.state.anchor.speed > 0 ? 'playing' : 'paused',
      message: result.hasLyrics ? '' : '这首歌没有时间轴歌词',
      track: {
        songId: result.songId,
        title: result.title,
        artist: result.artist,
        album: result.album,
        duration: result.duration || durationHint || 0,
        cover: coverHint || result.cover,
        matched: true,
        hasLyrics: result.hasLyrics,
      },
      lyrics: result.lyrics,
    });
  }

  /** 手动指定正确的歌曲（匹配错误时的兜底） */
  async pin(songId) {
    const track = this.state.track;
    if (!track) return { ok: false, error: '当前没有曲目' };

    const values = [track.title, track.artist, track.album].filter(Boolean);
    this._pin = { songId: Number(songId), at: Date.now() };
    const token = ++this._resolveToken;
    this._commit({ status: 'resolving', resolving: true, message: '正在按指定曲目重新加载…' });
    await this._resolve(values, track.duration, Number(songId), '', token);
    return { ok: true };
  }

  /** 让当前曲目重新走一次匹配（清缓存） */
  async refresh() {
    const track = this.state.track;
    if (!track) return { ok: false, error: '当前没有曲目' };
    const values = [track.title, track.artist, track.album].filter(Boolean);
    const token = ++this._resolveToken;
    this._commit({ status: 'resolving', resolving: true, message: '正在刷新…' });
    await this._resolve(values, track.duration, 0, '', token);
    return { ok: true };
  }

  info() {
    return {
      source: this._activeSource,
      configured: this.config.source,
      hash: this.hash,
      adb: this.adbStatus,
      receivers: this.ws ? this.ws.size : 0,
      resolver: this.resolver.stats ? this.resolver.stats() : {},
      track: this.state.track,
    };
  }
}

module.exports = { Hub, signatureOf, textValues, isLoopbackIp };
