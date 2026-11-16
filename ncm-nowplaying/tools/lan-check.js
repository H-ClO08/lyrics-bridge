#!/usr/bin/env node
'use strict';

/**
 * 二维码扫不开 / 平板打不开页面时，先用这个看清楚「本机到底有哪些地址」。
 *
 *   node tools/lan-check.js
 *
 * 输出的是服务端 /api/lan 的同一套判断结果：第一行是推荐给平板用的那个地址。
 *
 * 为什么需要它：Windows 上装了 WSL、Hyper-V、Docker、VMware、VPN 之后会多出好几张
 * 虚拟网卡，它们也有 IPv4 地址。按"第一个非内网地址"取，很容易取到平板连不上的那张，
 * 二维码就废了。这里会标明每张网卡是物理还是虚拟、是不是系统出口地址。
 *
 * 想在 config.json 里钉死用某个地址，就把 lanHost 填成它。
 */

const fs = require('fs');
const path = require('path');
const { listLanCandidates, preferredOutboundIp, VIRTUAL, PHYSICAL } = require('../src/lan');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (err) { /* 用默认值 */ }

  const port = Number(config.port) || 8787;
  const outbound = await preferredOutboundIp();
  const list = listLanCandidates({ outboundIp: outbound, port, override: config.lanHost });

  console.log('');
  console.log('本机地址体检');
  console.log('='.repeat(64));
  console.log(`端口        : ${port}`);
  console.log(`系统出口地址: ${outbound || '(探测失败)'}`);
  console.log(`config.lanHost: ${String(config.lanHost || '').trim() || '(未设置)'}`);
  console.log('');

  if (!list.length) {
    console.log('没有找到任何可用的局域网地址（只有回环/内网）。');
    console.log('检查一下是否连上了 Wi-Fi 或网线。');
    return;
  }

  console.log('候选地址（推荐项排第一）：');
  list.forEach((a, i) => {
    const mark = i === 0 ? '   <== 推荐给平板 / 手机' : '';
    console.log(`  ${i + 1}. ${a.url}`);
    console.log(`     ${a.name}${a.note ? ' · ' + a.note : ''}${mark}`);
  });
  console.log('');
  console.log('判断规则：物理网卡优先（WLAN / 以太网），命中系统出口地址加分，');
  console.log('          虚拟网卡（WSL / Hyper-V / VMware / VirtualBox / Docker / VPN）扣分。');
  console.log('');

  const virtuals = list.filter((a) => VIRTUAL.test(a.name));
  const physicals = list.filter((a) => PHYSICAL.test(a.name));
  if (virtuals.length) {
    console.log(`注意：检测到 ${virtuals.length} 张虚拟网卡（${virtuals.map((a) => a.name).join(', ')}）。`);
    console.log('      这些地址平板通常连不上，二维码里千万别用它们。');
  }
  if (!physicals.length) {
    console.log('注意：没识别出物理网卡名 —— 如果你的系统用了非常规命名，');
    console.log('      建议直接把 config.json 的 lanHost 填成你要用的地址。');
  }

  console.log('');
  console.log('平板还是打不开？按顺序排查：');
  console.log('  1. 平板和电脑是不是同一个 Wi-Fi（别一个连 5G 一个连访客网络）');
  console.log('  2. 电脑防火墙是否放行了 Node（首次运行会弹窗，必须选"专用网络"允许）');
  console.log('  3. 校园网 / 公共 Wi-Fi 常开"客户端隔离"(AP isolation)，设备之间禁止互访 ——');
  console.log('     这种情况下任何 IP 都没用，只能让两台设备接同一个手机热点');
  console.log('  4. 电脑 IP 是不是又变了（校园网/热点每次都换）：重开页面拿最新地址');
  console.log('');
})();
