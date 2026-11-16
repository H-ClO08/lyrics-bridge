'use strict';

/**
 * 「在页面上切歌」的执行端。
 *
 * 只对本机（Windows）正在播放的那个媒体会话生效 —— 也就是电脑当音源时
 * 页面显示的那一首。手机当音源时控制不到（那是另一台设备上的会话），
 * 这种情况 server 会直接拒绝，页面把按钮置灰。
 *
 * 底层是 smtc/smtc-control.ps1（SMTC 的 TrySkipNext 等），每次动作起一个
 * PowerShell 进程，600ms 左右，够快，也不用常驻。
 *
 * 那个脚本是纯 ASCII 的，错误以 code 形式返回，面向用户的中文文案在这里映射。
 */

const { execFile } = require('child_process');
const path = require('path');
const { run: runAdb } = require('./adb');

const SCRIPT = path.resolve(__dirname, '..', 'smtc', 'smtc-control.ps1');
const ACTIONS = new Set(['next', 'prev', 'toggle', 'play', 'pause']);

// Android 的媒体键：87 下一首 / 88 上一首 / 85 播放暂停 / 126 播放 / 127 暂停
const KEYCODE = { next: 87, prev: 88, toggle: 85, play: 126, pause: 127 };

const CODE_TEXT = {
  'no-manager': '读取不到 Windows 媒体会话（系统版本太旧？）',
  'no-session': '这台电脑上没有正在播放的媒体',
  'not-supported': '当前播放器不支持这个操作（网页视频通常不能切歌）',
  exception: '播放器拒绝了这次操作',
};

// 手机 App 那边返回的 ASCII 错误码
const PHONE_CODE_TEXT = {
  'no-listener': '手机上的「通知使用权」没开',
  'no-session': '手机上当前没有媒体会话',
  'no-manager': '手机系统拒绝了会话访问',
  'bad-action': '不支持的操作',
  exception: '手机端执行失败',
  'no-listener-instance': '手机 App 的通知监听服务没连上',
};

function runControl(action) {
  const act = String(action || '').toLowerCase();
  if (!ACTIONS.has(act)) {
    return Promise.resolve({ ok: false, action: act, error: '不支持的操作：' + action });
  }

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Action', act],
      { timeout: 8000, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
        const text = out.trim().split(/\r?\n/).pop() || '';
        if (text) {
          try {
            const data = JSON.parse(text);
            if (data && data.ok) return resolve(data);
            const code = String((data && data.code) || '');
            const detail = (data && data.error) || '';
            return resolve({
              ok: false,
              action: act,
              session: data && data.session,
              code,
              error: CODE_TEXT[code] || detail || '操作没有生效',
            });
          } catch (e) { /* 落到下面的兜底 */ }
        }
        const errText = (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '').trim();
        resolve({
          ok: false,
          action: act,
          error: err ? `控制脚本执行失败：${errText.split(/\r?\n/).slice(-1)[0] || err.message}` : errText || '控制脚本没有返回结果',
        });
      }
    );
  });
}

/**
 * 手机 App 当音源：把指令 POST 给手机自己的 HTTP 服务（v1.4+ 才有 /api/control）。
 * 手机 App 用通知使用权拿到的 MediaController 去 skipToNext / play / pause。
 */
async function phoneControl(phoneUrl, action) {
  const act = String(action || '').toLowerCase();
  if (!ACTIONS.has(act)) return { ok: false, action: act, error: '不支持的操作：' + action };

  const base = String(phoneUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, action: act, error: '没有配置手机地址（config.json 的 phoneUrl）' };

  try {
    const res = await fetch(base + '/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: act }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 404) {
      return { ok: false, action: act, error: '手机 App 版本太旧，还不支持控制（需要 v1.4 以上）' };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (data && data.ok) return { ok: true, action: act, via: 'phone' };
    const code = data && data.code;
    return {
      ok: false,
      action: act,
      via: 'phone',
      code: code || '',
      error: PHONE_CODE_TEXT[code] || (data && data.error) || '手机没有响应这次操作',
    };
  } catch (err) {
    return { ok: false, action: act, error: '连不上手机 App：' + err.message };
  }
}

/**
 * adb 当音源：直接往手机注入媒体键（不需要 App 支持）。
 * KEYCODE_MEDIA_NEXT=87 / PREVIOUS=88 / PLAY_PAUSE=85 —— 系统会把它路由给当前
 * 活跃的媒体会话，所以网易云会响应；代价是「有没有真的执行」无法确认。
 */
async function adbControl(source, action) {
  const act = String(action || '').toLowerCase();
  const key = KEYCODE[act];
  if (!key) return { ok: false, action: act, error: '不支持的操作：' + action };
  if (!source) return { ok: false, action: act, error: 'adb 数据源没有启动' };

  const args = [];
  if (source.serial) args.push('-s', source.serial);
  args.push('shell', 'input', 'keyevent', String(key));

  const res = await runAdb(source.adb, args, 8000);
  if (res.ok) return { ok: true, action: act, via: 'adb' };
  const detail = (res.error || res.stderr || '').trim().split(/\r?\n/).pop();
  return { ok: false, action: act, error: '按键注入失败：' + (detail || '未知原因') };
}

module.exports = { runControl, phoneControl, adbControl, ACTIONS, CODE_TEXT, PHONE_CODE_TEXT };
