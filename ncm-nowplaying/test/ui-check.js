'use strict';

/**
 * 前端冒烟测试：用本机已装的 Edge / Chrome 无头模式打开显示页，
 * 通过 DevTools 协议读取真实渲染结果，并捕获所有 JS 运行时报错。
 *
 * 用法： node test/ui-check.js [页面地址]
 * 退出码非 0 表示页面有异常。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAGE_URL = process.argv[2] || 'http://127.0.0.1:8787/';
const PORT = 9333;

function findBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function waitForDevtools(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch (err) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('DevTools 端口未就绪');
}

async function openTarget(url) {
  let res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error('无法创建标签页: ' + res.status);
  return res.json();
}

const DIAGNOSTIC = `(() => {
  // 关掉过渡再取值：否则刚好切到下一句时，读到的是 opacity 动画中间值（例如 0.28 而不是 0.14）
  const probe = document.createElement('style');
  probe.textContent = '*{transition:none !important;animation:none !important}';
  document.head.appendChild(probe);
  void document.body.offsetHeight;

  const q = (s) => document.querySelector(s);
  const on = q('.line.on');
  const all = Array.from(document.querySelectorAll('.line'));
  const cs = on ? getComputedStyle(on) : null;
  const inner = q('#lyricsInner');
  const cover = q('#cover');
  const result = JSON.stringify({
    title: q('#title').textContent,
    artist: q('#artist').textContent,
    album: q('#album').textContent,
    coverReady: cover.classList.contains('ready'),
    coverLoaded: cover.naturalWidth > 0,
    coverSize: cover.naturalWidth + 'x' + cover.naturalHeight,
    dotClass: q('#dot').className,
    statusText: q('#statusText').textContent,
    pos: q('#pos').textContent,
    dur: q('#dur').textContent,
    fill: q('#fill').style.width,
    lineCount: all.length,
    activeIndex: all.indexOf(on),
    activeText: on ? on.textContent.slice(0, 24) : null,
    activeColor: cs ? cs.color : null,
    activeOpacity: cs ? cs.opacity : null,
    activeTransform: cs ? cs.transform : null,
    nextLine: (() => {
      const n = all[all.indexOf(on) + 1];
      if (!n) return 'n/a';
      const c = getComputedStyle(n);
      return 'opacity=' + c.opacity + ' color=' + c.color;
    })(),
    pastLine: (() => {
      const n = all[all.indexOf(on) - 1];
      if (!n) return 'n/a';
      const c = getComputedStyle(n);
      return 'opacity=' + c.opacity + ' color=' + c.color;
    })(),
    innerTransform: inner ? inner.style.transform : null,
    innerHeight: q('#lyrics').clientHeight,
    activeCenterRatio: (() => {
      if (!on) return null;
      const r = on.getBoundingClientRect();
      const box = q('#lyrics').getBoundingClientRect();
      return +(((r.top + r.height / 2) - box.top) / box.height).toFixed(3);
    })(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    theme: document.documentElement.getAttribute('data-theme'),
    hintShown: q('#hint').classList.contains('show')
  });
  probe.remove();
  return result;
})()`;

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('未找到 Edge / Chrome，跳过前端检查');
    process.exit(0);
  }

  const userDataDir = path.join(os.tmpdir(), 'ncm-ui-check-' + Date.now());
  const proc = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const problems = [];
  let ws;

  try {
    await waitForDevtools();
    const target = await openTarget(PAGE_URL);

    ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();

    const send = (method, params) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
    });

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        problems.push('JS 未捕获异常: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        const text = msg.params.args.map((a) => a.value || a.description || '').join(' ');
        problems.push(`控制台 ${msg.params.type}: ${text}`);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        problems.push('浏览器日志错误: ' + msg.params.entry.text + ' @ ' + (msg.params.entry.url || ''));
      }
    };

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    // 给页面留出连 WebSocket、拉封面、跑动画的时间
    await new Promise((r) => setTimeout(r, 6000));

    const result = await send('Runtime.evaluate', { expression: DIAGNOSTIC, returnByValue: true });
    const diag = result && result.result && result.result.value ? JSON.parse(result.result.value) : null;

    console.log('\n页面诊断');
    if (!diag) {
      console.log('  无法读取诊断数据');
      problems.push('诊断表达式执行失败');
    } else {
      for (const [k, v] of Object.entries(diag)) console.log(`  ${k.padEnd(16)} ${v}`);
    }

    if (diag) {
      console.log('\n断言');
      const assert = (ok, msg) => {
        console.log(`  ${ok ? '\u2713' : '\u2717'} ${msg}`);
        if (!ok) problems.push(msg);
      };
      assert(diag.lineCount > 0, `歌词已渲染（${diag.lineCount} 行）`);
      assert(diag.activeIndex >= 0, `存在当前高亮行（第 ${diag.activeIndex} 行）`);
      assert(diag.activeOpacity === '1', `当前行不透明度为 1（实际 ${diag.activeOpacity}）`);
      assert(
        diag.activeCenterRatio !== null && Math.abs(diag.activeCenterRatio - 0.44) < 0.06,
        `当前行位于歌词区 44% 高度处（实际 ${diag.activeCenterRatio}）`
      );
      assert(diag.innerTransform && diag.innerTransform !== 'translateY(0px)', `歌词已滚动（${diag.innerTransform}）`);
      assert(diag.coverLoaded, `封面已加载（${diag.coverSize}）`);
      assert(diag.fill && diag.fill !== '0%', `进度条有进度（${diag.fill}）`);
      assert(/live|busy/.test(diag.dotClass), `状态指示灯已激活（${diag.dotClass}）`);
    }

    if (problems.length) {
      console.log('\n发现问题');
      for (const p of problems) console.log('  - ' + p);
    } else {
      console.log('\n前端检查全部通过，无 JS 报错');
    }
  } catch (err) {
    console.error('检查过程出错:', err.message);
    problems.push(err.message);
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    proc.kill();
    setTimeout(() => {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
    }, 400);
  }

  setTimeout(() => process.exit(problems.length ? 1 : 0), 700);
}

main();
