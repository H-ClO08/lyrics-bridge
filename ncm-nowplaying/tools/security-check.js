#!/usr/bin/env node
'use strict';

/**
 * 账号与暴露面体检。
 *
 *   node tools/security-check.js            # 默认查 config.json 里的端口
 *   node tools/security-check.js --port=8787
 *
 * 回答四个问题：
 *   1. 网易云凭据落在哪、还有谁能读
 *   2. 这个服务在局域网上暴露到什么程度
 *   3. 任何 GET 接口会不会把 cookie 吐出来
 *   4. 跨站网页能不能偷偷调写接口（点赞 / 切歌 / 改设置）
 *
 * 这是一个只读体检：唯一的写请求打的是 /api/pin 且不带 songId，
 * 守卫放行时也只会返回 400「缺少 songId」，不会产生任何副作用。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { listLanCandidates, preferredOutboundIp } = require('../src/lan');

const ROOT = path.resolve(__dirname, '..');
const DIST_ZIP = path.join(ROOT, '..', 'dist', 'ncm-pc-source.zip');

const args = process.argv.slice(2);
const argPort = (args.find((a) => a.startsWith('--port=')) || '').split('=')[1];

const MARK = '  ';
const OK = 'OK  ';
const BAD = '!!  ';
const WARN = '~   ';

function line() {
  console.log('-'.repeat(66));
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers, timeout: 6000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', (err) => resolve({ status: 0, text: '', error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

function json(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

(async () => {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (e) { /* 用默认值 */ }

  const port = Number(argPort) || Number(config.port) || 8787;
  const host = String(config.host || '0.0.0.0');
  const file = path.join(ROOT, '.cache', 'netease-account.json');

  console.log('');
  console.log('账号与暴露面体检');
  console.log('='.repeat(66));

  // ---------------------------------------------------------------- 1. 凭据
  console.log('');
  console.log('1. 网易云登录态');
  line();
  if (!fs.existsSync(file)) {
    console.log(`${OK}没有凭据文件 —— 当前没登录网易云`);
    console.log(`${MARK}${file}`);
  } else {
    const stat = fs.statSync(file);
    let hasCookie = false;
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      hasCookie = !!state.cookie;
      console.log(`${WARN}凭据文件存在，${stat.size} 字节，昵称：${state.nickname || '(未知)'}`);
    } catch (e) {
      console.log(`${WARN}凭据文件存在但解析失败：${e.message}`);
    }
    console.log(`${MARK}${file}`);
    if (hasCookie) {
      console.log(`${BAD}文件里存着 MUSIC_U —— 拿到这个文件 = 直接接管账号`);
    }

    // 谁能读
    if (process.platform === 'win32') {
      let acl = '';
      try {
        acl = execFileSync('icacls', [file], { encoding: 'utf8', timeout: 5000 });
      } catch (e) {
        acl = '';
      }
      // icacls 会把同一个文件的多条 ACE 分行打印：第一行带路径，后面是缩进。
      const lines = acl.split(/\r?\n/);
      const start = lines.findIndex((l) => l.includes(file));
      const aclLines = [];
      if (start >= 0) {
        for (let i = start; i < lines.length; i++) {
          const l = lines[i];
          if (i > start && (/^[A-Za-z]:\\/.test(l) || !l.trim())) break;
          aclLines.push(l.trim());
        }
      }
      const perms = aclLines.join(' ');
      const broad = /Everyone|BUILTIN\\Users|INTERACTIVE|Authenticated Users/i.test(perms);
      console.log(`${MARK}ACL: ${aclLines.length ? aclLines.join(' / ') : '(读不到)'}`);
      if (broad) {
        console.log(`${BAD}除了你，其他账户/Everyone 也能读。修：icacls "${file}" /inheritance:r /grant:r "%USERNAME%:F"`);
      } else if (aclLines.length) {
        console.log(`${OK}只有当前用户可读（等价于 0600）`);
      }
    } else {
      const mode = (stat.mode & 0o777).toString(8);
      console.log(
        mode === '600'
          ? `${OK}权限 ${mode}（只有属主可读写）`
          : `${BAD}权限 ${mode}，建议 chmod 600`,
      );
    }
  }

  // ---------------------------------------------------------------- 2. 监听
  console.log('');
  console.log('2. 服务暴露面');
  line();
  console.log(`${MARK}config.host = ${host}，端口 ${port}`);
  if (host === '127.0.0.1' || host === 'localhost') {
    console.log(`${OK}只监听本机回环，局域网访问不到（平板也就用不了）`);
  } else {
    const outbound = await preferredOutboundIp().catch(() => '');
    const list = listLanCandidates({ outboundIp: outbound, port, override: config.lanHost });
    const top = list.slice(0, 3).map((a) => a.url);
    console.log(`${WARN}对所有网卡开放 —— 同一局域网内的设备都能访问这些地址：`);
    for (const u of top) console.log(`${MARK}  ${u}`);
    console.log(`${MARK}这是「平板能用」的前提，但也意味着同网段的人能调接口。`);
  }

  // ---------------------------------------------------------------- 3. 泄漏
  console.log('');
  console.log('3. 接口会不会吐出凭据');
  line();
  const probes = ['/api/account', '/api/state', '/api/info', '/api/health'];
  let reachable = true;
  let leaked = false;
  for (const p of probes) {
    const r = await request(port, { path: p });
    if (r.status === 0) {
      reachable = false;
      console.log(`${WARN}${p} 连不上：${r.error}`);
      continue;
    }
    const hit = /MUSIC_U|MUSIC_A|__csrf|os=pc;|appver=/.test(r.text);
    if (hit) leaked = true;
    console.log(
      `${hit ? BAD : OK}${p.padEnd(14)} ${r.status}  ${r.text.length} 字节  ${hit ? '含 cookie 字样！' : '无凭据'}`,
    );
  }
  if (leaked) console.log(`${BAD}有接口把 cookie 相关字段带出来了 —— 必须立刻修`);
  else if (reachable) console.log(`${OK}页面能拿到的只有登录状态，拿不到 cookie`);

  // ---------------------------------------------------------------- 4. 跨站
  console.log('');
  console.log('4. 跨站网页能不能偷偷调写接口');
  line();
  if (!reachable) {
    console.log(`${WARN}服务没在跑，跳过（先 start.bat）`);
  } else {
    const jsonHdr = { 'Content-Type': 'application/json', 'Content-Length': '2' };
    const cases = [
      { name: 'cross-site 页面发 JSON', headers: { ...jsonHdr, 'Sec-Fetch-Site': 'cross-site' }, want: 403 },
      { name: '陌生 Origin 发 JSON', headers: { ...jsonHdr, Origin: 'http://evil.example' }, want: 403 },
      { name: '表单编码的请求体', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '2' }, want: 403 },
      { name: '本页面正常调用（对照）', headers: jsonHdr, want: 400 },
    ];
    for (const c of cases) {
      const r = await request(port, { method: 'POST', path: '/api/pin', headers: c.headers, body: '{}' });
      const good = r.status === c.want;
      console.log(`${good ? OK : BAD}${c.name.padEnd(24)} 期望 ${c.want}，实际 ${r.status || '无响应'}`);
    }
    console.log(`${MARK}（老服务端没重启时，前三项会返回 400 —— 重启即可生效）`);
  }

  // ---------------------------------------------------------------- 5. 打包物
  console.log('');
  console.log('5. 分享出去的包');
  line();
  if (!fs.existsSync(DIST_ZIP)) {
    console.log(`${OK}没有找到 ${path.basename(DIST_ZIP)}，跳过`);
  } else {
    const buf = fs.readFileSync(DIST_ZIP);
    const text = buf.toString('latin1');
    const bad = text.includes('netease-account.json');
    console.log(`${bad ? BAD : OK}${path.basename(DIST_ZIP)} ${(buf.length / 1024).toFixed(0)}KB  ${bad ? '含凭据文件！' : '不含凭据文件'}`);
    if (bad) console.log(`${BAD}这个包不能发给任何人`);
  }

  // ---------------------------------------------------------------- 结论
  console.log('');
  console.log('='.repeat(66));
  console.log('结论');
  line();
  console.log(`${MARK}· cookie 只在这台电脑上，走 HTTPS 直接发给网易云，不经局域网、不进页面`);
  console.log(`${MARK}· 真正的风险是「这台电脑上谁能读到 .cache/netease-account.json」`);
  console.log(`${MARK}· 其次才是「同一 Wi-Fi 下谁能调写接口」（改收藏 / 切歌，拿不到账号）`);
  console.log('');
})();
