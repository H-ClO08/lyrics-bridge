#!/usr/bin/env node
'use strict';

/**
 * 电脑播放 -> 服务端推送
 * ------------------------------------------------------------------
 * 定期读取本机 Windows 媒体会话（SMTC），把「电脑正在播放的歌」推给
 * ncm-nowplaying 服务端的 /api/push，这样平板浏览器打开服务端页面时
 * 就能显示电脑上播放的音乐（不局限于网易云，任何会注册 SMTC 的播放器
 * 都行）。
 *
 *   node tools/smtc-push.js [服务端地址] [间隔毫秒]
 *
 * 默认推送到 http://127.0.0.1:8787，每 1500ms 一次。
 * 电脑停止播放时会补推一次「暂停」状态，好让手机源能及时接管。
 *
 * 推送体里带 positionAgeMs：这条 position 是多少毫秒之前采到的。
 * 播放器（尤其是网易云 PC 版）不是每毫秒都刷新媒体会话进度，直接读到的值
 * 最多会旧一秒，把旧值当成「此刻的进度」就是歌词偏慢的根因。服务端拿这个
 * 字段把锚点时间戳往回调，进度就对齐了。详见 smtc/read-smtc-json.ps1。
 */

const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'smtc', 'read-smtc-json.ps1');

const SERVER = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const INTERVAL = Math.max(1000, Number(process.argv[3] || 1500));

function readSmtc() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { timeout: 15000, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const text = stdout.toString('utf8').replace(/^\uFEFF/, '').trim();
          resolve(JSON.parse(text));
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

async function push(body) {
  try {
    await fetch(`${SERVER}/api/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    return true;
  } catch (e) {
    return false;
  }
}

let lastTitle = '';
let lastArtist = '';
let lastSentKey = '';
let failStreak = 0;

async function tick() {
  const st = await readSmtc();

  if (st && st.active && st.title) {
    lastTitle = st.title;
    lastArtist = st.artist;
    // read-smtc-json.ps1 已经把「播放器多久没刷新进度」补进 position 了，
    // 这里再补上「采样完到发出」的这一小段（几十毫秒），服务端才能把锚点
    // 的时间戳往回调，而不是把旧进度当成此刻的进度。
    const at = Number(st.at) || 0;
    const ageMs = at ? Math.max(0, Math.min(5000, Date.now() - at)) : 0;
    const body = {
      title: st.title,
      artist: st.artist,
      album: st.album,
      duration: st.duration || 0,
      position: st.position || 0,
      positionAgeMs: ageMs,
      playing: !!st.playing,
    };
    const ok = await push(body);
    if (ok) {
      if (failStreak) console.log(`[重连成功] ${st.title} - ${st.artist}`);
      failStreak = 0;
      const key = `${st.title}|${st.artist}|${st.playing}`;
      if (key !== lastSentKey) {
        lastSentKey = key;
        console.log(`[推送] ${st.title} - ${st.artist}  ${st.playing ? '▶' : '⏸'}  ${Math.round(st.position / 1000)}s/${Math.round(st.duration / 1000)}s  (样本年龄 ${st.positionAgeMs || 0}ms)`);
      }
    } else {
      failStreak++;
      if (failStreak === 1 || failStreak % 10 === 0) console.log(`[失败] 无法连接 ${SERVER}（${failStreak} 次）`);
    }
  } else if (lastTitle) {
    // 电脑停止播放：补推一次暂停，释放 push 源让手机能接管
    await push({ title: lastTitle, artist: lastArtist, playing: false, position: 0, duration: 0 });
    console.log(`[停止] ${lastTitle} - ${lastArtist} 已暂停`);
    lastTitle = '';
    lastArtist = '';
    lastSentKey = '';
  }
}

console.log('==================================================');
console.log('  电脑 SMTC -> 服务端推送');
console.log(`  目标  : ${SERVER}`);
console.log(`  间隔  : ${INTERVAL}ms`);
console.log('  按 Ctrl+C 停止');
console.log('==================================================');

// 自己排队而不是 setInterval：读取一次要跑一个 PowerShell（约 0.6-0.9 秒），
// 用定时器会重叠成两个进程、推送还可能乱序到达。串行 + 固定周期既稳，
// 实际每秒推送次数也更高。
async function loop() {
  const t0 = Date.now();
  try {
    await tick();
  } catch (err) {
    console.log('[异常] ' + err.message);
  }
  const wait = Math.max(300, INTERVAL - (Date.now() - t0));
  setTimeout(loop, wait);
}

loop();
