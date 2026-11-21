'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { WSServer } = require('./ws');
const { Hub } = require('./hub');
const { NeteaseResolver } = require('./netease');
const { AdbSource, parseMediaSessions, findAdb } = require('./adb');
const { MockSource } = require('./mock');
const { HttpSource } = require('./http-source');
const { listLanCandidates, preferredOutboundIp } = require('./lan');
const { NeteaseAccount } = require('./netease-account');
const { runControl, phoneControl, adbControl } = require('./control');
const { checkWrite } = require('./guard');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2] === undefined ? 'true' : m[2];
    args[key] = value;
  }
  return args;
}

function loadConfig() {
  const cli = parseCli(process.argv);
  let fileConfig = {};
  const configPath = path.join(ROOT, 'config.json');
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[配置] config.json 解析失败，使用默认值：${err.message}`);
    }
  }

  const config = { ...fileConfig };

  if (cli.source) config.source = cli.source;
  if (cli.port) config.port = Number(cli.port);
  if (cli.host) config.host = cli.host;
  if (cli.adb) config.adbPath = cli.adb;
  if (cli.serial) config.adbSerial = cli.serial;
  if (cli.interval) config.pollIntervalMs = Number(cli.interval);
  if (cli['phone-url']) config.phoneUrl = cli['phone-url'];
  if (cli['http-interval']) config.httpIntervalMs = Number(cli['http-interval']);
  if (cli['lan-host']) config.lanHost = cli['lan-host'];
  if (cli['log-raw']) config.logRawDumpsys = true;

  config.port = Number(config.port) || 8787;
  config.host = config.host || '0.0.0.0';
  config.source = config.source || 'auto';
  config.pollIntervalMs = Number(config.pollIntervalMs) || 900;
  config.cacheFile = path.isAbsolute(config.cacheFile || '')
    ? config.cacheFile
    : path.join(ROOT, config.cacheFile || '.cache/netease.json');

  return config;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readBodyAny(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
  }
}

// ---------------------------------------------------------------------------
// 显示页的个性化设置（字体 / 字号 / 布局 …）
//
// 为什么要存在服务端：浏览器的 localStorage 是**按网址隔离**的，
// 而这个环境里 IP 老是变 —— 一换 IP，浏览器就当成了新网站，设置全丢。
// 存到服务端之后，只要连的还是同一个服务，不管从哪个地址访问都一致。
// ---------------------------------------------------------------------------

const PREFS_FILE = path.join(ROOT, '.cache', 'prefs.json');

function loadPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function savePrefs(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '设置必须是一个对象' };
  }
  let json;
  try {
    json = JSON.stringify(data);
  } catch (err) {
    return { ok: false, error: '设置无法序列化' };
  }
  if (json.length > 64 * 1024) return { ok: false, error: '设置数据过大' };
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/**
 * 局域网候选地址（推荐项排第一）。出口地址探测有缓存，避免每次请求都开 socket。
 */
let _outbound = { ip: '', at: 0 };
async function lanCandidates(config, port) {
  if (Date.now() - _outbound.at > 30000) {
    _outbound = { ip: await preferredOutboundIp(), at: Date.now() };
  }
  return listLanCandidates({
    outboundIp: _outbound.ip,
    port,
    override: config.lanHost,
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function main() {
  const config = loadConfig();
  const startedAt = Date.now();

  const log = (...args) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...args);

  // -------------------------------------------------------------------------
  // 兜底：不让一次网络抖动把整个服务带走
  //
  // Node 22 起未处理的 Promise 拒绝默认直接终止进程。这个服务会长期挂在后台，
  // 而它要访问网易云接口、手机 HTTP 服务、封面图床 —— 任一处 keep-alive 连接
  // 在 AbortSignal.timeout 到点时抛出的 DOMException，只要有一条路径漏了
  // catch，整个投屏就断了。所以这里统一记录并继续运行，而不是进程退出。
  // -------------------------------------------------------------------------
  process.on('unhandledRejection', (err) => {
    log('未处理的 Promise 拒绝（已忽略，服务继续运行）：', (err && (err.stack || err.message)) || String(err));
  });
  process.on('uncaughtException', (err) => {
    log('未捕获的异常（已忽略，服务继续运行）：', (err && (err.stack || err.message)) || String(err));
  });

  const resolver = new NeteaseResolver(config);
  const account = new NeteaseAccount({ cacheDir: path.join(ROOT, '.cache'), log });
  const hub = new Hub({ config, resolver, log, account });
  // 收藏集合在后台拉完 / 登录状态变化时，让页面立刻拿到新状态
  account.onChange = () => hub.broadcast();

  // 有 cookie 就顺手验一下（失效会自己登出），并把「我喜欢的音乐」拉进内存，
  // 这样页面渲染时就能同步显示出红心状态。
  if (account.loggedIn) {
    account
      .refreshProfile()
      .then(() => {
        if (!account.loggedIn) return;
        hub.broadcast();
        return account.refreshLiked(true);
      })
      .then(() => hub.broadcast())
      .catch(() => {});
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const query = new URLSearchParams((req.url || '').split('?')[1] || '');

    try {
      if (url === '/api/state') return sendJson(res, hub.snapshot());
      if (url === '/api/nowplaying') return sendJson(res, nowPlayingPayload(hub));
      if (url === '/api/info') return sendJson(res, { ...hub.info(), uptimeMs: Date.now() - startedAt, config: redactConfig(config) });

      if (url === '/api/push') {
        const payload = req.method === 'POST' ? await readBodyAny(req) : Object.fromEntries(query.entries());
        // 把来源地址一起交给 hub：手机 App 和本机 SMTC 发布端都推 /api/push，
        // 但「切歌指令该发给谁」完全相反。回环 = 本机，局域网 IP = 手机。
        const remoteIp = (req.socket && req.socket.remoteAddress) || '';
        return sendJson(res, hub.onPush(normalizePush(payload), { remoteIp, port: 8787 }));
      }

      if (url === '/api/search') {
        const q = query.get('q') || '';
        if (!q.trim()) return sendJson(res, { ok: false, error: '缺少 q 参数' }, 400);
        const results = await resolver.search(q, Number(query.get('limit')) || 12);
        return sendJson(res, { ok: true, results });
      }

      if (url === '/api/pin') {
        const gate = checkWrite(req);
        if (!gate.ok) return sendJson(res, gate, 403);
        const payload = req.method === 'POST' ? await readBodyAny(req) : Object.fromEntries(query.entries());
        const songId = Number(payload.songId);
        if (!songId) return sendJson(res, { ok: false, error: '缺少 songId' }, 400);
        return sendJson(res, await hub.pin(songId));
      }

      if (url === '/api/refresh') return sendJson(res, await hub.refresh());

      if (url === '/api/cover') {
        return proxyCover(query.get('url'), res, config.coverSize);
      }

      if (url === '/api/debug/dumpsys') {
        const raw = adbSource ? adbSource.rawDump() : '';
        if (query.get('format') === 'json') {
          return sendJson(res, { ok: true, sessions: parseMediaSessions(raw) });
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(raw || '（还没有采集到任何 dumpsys 输出）');
      }

      if (url === '/api/health') {
        return sendJson(res, {
          ok: true,
          source: hub.activeSource,
          adb: hub.adbStatus,
          clients: ws.size,
          uptimeMs: Date.now() - startedAt,
        });
      }

      if (url === '/api/lan') {
        const port = config.port;
        const addresses = await lanCandidates(config, port);
        return sendJson(res, {
          ok: true,
          port,
          // 第一项是推荐的（物理网卡优先、命中系统出口地址优先）。
          // 全部候选都返回，页面上可以手动换 —— 校园网/多网卡机器上
          // 自动判断不保证一次就对。
          addresses,
          recommended: addresses.length ? addresses[0].url : '',
          forced: String(config.lanHost || '').trim(),
        });
      }

      // 播放控制：按当前生效的音源走不同的通道
      //   push -> 本机 Windows 媒体会话（SMTC）
      //   http -> 转发给手机 App 的 /api/control（v1.4+）
      //   adb  -> 往手机注入媒体键（不需要 App 支持）
      if (url === '/api/control') {
        if (req.method !== 'POST') return sendJson(res, { ok: false, error: '请用 POST' }, 405);
        const gate = checkWrite(req);
        if (!gate.ok) return sendJson(res, gate, 403);
        const body = await readBodyAny(req);
        const action = body.action || body.op;
        const src = hub.activeSource;
        // push 源有两种身份：本机播放器（127.0.0.1 推上来的）或手机 App（局域网推上来的）。
        // 不区分的话，手机放歌时点「下一首」会去控电脑上空着的会话 —— 表现就是按钮点了没反应。
        const target = hub.controlTarget();

        let result;
        if (src === 'adb') {
          result = await adbControl(adbSource, action);
        } else if (src === 'push' && target.kind === 'pc') {
          result = await runControl(action);
        } else if (target.kind === 'phone') {
          if (!target.base) {
            return sendJson(
              res,
              { ok: false, error: '还没收到过手机推送，不知道手机地址。等手机 App 连上后再试。' },
            );
          }
          result = await phoneControl(target.base, action);
        } else {
          const why = src === 'mock' ? '演示模式（mock）下不能控制' : '当前没有正在播放的来源可以控制';
          return sendJson(res, { ok: false, error: why });
        }

        if (result.ok) setTimeout(() => hub.broadcast(), 300);
        return sendJson(res, result);
      }

      // 网易云账号（扫码登录 / 我喜欢）—— 返回给网页的永远只有登录状态和昵称
      if (url === '/api/account') return sendJson(res, { ok: true, ...account.info() });

      if (url === '/api/account/qr') {
        if (req.method === 'POST') {
          const gate = checkWrite(req);
          if (!gate.ok) return sendJson(res, gate, 403);
          try {
            return sendJson(res, { ok: true, ...(await account.createQr()) });
          } catch (err) {
            return sendJson(res, { ok: false, error: err.message });
          }
        }
        try {
          const status = await account.pollQr(query.get('key') || '');
          if (status.code === 803) {
            await account.refreshLiked(true);
            hub.broadcast();
          }
          return sendJson(res, { ok: true, ...status });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message });
        }
      }

      if (url === '/api/account/logout') {
        const gate = checkWrite(req);
        if (!gate.ok) return sendJson(res, gate, 403);
        account.logout();
        hub.broadcast();
        return sendJson(res, { ok: true, ...account.info() });
      }

      if (url === '/api/like') {
        if (req.method !== 'POST') return sendJson(res, { ok: false, error: '请用 POST' }, 405);
        const gate = checkWrite(req);
        if (!gate.ok) return sendJson(res, gate, 403);
        const body = await readBodyAny(req);
        const songId = Number(body.songId) || Number(hub.state.track && hub.state.track.songId) || 0;
        try {
          const result = await account.setLiked(songId, !!body.liked);
          hub.broadcast();
          return sendJson(res, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message });
        }
      }

      // 显示页的个性化设置：存在服务端，换 IP / 换设备都不会丢
      if (url === '/api/prefs') {
        if (req.method === 'POST' || req.method === 'PUT') {
          const gate = checkWrite(req);
          if (!gate.ok) return sendJson(res, gate, 403);
          const body = await readBodyAny(req);
          const result = savePrefs(body);
          return sendJson(res, result, result.ok ? 200 : 400);
        }
        return sendJson(res, { ok: true, prefs: loadPrefs() });
      }

      if (url.startsWith('/api/')) return sendJson(res, { ok: false, error: '未知接口' }, 404);
      return serveStatic(req, res);
    } catch (err) {
      log('请求处理失败', url, err.message);
      return sendJson(res, { ok: false, error: err.message }, 500);
    }
  });

  const ws = new WSServer(httpServer, '/ws');

  ws.on('connection', (conn) => {
    conn.send({ type: 'state', data: hub.snapshot() });
    conn.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        return;
      }
      if (msg && msg.type === 'ping') {
        conn.send({ type: 'pong', t: msg.t, serverTime: Date.now() });
      }
    });
  });

  hub.attachWS(ws);

  let adbSource = null;
  let mockSource = null;
  let httpSource = null;

  // 配了 phoneUrl 就优先走手机 App 的 HTTP 接口（这条链路不需要 adb，
  // 也不需要开发者选项，所以一旦配好就默认切成它）。
  const useHttp = !!String(config.phoneUrl || '').trim() && config.source !== 'adb' && config.source !== 'push';

  if (config.source === 'mock') {
    mockSource = new MockSource(config, log);
    mockSource.on('track', (evt) => hub.onTrackEvent(evt, 'mock'));
    mockSource.start();
  } else if (useHttp) {
    httpSource = new HttpSource(config, log);
    httpSource.on('state', (msg) => hub.onPhoneState(msg));
    httpSource.start();
  } else if (config.source !== 'push') {
    adbSource = new AdbSource(config, log);
    adbSource.on('track', (evt) => hub.onAdbEvent(evt));
    hub.setAdbStatus(adbSource.status);
    adbSource.start();
    log(`adb 探测路径：${findAdb(config)}`);
    adbSource
      .devices()
      .then((list) => {
        hub.setAdbStatus(adbSource.status);
        if (!list.length) {
          log('暂未发现 adb 设备。请先在手机上开启「开发者选项 → 无线调试」，然后执行：');
          log('  adb pair <手机IP>:<配对端口> <配对码>');
          log('  adb connect <手机IP>:<调试端口>');
          log('  或把手机用 USB 连接电脑一次，授权后即可长期使用无线调试。');
        } else {
          log(`发现 ${list.length} 个设备：${list.map((d) => `${d.serial}(${d.state})`).join(', ')}`);
        }
      })
      .catch(() => {});
  } else {
    log('以纯推送模式启动，等待 /api/push 上报播放状态');
  }

  setInterval(() => {
    if (adbSource) hub.setAdbStatus(adbSource.status);
  }, 5000).unref?.();

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('');
      log('!!! 端口 ' + config.port + ' 已被占用，启动失败 !!!');
      log('');
      log('  最可能的原因：已经有一个本服务在跑了（比如你之前双击过 demo.bat 或 start.bat）。');
      log('  这很危险 —— 后启动的这个没起来，但工具（比如 SMTC 桥接）会继续读那个旧的服务，');
      log('  于是你手机上切歌、电脑上却一直显示旧内容。');
      log('');
      log('  处理办法：先关掉另一个窗口，或者用别的端口启动：');
      log('      node src/server.js --port=' + (config.port + 1));
      log('');
    } else {
      log('服务启动失败：' + err.message);
    }
    process.exit(1);
  });

  httpServer.listen(config.port, config.host, () => {
    log('==================================================');
    log('  手机网易云 → 电脑实时歌词  已启动');
    log(`  显示页：http://localhost:${config.port}`);
    lanCandidates(config, config.port).then((list) => {
      if (!list.length) {
        log('  局域网：未检测到局域网地址（只有内网/回环地址？）');
        return;
      }
      for (const a of list) {
        const mark = a.url === list[0].url ? '  ← 推荐给平板 / 手机' : '';
        log(`  局域网：${a.url}${a.name ? `  (${a.name}${a.note ? ' · ' + a.note : ''})` : ''}${mark}`);
      }
      if (list.length > 1) {
        log(`  若平板上打不开第一个地址，页面设置里的二维码下方可以切换其它地址。`);
      }
    }).catch((err) => {
      // 探测出口地址失败只影响启动时那行提示，不影响服务本身
      log('局域网地址探测失败：', err.message);
    });
    const srcDesc = useHttp
      ? `手机 App（${String(config.phoneUrl).trim()}）— 无需 adb`
      : config.source === 'auto'
        ? 'auto（有 adb 设备则用 adb，否则用推送）'
        : config.source;
    log(`  数据源：${srcDesc}`);
    log('==================================================');

    if (config.source === 'mock') {
      log('');
      log('  **************************************************');
      log('  *  演示模式（mock）                               *');
      log('  *  当前播放的是内置的虚拟列表，不会读取你的手机。 *');
      log('  *  要显示手机上的歌，请关掉本窗口后用 start.bat。 *');
      log('  **************************************************');
      log('');
    }
  });

  const shutdown = () => {
    log('正在退出…');
    if (adbSource) adbSource.stop();
    if (mockSource) mockSource.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const COVER_CACHE = new Map();
// 内存缓存只活到进程退出，而封面在切歌前会反复被请求（桥接每秒一轮、
// 网页每次刷新）。落一份到磁盘后，同一首歌第二次起就是本地读。
const COVER_DISK_DIR = path.join(ROOT, '.cache', 'covers');

/**
 * 给外部集成（SMTC 桥接、BetterLyrics、状态灯之类的工具）用的精简状态。
 * 只给当前曲目和「此刻」的播放位置，不含体积很大的歌词数组——因为它会被高频轮询。
 * 位置由服务端按锚点外推到请求时刻，调用方不需要理解锚点机制。
 */
function nowPlayingPayload(hub) {
  const s = hub.snapshot();
  const t = s.track;

  if (!t || !t.title || s.status === 'idle' || s.status === 'error') {
    return { ok: true, active: false, playing: false, status: s.status, source: s.source };
  }

  const a = s.anchor;
  let positionMs = 0;
  if (a) positionMs = Math.max(0, a.position + (Date.now() - a.serverTime) * (a.speed || 0));

  let durationMs = t.duration || 0;
  if (!durationMs && s.lyrics && s.lyrics.length) {
    durationMs = s.lyrics[s.lyrics.length - 1].t + 12000;
  }
  if (durationMs && positionMs > durationMs) positionMs = durationMs;

  return {
    ok: true,
    active: true,
    playing: !!(a && a.speed > 0),
    status: s.status,
    source: s.source,
    title: t.title,
    artist: t.artist || '',
    album: t.album || '',
    songId: t.songId || 0,
    matched: !!t.matched,
    durationMs: Math.round(durationMs),
    positionMs: Math.round(positionMs),
    cover: t.cover || '',
  };
}

/**
 * 封面代理：让页面与封面同源，前端才能用 canvas 提取主色。
 * NetEase 图床不返回 CORS 头，直连会污染 canvas。
 */
async function proxyCover(rawUrl, res, coverSize = 1024) {
  let target;
  try {
    target = new URL(String(rawUrl || ''));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad url');
    return;
  }

  const allowed = /(^|\.)music\.126\.net$|(^|\.)126\.net$|(^|\.)music\.163\.com$/;
  if (target.protocol !== 'https:' || !allowed.test(target.hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden host');
    return;
  }

  // 手机推送过来的封面是图床原始地址，不带尺寸参数。部分专辑的原图极大
  // （实测一张 14,916,631 字节，下载耗时 77 秒），远超任何合理的超时窗口，
  // 外部表现就是「一直没有封面」。这里统一补尺寸参数，让图床直接返回适合
  // 屏幕显示的版本；URL 自带 param 的（网易云搜索结果）保持原样不动。
  if (!target.searchParams.has('param')) {
    const size = Number(coverSize) > 0 ? Math.min(Number(coverSize), 2048) : 1024;
    target.searchParams.set('param', `${size}y${size}`);
  }

  const key = target.toString();
  const send = (body, type) => {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  };

  const hit = COVER_CACHE.get(key);
  if (hit) {
    send(hit.body, hit.type);
    return;
  }

  const diskPath = path.join(COVER_DISK_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.img');
  try {
    const body = fs.readFileSync(diskPath);
    if (body.length > 1000) {
      let type = 'image/jpeg';
      try { type = fs.readFileSync(diskPath + '.type', 'utf8').trim() || type; } catch (e) { /* 沿用默认值 */ }
      COVER_CACHE.set(key, { body, type });
      send(body, type);
      return;
    }
  } catch (err) { /* 没有磁盘缓存，继续回源 */ }

  let upstream;
  let buf;
  try {
    upstream = await fetch(key, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(45000),
    });
    if (!upstream.ok) {
      // 必须把 body 消费/取消掉：留着不读的话，超时到点后的 abort 会在
      // undici 内部留下一条没有监听者的拒绝，Node 22 会把它升级成进程退出。
      try { await upstream.body?.cancel(); } catch (e) { /* 忽略 */ }
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('upstream ' + upstream.status);
      return;
    }
    buf = Buffer.from(await upstream.arrayBuffer());
  } catch (err) {
    res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' }).end('cover timeout: ' + err.message);
    return;
  }
  const type = upstream.headers.get('content-type') || 'image/jpeg';

  if (COVER_CACHE.size > 60) COVER_CACHE.delete(COVER_CACHE.keys().next().value);
  COVER_CACHE.set(key, { body: buf, type });

  // 写盘失败不影响本次响应，只是下次还得回源。
  try {
    fs.mkdirSync(COVER_DISK_DIR, { recursive: true });
    fs.writeFileSync(diskPath, buf);
    fs.writeFileSync(diskPath + '.type', type, 'utf8');
  } catch (err) { /* 忽略 */ }

  send(buf, type);
}

function normalizePush(payload) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const playingRaw = payload.playing;
  const playing = playingRaw === undefined || playingRaw === '' ? true : !/^(false|0|no|paused)$/i.test(String(playingRaw));
  return {
    title: payload.title || payload.name || '',
    artist: payload.artist || payload.artists || '',
    album: payload.album || '',
    duration: num(payload.duration),
    position: num(payload.position),
    speed: payload.speed ? num(payload.speed) : playing ? 1 : 0,
    // 这条 position 是多少毫秒之前采到的（推送端算好的）。播放器的媒体会话
    // 进度不是实时刷新的，电脑端读到的值可能已经旧了近一秒 —— 服务端必须
    // 用它把锚点时间戳往回调，否则歌词会稳定地慢一拍。
    positionAgeMs: Math.max(0, Math.min(10000, num(payload.positionAgeMs))),
    playing,
    cover: payload.cover || payload.coverUrl || '',
    songId: num(payload.songId || payload.id),
    package: payload.package || 'push',
  };
}

function redactConfig(config) {
  return {
    port: config.port,
    host: config.host,
    source: config.source,
    pollIntervalMs: config.pollIntervalMs,
    requirePackage: config.requirePackage,
    translationEnabled: config.translationEnabled,
    coverSize: config.coverSize,
    adbPath: config.adbPath || '',
    adbSerial: config.adbSerial || '',
    adbAutoConnect: config.adbAutoConnect || '',
  };
}

main();
