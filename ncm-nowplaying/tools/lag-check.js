#!/usr/bin/env node
'use strict';

/**
 * 端到端对表：服务端推算出的播放进度，和播放器真实进度差多少毫秒。
 *
 *   node tools/lag-check.js [服务地址] [时长秒]
 *   node tools/lag-check.js http://127.0.0.1:8787 15
 *
 * 为什么要它
 * --------
 * 「歌词比声音慢」这种问题，靠肉眼只能感觉到「慢一点」，说不清是 100ms 还是
 * 2 秒，也分不清是数据源的问题还是页面渲染的问题。这个工具用两个独立采样：
 *
 *   1. 服务端 /api/state 里 anchor 推出来的进度（页面用的就是它）
 *   2. Windows 媒体会话里 Position + 采样年龄，也就是播放器时间轴的真值
 *      （tools/smtc-lag.js 已经验证过它和墙上时钟同速）
 *
 * 两边对齐到同一时刻相减，就得到误差的中位数和最坏值。
 *
 * 注意：真值来自本机 SMTC，所以只有当「电脑在放歌」、且服务端数据源确实是
 * push/adb（也就是进度代表电脑这一侧）时才有意义。若数据源是手机，本工具会
 * 提示你它不适用。
 */

const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'smtc', 'measure-lag.ps1');

const SERVER = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SECONDS = Math.max(4, Number(process.argv[3] || 15));
const DURATION_MS = SECONDS * 1000;

function sampleTruth() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Samples', String(Math.round(DURATION_MS / 250)), '-IntervalMs', '250'],
      { timeout: DURATION_MS + 25000, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const out = (stdout || Buffer.alloc(0)).toString('utf8');
        resolve(
          out
            .split(/\r?\n/)
            .filter((l) => /^\d+,/.test(l.trim()))
            .map((l) => {
              const [t, pos, dur, age, status] = l.trim().split(',');
              const ageMs = Math.max(0, Number(age));
              return { t: Number(t), pos: Number(pos), posAgeMs: Number(age), status, truth: Number(pos) + ageMs };
            })
        );
      }
    );
  });
}

async function grab() {
  const t = Date.now();
  try {
    const res = await fetch(SERVER + '/api/state', { signal: AbortSignal.timeout(3000) });
    const j = await res.json();
    const a = j.anchor;
    if (!a || !j.track) return { t, empty: true, status: j.status, source: j.source };
    return {
      t,
      source: j.source,
      title: j.track.title,
      anchorAgeMs: a.ageMs || 0,
      anchorBehindMs: t - a.serverTime,
      derived: a.position + (t - a.serverTime) * (a.speed || 0),
    };
  } catch (err) {
    return { t, error: err.message };
  }
}

