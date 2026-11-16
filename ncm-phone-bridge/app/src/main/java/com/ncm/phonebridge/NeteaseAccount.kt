package com.ncm.phonebridge

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * 网易云账号：扫码登录 + 「我喜欢的音乐」增删（全部在手机上完成，不需要电脑）。
 *
 * 为什么要有这一份
 * ----------------
 * 收藏是账号数据，必须带登录态、并且走 weapi 加密。之前这份能力只存在于电脑版服务里，
 * 所以「手机放歌 + 平板看歌词」这个场景想要红心，就不得不把电脑也开着。
 * 现在把同样的逻辑搬进 App：pad 直接连手机就能收藏。
 *
 * 凭据怎么存
 * ----------
 * cookie 只写进 App 私有目录的 SharedPreferences，受 Android 沙箱保护，
 * **不下发给页面**（页面只知道登录了没 + 昵称），也不写日志。
 *
 * 登录方式
 * --------
 * 二维码由**手机**向网易云申请，pad 上显示；用手机上的网易云 App 扫一下确认。
 * 整个过程不需要电脑，也不需要输密码。
 */
object NeteaseAccount {

    private const val PREF = "ncm_account"
    private const val LIKED_TTL_MS = 5 * 60 * 1000L

    private lateinit var prefs: android.content.SharedPreferences
    private val pool = Executors.newSingleThreadExecutor { r -> Thread(r, "ncm-account").apply { isDaemon = true } }

    @Volatile private var cookie: String = ""
    @Volatile private var uid: Long = 0
    @Volatile private var nickname: String = ""
    @Volatile private var likedPid: Long = 0

