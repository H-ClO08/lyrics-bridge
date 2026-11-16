'use strict';

/**
 * 自检脚本：不依赖手机，验证解析器、匹配算法和网易云接口。
 * 用法： node test/selftest.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const lrc = require('../src/lrc');
const adb = require('../src/adb');
const netease = require('../src/netease');
const lan = require('../src/lan');
const account = require('../src/netease-account');
const guard = require('../src/guard');
const hub = require('../src/hub');

/** 造一张网卡的 IPv4 条目，省得每条都写全 */
function v4(address, netmask = '255.255.255.0') {
  return { family: 'IPv4', address, netmask, internal: false };
}

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

// ---------------------------------------------------------------------------

const SAMPLE_LRC = [
  '[ti:起风了]',
  '[ar:买辣椒也用券]',
  '[offset:0]',
  '[00:00.000] 作词 : 米果',
  '[00:25.237]这一路上走走停停',
  '[00:28.592]顺着少年漂流的痕迹',
  '[00:31.68]迈出车站的前一刻',
  '[00:34.795][01:20.000]重复段',
].join('\n');

const SAMPLE_YRC = [
  '[25000,3000](25000,600,0)这(25600,500,0)一(26100,700,0)路(26800,1200,0)上',
].join('\n');

// 依据 AOSP dumpsys media_session 的真实输出构造（含网易云会话 + 一个干扰会话）
const SAMPLE_DUMPSYS = `
MEDIA SESSION SERVICE (dumpsys media_session)
  3 sessions listeners.
  Global priority session is null
  User Records:
    Record for full_user=0
      Volume key long-press listener: null
      Volume key long-press listener package: null
  Media button session is com.netease.cloudmusic/.activity.PlayingActivity (userId=0)
  Sessions Stack - have 2 sessions:
    PlayingActivity com.netease.cloudmusic/.activity.PlayingActivity (userId=0)
        ownerPid=12345, ownerUid=10600, userId=0
        package=com.netease.cloudmusic
        launchIntent=null
        mediaButtonReceiver=null
        active=true
        flags=3
        rating type=0
        controllers: 15
        state=PlaybackState {state=3, position=45230, buffered position=0, speed=1.0, updated=99887766, actions=142132, custom actions=[], active item id=-1, error=null}
        audioAttrs=AudioAttributes: usage=USAGE_MEDIA content=CONTENT_TYPE_MUSIC flags=0x800
        volumeType=1, controlType=2, max=0, current=0
        metadata: size=4, description=起风了, 冯沁苑(买辣椒也用券), 起风了, 325868
        queueTitle=null, size=0
    SomeActivity com.example.video/.Player (userId=0)
        ownerPid=999, ownerUid=10111, userId=0
        package=com.example.video
        active=false
        state=PlaybackState {state=2, position=0, buffered position=0, speed=0.0, updated=1, actions=0, custom actions=[], active item id=-1, error=null}
        metadata: size=0, null
`;

