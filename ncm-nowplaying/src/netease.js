'use strict';

const fs = require('fs');
const path = require('path');
const lrc = require('./lrc');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Cookie: 'appver=2.10.6; os=pc;',
  Accept: 'application/json, text/plain, */*',
};

const API = {
  search: (q, limit) =>
    `https://music.163.com/api/search/get/web?type=1&offset=0&limit=${limit}&s=${encodeURIComponent(q)}`,
  detail: (ids) => `https://music.163.com/api/song/detail?ids=[${ids.join(',')}]`,
  lyric: (id) => `https://music.163.com/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1&rv=-1&yv=1&ytv=1&ytl=1&yrv=1`,
};

// ---------------------------------------------------------------------------
// 文本归一化与相似度
// ---------------------------------------------------------------------------

/** 去掉所有标点、空格、全角符号，只保留字母/数字/汉字。这样 "冯沁苑(买辣椒也用券)" 能命中 "买辣椒也用券" */
function normalize(input) {
  return String(input == null ? '' : input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/** 0..100 的相似度，兼顾完全相等、包含关系与编辑距离 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  let score = dice(a, b) * 85;
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    score = Math.max(score, 60 + ratio * 38);
  }
  return score;
}

/**
 * 对一首候选歌曲打分。
 * 关键点：手机端 dumpsys 给出的 title/artist/album 顺序不固定（Bundle 迭代顺序），
 * 因此这里对每个字段都在「所有候选字符串」里取最大值，而不是依赖位置。
 */
function scoreCandidate(song, values, durationHint) {
  const title = normalize(song.name);
  const artist = normalize(song.artists);
  const album = normalize(song.album);

  let titleScore = 0;
  let artistScore = 0;
  let albumScore = 0;

  for (const value of values) {
    const nv = normalize(value);
    if (!nv) continue;
    titleScore = Math.max(titleScore, similarity(title, nv));
    artistScore = Math.max(artistScore, similarity(artist, nv));
    albumScore = Math.max(albumScore, similarity(album, nv));
  }

  let total = titleScore + artistScore * 0.55 + albumScore * 0.12;

  if (durationHint && song.duration) {
    const diff = Math.abs(song.duration - durationHint);
    if (diff <= 2000) total += 18;
    else if (diff <= 5000) total += 8;
    else if (diff > 20000) total -= 25;
  }

  return { total, titleScore, artistScore, albumScore };
}

/**
 * 候选是否需要被接受。
 * 单看标题容易误判（短歌名被长字符串"包含"就能骗到分），
 * 所以规则是：标题足够强，或者标题中等但歌手能互相印证。
 */
function isAcceptable(score) {
  if (!score) return false;
  if (score.titleScore >= 85) return true;
  return score.titleScore >= 70 && score.artistScore >= 50;
}

function buildQueries(values, max) {
  const cleaned = values.map((v) => String(v || '').trim()).filter((v) => v.length > 0);
  const queries = [];
  const push = (q) => {
    const t = q.replace(/\s+/g, ' ').trim();
    if (t.length >= 2 && !queries.includes(t)) queries.push(t);
  };

  push(cleaned.join(' '));
  push(cleaned.slice(0, 2).join(' '));
  for (const v of cleaned) push(v);
  return queries.slice(0, Math.max(1, max));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function getJson(url, timeoutMs = 9000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`响应不是合法 JSON（可能被风控）：${text.slice(0, 120)}`);
  }
}

async function searchSongs(keyword, limit = 10) {
  const data = await getJson(API.search(keyword, limit));
  const songs = (data && data.result && data.result.songs) || [];
  return songs.map((s) => ({
    id: s.id,
    name: s.name,
    artists: (s.artists || s.ar || []).map((a) => a.name).join('/'),
    album: (s.album && s.album.name) || (s.al && s.al.name) || '',
    duration: s.duration || (s.dt ? s.dt : 0),
  }));
}

async function fetchDetail(id) {
  const data = await getJson(API.detail([id]));
  const song = data && data.songs && data.songs[0];
  if (!song) return null;
  return {
    id: song.id,
    name: song.name,
    artists: (song.artists || song.ar || []).map((a) => a.name).join('/'),
    album: (song.album && song.album.name) || '',
    picUrl: (song.album && song.album.picUrl) || '',
    duration: song.duration || (song.dt ? song.dt : 0),
  };
}

async function fetchLyric(id) {
  try {
    const data = await getJson(API.lyric(id));
    return {
      lrc: (data.lrc && data.lrc.lyric) || '',
      tlyric: (data.tlyric && data.tlyric.lyric) || '',
      romalrc: (data.romalrc && data.romalrc.lyric) || '',
      yrc: (data.yrc && data.yrc.lyric) || '',
    };
  } catch (err) {
    return { lrc: '', tlyric: '', romalrc: '', yrc: '', error: err.message };
  }
}

function coverUrl(picUrl, size = 640) {
  if (!picUrl) return '';
  const base = picUrl.split('?')[0];
  return `${base}?param=${size}y${size}`;
}

// ---------------------------------------------------------------------------
// 解析器：带内存 + 磁盘缓存
// ---------------------------------------------------------------------------

class NeteaseResolver {
  constructor(config = {}) {
    this.config = config;
    this.cache = new Map();
    this.inflight = new Map();
    this.cacheMax = config.cacheMaxEntries || 300;
    this.cacheFile = config.cacheFile
      ? path.resolve(config.cacheFile)
      : path.resolve('.cache/netease.json');
    this._dirty = false;
    this._load();
    this._flushTimer = setInterval(() => this._flush(), 5000);
    this._flushTimer.unref?.();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.cacheFile, 'utf8');
      const obj = JSON.parse(raw);
      for (const [key, value] of Object.entries(obj)) this.cache.set(key, value);
    } catch (err) {
      /* 首次运行没有缓存文件，正常 */
    }
  }

  _flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const entries = [...this.cache.entries()].slice(-this.cacheMax);
      fs.writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(entries), null, 0), 'utf8');
    } catch (err) {
      /* 缓存写失败不影响主流程 */
    }
  }

  _remember(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.cacheMax) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this._dirty = true;
  }

  _decorate(entry) {
    if (!entry) return null;
    const lyrics = lrc.buildLyrics(
      {
        lrc: entry.lrcText,
        tlyric: entry.transText,
        romalrc: entry.romajiText,
        yrc: entry.yrcText,
      },
      { offsetMs: this.config.lyricOffsetMs || 0, withTranslation: this.config.translationEnabled !== false }
    );
    return {
      songId: entry.songId,
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      duration: entry.duration,
      cover: coverUrl(entry.picUrl, this.config.coverSize || 640),
      matched: true,
      matchScore: entry.matchScore,
      hasLyrics: !lrc.isInstrumental(lyrics),
      lyrics,
    };
  }

  /**
   * 核心入口：用手机上报的元数据字符串解析出完整曲目信息。
   * @param {object} opts
   * @param {string[]} opts.values  手机端拿到的所有元数据字符串（顺序不可信）
   * @param {number}  [opts.durationHint] 手机端上报的时长（毫秒）
   * @param {number}  [opts.pinnedSongId] 用户手动指定的歌曲 ID，直接跳过搜索
   * @param {boolean} [opts.forceRefresh]
   */
  async resolve({ values = [], durationHint = 0, pinnedSongId = 0, forceRefresh = false }) {
    const signature = pinnedSongId
      ? `pin:${pinnedSongId}`
      : `m:${values.map(normalize).filter(Boolean).join('|')}`;

    if (!forceRefresh) {
      const hit = this.cache.get(signature);
      if (hit) {
        if (hit.__miss) return null;
        return this._decorate(hit);
      }
    }

    if (this.inflight.has(signature)) return this.inflight.get(signature);

    const task = this._resolveUncached({ values, durationHint, pinnedSongId })
      .then((entry) => {
        // undefined 表示网络临时故障，不写缓存，下次还能重试
        if (entry === undefined) return null;
        this._remember(signature, entry || { __miss: true });
        return entry ? this._decorate(entry) : null;
      })
      .finally(() => this.inflight.delete(signature));

    this.inflight.set(signature, task);
    return task;
  }

  async _resolveUncached({ values, durationHint, pinnedSongId }) {
    let best = null;
    let bestScore = null;

    if (pinnedSongId) {
      const detail = await fetchDetail(pinnedSongId);
      if (!detail) return null;
      best = detail;
      bestScore = { total: 999, titleScore: 100, artistScore: 100, albumScore: 100 };
    } else {
      const queries = buildQueries(values, this.config.searchFallbackQueries || 4);
      const seen = new Map();
      let networkErrors = 0;

      for (const query of queries) {
        let results = [];
        try {
          results = await searchSongs(query, 10);
        } catch (err) {
          networkErrors += 1;
          continue;
        }
        for (const song of results) {
          if (seen.has(song.id)) continue;
          const score = scoreCandidate(song, values, durationHint);
          seen.set(song.id, { song, score });
          if (!bestScore || score.total > bestScore.total) {
            best = song;
            bestScore = score;
          }
        }
        // 已经足够可信就不再多打接口
        if (bestScore && bestScore.titleScore >= 88 && bestScore.artistScore >= 60) break;
      }

      // 所有查询都失败了：属于临时性故障，不要把结果写进缓存
      if (!seen.size && networkErrors === queries.length) return undefined;
      if (!best || !isAcceptable(bestScore)) return null;
    }

    const [detail, lyrics] = await Promise.all([fetchDetail(best.id), fetchLyric(best.id)]);
    const info = detail || best;

    return {
      songId: info.id,
      title: info.name,
      artist: info.artists,
      album: info.album,
      duration: info.duration || 0,
      picUrl: info.picUrl || '',
      matchScore: Math.round(bestScore.total),
      lrcText: lyrics.lrc,
      transText: lyrics.tlyric,
      romajiText: lyrics.romalrc,
      yrcText: lyrics.yrc,
      cachedAt: Date.now(),
    };
  }

  /** 供前端「手动纠正」用 */
  async search(keyword, limit = 12) {
    const results = await searchSongs(keyword, limit);
    return results.map((s) => ({
      songId: s.id,
      title: s.name,
      artist: s.artists,
      album: s.album,
      duration: s.duration,
    }));
  }

  stats() {
    return { cached: this.cache.size, file: this.cacheFile };
  }
}

module.exports = {
  NeteaseResolver,
  normalize,
  similarity,
  scoreCandidate,
  isAcceptable,
  buildQueries,
  searchSongs,
  fetchDetail,
  fetchLyric,
  coverUrl,
};
