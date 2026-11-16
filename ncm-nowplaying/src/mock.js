'use strict';

const { EventEmitter } = require('events');

const PLAYLIST = [
  { values: ['起风了', '买辣椒也用券', '起风了'], duration: 325868 },
  { values: ['海阔天空', 'Beyond', '乐与怒'], duration: 318000 },
  { values: ['Lemon', '米津玄師', 'BOOTLEG'], duration: 256000 },
];

/** 演示源：用一个虚拟时钟模拟手机端播放，全程走和 ADB 完全相同的下游链路 */
class MockSource extends EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log || (() => {});
    this.running = false;
    this.index = 0;
    this.startedAt = Date.now();
    this._timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log(`演示模式启动，共 ${PLAYLIST.length} 首曲目循环播放`);
    this._tick();
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
  }

  _tick() {
    const emit = () => {
      const item = PLAYLIST[this.index % PLAYLIST.length];
      const elapsed = Date.now() - this.startedAt;
      if (elapsed >= item.duration) {
        this.index += 1;
        this.startedAt = Date.now();
      }
      const current = PLAYLIST[this.index % PLAYLIST.length];
      const position = Math.min(Date.now() - this.startedAt, current.duration);
      this.emit('track', {
        kind: 'track',
        changed: false,
        package: 'com.netease.cloudmusic.demo',
        values: current.values,
        duration: current.duration,
        playing: true,
        stateName: 'playing',
        stateCode: 3,
        anchor: { position, serverTime: Date.now(), speed: 1, updated: position, rawPosition: position, stateCode: 3 },
        latencyMs: 0,
        at: Date.now(),
      });
    };
    emit();
    this._timer = setInterval(emit, Math.max(250, this.config.pollIntervalMs || 900));
    this._timer.unref?.();
  }
}

module.exports = { MockSource, PLAYLIST };
