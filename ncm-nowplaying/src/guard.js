'use strict';

/**
 * 写操作的「来源」校验。
 *
 * 这个服务没有密码：局域网里的设备只要知道地址就能用。这是刻意的（平板扫码即用），
 * 但它带来一个副作用 —— 你在浏览器里随手打开的任意网页，也能悄悄向
 * http://<你的电脑>:8787/api/... 发请求。
 *
 * 浏览器在这种跨站请求上会自动带上 Sec-Fetch-Site / Origin，所以不需要配置、
 * 不需要口令，就能把「网页偷偷干的」和「你自己页面上点的」区分开：
 *
 *   - Sec-Fetch-Site: cross-site      -> 拒
 *   - Origin 存在且与 Host 不同        -> 拒
 *   - 声明了非 JSON 的请求体            -> 拒（跨站表单只能发 simple content-type）
 *
 * 它挡不住「同一局域网里用 curl 直接调」的攻击者 —— 那种必须有口令才行，
 * 而口令会让平板每次都要输。取舍写在 README 的「账号与隐私」一节。
 */

const SAFE_REASON = {
  'cross-site': '跨站请求被拒绝（这个接口只接受本页面发起的调用）',
  'origin-mismatch': '请求来源与本站不一致，已拒绝',
  'bad-origin': 'Origin 头无法解析，已拒绝',
  'content-type': '写接口只接受 application/json',
};

function deny(reason) {
  return { ok: false, reason, error: SAFE_REASON[reason] || '请求被拒绝' };
}

/** 只看请求头，不碰请求体；调用方在 readBodyAny 之前调它。 */
function checkWrite(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return deny('cross-site');

  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch (err) {
      return deny('bad-origin');
    }
    if (host !== req.headers.host) return deny('origin-mismatch');
  }

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct && !ct.includes('application/json')) return deny('content-type');

  return { ok: true };
}

module.exports = { checkWrite };
