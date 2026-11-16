#!/usr/bin/env node
'use strict';

/**
 * 列出当前 Windows 上的所有媒体会话（SMTC），含封面字节数与时间轴。
 *
 *   node tools/list-smtc.js
 *
 * 用途：确认 SMTC 桥接（smtc/smtc-bridge.ps1）是否把状态发布正确了。
 * 底层还是 smtc/list-sessions.ps1，但这里顺带解决了两个麻烦：
 *   - 不用记 powershell -ExecutionPolicy Bypass -File ... 这一长串
 *   - PowerShell 重定向出来的是 UTF-16LE + BOM，直接看是一堆乱码，这里统一解码
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'smtc', 'list-sessions.ps1');

function decode(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf).swap16().toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

if (process.platform !== 'win32') {
  console.log('这个工具只在 Windows 上有意义（SMTC 是 Windows 的系统媒体会话）。');
  process.exit(1);
}

if (!fs.existsSync(SCRIPT)) {
  console.error(`找不到 ${SCRIPT}`);
  process.exit(1);
}

execFile(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
  { timeout: 30000, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  (err, stdout, stderr) => {
    const out = decode(stdout);
    const errText = decode(stderr);

    if (out.trim()) {
      let text = out.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      // 结束前多余的两行空行去掉
      text = text.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
      console.log(text);
    }

    if (errText.trim()) {
      console.error('\n[stderr]\n' + errText.trim());
    }

    if (err) {
      console.error('\n[失败] ' + err.message);
      if (/ExecutionPolicy/i.test(errText)) {
        console.error('提示：如果被执行策略拦住，改用 setup-adb.bat 那种方式，或直接运行：');
        console.error(`  powershell -ExecutionPolicy Bypass -File "${SCRIPT}"`);
      }
      process.exit(1);
    }

    if (!out.includes('NCMPhoneBridge')) {
      console.log('');
      console.log('提示：上面没有出现 NCMPhoneBridge 会话 —— 说明 SMTC 桥接没在运行。');
      console.log('      双击 smtc-bridge.bat 启动它，然后重新运行本命令。');
    }
  }
);