async function main() {
  console.log('\n歌词解析');
  check('标准 LRC：行数与排序正确', () => {
    const lines = lrc.parseLrc(SAMPLE_LRC);
    assert.strictEqual(lines.length, 6, `期望 6 行，实际 ${lines.length}`);
    assert.strictEqual(lines[0].text, '作词 : 米果');
    assert.strictEqual(lines[1].time, 25237);
    assert.ok(lines[1].time <= lines[2].time, '时间轴未升序');
  });

  check('标准 LRC：一行多时间标签会展开', () => {
    const lines = lrc.parseLrc(SAMPLE_LRC);
    const dup = lines.filter((l) => l.text === '重复段');
    assert.strictEqual(dup.length, 2, '重复段未展开为两行');
  });

  check('标准 LRC：[mm:ss.xx] 两位小数按厘秒解析', () => {
    const lines = lrc.parseLrc('[00:31.68]迈出车站的前一刻');
    assert.strictEqual(lines[0].time, 31680);
  });

  check('逐字歌词 YRC 能解析出词级时间', () => {
    const lines = lrc.parseYrc(SAMPLE_YRC);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].text, '这一路上');
    assert.strictEqual(lines[0].words.length, 4);
    assert.strictEqual(lines[0].words[0].time, 25000);
    assert.strictEqual(lines[0].words[1].time, 25600);
  });

  check('翻译歌词按时间就近合并', () => {
    const main = lrc.parseLrc('[00:10.000]hello\n[00:20.000]world');
    const trans = lrc.parseLrc('[00:10.010]你好\n[00:20.020]世界');
    lrc.mergeTranslation(main, trans);
    assert.strictEqual(main[0].trans, '你好');
    assert.strictEqual(main[1].trans, '世界');
  });

  check('纯音乐判定', () => {
    assert.strictEqual(lrc.isInstrumental([]), true);
    assert.strictEqual(lrc.isInstrumental(lrc.buildLyrics({ lrc: SAMPLE_LRC })), false);
  });

  console.log('\ndumpsys media_session 解析');
  const sessions = adb.parseMediaSessions(SAMPLE_DUMPSYS);

  check('识别出 2 个会话，且不会把 "Media button session" 行当成会话', () => {
    assert.strictEqual(sessions.length, 2, `期望 2 个会话，实际 ${sessions.length}: ${JSON.stringify(sessions.map((s) => s.name))}`);
  });

  check('正确解析播放状态、进度与速度', () => {
    const s = sessions.find((x) => x.package.includes('netease'));
    assert.ok(s, '没找到网易云会话');
    assert.strictEqual(s.stateCode, 3);
    assert.strictEqual(s.position, 45230);
    assert.strictEqual(s.speed, 1);
    assert.strictEqual(s.updated, 99887766);
  });

  check('元数据值按逗号切分并剔除 null / size', () => {
    const s = sessions.find((x) => x.package.includes('netease'));
    assert.deepStrictEqual(s.values, ['起风了', '冯沁苑(买辣椒也用券)', '起风了', '325868']);
  });

  check('从元数据中猜出时长', () => {
    const s = sessions.find((x) => x.package.includes('netease'));
    assert.strictEqual(adb.guessDuration(s.values), 325868);
  });

  check('会话挑选：优先网易云且处于播放态', () => {
    const picked = adb.pickSession(sessions, 'netease');
    assert.strictEqual(picked.reason, 'ok');
    assert.ok(picked.session.package.includes('netease'));
  });

  check('没有网易云会话时会回落到其它播放器并标记 package-mismatch', () => {
    const onlyOther = sessions.filter((s) => !s.package.includes('netease'));
    const picked = adb.pickSession(onlyOther, 'netease');
    // com.example.video 的 metadata 为 size=0, null → 解析后没有有效值
    assert.ok(['package-mismatch', 'no-metadata'].includes(picked.reason), `意外结果 ${picked.reason}`);
  });

  console.log('\n网易云账号（扫码登录 / 收藏）');

  check('cookie 合并：保留旧键、追加新键、丢掉属性', () => {
    const jar = account.mergeCookie('MUSIC_U=old; __csrf=abc', 'MUSIC_U=new; Path=/; Domain=.music.163.com; NMTID=xyz');
    assert.ok(jar.includes('MUSIC_U=new'), '应为新值覆盖');
    assert.ok(jar.includes('__csrf=abc'), '应保留原有键');
    assert.ok(jar.includes('NMTID=xyz'), '应追加新键');
    assert.ok(!/Path=/.test(jar) && !/Domain=/.test(jar), `属性不该进 cookie：${jar}`);
    assert.strictEqual(account.cookieValue(jar, 'MUSIC_U'), 'new');
  });

  check('weapi 加密：params 是 base64，encSecKey 是 256 位十六进制', () => {
    const { params, encSecKey } = account.weapi({ a: 1 });
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(params) && params.length > 20, `params 异常：${params}`);
    assert.ok(/^[0-9a-f]{256}$/.test(encSecKey), `encSecKey 长度/字符异常：${encSecKey.length}`);
  });

  await checkAsync('未登录时 isLikedQuick 返回 null，setLiked 明确报错', async () => {
    // 用一个不存在的目录，避免读到真实的登录态
    const acc = new account.NeteaseAccount({ cacheDir: path.join(__dirname, '..', '.tmp', 'selftest-account') });
    assert.strictEqual(acc.loggedIn, false);
    assert.strictEqual(acc.isLikedQuick(123), null);
    let threw = '';
    try {
      await acc.setLiked(123, true);
    } catch (err) {
      threw = err.message;
    }
    assert.ok(/登录/.test(threw), `未登录时应提示登录，实际：${threw}`);
  });

  console.log('\n写接口的来源校验（防跨站网页偷偷点赞 / 切歌）');

  check('跨站页面（Sec-Fetch-Site: cross-site）被拒', () => {
    const g = guard.checkWrite({ headers: { 'sec-fetch-site': 'cross-site' } });
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.reason, 'cross-site');
  });

  check('Origin 与 Host 不一致被拒', () => {
    const g = guard.checkWrite({
      headers: { origin: 'http://evil.example', host: '192.168.1.23:8787' },
    });
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.reason, 'origin-mismatch');
  });

  check('表单编码的请求体被拒（跨站表单只能发这种）', () => {
    const g = guard.checkWrite({
      headers: { host: '192.168.1.23:8787', 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.reason, 'content-type');
  });

  check('同源 JSON 请求放行', () => {
    const g = guard.checkWrite({
      headers: {
        host: '192.168.1.23:8787',
        origin: 'http://192.168.1.23:8787',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
    });
    assert.strictEqual(g.ok, true);
  });

  check('命令行客户端（没有浏览器头）仍可调用，不影响本机推送/脚本', () => {
    assert.strictEqual(guard.checkWrite({ headers: {} }).ok, true);
    assert.strictEqual(
      guard.checkWrite({ headers: { 'content-type': 'application/json; charset=utf-8' } }).ok,
      true,
    );
  });

  console.log('\n控制指令的路由（手机在放歌时不能去打电脑）');

  check('回环地址判定：127.0.0.1 / ::1 / IPv4 映射都算本机', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '']) {
      assert.strictEqual(hub.isLoopbackIp(ip), true, ip + ' 应判为本机');
    }
  });

  check('回环地址判定：局域网 IP 不算本机', () => {
    for (const ip of ['192.168.1.50', '172.23.137.232', '::ffff:192.168.1.50', '10.0.0.7']) {
      assert.strictEqual(hub.isLoopbackIp(ip), false, ip + ' 应判为手机');
    }
  });

  const mkHub = (cfg = {}) =>
    new hub.Hub({ config: { source: 'auto', ...cfg }, resolver: {}, log: () => {} });

  check('手机推过状态 → 切歌指令发回那台手机', () => {
    const h = mkHub();
    h._activeSource = 'push';
    h._pushDevice = { ip: '192.168.1.50', port: 8787, at: Date.now() };
    const t = h.controlTarget();
    assert.strictEqual(t.kind, 'phone');
    assert.strictEqual(t.base, 'http://192.168.1.50:8787');
  });

  check('本机发布端推过状态 → 切歌指令留在电脑', () => {
    const h = mkHub();
    h._activeSource = 'push';
    h._pushDevice = null; // 本机推送会把它清空
    assert.strictEqual(h.controlTarget().kind, 'pc');
  });

  check('手机地址超过 10 分钟没再出现 → 不再往那个地址发指令', () => {
    const h = mkHub();
    h._activeSource = 'push';
    h._pushDevice = { ip: '192.168.1.50', port: 8787, at: Date.now() - 11 * 60 * 1000 };
    assert.strictEqual(h.controlTarget().kind, 'pc');
  });

  check('拉取模式（http 源）用 config.phoneUrl', () => {
    const h = mkHub({ phoneUrl: 'http://192.168.1.9:8787/' });
    h._activeSource = 'http';
    const t = h.controlTarget();
    assert.strictEqual(t.kind, 'phone');
    assert.strictEqual(t.base, 'http://192.168.1.9:8787');
  });

  console.log('\n局域网地址选择（二维码该用哪个 IP）');

  // 装了 WSL / VMware / VirtualBox 的 Windows，网卡枚举顺序里虚拟网卡常常在最前面。
  // 平板连不上虚拟网卡的地址，二维码就废了 —— 这是「扫码打不开」最常见的原因。
  const MESSY_NICS = {
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.28.96.1', '255.255.240.0')],
    'VMware Network Adapter VMnet8': [v4('192.168.233.1')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    WLAN: [v4('192.168.1.42')],
  };

  check('多网卡时推荐物理网卡，虚拟网卡不排第一', () => {
    const list = lan.listLanCandidates({ ifaces: MESSY_NICS, outboundIp: '192.168.1.42', port: 8787 });
    assert.strictEqual(list[0].ip, '192.168.1.42', `推荐了 ${list[0].ip}（${list[0].name}）`);
    assert.strictEqual(list[0].recommended, true);
    assert.ok(/^http:\/\/192\.168\.1\.42:8787$/.test(list[0].url), `URL 异常 ${list[0].url}`);
  });

  check('虚拟网卡仍然保留为候选（方便手动切换）', () => {
    const list = lan.listLanCandidates({ ifaces: MESSY_NICS, outboundIp: '192.168.1.42', port: 8787 });
    // 4 个非回环地址：WLAN + WSL + VMnet8 + VirtualBox
    assert.strictEqual(list.length, 4, `候选数 ${list.length}`);
    assert.ok(list.some((a) => a.ip === '172.28.96.1'), 'WSL 的地址应作为候选保留');
  });

  check('回环地址永远不会出现在候选里', () => {
    const list = lan.listLanCandidates({ ifaces: MESSY_NICS, outboundIp: '', port: 8787 });
    assert.ok(!list.some((a) => a.ip === '127.0.0.1'), '回环地址泄漏进了候选');
  });

  check('默认出口落在虚拟网卡上时，物理网卡依然优先', () => {
    // VPN / 虚拟机把默认路由抢走的情况：出口是 VMnet8，但平板只可能连 WLAN
    const list = lan.listLanCandidates({ ifaces: MESSY_NICS, outboundIp: '192.168.233.1', port: 8787 });
    assert.strictEqual(list[0].ip, '192.168.1.42', `推荐了 ${list[0].ip}（${list[0].name}）`);
  });

  check('APIPA（169.254.x）地址垫底', () => {
    const ifaces = {
      'Ethernet 2': [v4('169.254.13.7')],
      WLAN: [v4('10.0.0.8')],
    };
    const list = lan.listLanCandidates({ ifaces, outboundIp: '10.0.0.8', port: 8787 });
    assert.strictEqual(list[0].ip, '10.0.0.8');
    assert.strictEqual(list[list.length - 1].ip, '169.254.13.7');
  });

  check('config.json 的 lanHost 能钉死用哪个地址', () => {
    const list = lan.listLanCandidates({ ifaces: MESSY_NICS, outboundIp: '192.168.1.42', port: 8787, override: '192.168.56.1' });
    assert.strictEqual(list[0].ip, '192.168.56.1', `钉死失败，第一位是 ${list[0].ip}`);
    assert.strictEqual(list[0].recommended, true);
  });

  check('lanHost 写了个本机不存在的地址也不会崩', () => {
    const list = lan.listLanCandidates({ ifaces: MESSY_NICS, outboundIp: '', port: 8787, override: '192.168.9.9' });
    assert.strictEqual(list[0].ip, '192.168.9.9');
    assert.ok(/config\.json/.test(list[0].note), `note 未标记来源：${list[0].note}`);
  });

  console.log('\n曲目匹配算法');
  const phoneValues = ['起风了', '冯沁苑(买辣椒也用券)', '起风了', '325868'];

  check('文本归一化会剥离标点与括号', () => {
    assert.strictEqual(netease.normalize('冯沁苑(买辣椒也用券)'), '冯沁苑买辣椒也用券');
    assert.strictEqual(netease.normalize('Lemon - 米津玄師'), 'lemon米津玄師');
  });

  check('括号内的别名也能匹配上', () => {
    const song = { id: 1, name: '起风了', artists: '冯沁苑(买辣椒也用券)', album: '起风了', duration: 325868 };
    const score = netease.scoreCandidate(song, phoneValues, 325868);
    assert.ok(score.titleScore >= 95, `标题分过低：${score.titleScore}`);
    assert.ok(score.artistScore >= 95, `歌手分过低：${score.artistScore}`);
  });

  check('错误候选项得分明显更低', () => {
    const right = netease.scoreCandidate(
      { id: 1, name: '起风了', artists: '冯沁苑(买辣椒也用券)', album: '起风了', duration: 325868 },
      phoneValues, 325868
    );
    const wrong = netease.scoreCandidate(
      { id: 2, name: '晴天', artists: '周杰伦', album: '叶惠美', duration: 269000 },
      phoneValues, 325868
    );
    assert.ok(right.total > wrong.total + 60, `区分度不足：${right.total} vs ${wrong.total}`);
  });

  check('元数据顺序被打乱也不影响匹配', () => {
    const shuffled = ['冯沁苑(买辣椒也用券)', '325868', '起风了'];
    const score = netease.scoreCandidate(
      { id: 1, name: '起风了', artists: '冯沁苑(买辣椒也用券)', album: '起风了', duration: 325868 },
      shuffled, 325868
    );
    assert.ok(score.titleScore >= 95 && score.artistScore >= 95);
  });

  check('乱码字符串不会被"包含"关系骗到 2 字歌名上', () => {
    const score = netease.scoreCandidate(
      { id: 2122910141, name: 'QQ', artists: 'PHQUASE/ZAQUVA', album: 'QQ', duration: 126093 },
      ['zzzzqqqq 不存在的歌手名 xxxx', 'qqqqzzzz'], 0
    );
    assert.strictEqual(
      netease.isAcceptable(score), false,
      `不该接受，得分 title=${score.titleScore.toFixed(1)} artist=${score.artistScore.toFixed(1)}`
    );
  });

  check('标题强但歌手拼写有差异时仍然接受', () => {
    const score = netease.scoreCandidate(
      { id: 1, name: '海阔天空', artists: 'Beyond', album: '乐与怒', duration: 318000 },
      ['海阔天空', 'BEYOND'], 318000
    );
    assert.strictEqual(netease.isAcceptable(score), true);
  });

  console.log('\n缓存与磁盘');
  const tmpCache = path.join(__dirname, '..', '.cache', 'selftest.json');
  const resolver = new netease.NeteaseResolver({ cacheFile: tmpCache, translationEnabled: true });

  console.log('\n网易云在线接口');
  await checkAsync('搜索接口返回结果', async () => {
    const results = await netease.searchSongs('起风了 买辣椒也用券', 5);
    assert.ok(results.length > 0, '搜索无结果（可能被风控或断网）');
    assert.ok(results[0].id > 0);
  });

  await checkAsync('端到端解析：元数据 → 封面 + 时间轴歌词', async () => {
    const result = await resolver.resolve({ values: phoneValues, durationHint: 325868 });
    assert.ok(result, '解析失败');
    assert.strictEqual(result.matched, true);
    assert.ok(result.title.length > 0);
    assert.ok(/^https:\/\//.test(result.cover), `封面地址异常：${result.cover}`);
    assert.ok(result.lyrics.length > 10, `歌词行数过少：${result.lyrics.length}`);
    assert.ok(result.lyrics[0].t >= 0 && typeof result.lyrics[0].x === 'string');
    const ascending = result.lyrics.every((l, i) => i === 0 || l.t >= result.lyrics[i - 1].t);
    assert.ok(ascending, '歌词时间轴未升序');
    console.log(`      匹配到：《${result.title}》 - ${result.artist}`);
    console.log(`      封面：${result.cover}`);
    console.log(`      歌词：${result.lyrics.length} 行，首行 ${result.lyrics[0].t}ms`);
    console.log(`      示例：${result.lyrics[4] ? result.lyrics[4].x : '-'}`);
  });

  await checkAsync('缓存命中：第二次解析不再走网络', async () => {
    const t0 = Date.now();
    const result = await resolver.resolve({ values: phoneValues, durationHint: 325868 });
    const cost = Date.now() - t0;
    assert.ok(result, '缓存解析失败');
    assert.ok(cost < 60, `缓存命中但耗时 ${cost}ms，疑似又走了网络`);
  });

  await checkAsync('无法匹配的曲目返回 null 而不是抛异常', async () => {
    const result = await resolver.resolve({
      values: ['zzzzqqqq 不存在的歌手名 xxxx', 'qqqqzzzz'],
      durationHint: 0,
    });
    assert.strictEqual(result, null);
  });

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
  try { fs.rmSync(tmpCache, { force: true }); } catch (err) {}
  process.exit(failed ? 1 : 0);
}

main();
