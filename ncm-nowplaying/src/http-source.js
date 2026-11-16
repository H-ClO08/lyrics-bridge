'use strict';

/**
 * HTTP 数据源：直接从手机 App（ncm-phone-bridge）读取播放状态。
 *
 * 为什么需要它：手机 App 自己就已经读到了网易云的播放信息、并匹配好了
 * 封面和歌词。电脑端只要把这份状态拉过来，就能同时喂给：
 *   - 网页显示页（浏览器）
 *   - smtc-bridge.ps1（伪造成 Windows 媒体会话 → BetterLyrics）
 * 于是整条链路里 **不再需要 adb、也不需要开发者选项**。
 *
 * 手机接口 /api/state 返回：
 *   {
 *     status: 'idle' | 'playing' | 'paused',
 *     serverNowMs: <手机时钟 ms>,
 *     track:    { title, artist, album, duration, songId?, cover?, matched },
 *     anchor:   { position, serverTime, speed },     // serverTime 用手机时钟
 *     lyrics:   [ { t, x, r? } ]
 *   }
 *
 * 关键点：anchor.serverTime 是**手机的**时钟，电脑端必须换算成本机时钟，
 * 否则前端按本地时间外推出来的进度会整体平移。所以每次请求都记录
 * t0/t1，用返回的 serverNowMs 估算两台设备的时钟偏移。
 */

const { EventEmitter } = require('events');

class HttpSource extends EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log || (() => {});
    this.url = String(config.phoneUrl || '').trim().replace(/\/+$/, '');
    this.running = false;
    this._timer = null;
    this._fails = 0;
    this.status = { connected: false, error: '', lastAt: 0 };
  }

  get available() {
    return !!this.url;
  }

  start() {
    if (this.running) return;
    if (!this.url) {
      this.log('未配置 phoneUrl，跳过手机 HTTP 数据源');
      return;
    }
    this.running = true;
    this.log(`手机 HTTP 数据源：${this.url}`);
    this._loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
  }

  async _loop() {
    if (!this.running) return;
    try {
      await this._tick();
    } catch (err) {
      this.log('手机 HTTP 轮询异常:', err.message);
    }
    if (!this.running) return;
    this._timer = setTimeout(() => this._loop(), Math.max(400, this.config.httpIntervalMs || 1500));
    this._timer.unref?.();
  }

  async _tick() {
    const t0 = Date.now();
    let data;
    try {
      const res = await fetch(this.url + '/api/state', {
        signal: AbortSignal.timeout(this.config.httpTimeoutMs || 4000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (err) {
      this._fails += 1;
      this.status.connected = false;
      this.status.error = err.message;
      // 只在第一次和第 20/40/60… 次提示，避免手机没开 App 时刷屏
      if (this._fails === 1 || this._fails % 20 === 0) {
        this.log(`读取手机状态失败（第 ${this._fails} 次）：${err.message}`);
        if (this._fails === 1) {
          this.log('  请确认：手机 App 已点「启动服务」、手机与电脑在同一 Wi-Fi、phoneUrl 地址正确。');
        }
      }
      this.emit('state', { ok: false, error: err.message });
      return;
    }

    const t1 = Date.now();
    this._fails = 0;
    this.status.connected = true;
    this.status.error = '';
    this.status.lastAt = t1;

    // 时钟偏移 = 手机时钟 − 电脑时钟（用请求往返中点估计，抵消一半网络延迟）
    const phoneNow = Number(data.serverNowMs) || 0;
    const offset = phoneNow ? phoneNow - Math.round((t0 + t1) / 2) : 0;

    this.emit('state', { ok: true, data, rtt: t1 - t0, offset });
  }
}

module.exports = { HttpSource };
