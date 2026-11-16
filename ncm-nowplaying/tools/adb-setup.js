#!/usr/bin/env node
'use strict';

/**
 * 引导式接入：把手机和电脑连起来，并验证真的能读到播放状态。
 *
 *   node tools/adb-setup.js                     交互式引导
 *   node tools/adb-setup.js --check             只检查当前连接并试读播放状态
 *   node tools/adb-setup.js --p <IP:配对端口> -c <IP:调试端口> --code <配对码>
 *   node tools/adb-setup.js --serial <序列号>    多设备时指定
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const adbMod = require(path.join(ROOT, 'src', 'adb.js'));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
};

function say(text) {
  console.log(text == null ? '' : text);
}
function ok(text) {
  say(`${C.green}✓${C.reset} ${text}`);
}
function warn(text) {
  say(`${C.yellow}!${C.reset} ${text}`);
}
function bad(text) {
  say(`${C.red}✗${C.reset} ${text}`);
}
function step(n, text) {
  say('');
  say(`${C.bold}${C.cyan}第 ${n} 步 · ${text}${C.reset}`);
  say('─'.repeat(58));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--p' || a === '--pair') out.pair = argv[++i];
    else if (a === '--c' || a === '--connect') out.connect = argv[++i];
    else if (a === '--code') out.code = argv[++i];
    else if (a === '--serial') out.serial = argv[++i];
    else out._.push(a);
  }
  return out;
}

function ask(question, defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` ${C.dim}[${defaultValue}]${C.reset}` : '';
    rl.question(`${question}${suffix} `, (answer) => {
      rl.close();
      const v = (answer || '').trim();
      resolve(v || defaultValue || '');
    });
  });
}

function findAdb() {
  const candidates = [
    path.join(ROOT, 'tools', 'platform-tools', 'adb.exe'),
    path.join(ROOT, 'tools', 'platform-tools', 'adb'),
    'adb',
  ];
  for (const c of candidates) {
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    return c;
  }
  return 'adb';
}

const ADB = findAdb();

function run(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      ADB,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || ''),
          error: err ? err.message : '',
        });
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 步骤
// ---------------------------------------------------------------------------

async function checkAdb() {
  const res = await run(['version'], 8000);
  if (!res.ok) {
    bad('adb 无法运行');
    say(`   ${res.error || res.stderr}`);
    say('   请运行 setup-adb.bat 自动安装，或手动下载 platform-tools 解压到 tools/ 目录。');
    return null;
  }
  const version = (res.stdout.match(/Version ([\d.]+)/) || [])[1] || '未知';
  ok(`adb 可用（${version}）`);
  say(`   ${C.dim}${ADB}${C.reset}`);
  return ADB;
}

async function listDevices() {
  const res = await run(['devices', '-l'], 8000);
  if (!res.ok) return [];
  return res.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      return { serial: parts[0], state: parts[1] || '', detail: l };
    });
}

async function reachHost(addr) {
  const host = String(addr).split(':')[0];
  if (!host || !/^[\d.]+$/.test(host)) return true; // 主机名就交给 adb 自己解析
  // 配对之前就能发现 IP 写错，比等着看 adb 超时友好得多
  const args =
    process.platform === 'win32'
      ? ['-n', '1', '-w', '1200', host]
      : ['-c', '1', '-W', '2', host];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 4000, windowsHide: true }, (err) => resolve(!err));
  });
}

async function doPair(pairAddr, code) {
  if (!pairAddr || !code) return true;
  say(`正在配对 ${pairAddr} …`);
  if (!(await reachHost(pairAddr))) {
    warn(`ping 不通 ${pairAddr.split(':')[0]} —— 请确认手机和电脑在同一个 Wi-Fi 下`);
  }
  const res = await run(['pair', pairAddr, code], 30000);
  const text = (res.stdout + res.stderr).trim();
  if (/Successfully paired/i.test(text)) {
    ok('配对成功');
    return true;
  }
  bad('配对失败');
  say(`   ${text || res.error}`);
  say('   ' + C.dim + '注意：配对端口和调试端口不是同一个，且每次打开"使用配对码配对设备"' + C.reset);
  say('   ' + C.dim + '对话框时都会变。请重新打开该对话框并抄最新的端口和配对码。' + C.reset);
  return false;
}

async function doConnect(addr) {
  if (!addr) return false;
  say(`正在连接 ${addr} …`);
  if (!(await reachHost(addr))) {
    warn(`ping 不通 ${addr.split(':')[0]} —— 请确认手机和电脑在同一个 Wi-Fi 下`);
  }
  const res = await run(['connect', addr], 30000);
  const text = (res.stdout + res.stderr).trim();
  if (/connected to/i.test(text)) {
    ok('已连接');
    return true;
  }
  bad('连接失败');
  say(`   ${text || res.error}`);
  return false;
}

async function pickDevice(preferredSerial) {
  let list = await listDevices();
  let online = list.filter((d) => d.state === 'device');

  if (!online.length && list.some((d) => d.state === 'unauthorized')) {
    bad('设备未授权');
    say('   请解锁手机，在"允许 USB 调试吗？"的弹窗上点【允许】。');
    say('   如果没有弹窗，到 开发者选项 里点"撤销 USB 调试授权"，再重新连接。');
    return null;
  }

  if (!online.length) {
    bad('没有发现已连接的设备');
    say('   请先完成上面的配对与连接步骤。');
    return null;
  }

  let chosen = online[0];
  if (preferredSerial && online.some((d) => d.serial === preferredSerial)) {
    chosen = online.find((d) => d.serial === preferredSerial);
  } else if (online.length > 1) {
    say('发现多个设备：');
    online.forEach((d, i) => say(`   ${i + 1}. ${d.serial}`));
    const pick = await ask('请选择要使用的序号', '1');
    const idx = Math.max(0, Math.min(online.length - 1, Number(pick) - 1 || 0));
    chosen = online[idx];
  }

  ok(`使用设备 ${chosen.serial}`);
  return chosen.serial;
}

async function verify(serial) {
  say('正在读取手机当前的播放状态 …');
  const res = await run(['-s', serial, 'shell', 'dumpsys media_session'], 15000);

  if (!res.ok) {
    bad('读取失败');
    say(`   ${res.error || res.stderr}`);
    return false;
  }

  const sessions = adbMod.parseMediaSessions(res.stdout);
  const withMeta = sessions.filter((s) => s.values && s.values.length);

  if (!sessions.length) {
    bad('没解析出任何媒体会话');
    saveRaw(serial, res.stdout);
    return false;
  }

  say('');
  say(`  ${C.bold}解析出 ${sessions.length} 个媒体会话：${C.reset}`);
  sessions.forEach((s, i) => {
    const playing = s.state === 'playing' ? `${C.green}播放中${C.reset}` : `${C.dim}${s.state}${C.reset}`;
    say('');
    say(`  ${i + 1}. ${s.package || '(未知包名)'}  ${playing}`);
    if (s.values && s.values.length) {
      say(`     元数据：${s.values.join('  |  ')}`);
    } else {
      say(`     ${C.dim}元数据：无${C.reset}`);
    }
  });
  say('');

  const picked = adbMod.pickSession(sessions, 'netease');
  if (picked.reason === 'ok' && picked.session) {
    const v = (picked.session.values || []).filter((x) => !/^\d+$/.test(x));
    ok(`识别到网易云：${v[0] || '?'}${v[1] ? ' - ' + v[1] : ''}  （${picked.session.state}）`);
    if (picked.session.metadataRaw) {
      say(`   ${C.dim}${picked.session.metadataRaw}${C.reset}`);
    }
    return true;
  }

  if (picked.reason === 'package-mismatch') {
    warn('找到了媒体会话，但当前播放的不是网易云音乐');
    say(`   现在在放的是：${picked.session.package}`);
    say('   请用网易云音乐播放任意一首歌，然后重新运行：');
    say(`   node tools/adb-setup.js --check`);
    return false;
  }

  warn('找到了媒体会话，但里面没有曲目信息');
  say('   请确认网易云音乐正在播放（不是暂停在空白页）。');
  if (!withMeta.length) {
    saveRaw(serial, res.stdout);
  }
  return false;
}

function saveRaw(serial, raw) {
  try {
    const out = path.join(ROOT, 'tools', 'dumpsys-raw.txt');
    fs.writeFileSync(out, raw, 'utf8');
    say('');
    say(`   原始输出已保存到：${C.bold}${out}${C.reset}`);
    say('   如果确认手机在放歌但这里读不到，把这个文件发我，我加一条机型适配规则。');
  } catch (err) {
    /* 保存失败不影响主流程 */
  }
}