(async () => {
  const truthP = sampleTruth();
  const samples = [];
  const end = Date.now() + DURATION_MS;
  while (Date.now() < end) {
    samples.push(await grab());
    await new Promise((r) => setTimeout(r, 250));
  }
  const truth = await truthP;

  if (!truth.length) {
    console.log('没采到 SMTC 真值：这台电脑当前没有正在播放的媒体会话。');
    console.log('（如果歌是在手机上放的，本工具不适用 —— 真值就是电脑的时间轴。）');
    return;
  }

  const alive = samples.filter((s) => s && !s.empty && !s.error && s.derived !== undefined);
  if (!alive.length) {
    console.log('服务端 /api/state 没有可用锚点：');
    console.log('  ' + JSON.stringify(samples[samples.length - 1] || {}));
    return;
  }

  const source = alive[0].source;
  const ages = truth.filter((r) => r.status === 'Playing').map((r) => r.posAgeMs).filter((a) => a > 0);
  const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 0;
  const maxAge = ages.length ? Math.max(...ages) : 0;

  console.log('');
  console.log(`服务地址   : ${SERVER}`);
  console.log(`曲目       : ${alive[0].title}   (source=${source})`);
  console.log(`采样       : 真值 ${truth.length} 点 / 服务端 ${alive.length} 点，跨度约 ${Math.round((truth[truth.length - 1].t - truth[0].t) / 1000)}s`);
  console.log('');
  console.log(`播放器进度自己有多旧 : 平均 ${Math.round(avgAge)}ms，最坏 ${Math.round(maxAge)}ms`);
  console.log('  （0ms 表示这个播放器每毫秒都在更新；这就是「直接把读到的值当成现在」的偏差上限）');
  console.log('');

  if (source !== 'push' && source !== 'adb') {
    console.log(`提示：当前数据源是 ${source}，进度代表的是手机那一侧，`);
    console.log('      而本工具的真值来自本机 SMTC —— 两者的数字不该相等，下面的误差没有意义。');
    console.log('');
  }

  // 时间轴是不是按 1:1 走？倍速播放（视频 1.5x/2x、直播）会让两边都错，
  // 而错法不同 —— 曾经因此得到过一个假的「慢 4.4 秒」结论。
  const played = truth.filter((r) => r.status === 'Playing');
  const rate = played.length > 1
    ? (played[played.length - 1].truth - played[0].truth) / (played[played.length - 1].t - played[0].t)
    : 0;

  if (!played.length) {
    console.log('播放器现在是暂停/停止状态，没有可比的真实进度。');
    console.log('让它继续播放，再跑一次。');
    return;
  }
  if (Math.abs(rate - 1) > 0.15) {
    console.log(`这份时间轴大约以 ${rate.toFixed(2)}x 前进，不是 1.00x。`);
    console.log('（倍速播放，或者视频/直播这类非线性进度。）');
    console.log('本工具与服务端的进度补偿都按 1x 假设，此时两边的误差不能按字面理解，');
    console.log('所以这里不下「准 / 不准」的结论。放一首 1x 的歌再测。');
    return;
  }

  function truthAt(t) {
    let best = null;
    let bestD = Infinity;
    for (const r of truth) {
      const d = Math.abs(r.t - t);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (!best || bestD > 500) return null;
    return best.truth + (t - best.t);
  }

  const errs = [];
  for (const s of alive) {
    const tr = truthAt(s.t);
    if (tr === null) continue;
    errs.push({ t: s.t, err: s.derived - tr, anchorAgeMs: s.anchorAgeMs, anchorBehindMs: s.anchorBehindMs });
  }
  if (!errs.length) {
    console.log('两边时间戳没有对得上（采样错开了），换个时长再试。');
    return;
  }

  const sorted = errs.map((e) => e.err).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const behind = Math.abs(Math.round(sorted[0]));
  const ahead = Math.round(sorted[sorted.length - 1]);
  const avgAnchorBehind = errs.reduce((a, e) => a + e.anchorBehindMs, 0) / errs.length;

  console.log('结果');
  console.log('='.repeat(60));
  console.log(`页面进度 − 真实进度 : 中位数 ${Math.round(median)}ms   平均 ${Math.round(mean)}ms`);
  console.log(`                     最多偏慢 ${behind}ms   最多偏快 ${ahead}ms`);
  console.log(`最新锚点距今        : ${Math.round(avgAnchorBehind)}ms（推送间隔的体现，不是误差）`);
  console.log('');
  if (Math.abs(median) <= 120) {
    console.log('=> 对得很准（±120ms 以内），歌词和人声应该听着是同步的。');
  } else if (median < 0) {
    console.log(`=> 稳定偏慢约 ${Math.abs(Math.round(median))}ms。`);
    console.log('   若数据源是 push/adb：播放器刷新媒体会话进度的间隔就是这个量级，');
    console.log('   检查推送端是否上报了 positionAgeMs（见 tools/smtc-push.js）。');
    console.log('   若数据源是手机：检查两台设备对时（/api/state 的 anchor.serverTime 是本机时钟）。');
    console.log('   也可以先用页面上的「时间轴偏移」临时补偿。');
  } else {
    console.log(`=> 偏快约 ${Math.round(median)}ms，通常是重复补偿了一次采样年龄。`);
  }
})();
