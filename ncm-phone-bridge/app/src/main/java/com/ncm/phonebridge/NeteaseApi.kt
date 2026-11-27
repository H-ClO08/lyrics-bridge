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

    private fun buildLines(set: LyricSet): MutableList<LrcLine> {
        var lines: MutableList<LrcLine> =
            if (set.yrc.isNotBlank()) LrcParser.parseYrc(set.yrc) else ArrayList()
        if (lines.isEmpty()) lines = LrcParser.parse(set.lrc)
        if (lines.isNotEmpty() && set.tlrc.isNotBlank()) {
            LrcParser.mergeTranslation(lines, LrcParser.parse(set.tlrc))
        }
        return lines
    }

    /**
     * 网易云确实没有歌词时的兜底。LRCLIB 免费、无需鉴权，返回标准 LRC。
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
            val synced = try {
                if (body.trimStart().startsWith("[")) {
                    val arr = org.json.JSONArray(body)
                    (0 until arr.length())
                        .mapNotNull { arr.optJSONObject(it) }
                        .firstOrNull { it.optString("syncedLyrics", "").isNotBlank() }
                        ?.optString("syncedLyrics", "")
                } else {
                    JSONObject(body).takeIf { it.optString("syncedLyrics", "").isNotBlank() }
                        ?.optString("syncedLyrics", "")
                }
            } catch (e: Exception) {
                null
            }
            if (!synced.isNullOrBlank()) {
                val lines = LrcParser.parse(synced)
                if (lines.isNotEmpty()) return lines
            }
        }
        return ArrayList()
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
        if (chosen == null || similarity(chosen.name, title) < 62) {
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