function saveConfig(addr, serial) {
  const configPath = path.join(ROOT, 'config.json');
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    warn('config.json 读取失败，跳过写入');
    return;
  }

  if (addr) config.adbAutoConnect = addr;
  // 无线调试的序列号本身就是 IP:端口，会随 IP 变化，所以不锁定 adbSerial
  if (serial && !serial.includes(':') && !serial.includes('.')) config.adbSerial = serial;

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok('已写入 config.json，之后掉线会自动重连');
    if (config.adbAutoConnect) say(`   "adbAutoConnect": "${config.adbAutoConnect}"`);
  } catch (err) {
    warn('写入 config.json 失败：' + err.message);
  }
}

function printPhoneGuide() {
  say('');
  say(`${C.bold}手机侧需要你先做的（只有你能操作）：${C.reset}`);
  say('');
  say('  1. 打开「设置 → 关于手机」，连续点 7 次「版本号」');
  say('     —— 提示"您已处于开发者模式"即可');
  say('  2. 回到「设置 → 系统 → 开发者选项」');
  say('  3. 打开「无线调试」开关');
  say('  4. 点进「无线调试」，选「使用配对码配对设备」');
  say('     屏幕上会出现：');
  say(`       ${C.cyan}IP 地址和端口${C.reset}（例如 192.168.1.23:37001）← 这是配对端口`);
  say(`       ${C.cyan}Wi-Fi 配对码${C.reset}（6 位数字）`);
  say(`     ${C.dim}别关这个对话框，等下要输进去${C.reset}`);
  say('  5. 返回上一级，记下「IP 地址和端口」那一行（例如 192.168.1.23:5555）');
  say(`     ${C.dim}这是调试端口，和配对端口不一样${C.reset}`);
  say('');
  say(`  ${C.dim}前提：手机和电脑连同一个 Wi-Fi。${C.reset}`);
  say(`  ${C.dim}小米/红米还需要额外打开「USB 调试（安全设置）」。${C.reset}`);
  say('');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  say('');
  say(`${C.bold}手机网易云 → 电脑   接入引导${C.reset}`);
  say('='.repeat(58));

  step(1, '检查 adb');
  if (!(await checkAdb())) process.exit(1);

  step(2, '检查设备连接');
  let serial = await pickDevice(args.serial);

  if (args.check) {
    if (!serial) process.exit(1);
    step(3, '试读手机播放状态');
    const good = await verify(serial);
    say('');
    process.exit(good ? 0 : 1);
  }

  if (!serial) {
    printPhoneGuide();

    const pairAddr = args.pair || (await ask('配对端口（IP:端口，直接回车跳过配对）'));
    let code = args.code;
    if (pairAddr && !code) code = await ask('6 位配对码');

    if (pairAddr) {
      const paired = await doPair(pairAddr, code);
      if (!paired) process.exit(1);
    }

    const connectAddr = args.connect || (await ask('调试端口（IP:端口）'));
    if (!connectAddr) {
      bad('没有提供调试端口，无法继续');
      process.exit(1);
    }
    await doConnect(connectAddr);
    await sleep(1200);

    serial = await pickDevice(args.serial);
    if (serial) saveConfig(connectAddr, serial);
  }

  if (!serial) {
    bad('仍未连接到设备');
    if (args.connect || args.pair) {
      const addr = args.connect || args.pair;
      warn('如果刚才是"已连接"但设备列表为空，请拔掉数据线再试一次，或重新开关无线调试。');
      void addr;
    }
    process.exit(1);
  }

  step(3, '试读手机播放状态');
  say(`${C.dim}提示：先在手机上用网易云音乐播放一首歌，结果最准。${C.reset}`);
  say('');
  let good = await verify(serial);

  if (!good) {
    const again = await ask('想重试一次吗？（手机上开始播放后回车重试，输入 n 结束）', '');
    if (again.toLowerCase() !== 'n') {
      say('');
      good = await verify(serial);
    }
  }

  say('');
  say('='.repeat(58));
  if (good) {
    ok(`${C.bold}通了。${C.reset}即将自动启动服务端和 SMTC 桥接（两个新窗口）。`);
    say('');
    say('   - 服务端：浏览器打开 http://localhost:8787 看歌词');
    say('   - SMTC 桥接：如果你用 BetterLyrics，它会自动识别');
    say('');
    say(`   ${C.dim}以后手机重启或换 Wi-Fi 后如果断了，重新跑一次本脚本即可。${C.reset}`);
    say('='.repeat(58));
    say('');
    process.exit(0);
  } else {
    warn('还没能读到播放状态。按上面的提示调整后，重新运行：');
    say('');
    say(`   ${C.bold}node tools/adb-setup.js --check${C.reset}`);
    say('');
    process.exit(1);
  }
}

main().catch((err) => {
  say('');
  bad('出错了：' + err.message);
  process.exit(1);
});
