package com.ncm.phonebridge

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors

object ResolvedStore {
    @Volatile
    var current: NeteaseApi.Resolved? = null

    @Volatile
    var forKey: String = ""

    @Volatile
    var pinnedKey: String = ""

    @Volatile
    var pinnedSongId: Long = 0L
}

class BridgeHttpServer(private val port: Int, private val context: Context) {

    private var serverSocket: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(6)

    @Volatile
    var running = false
        private set

    fun start() {
        if (running) return
        NeteaseAccount.init(context)
        serverSocket = ServerSocket(port)
        running = true
        Thread {
            while (running) {
                val sock = try {
                    serverSocket?.accept()
                } catch (e: Exception) {
                    null
                } ?: continue
                pool.execute { handle(sock) }
            }
        }.apply { isDaemon = true }.start()
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (e: Exception) {
        }
        serverSocket = null
    }

    private fun handle(sock: Socket) {
        try {
            sock.soTimeout = 15000
            val input = sock.getInputStream()
            val header = readHeader(input) ?: return
            val lines = header.split("\r\n")
            val first = lines.firstOrNull() ?: return
            val parts = first.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val rawPath = parts[1]
            val qi = rawPath.indexOf('?')
            val path = if (qi >= 0) rawPath.substring(0, qi) else rawPath
            val query = if (qi >= 0) parseQuery(rawPath.substring(qi + 1)) else emptyMap()

            var contentLength = 0
            for (l in lines) {
                val idx = l.indexOf(':')
                if (idx > 0 && l.substring(0, idx).trim().equals("Content-Length", true)) {
                    contentLength = l.substring(idx + 1).trim().toIntOrNull() ?: 0
                }
            }
            val body = readBody(input, contentLength)
            route(sock, method, path, query, body)
        } catch (e: Exception) {
        } finally {
            try {
                sock.close()
            } catch (e: Exception) {
            }
        }
    }

    private fun readHeader(input: InputStream): String? {
        val sb = StringBuilder()
        var count = 0
        while (true) {
            val c = input.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            sb.append(c.toChar())
            count++
            if (count > 65536) return null
            if (sb.length >= 4 && sb.endsWith("\r\n\r\n")) return sb.toString()
        }
    }

    private fun readBody(input: InputStream, len: Int): String {
        if (len <= 0) return ""
        val buf = ByteArray(minOf(len, 1 shl 20))
        var off = 0
        while (off < len) {
            val n = input.read(buf, 0, minOf(buf.size, len - off))
            if (n < 0) break
            off += n
        }
        return String(buf, 0, off, Charsets.UTF_8)
    }

    private fun parseQuery(q: String): Map<String, String> {
        val out = HashMap<String, String>()
        for (pair in q.split("&")) {
            if (pair.isEmpty()) continue
            val i = pair.indexOf('=')
            if (i < 0) {
                out[dec(pair)] = ""
            } else {
                out[dec(pair.substring(0, i))] = dec(pair.substring(i + 1))
            }
        }
        return out
    }

    private fun dec(s: String): String = try {
        URLDecoder.decode(s, "UTF-8")
    } catch (e: Exception) {
        s
    }

