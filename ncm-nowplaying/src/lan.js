'use strict';

/**
 * 找出「平板 / 手机应该访问哪个地址」。
 *
 * 为什么不能简单取第一个非内网 IPv4
 * ---------------------------------
 * `os.networkInterfaces()` 的顺序是系统给的，而 Windows 上装了 WSL、Hyper-V、
 * Docker、VMware/VirtualBox 之后，会多出一堆虚拟网卡（vEthernet、VMnet、
 * VirtualBox Host-Only…）。它们的地址也是「非内网 IPv4」，于是第一个常常是
 * 平板根本连不上的那一个 —— 二维码扫出来就是错的 IP。
 *
 * 所以这里做三件事：
 *   1. 用 UDP connect 探出**系统默认出口地址**（不真的发包），这是「本机能通外网
 *      的那张网卡」，也就是平板大概率在同一个网段的那张；
 *   2. 按网卡名判断物理/虚拟，物理优先，虚拟垫底；
 *   3. 把所有候选都返回（带网卡名），页面上可以手动换一个。
 *
 * 另外支持 config.json 里的 `lanHost` 手动指定 —— 自动判断在奇怪网络下失灵时的
 * 唯一确定性出口。
 */

const os = require('os');
const dgram = require('dgram');

// 物理网卡（中英文 Windows 都覆盖）
const PHYSICAL = /(wlan|wi-?fi|wireless|ethernet|以太网|无线网络连接|本地连接)/i;
// 虚拟 / 隧道网卡
const VIRTUAL = /(vethernet|hyper-?v|wsl|vmware|vmnet|virtualbox|vbox|docker|loopback|tap|tun|tailscale|zerotier|radmin|npcap|bluetooth|nvidia|virtual|vpn|clash|singbox|sing-box|wintun)/i;

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  return false;
}

function isLinkLocal(ip) {
  return /^169\.254\./.test(ip);
}

/**
 * 系统默认出口地址。UDP 的 connect 不会发任何包，只是让系统按路由表挑一个源地址，
 * 所以拿到的就是「真正能出去的那张网卡」。
 */
function preferredOutboundIp(timeoutMs = 400, probe = '223.5.5.5') {
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (sock) sock.close(); } catch (e) { /* 已关闭 */ }
      resolve(value || '');
    };
    const timer = setTimeout(() => finish(''), timeoutMs);
    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', () => finish(''));
      sock.connect(53, probe, () => {
        let addr = '';
        try { addr = sock.address().address || ''; } catch (e) { addr = ''; }
        finish(addr);
      });
    } catch (e) {
      finish('');
    }
  });
}

/** 采集网卡上的 IPv4（name 与地址一起带走，后面排序和展示都要用） */
function collectInterfaces(ifaces) {
  const out = [];
  const source = ifaces || os.networkInterfaces() || {};
  for (const [name, list] of Object.entries(source)) {
    for (const ni of list || []) {
      const family = typeof ni.family === 'string' ? ni.family : `IPv${ni.family}`;
      if (family !== 'IPv4' || ni.internal) continue;
      out.push({ name, address: ni.address, netmask: ni.netmask || '' });
    }
  }
  return out;
}

/**
 * 排序后的候选地址。第一项就是「推荐」的那个。
 *
 *   port     拼 URL 用
 *   override config.json 的 lanHost，给了就直接置顶（带 forced 标记）
 */
function listLanCandidates({ ifaces, outboundIp, port, override } = {}) {
  const all = collectInterfaces(ifaces);
  const target = Number(port) || 8787;
  const forced = String(override || '').trim();

  const scored = all.map((it) => {
    const physical = PHYSICAL.test(it.name);
    const virtual = VIRTUAL.test(it.name);
    let score = 0;
    if (physical) score += 100;
    if (outboundIp && it.address === outboundIp) score += 60;
    if (isPrivateV4(it.address)) score += 30;
    if (virtual) score -= 80;
    if (isLinkLocal(it.address)) score -= 200;
    let note = '';
    if (physical) note = '物理网卡';
    else if (virtual) note = '虚拟网卡';
    if (outboundIp && it.address === outboundIp) note = note ? `${note} · 系统出口` : '系统出口';
    return { ...it, score, physical, virtual, note };
  });

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const entries = scored.map((it, i) => ({
    ip: it.address,
    url: `http://${it.address}:${target}`,
    name: it.name,
    note: it.note,
    recommended: i === 0,
  }));

  if (forced) {
    const hit = entries.find((e) => e.ip === forced);
    if (hit) {
      for (const e of entries) e.recommended = false;
      hit.recommended = true;
      hit.note = hit.note ? `${hit.note} · 已在 config.json 指定` : '已在 config.json 指定';
      entries.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
    } else {
      entries.unshift({
        ip: forced,
        url: `http://${forced}:${target}`,
        name: 'config.json',
        note: '已在 config.json 指定（本机网卡上没找到这个地址）',
        recommended: true,
      });
      for (const e of entries.slice(1)) e.recommended = false;
    }
  }

  return entries;
}

module.exports = {
  listLanCandidates,
  preferredOutboundIp,
  collectInterfaces,
  isPrivateV4,
  PHYSICAL,
  VIRTUAL,
};
