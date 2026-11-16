'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLAYBACK_STATE_NAMES = {
  0: 'none',
  1: 'stopped',
  2: 'paused',
  3: 'playing',
  4: 'fast_forwarding',
  5: 'rewinding',
  6: 'buffering',
  7: 'error',
  8: 'connecting',
  9: 'skipping_previous',
  10: 'skipping_next',
  11: 'skipping_queue_item',
};

const PLAYING_STATES = new Set([3, 4, 5]);
const ACTIVE_STATES = new Set([2, 3, 4, 5, 6, 8, 9, 10, 11]);

/** adb 在 Windows 上偶发把 UTF-8 当 Latin-1 透传，这里做一次修复 */
function repairEncoding(text) {
  if (!text) return text;
  if (!/[\u00c2\u00c3\u00e5\u00e6\u00e8]/.test(text)) return text;
  try {
    const fixed = Buffer.from(text, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? text : fixed;
  } catch (err) {
    return text;
  }
}

// ---------------------------------------------------------------------------
// dumpsys 解析
// ---------------------------------------------------------------------------

/**
 * 解析 `dumpsys media_session` 输出。
 * 不依赖缩进层级（各厂商 ROM 会改），而是「就近归属」：
 * package / state / metadata 三类行按出现顺序各自记录，metadata 归给最近的上一个 state。
 */
function parseMediaSessions(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const sessions = [];
  let current = null;

  const startSession = (name, userId) => {
    current = {
      name,
      userId,
      package: '',
      state: null,
      stateCode: 0,
      position: 0,
      speed: 0,
      updated: 0,
      metadataRaw: '',
      values: [],
    };
    sessions.push(current);
  };

  const NONE_SESSION_PREFIXES = [
    'Media button session',
    'Media key listener',
    'Volume key long-press listener',
    'Global priority session',
    'Last MediaButtonReceiver',
    'Restored MediaButtonReceiver',
  ];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (NONE_SESSION_PREFIXES.some((p) => trimmed.startsWith(p))) continue;

    // 会话头：以 (userId=N) 结尾的行
    const header = trimmed.match(/^(.*)\(userId=(\d+)\)\s*$/);
    if (header && !trimmed.startsWith('package=')) {
      startSession(header[1].trim(), Number(header[2]));
      continue;
    }

    if (!current) continue;

    const pkg = trimmed.match(/^package=(.+)$/);
    if (pkg) {
      current.package = pkg[1].trim();
      continue;
    }

    if (trimmed.startsWith('state=PlaybackState')) {
      const body = trimmed;
      const stateMatch = body.match(/\{state=(?:[A-Z_]+\s*\((\d+)\)|(\d+))/);
      const stateCode = stateMatch ? Number(stateMatch[1] || stateMatch[2]) : 0;
      const posMatch = body.match(/\{state=[^,]+,\s*position=(-?\d+)/);
      const speedMatch = body.match(/speed=(-?[\d.]+)/);
      const updatedMatch = body.match(/updated=(\d+)/);

      current.stateCode = stateCode;
      current.state = PLAYBACK_STATE_NAMES[stateCode] || String(stateCode);
      current.position = posMatch ? Number(posMatch[1]) : 0;
      current.speed = speedMatch ? Number(speedMatch[1]) : 0;
      current.updated = updatedMatch ? Number(updatedMatch[1]) : 0;
      continue;
    }

    if (trimmed.startsWith('metadata:')) {
      current.metadataRaw = trimmed;
      current.values = extractMetadataValues(trimmed);
      continue;
    }
  }

  return sessions.filter((s) => s.package || s.metadataRaw);
}

/**
 * 从 `metadata: size=5, description=A, B, C, null` 中提取候选字符串。
 * 注意：Bundle 的迭代顺序不保证，所以值的位置没有语义，交给匹配器打分。
 */
function extractMetadataValues(line) {
  let body = line.replace(/^metadata:\s*/, '');
  body = body.replace(/(^|,\s*)size=\d+/g, '');
  body = body.replace(/^,\s*/, '');
  if (body.startsWith('description=')) body = body.slice('description='.length);

  return body
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'null' && s !== '""' && s !== '[]' && s !== '{}');
}

/** 从候选字符串里猜时长（dumpsys 有时会把 duration 一起打出来） */
function guessDuration(values) {
  for (const v of values) {
    if (/^\d{5,8}$/.test(v)) {
      const n = Number(v);
      if (n >= 20000 && n <= 3 * 3600 * 1000) return n;
    }
  }
  return 0;
}

function pickSession(sessions, requirePackage) {
  if (!sessions.length) return { session: null, reason: 'no-session' };

  const needle = (requirePackage || '').toLowerCase();
  const preferred = needle
    ? sessions.filter((s) => s.package.toLowerCase().includes(needle) && s.metadataRaw)
    : [];
  const pool = preferred.length ? preferred : needle ? sessions.filter((s) => s.metadataRaw) : sessions;

  if (!pool.length) {
    return { session: null, reason: 'no-metadata', sessions };
  }

  const rank = (s) => {
    let r = 0;
    if (PLAYING_STATES.has(s.stateCode)) r += 100;
    else if (ACTIVE_STATES.has(s.stateCode)) r += 40;
    if (s.metadataRaw) r += 20;
    if (needle && s.package.toLowerCase().includes(needle)) r += 30;
    return r;
  };

  const sorted = pool.slice().sort((a, b) => rank(b) - rank(a));
  const winner = sorted[0];

  if (!winner.metadataRaw) return { session: null, reason: 'no-metadata', sessions };
  if (needle && !winner.package.toLowerCase().includes(needle)) {
    return { session: winner, reason: 'package-mismatch', sessions };
  }
  return { session: winner, reason: 'ok', sessions };
}

// ---------------------------------------------------------------------------
// adb 进程封装
// ---------------------------------------------------------------------------

function findAdb(config = {}) {
  const candidates = [];
  if (config.adbPath) candidates.push(config.adbPath);

  const projectRoot = path.resolve(__dirname, '..');
  candidates.push(path.join(projectRoot, 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  candidates.push(path.join(projectRoot, 'tools', 'adb.exe'));

  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // 交给 PATH 解析
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function run(cmd, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const out = repairEncoding(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || ''));
        const errOut = repairEncoding(Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || ''));
        resolve({
          ok: !err,
          error: err ? err.message : '',
          stdout: out,
          stderr: errOut,
          latencyMs: Date.now() - startedAt,
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// 采集源
// ---------------------------------------------------------------------------

class AdbSource extends require('events').EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log || (() => {});
    this.adb = findAdb(config);
    this.serial = config.adbSerial || '';
    this.running = false;
    this._timer = null;
    this._anchor = null;
    this._lastRaw = '';
    this._failStreak = 0;
    // 自动重连的退避状态。无线调试端口是临时的，手机重启/换网后
    // config 里存的地址几乎必然失效，必须限速重试（否则每轮都要等一次
    // 8 秒超时的 connect，把轮询节奏拖垮、终端也刷屏）。
    this._reconnectFails = 0;
    this._nextConnectAt = 0;
    this.status = { available: false, connected: false, error: '', adbPath: this.adb, devices: [] };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
  }

  async _loop() {
    if (!this.running) return;
    try {
      await this._tick();
    } catch (err) {
      this.log('adb 轮询异常:', err.message);
    }
    if (!this.running) return;
    // 地板值 2000ms：dumpsys media_session 是系统级 dump，对低端机不算轻。
    // 即便配置里写得更小（比如 500），也不允许对真机以高于每 2 秒一次的频率打。
    // 歌词同步靠的是锚点外推，不是轮询频率，所以慢一点完全不影响体验。
    this._timer = setTimeout(() => this._loop(), Math.max(2000, this.config.pollIntervalMs || 5000));
    this._timer.unref?.();
  }

  async devices() {
    const res = await run(this.adb, ['devices', '-l'], 5000);
    if (!res.ok) {
      this.status.available = false;
      this.status.error = res.error || res.stderr || 'adb 调用失败';
      return [];
    }
    this.status.available = true;
    const list = res.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1] || '', detail: l };
      })
      .filter((d) => d.serial && d.state !== 'offline');
    this.status.devices = list;
    return list;
  }

  async _ensureDevice() {
    const list = await this.devices();
    let online = list.filter((d) => d.state === 'device');

    if (!online.length && this.config.adbAutoConnect) {
      online = await this._tryAutoConnect();
    }

    if (!online.length) {
      this.status.connected = false;
      this.status.error = list.length ? '设备未授权或离线，请在手机上确认 USB/无线调试授权' : '未发现任何 adb 设备';
      return null;
    }

    this._reconnectFails = 0;
    this._nextConnectAt = 0;
    if (!this.serial || !online.some((d) => d.serial === this.serial)) {
      this.serial = online[0].serial;
    }
    this.status.connected = true;
    this.status.error = '';
    return this.serial;
  }

  /**
   * 自动重连，带指数退避。
   *
   * 无线调试的端口是每次开启时随机分配的，手机重启或换 Wi-Fi 之后，
   * config.json 里存的地址几乎必然失效。如果每一轮轮询都重试，就会变成
   * 「每 5 秒发起一次 8 秒超时的 connect」，既把轮询节奏彻底拖垮，
   * 终端也会被刷屏 —— 用户看到的就是「它一直在重连手机」。
   *
   * 所以这里限速：失败后按 5s → 10s → 20s → 40s → 80s → 120s 递增，
   * 且只在连续失败到第 5 次时提示一遍，之后安静等待。
   */
  async _tryAutoConnect() {
    if (Date.now() < this._nextConnectAt) return [];

    const target = String(this.config.adbAutoConnect).trim();
    if (this._reconnectFails === 0) this.log('尝试自动连接设备', target);

    await run(this.adb, ['connect', target], 8000);
    const list = await this.devices();
    const online = list.filter((d) => d.state === 'device');

    if (online.length) {
      this._reconnectFails = 0;
      this._nextConnectAt = 0;
      this.log('已自动连接设备', online[0].serial);
      return online;
    }

    this._reconnectFails += 1;
    const backoff = Math.min(120000, 5000 * Math.pow(2, Math.min(this._reconnectFails - 1, 5)));
    this._nextConnectAt = Date.now() + backoff;

    if (this._reconnectFails === 5) {
      this.log(`自动连接 ${target} 已连续失败 5 次，之后每 ${Math.round(backoff / 1000)} 秒才重试一次。`);
      this.log('  常见原因：手机 IP 变了，或无线调试被关掉了。重新运行 setup-adb.bat 可重新配对。');
      this.log('  若你已改用手机 App 或电脑推送，把 config.json 的 "source" 改为 "push" 即可彻底停掉 adb。');
    }
    return [];
  }

  async _tick() {
    const serial = await this._ensureDevice();
    if (!serial) {
      this._emitEmpty('device');
      return;
    }

    // 一条命令同时拿「当前开机毫秒数」和 dumpsys，避免两次 adb 往返。
    // 用手机自己的 elapsedRealtime 做外推基准，才能消除轮询间隔带来的滞后
    //（系统媒体小组件正是这么干的，所以它能跟得比我们准）。
    const res = await run(
      this.adb,
      ['-s', serial, 'shell', 'dumpsys media_session; echo __NCM_UPTIME__; cat /proc/uptime'],
      8000
    );
    if (!res.ok) {
      this._failStreak += 1;
      // 无线调试掉线时连接会失效。这里只清掉 serial，让下一轮 _ensureDevice
      // 走带退避的自动重连 —— 不在这里直接 connect，是为了避免
      // 「每轮都发一次 8 秒超时的 connect」把轮询节奏拖垮。
      if (/device offline|device not found|no devices|closed/i.test(res.error + res.stderr)) {
        this.status.connected = false;
        this.serial = '';
      }
      this._emitEmpty('adb-error', res.error || res.stderr);
      return;
    }
    this._failStreak = 0;

    const parts = String(res.stdout).split('__NCM_UPTIME__');
    const dumpOut = parts[0] || res.stdout;
    let elapsedNow = 0;
    if (parts[1]) {
      const uptimeMatch = parts[1].match(/([\d.]+)\s/);
      if (uptimeMatch) elapsedNow = Math.round(parseFloat(uptimeMatch[1]) * 1000);
    }
    this._lastRaw = dumpOut;

    const sessions = parseMediaSessions(dumpOut);
    const picked = pickSession(sessions, this.config.requirePackage);

    this.status.available = true;
    this.status.connected = true;
    this.status.error = '';
    this.status.sessionCount = sessions.length;
    this.status.sessions = sessions.map((s) => ({
      package: s.package,
      state: s.state,
      values: s.values,
    }));

    if (!picked.session) {
      this._anchor = null;
      this.emit('track', {
        kind: 'idle',
        reason: picked.reason,
        sessions,
        at: Date.now(),
      });
      return;
    }

    const s = picked.session;
    const signature = [...s.values].sort().join('\u0001');
    const prev = this._prevSignature;
    const changed = signature !== prev;
    this._prevSignature = signature;

    const speed = PLAYING_STATES.has(s.stateCode) ? (s.speed > 0 ? s.speed : 1) : 0;
    const latency = Math.min(600, res.latencyMs / 2);

    const anchorMoved =
      !this._anchor ||
      this._anchor.updated !== s.updated ||
      this._anchor.rawPosition !== s.position ||
      this._anchor.stateCode !== s.stateCode;

    if (anchorMoved) {
      // 用手机 elapsedRealtime 精确外推：网易云在 `updated`（毫秒）时刻把进度设为
      // position，之后它以 speed 持续播放。到现在（elapsedNow）已过去
      // (elapsedNow - updated) 毫秒，真实位置 = position + 该时长 × speed。
      // 这样锚点就不依赖「服务端哪一刻采到数据」，彻底消除轮询滞后。
      let position = s.position;
      if (speed > 0) {
        if (s.updated > 0 && elapsedNow > s.updated) {
          position = s.position + (elapsedNow - s.updated) * speed;
        } else {
          // updated 缺失时退化：仍用 adb 往返半程做近似补偿
          position = s.position + latency * speed;
        }
      }
      this._anchor = {
        position,
        serverTime: Date.now(),
        speed,
        updated: s.updated,
        rawPosition: s.position,
        stateCode: s.stateCode,
      };
    } else {
      this._anchor = { ...this._anchor, speed };
    }

    const duration = guessDuration(s.values);

    this.emit('track', {
      kind: 'track',
      changed,
      package: s.package,
      values: s.values,
      duration,
      playing: PLAYING_STATES.has(s.stateCode),
      stateName: s.state,
      stateCode: s.stateCode,
      anchor: this._anchor,
      latencyMs: res.latencyMs,
      at: Date.now(),
    });
  }

  _emitEmpty(reason, error) {
    this._anchor = null;
    this._prevSignature = '';
    this.emit('track', { kind: 'idle', reason, error: error || '', at: Date.now() });
  }

  get lastRaw() {
    return this._lastRaw;
  }

  rawDump() {
    return this._lastRaw;
  }
}

module.exports = {
  AdbSource,
  findAdb,
  parseMediaSessions,
  extractMetadataValues,
  guessDuration,
  pickSession,
  run,
  PLAYBACK_STATE_NAMES,
};