    private fun route(sock: Socket, method: String, path: String, query: Map<String, String>, body: String) {
        if (method == "OPTIONS") {
            respond(sock, "204 No Content", "text/plain", ByteArray(0))
            return
        }
        when (path) {
            "/", "/index.html" -> serveAsset(sock, "index.html", "text/html; charset=utf-8")
            "/api/state" -> respondJson(sock, stateJson())
            "/api/nowplaying" -> respondJson(sock, nowPlayingJson())
            "/api/info" -> respondJson(sock, infoJson())
            "/api/search" -> respondJson(sock, searchJson(query["q"] ?: "", query["limit"]?.toIntOrNull() ?: 12))
            "/api/pin" -> respondJson(sock, pinJson(body))
            "/api/refresh" -> {
                ResolvedStore.current = null
                ResolvedStore.forKey = ""
                respondJson(sock, JSONObject().put("ok", true))
            }
            "/api/prefs" -> {
                if (method == "POST") {
                    respondJson(sock, savePrefs(body))
                } else {
                    respondJson(sock, JSONObject().put("ok", true).put("prefs", loadPrefs()))
                }
            }
            "/api/cover" -> proxyCover(sock, query["url"])
            "/api/art" -> serveArt(sock)
            "/api/control" -> respondJson(sock, controlJson(method, query, body))
            // 网易云账号：扫码登录 / 收藏。全部在手机上完成，不需要电脑。
            "/api/account" -> respondJson(sock, NeteaseAccount.info())
            "/api/account/qr" -> respondJson(sock, accountQrJson(method, query))
            "/api/account/logout" -> {
                NeteaseAccount.logout()
                respondJson(sock, NeteaseAccount.info())
            }
            "/api/like" -> respondJson(sock, likeJson(method, body))
            else -> respond(
                sock, "404 Not Found", "text/plain; charset=utf-8",
                "not found".toByteArray(Charsets.UTF_8)
            )
        }
    }

    /**
     * 播放控制：电脑上的歌词页点「上一首 / 下一首 / 播放暂停」时打到这里。
     * 指令转给 MediaNotificationListener，由它用当前活跃的 MediaController 下发。
     *
     * 支持 POST {"action":"next"}，也支持 ?action=next（方便 curl 调试）。
     */
    private fun controlJson(method: String, query: Map<String, String>, body: String): JSONObject {
        val out = JSONObject()
        var action = ""
        if (method == "POST" && body.isNotBlank()) {
            action = try {
                JSONObject(body).optString("action", "")
            } catch (e: Exception) {
                ""
            }
        }
        if (action.isBlank()) action = query["action"] ?: ""
        action = action.trim().lowercase()

        if (action !in setOf("next", "prev", "toggle", "play", "pause")) {
            return out.put("ok", false).put("error", "bad-action")
        }
        val code = MediaNotificationListener.sendControl(action)
        return out.put("ok", code == "ok").put("action", action).put("code", code)
    }

