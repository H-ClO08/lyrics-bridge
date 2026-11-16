#!/usr/bin/env node
'use strict';

/**
 * 测量「电脑播放 -> 歌词显示」这一段到底慢了多少毫秒。
 *
 *   node tools/smtc-lag.js [采样数] [间隔毫秒]
 *
 * 背景
 * ----
 * 播放器不会每毫秒都往 Windows 媒体会话（SMTC）里写一次进度，网易云 PC 版
 * 大约每 1 秒才发布一份新的 MediaTimelineProperties，两次发布之间 Position
 * 是冻住的。所以直接读 Position 拿到的值最多会旧 1 秒 —— 这正是「电脑当数据源
 * 时歌词稳定慢 1s」的来源。
 *
 * 时间轴本身带 LastUpdatedTime（这份进度是什么时候写的），于是：
 *
 *     真实进度 ≈ Position + (现在 - LastUpdatedTime)
 *
 * 本工具连续采样，把「原始 Position」和「修正后进度」并排打出来，就能直观看到：
 *   - 原始值是一条 1 秒一跳的阶梯（所以平均慢 0.5s、最坏慢 1s）
 *   - 修正值是连续的，和墙上时钟同速
 */

const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'smtc', 'measure-lag.ps1');

const SAMPLES = Math.max(4, Number(process.argv[2] || 24));
const INTERVAL = Math.max(50, Number(process.argv[3] || 250));

function run() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Samples', String(SAMPLES), '-IntervalMs', String(INTERVAL)],
      { timeout: 60000, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
        resolve({ err, out, errText: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '') });
      }
    );
  });
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s = ' ' + s;
  return s;
}

(async () => {
  const { err, out, errText } = await run();
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.find((l) => l.startsWith('#')) || '';
  const rows = lines
    .filter((l) => /^\d+,/.test(l))
    .map((l) => {
      const [t, pos, dur, age, status] = l.split(',');
      return { t: Number(t), pos: Number(pos), dur: Number(dur), age: Number(age), status };
    });

  if (errText.trim()) console.error('[stderr]\n' + errText.trim());

  if (!rows.length) {
    console.log('没有采到样本。');
    console.log(header || '(未找到正在播放的会话)');
    if (err) console.error('[失败] ' + err.message);
    process.exit(err ? 1 : 0);
  }

  console.log('');
  console.log(header);
  console.log('='.repeat(86));
  console.log('    墙钟(ms)   原始Pos   修正Pos   原始-修正   LastUpdAge   原始跳变   状态');
  console.log('-'.repeat(86));

  const t0 = rows[0].t;
  let prevRaw = null;
  let rawSteps = 0;
  const ages = [];
  let first = null;
  let last = null;

  for (const r of rows) {
    const corrected = r.pos >= 0 && r.age >= 0 ? r.pos + r.age : -1;
    const diff = corrected >= 0 ? r.pos - corrected : 0;
    const jump = prevRaw === null ? '' : (r.pos !== prevRaw ? String(r.pos - prevRaw) : '·');
    if (prevRaw !== null && r.pos !== prevRaw) rawSteps++;
    prevRaw = r.pos;
    if (r.pos >= 0) { first = first || r; last = r; }
    ages.push(r.age);
    console.log(
      pad(r.t - t0, 11) +
      pad(r.pos, 10) +
      pad(corrected, 10) +
      pad(r.pos >= 0 && corrected >= 0 ? diff : '', 11) +
      pad(r.age, 12) +
      pad(jump, 11) +
      '   ' + r.status
    );
  }

  const elapsed = last.t - first.t;
  const rawAdvance = last.pos - first.pos;
  const corrAdvance = (last.pos + last.age) - (first.pos + first.age);
  const validAges = ages.filter((a) => a >= 0);
  const maxAge = validAges.length ? Math.max(...validAges) : 0;
  const avgAge = validAges.length ? validAges.reduce((a, b) => a + b, 0) / validAges.length : 0;

  console.log('-'.repeat(86));
  console.log(`采样跨度            : ${elapsed} ms  (${rows.length} 个样本)`);
  console.log(`原始 Pos 前进       : ${rawAdvance} ms   -> 每秒前进 ${((rawAdvance / elapsed) * 1000).toFixed(0)} ms`);
  console.log(`修正 Pos 前进       : ${corrAdvance} ms   -> 每秒前进 ${((corrAdvance / elapsed) * 1000).toFixed(0)} ms`);
  console.log(`原始值跳变次数      : ${rawSteps} 次（${elapsed > 0 ? (rawSteps / (elapsed / 1000)).toFixed(2) : 0} 次/秒）`);
  const playing = rows.filter((r) => r.status === 'Playing').length;
  const rate = elapsed > 0 ? corrAdvance / elapsed : 0;

  console.log(`LastUpdatedTime 年龄: 平均 ${avgAge.toFixed(0)} ms，最大 ${maxAge.toFixed(0)} ms`);
  console.log(`播放中样本          : ${playing} / ${rows.length}`);
  console.log('');

  if (!playing) {
    console.log('=> 这个会话现在不是播放状态（暂停/停止），阶梯和年龄都没有意义。');
    console.log('   让它继续播放再跑一次。');
    return;
  }

  if (rawSteps > 0 && elapsed > 0 && rawSteps / (elapsed / 1000) < 8) {
    console.log(`=> 原始进度是约 ${Math.round(elapsed / rawSteps)}ms 一格的阶梯。`);
    console.log(`   直接用它当「现在的进度」，落后真实播放量平均约 ${avgAge.toFixed(0)}ms、最坏约 ${maxAge.toFixed(0)}ms。`);
    console.log('   这就是歌词偏慢的根因：播放器不是每毫秒都在更新 SMTC。');
  } else {
    console.log('=> 这个播放器的进度几乎每毫秒都在变，本身没有阶梯问题。');
  }

  if (Math.abs(rate - 1) > 0.15) {
    console.log('');
    console.log(`!! 注意：这份时间轴大约以 ${rate.toFixed(2)}x 前进（不是 1.00x）。`);
    console.log('   多半是播放器开了倍速，或者是视频/直播这类非线性进度。');
    console.log('   本工具与进度补偿都按 1x 假设，此时读数不能按字面理解 ——');
    console.log('   tools/lag-check.js 也会因此不给「准/不准」的结论。');
  }
})();