    @Volatile private var liked: MutableSet<Long>? = null
    @Volatile private var likedAt: Long = 0
    @Volatile private var loading = false

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        cookie = prefs.getString("cookie", "") ?: ""
        uid = prefs.getLong("uid", 0)
        nickname = prefs.getString("nickname", "") ?: ""
        likedPid = prefs.getLong("likedPid", 0)
        if (cookie.isNotEmpty()) {
            pool.execute { refreshProfile() }
        }
    }

    val loggedIn: Boolean get() = cookie.isNotEmpty()

    /** 给页面看的账号信息 —— 绝不包含 cookie */
    fun info(): JSONObject = JSONObject()
        .put("loggedIn", loggedIn)
        .put("nickname", nickname)
        .put("likedKnown", liked != null)

    private fun save() {
        prefs.edit()
            .putString("cookie", cookie)
            .putLong("uid", uid)
            .putString("nickname", nickname)
            .putLong("likedPid", likedPid)
            .apply()
    }

    // ------------------------------------------------------------------ 扫码登录

    /** 申请一个二维码。返回 (key, 二维码内容) —— 二维码内容交给页面渲染。 */
    fun createQr(): Pair<String, String> {
        val res = Weapi.post(
            "/weapi/login/qrcode/unikey",
            linkedMapOf("type" to "1"),
            cookie,
        )
        val data = JSONObject(res.body)
        if (data.optInt("code") != 200) {
            throw IllegalStateException(data.optString("message", "获取二维码失败"))
        }
        val key = data.optString("unikey", "")
        if (key.isBlank()) throw IllegalStateException("获取二维码失败")
        return key to "https://music.163.com/login?codekey=$key"
    }

    /**
     * 轮询扫码结果：800 过期 / 801 等待扫码 / 802 待确认 / 803 成功。
     * 成功时把 Set-Cookie 和 body 里的 cookie 合并，必须拿到 MUSIC_U 才算真的登录。
     */
    fun pollQr(key: String): JSONObject {
        if (key.isBlank()) return JSONObject().put("code", 800).put("message", "缺少 key")

        val res = Weapi.post(
            "/weapi/login/qrcode/client/login",
            linkedMapOf("key" to key, "type" to "1"),
            cookie,
        )
        val data = JSONObject(res.body)
        val code = data.optInt("code", 800)
        if (code != 803) {
            return JSONObject()
                .put("code", code)
                .put("loggedIn", loggedIn)
                .put("nickname", nickname)
        }

        var jar = mergeCookie(res.setCookie, data.optString("cookie", ""))
        if (cookieValue(jar, "MUSIC_U").isEmpty()) {
            return JSONObject().put("code", 800).put("message", "登录成功但没拿到登录态，请重试")
        }
        cookie = jar
        liked = null
        likedAt = 0
        refreshProfile()
        save()
        return JSONObject()
            .put("code", 803)
            .put("loggedIn", true)
            .put("nickname", nickname)
    }

    fun logout() {
        cookie = ""
        uid = 0
        nickname = ""
        likedPid = 0
        liked = null
        likedAt = 0
        prefs.edit().clear().apply()
    }

    private fun refreshProfile() {
        try {
            val res = Weapi.get("${Weapi.BASE}/api/nuser/account/get", cookie)
            val data = JSONObject(res.body)
            val profile = data.optJSONObject("profile")
            if (profile != null) {
                uid = profile.optLong("userId", uid)
                nickname = profile.optString("nickname", nickname)
                likedPid = findLikedPid(uid).takeIf { it > 0 } ?: likedPid
                save()
            } else if (cookie.isNotEmpty()) {
                // cookie 失效：清掉，避免页面一直以为登录着
                logout()
            }
        } catch (e: Exception) {
            // 网络问题不影响已保存的登录态
        }
    }

    /** 「我喜欢的音乐」是特殊歌单（specialType=5），id 通常等于用户 id，但仍以接口为准 */
    private fun findLikedPid(uid: Long): Long {
        if (uid <= 0) return 0
        return try {
            val res = Weapi.get("${Weapi.BASE}/api/user/playlist?uid=$uid&limit=200&offset=0", cookie)
            val arr = JSONObject(res.body).optJSONArray("playlist") ?: return 0
            for (i in 0 until arr.length()) {
                val p = arr.optJSONObject(i) ?: continue
                if (p.optInt("specialType") == 5) return p.optLong("id", 0)
            }
            0
        } catch (e: Exception) {
            0
        }
    }

    private val playlistId: Long get() = if (likedPid > 0) likedPid else uid

    // -------------------------------------------------------------- 我喜欢的音乐

    /** 同步查询（给 /api/state 用）：null = 还不知道 */
    fun isLikedQuick(songId: Long): Boolean? {
        val set = liked ?: return null
        if (!loggedIn || songId <= 0) return null
        return set.contains(songId)
    }

    /** 后台刷新（不阻塞页面），失败就算了，下次再试 */
    fun primeLiked() {
        if (!loggedIn) return
        if (liked != null && System.currentTimeMillis() - likedAt < LIKED_TTL_MS) return
        if (loading) return
        loading = true
        pool.execute {
            try {
                refreshLikedBlocking(true)
            } finally {
                loading = false
            }
        }
    }

    fun refreshLikedBlocking(force: Boolean = false): MutableSet<Long>? {
        if (!loggedIn) return null
        if (!force && liked != null && System.currentTimeMillis() - likedAt < LIKED_TTL_MS) return liked
        val pid = playlistId
        if (pid <= 0) return liked
        return try {
            val res = Weapi.get("${Weapi.BASE}/api/v6/playlist/detail?id=$pid&n=100000&s=0", cookie)
            val pl = JSONObject(res.body).optJSONObject("playlist") ?: return liked
            val ids = pl.optJSONArray("trackIds") ?: return liked
            val set = HashSet<Long>(ids.length())
            for (i in 0 until ids.length()) {
                val id = ids.optJSONObject(i)?.optLong("id", 0) ?: 0
                if (id > 0) set.add(id)
            }
            liked = set
            likedAt = System.currentTimeMillis()
            set
        } catch (e: Exception) {
            liked
        }
    }

    fun setLiked(songId: Long, like: Boolean): Boolean {
        if (!loggedIn) throw IllegalStateException("还没登录网易云账号")
        if (songId <= 0) throw IllegalStateException("当前曲目没有匹配到网易云 ID，无法收藏")
        val pid = playlistId
        if (pid <= 0) throw IllegalStateException("拿不到「我喜欢的音乐」歌单 ID，请重新登录")

        val res = Weapi.post(
            "/weapi/playlist/manipulate/tracks",
            linkedMapOf(
                "trackIds" to "[$songId]",
                "op" to if (like) "add" else "del",
                "pid" to pid.toString(),
            ),
            cookie,
        )
        val data = JSONObject(res.body)
        val code = data.optInt("code", -1)
        if (code != 200 && code != 201) {
            throw IllegalStateException(data.optString("message", "网易云拒绝了这次操作（$code）"))
        }
        val set = liked
        if (set != null) {
            if (like) set.add(songId) else set.remove(songId)
        }
        return like
    }

    // -------------------------------------------------------------------- cookie

    private fun mergeCookie(existing: String, incoming: String): String {
        val jar = LinkedHashMap<String, String>()
        for (part in "$existing;$incoming".split(";")) {
            val i = part.indexOf('=')
            if (i <= 0) continue
            val k = part.substring(0, i).trim()
            val v = part.substring(i + 1).trim()
            if (k.isEmpty() || v.isEmpty()) continue
            if (k.matches(Regex("(?i)path|domain|expires|max-age|secure|httponly|samesite"))) continue
            jar[k] = v
        }
        return jar.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    private fun cookieValue(jar: String, key: String): String {
        for (part in jar.split(";")) {
            val i = part.indexOf('=')
            if (i > 0 && part.substring(0, i).trim() == key) return part.substring(i + 1).trim()
        }
        return ""
    }

    /** 调试用：返回 liked 集合大小，好判断是不是真的拉到了 */
    fun likedCount(): Int = liked?.size ?: 0
}