    /**
     * 扫码登录：POST 申请二维码，GET?key= 轮询结果。
     * 二维码内容由**手机**向网易云申请，pad 只负责把它画出来 —— 所以不需要电脑。
     */
    private fun accountQrJson(method: String, query: Map<String, String>): JSONObject {
        return try {
            if (method == "POST") {
                val (key, url) = NeteaseAccount.createQr()
                JSONObject().put("ok", true).put("key", key).put("url", url)
            } else {
                val r = NeteaseAccount.pollQr(query["key"] ?: "")
                val o = JSONObject()
                    .put("ok", true)
                    .put("code", r.optInt("code", 800))
                    .put("loggedIn", r.optBoolean("loggedIn", NeteaseAccount.loggedIn))
                    .put("nickname", r.optString("nickname", ""))
                val msg = r.optString("message", "")
                if (msg.isNotEmpty()) o.put("message", msg)
                o
            }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "操作失败")
        }
    }

    /** 收藏 / 取消收藏。songId 不传就用当前已匹配到的那首。 */
    private fun likeJson(method: String, body: String): JSONObject {
        if (method != "POST") return JSONObject().put("ok", false).put("error", "请用 POST")
        return try {
            val j = if (body.isBlank()) JSONObject() else JSONObject(body)
            val songId = j.optLong("songId", 0).takeIf { it > 0 }
                ?: ResolvedStore.current?.songId
                ?: 0L
            val liked = j.optBoolean("liked", true)
            val now = NeteaseAccount.setLiked(songId, liked)
            JSONObject().put("ok", true).put("songId", songId).put("liked", now)
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "收藏失败")
        }
    }

    /**
     * 显示页的个性化设置，存在 SharedPreferences 里。
     * 前端把设置 POST 上来，之后任何设备打开（哪怕手机 IP 变了）都能读回去。
     */
    private fun prefsStore() = context.getSharedPreferences("ncm_display_prefs", Context.MODE_PRIVATE)

    private fun loadPrefs(): JSONObject {
        val raw = prefsStore().getString("json", "") ?: ""
        if (raw.isBlank()) return JSONObject()
        return try {
            JSONObject(raw)
        } catch (e: Exception) {
            JSONObject()
        }
    }

    private fun savePrefs(body: String): JSONObject = try {
        val obj = JSONObject(body)
        prefsStore().edit().putString("json", obj.toString()).apply()
        JSONObject().put("ok", true)
    } catch (e: Exception) {
        JSONObject().put("ok", false).put("error", e.message ?: "保存失败")
    }

    private fun stateJson(): JSONObject {
        val np = MediaRepository.current
        val now = System.currentTimeMillis()
        val resolved = ResolvedStore.current
        val o = JSONObject()
        o.put(
            "status",
            when {
                !np.active -> "idle"
                np.playing -> "playing"
                else -> "paused"
            }
        )
        o.put("source", "phone")
        o.put("serverNowMs", now)
        o.put("receivers", 0)

        // pad 上的控制条要用的三样东西：能不能控（能，就是这台手机）、
        // 当前这首收藏了没、账号登录状态。
        o.put("canControl", true)
        o.put("controlTarget", JSONObject().put("kind", "phone").put("base", ""))
        o.put("account", NeteaseAccount.info())
        val sid = ResolvedStore.current?.songId ?: 0L
        o.put("liked", if (NeteaseAccount.loggedIn) (NeteaseAccount.isLikedQuick(sid) ?: JSONObject.NULL) else JSONObject.NULL)
        NeteaseAccount.primeLiked()

        val track = JSONObject()
        track.put("title", if (np.title.isBlank()) "等待手机播放…" else np.title)
        track.put("artist", np.artist)
        track.put("album", np.album)
        track.put("duration", np.durationMs)
        if (resolved != null) {
            track.put("songId", resolved.songId)
            track.put("cover", resolved.cover ?: JSONObject.NULL)
            track.put("matched", true)
        } else {
            track.put("cover", JSONObject.NULL)
            track.put("matched", false)
        }
        o.put("track", track)

        val anchor = JSONObject()
        anchor.put("position", np.positionAt(now))
        anchor.put("serverTime", now)
        anchor.put("speed", if (np.playing) np.speed.toDouble() else 0.0)
        o.put("anchor", anchor)

        val lyrics = JSONArray()
        if (resolved != null) {
            for (l in resolved.lines) {
                val lo = JSONObject()
                lo.put("t", l.time)
                lo.put("x", l.text)
                if (!l.trans.isNullOrBlank()) lo.put("r", l.trans)
                lyrics.put(lo)
            }
        }
        o.put("lyrics", lyrics)
        if (resolved == null && np.active && np.title.isNotBlank()) {
            o.put("message", "正在匹配歌词…")
        }
        // 没读到播放状态时，把原因带出去 —— 否则页面只会干等着，
        // 分不清"没放歌"和"通知使用权掉了"。
        if (!np.active) {
            val why = MediaRepository.lastError
            o.put("message", if (why.isBlank()) "手机上没读到正在播放的媒体" else why)
        }
        return o
    }

    private fun nowPlayingJson(): JSONObject {
        val np = MediaRepository.current
        val now = System.currentTimeMillis()
        val o = JSONObject()
        o.put("active", np.active)
        o.put("playing", np.playing)
        o.put("title", np.title)
        o.put("artist", np.artist)
        o.put("album", np.album)
        o.put("durationMs", np.durationMs)
        o.put("positionMs", np.positionAt(now))
        o.put("speed", np.speed)
        o.put("source", "phone")
        o.put("serverNowMs", now)
        ResolvedStore.current?.let {
            o.put("songId", it.songId)
            o.put("cover", it.cover ?: JSONObject.NULL)
        }
        return o
    }

    private fun infoJson(): JSONObject {
        val o = JSONObject()
        o.put("ok", true)
        o.put("app", "ncm-phone-bridge")
        o.put("source", "phone")
        val np = MediaRepository.current
        o.put("active", np.active)
        o.put("playing", np.playing)
        o.put("title", np.title)
        o.put("error", MediaRepository.lastError)
        // 排查"pad 一直显示等待播放"时最先要看的就是这个
        o.put("listener", MediaNotificationListener.instance != null)
        return o
    }

    private fun searchJson(q: String, limit: Int): JSONObject {
        val o = JSONObject()
        if (q.isBlank()) {
            o.put("ok", false)
            o.put("error", "缺少 q 参数")
            return o
        }
        val arr = JSONArray()
        for (s in NeteaseApi.search(q, limit)) {
            val so = JSONObject()
            so.put("songId", s.id)
            so.put("title", s.name)
            so.put("artist", s.artists)
            so.put("album", s.album)
            so.put("duration", s.durationMs)
            arr.put(so)
        }
        o.put("ok", true)
        o.put("results", arr)
        return o
    }

    private fun pinJson(body: String): JSONObject {
        val o = JSONObject()
        return try {
            val j = JSONObject(body)
            val songId = j.optLong("songId")
            if (songId <= 0L) {
                o.put("ok", false)
                o.put("error", "缺少 songId")
            } else {
                ResolvedStore.pinnedKey = MediaRepository.current.key
                ResolvedStore.pinnedSongId = songId
                ResolvedStore.forKey = ""
                o.put("ok", true)
            }
            o
        } catch (e: Exception) {
            o.put("ok", false)
            o.put("error", "bad body")
            o
        }
    }

    private fun proxyCover(sock: Socket, url: String?) {
        if (url.isNullOrBlank() || !url.startsWith("http")) {
            respond(sock, "400 Bad Request", "text/plain", "bad url".toByteArray())
            return
        }
        val host = try {
            java.net.URI(url).host ?: ""
        } catch (e: Exception) {
            ""
        }
        if (!host.endsWith("music.126.net") && !host.endsWith("126.net")) {
            respond(sock, "403 Forbidden", "text/plain", "host not allowed".toByteArray())
            return
        }
        val bytes = NeteaseApi.httpBytes(url)
        if (bytes == null) {
            respond(sock, "502 Bad Gateway", "text/plain", "fetch failed".toByteArray())
            return
        }
        val ct = if (bytes.size > 3 && bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte()) {
            "image/png"
        } else {
            "image/jpeg"
        }
        respond(sock, "200 OK", ct, bytes)
    }

    private fun serveArt(sock: Socket) {
        val art = MediaRepository.albumArt
        if (art == null || art.isEmpty()) {
            respond(sock, "404 Not Found", "text/plain", "no art".toByteArray())
            return
        }
        respond(sock, "200 OK", "image/jpeg", art)
    }

    private fun serveAsset(sock: Socket, name: String, contentType: String) {
        val bytes = try {
            context.assets.open(name).use { it.readBytes() }
        } catch (e: Exception) {
            null
        }
        if (bytes == null) {
            respond(sock, "404 Not Found", "text/plain", "asset missing".toByteArray())
            return
        }
        respond(sock, "200 OK", contentType, bytes)
    }

    private fun respondJson(sock: Socket, obj: JSONObject) {
        respond(sock, "200 OK", "application/json; charset=utf-8", obj.toString().toByteArray(Charsets.UTF_8))
    }

    private fun respond(sock: Socket, status: String, contentType: String, body: ByteArray) {
        try {
            val out = BufferedOutputStream(sock.getOutputStream())
            val sb = StringBuilder()
            sb.append("HTTP/1.1 ").append(status).append("\r\n")
            sb.append("Content-Type: ").append(contentType).append("\r\n")
            sb.append("Content-Length: ").append(body.size).append("\r\n")
            sb.append("Access-Control-Allow-Origin: *\r\n")
            sb.append("Access-Control-Allow-Headers: *\r\n")
            sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
            sb.append("Cache-Control: no-store\r\n")
            sb.append("Connection: close\r\n\r\n")
            out.write(sb.toString().toByteArray(Charsets.UTF_8))
            out.write(body)
            out.flush()
        } catch (e: Exception) {
        }
    }
}
