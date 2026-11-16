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

    private fun lyricRaw(songId: Long): Pair<String, String> {
        val url = "https://music.163.com/api/song/lyric?id=$songId&lv=1&kv=1&tv=-1"
        val body = httpText(url) ?: return "" to ""
        return try {
            val j = JSONObject(body)
            val lrc = j.optJSONObject("lrc")?.optString("lyric") ?: ""
            val tlrc = j.optJSONObject("tlyric")?.optString("lyric") ?: ""
            lrc to tlrc
        } catch (e: Exception) {
            "" to ""
        }
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
        val (lrc, tlrc) = lyricRaw(songId)
        val lines = LrcParser.parse(lrc)
        if (tlrc.isNotBlank()) LrcParser.mergeTranslation(lines, LrcParser.parse(tlrc))
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

        val (lrc, tlrc) = lyricRaw(chosen.id)
        val lines = LrcParser.parse(lrc)
        if (tlrc.isNotBlank()) LrcParser.mergeTranslation(lines, LrcParser.parse(tlrc))
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
