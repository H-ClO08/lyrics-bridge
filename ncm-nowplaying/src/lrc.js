'use strict';

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[(ti|ar|al|by|offset|re|ve|length|kana):(.*)\]$/i;

function toMs(min, sec, frac) {
  let ms = 0;
  if (frac != null && frac !== '') {
    ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac);
  }
  return Number(min) * 60000 + Number(sec) * 1000 + ms;
}

/**
 * 解析标准 LRC 文本。支持一行多个时间标签、[mm:ss]、[mm:ss.xx]、[mm:ss.xxx] 混排。
 * 同时读取 [offset:] 标签并折算进时间轴。
 */
function parseLrc(text, offsetMs = 0) {
  if (!text || typeof text !== 'string') return [];

  const lines = [];
  let fileOffset = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = line.match(META_TAG);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        const parsed = Number(meta[2].trim());
        if (Number.isFinite(parsed)) fileOffset = parsed;
      }
      continue;
    }

    TIME_TAG.lastIndex = 0;
    const stamps = [];
    let match;
    while ((match = TIME_TAG.exec(line)) !== null) {
      stamps.push(toMs(match[1], match[2], match[3]));
    }
    if (!stamps.length) continue;

    const content = line.replace(TIME_TAG, '').trim();
    if (!content) continue;

    for (const stamp of stamps) {
      lines.push({ time: stamp + fileOffset + offsetMs, text: content });
    }
  }

  lines.sort((a, b) => a.time - b.time || a.text.localeCompare(b.text));
  return lines;
}

/**
 * 解析网易云逐字歌词（YRC）。
 * 行格式：[lineStart,lineDuration](wordStart,wordDuration,flag)词(…)
 * 词时间可能是相对行首的偏移，也可能是绝对值——按行首做一次判定。
 */
function parseYrc(text, offsetMs = 0) {
  if (!text || typeof text !== 'string') return [];

  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const head = line.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;

    const lineStart = Number(head[1]) + offsetMs;
    const rest = line.slice(head[0].length);
    const words = [];

    const wordRe = /\((\d+),(\d+),\d+\)([^()]*)/g;
    let m;
    while ((m = wordRe.exec(rest)) !== null) {
      const rawStart = Number(m[1]);
      const dur = Number(m[2]);
      const wordText = m[3];
      if (!wordText) continue;
      const start = rawStart < Number(head[1]) ? lineStart + rawStart : rawStart + offsetMs;
      words.push({ time: start, duration: dur, text: wordText });
    }

    if (!words.length) continue;
    lines.push({
      time: lineStart,
      text: words.map((w) => w.text).join(''),
      words,
    });
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/**
 * 把翻译歌词按时间就近合并到主歌词上。
 */
function mergeTranslation(mainLines, transLines, field = 'trans', toleranceMs = 60) {
  if (!mainLines.length || !transLines || !transLines.length) return mainLines;

  const pool = transLines.slice().sort((a, b) => a.time - b.time);
  let cursor = 0;

  for (const line of mainLines) {
    if (line[field]) continue;
    while (cursor < pool.length && pool[cursor].time < line.time - toleranceMs) cursor += 1;
    if (cursor < pool.length && Math.abs(pool[cursor].time - line.time) <= toleranceMs) {
      line[field] = pool[cursor].text;
    }
  }
  return mainLines;
}

/**
 * 生成用于前端的紧凑歌词结构。
 */
function buildLyrics({ lrc, tlyric, yrc, ytlrc, romalrc }, { offsetMs = 0, withTranslation = true } = {}) {
  let lines = yrc ? parseYrc(yrc, offsetMs) : [];
  if (!lines.length) lines = parseLrc(lrc, offsetMs);

  if (!lines.length) return [];

  if (withTranslation && tlyric) {
    mergeTranslation(lines, parseLrc(tlyric, offsetMs), 'trans');
  }
  if (withTranslation && romalrc) {
    mergeTranslation(lines, parseLrc(romalrc, offsetMs), 'romaji');
  }

  lines = lines.filter((l, i, arr) => i === 0 || l.time !== arr[i - 1].time || l.text !== arr[i - 1].text);

  return lines.map((l) => {
    const item = { t: l.time, x: l.text };
    if (l.trans) item.r = l.trans;
    if (l.romaji) item.m = l.romaji;
    if (l.words && l.words.length) {
      item.w = l.words.map((w) => ({ t: w.time, d: w.duration, x: w.text }));
    }
    return item;
  });
}

/** 没有任何可显示文字时视为纯音乐 / 无歌词 */
function isInstrumental(lines) {
  if (!lines.length) return true;
  return lines.every((l) => !l.x || !l.x.trim());
}

module.exports = {
  parseLrc,
  parseYrc,
  mergeTranslation,
  buildLyrics,
  isInstrumental,
};
