package com.ncm.phonebridge

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs

object NeteaseApi {
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    private const val REFERER = "https://music.163.com/"

    /** LRC 行与 YRC 行的时间容差：超出这个范围就不把逐字挂上去。 */
    private const val YRC_MATCH_TOLERANCE_MS = 150L

    data class Song(
        val id: Long,
        val name: String,
        val artists: String,
        val album: String,
        val durationMs: Long
    )

    class Resolved(
        val songId: Long,
        val title: String,
        val artist: String,
        val album: String,
        val durationMs: Long,
        val cover: String?,
        val lines: List<LrcLine>
    )

    private val cache = ConcurrentHashMap<String, Resolved?>()

    fun httpText(url: String, timeoutMs: Int = 8000): String? {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = "GET"
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.setRequestProperty("User-Agent", UA)
            c.setRequestProperty("Referer", REFERER)
            val code = c.responseCode
            if (code !in 200..299) {
                c.disconnect(); return null
            }
            val s = c.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            c.disconnect()
            s
        } catch (e: Exception) {
            null
        }
    }

    fun httpBytes(url: String, timeoutMs: Int = 12000): ByteArray? {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = "GET"
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.setRequestProperty("User-Agent", UA)
            c.setRequestProperty("Referer", REFERER)
            val code = c.responseCode
            if (code !in 200..299) {
                c.disconnect(); return null
            }
            val out = ByteArrayOutputStream()
            c.inputStream.use { it.copyTo(out) }
            c.disconnect()
            out.toByteArray()
        } catch (e: Exception) {
            null
        }
    }

    fun search(query: String, limit: Int = 10): List<Song> {
        val q = URLEncoder.encode(query, "UTF-8")
        val url = "https://music.163.com/api/search/get/web?s=$q&type=1&limit=$limit"
        val body = httpText(url) ?: return emptyList()
        return try {
            val j = JSONObject(body)
            val result = j.optJSONObject("result") ?: return emptyList()
            val songs = result.optJSONArray("songs") ?: return emptyList()
            val out = ArrayList<Song>()
            for (i in 0 until songs.length()) {
                val s = songs.getJSONObject(i)
                val arr = s.optJSONArray("artists") ?: s.optJSONArray("ar")
                val artists = if (arr != null) {
                    (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("name") }
                        .filter { it.isNotBlank() }.joinToString("/")
                } else ""
                val albumObj = s.optJSONObject("album") ?: s.optJSONObject("al")
                out.add(
                    Song(
                        id = s.optLong("id"),
                        name = s.optString("name"),
                        artists = artists,
                        album = albumObj?.optString("name") ?: "",
                        durationMs = s.optLong("duration")
                    )
                )
            }
            out
        } catch (e: Exception) {
            emptyList()
        }
    }

    /** 一次歌词请求的结果：主歌词 / 翻译 / 逐字。 */
    private data class LyricSet(val lrc: String, val tlrc: String, val yrc: String) {
        val isEmpty: Boolean get() = lrc.isBlank() && yrc.isBlank()
    }

    private fun parseLyricBody(body: String): LyricSet = try {
        val j = JSONObject(body)
        LyricSet(
            lrc = j.optJSONObject("lrc")?.optString("lyric", "") ?: "",
            tlrc = j.optJSONObject("tlyric")?.optString("lyric", "") ?: "",
            yrc = j.optJSONObject("yrc")?.optString("lyric", "") ?: ""
        )
    } catch (e: Exception) {
        LyricSet("", "", "")
    }

    /**
     * 取歌词。
     *
     * 关键：必须用 lv=-1 这一组参数。lv=1 在部分曲目（典型是较新的 / 冷门曲目）上
     * 会返回空字符串，而 lv=-1 能正常返回带时间轴的原始歌词 —— 例如
     * 《梦角补完计划》(3353204724)：lv=1 → 0 字符，lv=-1 → 1281 字符。
     * 老参数保留成兜底，以防个别曲目反过来只有 lv=1 有内容。
     */
    private fun lyricRaw(songId: Long): LyricSet {
        val full = "https://music.163.com/api/song/lyric?id=$songId" +
            "&lv=-1&kv=-1&tv=-1&rv=-1&yv=1&ytv=1&ytl=1&yrv=1"
        httpText(full)?.let { body ->
            val parsed = parseLyricBody(body)
            if (!parsed.isEmpty) return parsed
        }
        val legacy = "https://music.163.com/api/song/lyric?id=$songId&lv=1&kv=1&tv=-1"
        httpText(legacy)?.let { body ->
            val parsed = parseLyricBody(body)
            if (!parsed.isEmpty) return parsed
        }
        return LyricSet("", "", "")
    }

    /**
     * 组装歌词。
     *
     * 以 LRC 为骨架：分词/分行/标点都沿用网易云原始歌词，和 v1.5.4 的观感一致。
     * YRC 只用来给对应行补逐字时间轴 —— 不能拿 YRC 直接当主结构，它的分行是按演唱
     * 切分的，和 LRC 的整句不是一一对应，直接替换会让歌词文本和行数都变样。
     * 只有在 LRC 完全没有内容时，才退化为纯 YRC。
     */
    private fun buildLines(set: LyricSet): MutableList<LrcLine> {
        val lrcLines = LrcParser.parse(set.lrc)
        val yrcLines = if (set.yrc.isNotBlank()) LrcParser.parseYrc(set.yrc) else ArrayList()

        val lines: MutableList<LrcLine> = if (lrcLines.isNotEmpty()) lrcLines else yrcLines

        // 逐字只在两边行时间能对上（±150ms）时才挂，对不上就保持整行高亮，
        // 避免歌词版本不同导致逐字错位。
        if (lrcLines.isNotEmpty() && yrcLines.isNotEmpty()) {
            var j = 0
            for (line in lines) {
                while (j < yrcLines.size && yrcLines[j].time < line.time - YRC_MATCH_TOLERANCE_MS) j++
                val cand = yrcLines.getOrNull(j) ?: continue
                if (cand.words.isNullOrEmpty()) continue
                if (kotlin.math.abs(cand.time - line.time) <= YRC_MATCH_TOLERANCE_MS) {
                    line.words = cand.words
                }
            }
        }

        if (lines.isNotEmpty() && set.tlrc.isNotBlank()) {
            LrcParser.mergeTranslation(lines, LrcParser.parse(set.tlrc))
        }
        return lines
    }

    /**
     * 网易云确实没有歌词时的兜底。LRCLIB 免费、无需鉴权，返回标准 LRC。
     *
     * 注意：LRCLIB 的 search 是全文检索，会把"garden shameless."匹配成
     * 《Shameless Shadow》- The Garden 这种别的歌。所以每个候选都必须过一遍
     * 曲名 / 歌手 / 时长校验，宁可返回空，也不能把别人的歌词挂上来。
     */
    private fun lrclibLyrics(
        title: String,
        artist: String,
        album: String,
        durationMs: Long
    ): MutableList<LrcLine> {
        if (title.isBlank()) return ArrayList()
        val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
        val urls = ArrayList<String>()
        if (durationMs > 0) {
            urls.add(
                "https://lrclib.net/api/get?artist_name=${enc(artist)}&track_name=${enc(title)}" +
                    "&album_name=${enc(album)}&duration=${durationMs / 1000}"
            )
        }
        urls.add(
            "https://lrclib.net/api/search?q=" +
                enc(listOf(title, artist).filter { it.isNotBlank() }.joinToString(" "))
        )

        for (u in urls) {
            val body = httpText(u, 9000) ?: continue
            val candidates = try {
                if (body.trimStart().startsWith("[")) {
                    val arr = org.json.JSONArray(body)
                    (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                } else {
                    listOf(JSONObject(body))
                }
            } catch (e: Exception) {
                continue
            }

            for (c in candidates) {
                val name = c.optString("trackName", "")
                val by = c.optString("artistName", "")
                val durSec = c.optDouble("duration", 0.0)
                if (!lrclibAcceptable(name, by, durSec, title, artist, durationMs)) continue
                val synced = c.optString("syncedLyrics", "")
                if (synced.isBlank()) continue
                val lines = LrcParser.parse(synced)
                if (lines.isNotEmpty()) return lines
            }
        }
        return ArrayList()
    }

    /** LRCLIB 候选的准入检查：曲名要像，歌手要对得上，时长不能差太多。 */
    private fun lrclibAcceptable(
        name: String,
        by: String,
        durSec: Double,
        title: String,
        artist: String,
        durationMs: Long
    ): Boolean {
        if (name.isBlank()) return false
        if (similarity(name, title) < 80) return false
        if (artist.isNotBlank() && similarity(by, artist) < 55) return false
        if (durationMs > 0 && durSec > 0) {
            val diff = abs((durSec * 1000).toLong() - durationMs)
            if (diff > 15000) return false
        }
        return true
    }

    private fun coverUrl(songId: Long): String? {
        val url = "https://music.163.com/api/song/detail?ids=[$songId]"
        val body = httpText(url) ?: return null
        return try {
            val j = JSONObject(body)
            val songs = j.optJSONArray("songs") ?: return null
            if (songs.length() == 0) return null
            songs.getJSONObject(0).optJSONObject("album")?.optString("picUrl")
        } catch (e: Exception) {
            null
        }
    }

    data class Detail(
        val title: String,
        val artist: String,
        val album: String,
        val durationMs: Long,
        val cover: String?
    )

    fun detail(songId: Long): Detail? {
        val url = "https://music.163.com/api/song/detail?ids=[$songId]"
        val body = httpText(url) ?: return null
        return try {
            val j = JSONObject(body)
            val songs = j.optJSONArray("songs") ?: return null
            if (songs.length() == 0) return null
            val s = songs.getJSONObject(0)
            val arr = s.optJSONArray("artists")
            val artist = if (arr != null) {
                (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("name") }
                    .filter { it.isNotBlank() }.joinToString("/")
            } else ""
            val albumObj = s.optJSONObject("album")
            Detail(
                title = s.optString("name"),
                artist = artist,
                album = albumObj?.optString("name") ?: "",
                durationMs = s.optLong("duration"),
                cover = albumObj?.optString("picUrl")
            )
        } catch (e: Exception) {
            null
        }
    }

    fun resolveById(songId: Long): Resolved? {
        val d = detail(songId) ?: return null
        var lines = buildLines(lyricRaw(songId))
        if (lines.isEmpty()) {
            lines = lrclibLyrics(d.title, d.artist, d.album, d.durationMs)
        }
        return Resolved(
            songId = songId,
            title = d.title,
            artist = d.artist,
            album = d.album,
            durationMs = d.durationMs,
            cover = d.cover,
            lines = lines
        )
    }

    private fun normalize(s: String): String = s.lowercase()
        .replace(Regex("[\\s\\-_.·、,，。!！?？'\"()（）\\[\\]【】&+/|:~]"), "")
        .replace(Regex("\\((feat|ft|live|remaster|cover)[^)]*\\)"), "")

    private fun similarity(a: String, b: String): Int {
        val x = normalize(a)
        val y = normalize(b)
        if (x.isEmpty() || y.isEmpty()) return 0
        if (x == y) return 100
        val longer = if (x.length >= y.length) x else y
        val shorter = if (x.length >= y.length) y else x
        if (longer.contains(shorter)) {
            return (60 + 40 * shorter.length / longer.length).coerceAtMost(98)
        }
        val setA = x.toSet()
        val setB = y.toSet()
        val inter = setA.intersect(setB).size
        val union = setA.union(setB).size
        if (union == 0) return 0
        return (inter * 100 / union).coerceIn(0, 80)
    }

    /**
     * 候选是否够格。
     *
     * 旧逻辑只要求歌名相似度 ≥62，歌手和时长完全不设限，冷门歌很容易匹配到同名的
     * 热门歌。以前 lv=1 取不到词时表现为"无歌词"，改成 lv=-1 之后就直接把别人的
     * 歌词显示出来了。这里收紧成"歌名足够强，或歌名中等但歌手能互相印证"，
     * 并用时长兜一道硬门槛。
     */
    private fun isAcceptable(
        candidate: Song,
        title: String,
        artist: String,
        durationMs: Long
    ): Boolean {
        val t = similarity(candidate.name, title)
        val a = if (artist.isBlank()) -1 else similarity(candidate.artists, artist)
        val durDiff = if (durationMs > 0 && candidate.durationMs > 0) {
            abs(candidate.durationMs - durationMs)
        } else {
            -1L
        }

        if (durDiff > 25000) return false

        // 拿不到歌手时只剩歌名和时长可依，门槛要更严
        if (a < 0) return t >= 88 && (durDiff < 0 || durDiff <= 10000)

        // 歌名非常强：歌手只需不离谱
        if (t >= 88) return a >= 40
        // 歌名中等：歌手要能对上
        if (t >= 72 && a >= 55) return true
        // 歌名偏弱：歌手高度一致且时长吻合
        return t >= 62 && a >= 80 && durDiff in 0..5000
    }

    fun resolve(
        title: String,
        artist: String,
        album: String,
        durationMs: Long,
        force: Boolean = false
    ): Resolved? {
        if (title.isBlank()) return null
        val key = "$title|$artist|${durationMs / 1000}"
        if (!force) cache[key]?.let { return it }

        val queries = LinkedHashSet<String>()
        queries.add(listOf(title, artist).filter { it.isNotBlank() }.joinToString(" "))
        if (album.isNotBlank()) queries.add(listOf(title, album).filter { it.isNotBlank() }.joinToString(" "))
        queries.add(title)

        var best: Song? = null
        var bestScore = -1
        val seen = HashSet<Long>()
        for (q in queries) {
            for (s in search(q, 10)) {
                if (!seen.add(s.id)) continue
                val titleScore = similarity(s.name, title)
                // 时长差得离谱的候选直接排除：同名不同歌（garden 这种一抓一把）靠时长区分，
                // 宁可无歌词，也不显示另一首歌的词。
                if (durationMs > 0 && s.durationMs > 0 &&
                    abs(s.durationMs - durationMs) > 25000
                ) continue
                var score = titleScore * 2
                if (artist.isNotBlank()) {
                    val aScore = similarity(s.artists, artist)
                    score += aScore
                    if (aScore >= 60) score += 40
                }
                if (durationMs > 0 && s.durationMs > 0) {
                    val diff = abs(s.durationMs - durationMs)
                    if (diff <= 3000) score += 50 else if (diff <= 8000) score += 15
                }
                if (score > bestScore) {
                    bestScore = score
                    best = s
                }
            }
            val b = best
            if (b != null) {
                val tScore = similarity(b.name, title)
                if (tScore >= 95 && (artist.isBlank() || similarity(b.artists, artist) >= 60)) break
            }
        }

        val chosen = best
        if (chosen == null || !isAcceptable(chosen, title, artist, durationMs)) {
            cache[key] = null
            return null
        }

        var lines = buildLines(lyricRaw(chosen.id))
        if (lines.isEmpty()) {
            lines = lrclibLyrics(chosen.name, chosen.artists, chosen.album, chosen.durationMs)
        }
        val resolved = Resolved(
            songId = chosen.id,
            title = chosen.name,
            artist = chosen.artists,
            album = chosen.album,
            durationMs = chosen.durationMs,
            cover = coverUrl(chosen.id),
            lines = lines
        )
        if (cache.size > 60) cache.clear()
        cache[key] = resolved
        return resolved
    }
}
