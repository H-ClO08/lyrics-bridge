package com.ncm.phonebridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.service.notification.NotificationListenerService
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class BridgeService : Service() {

    private var server: BridgeHttpServer? = null
    private var worker: Thread? = null

    @Volatile
    private var workerRunning = false

    // 推送到电脑的节流状态
    private var lastPushKey = ""
    private var lastPushPlaying = false
    private var lastPushAt = 0L

    // 监听服务掉线后尝试自动重连的节流
    private var lastRebindAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
        if (server == null) {
            server = BridgeHttpServer(PORT, applicationContext).also {
                try {
                    it.start()
                } catch (e: Exception) {
                    MediaRepository.lastError = e.message ?: "端口占用"
                }
            }
        }
        startWorker()
        return START_STICKY
    }

    override fun onDestroy() {
        workerRunning = false
        try {
            server?.stop()
        } catch (e: Exception) {
        }
        server = null
        instance = null
        super.onDestroy()
    }

    private fun startWorker() {
        if (workerRunning) return
        workerRunning = true
        worker = Thread {
            while (workerRunning) {
                try {
                    ensureListener()
                    val np = MediaRepository.current
                    if (np.active && np.title.isNotBlank()) {
                        val key = np.key
                        val pinned = if (ResolvedStore.pinnedKey == key) ResolvedStore.pinnedSongId else 0L
                        val need = key != ResolvedStore.forKey ||
                            (pinned > 0L && ResolvedStore.current?.songId != pinned)
                        if (need) {
                            ResolvedStore.forKey = key
                            ResolvedStore.current = if (pinned > 0L) {
                                NeteaseApi.resolveById(pinned)
                            } else {
                                NeteaseApi.resolve(np.title, np.artist, np.album, np.durationMs)
                            }
                        }
                    } else if (ResolvedStore.forKey.isNotBlank()) {
                        ResolvedStore.forKey = ""
                        ResolvedStore.current = null
                    }
                    pushToTarget(MediaRepository.current)
                } catch (e: Exception) {
                }
                try {
                    Thread.sleep(1000)
                } catch (e: Exception) {
                    break
                }
            }
        }.apply {
            isDaemon = true
            start()
        }
    }

    /**
     * 确保「通知使用权」还连着。
     *
     * 为什么需要它：监听服务可能根本没连上 —— 覆盖安装、被系统或省电策略掐掉、
     * 用户在设置里关掉过。这时页面只会一直显示「等待播放」，看不出任何原因。
     * 所以这里做两件事：
     *   1) 没连上就把原因写进 lastError，页面能直接显示出来；
     *   2) 每 5 秒请系统重绑一次（requestRebind），能自动恢复的就不用用户动手。
     */
    private fun ensureListener() {
        val l = MediaNotificationListener.instance
        if (l != null) {
            l.refresh()
            return
        }
        MediaRepository.lastError = "通知使用权未开启或已断开：到系统设置里把「歌词桥」的通知使用权重新打开"
        val now = System.currentTimeMillis()
        if (now - lastRebindAt > 5000) {
            lastRebindAt = now
            try {
                NotificationListenerService.requestRebind(
                    ComponentName(this, MediaNotificationListener::class.java)
                )
            } catch (e: Exception) {
                // 个别 ROM 不支持，忽略
            }
        }
    }

    /**
     * 把当前播放状态推给电脑（/api/push）。
     *
     * 手机 IP 怎么变都无所谓 —— 这里手机是主动方，只需知道电脑地址。
     * 电脑端收到后走它自己的 push 源：网页、SMTC 桥接（BetterLyrics）都能用。
     *
     * 节流：曲目变化 / 播放状态变化时立即推；播放中每 3 秒推一次进度。
     * 空闲时不推，电脑端 push 源有 60 秒超时，会自动回落到「无播放」。
     */
    private fun pushToTarget(np: NowPlaying) {
        val target = getSharedPreferences("ncm_push", MODE_PRIVATE)
            .getString("target", "")?.trim() ?: ""
        if (target.isEmpty()) return
        if (!np.active || np.title.isBlank()) return

        val now = System.currentTimeMillis()
        val trackChanged = np.key != lastPushKey
        val stateChanged = np.playing != lastPushPlaying
        val intervalOk = np.playing && now - lastPushAt >= 3000
        if (!trackChanged && !stateChanged && !intervalOk) return

        lastPushKey = np.key
        lastPushPlaying = np.playing
        lastPushAt = now

        try {
            val resolved = ResolvedStore.current
            val body = JSONObject()
                .put("title", np.title)
                .put("artist", np.artist)
                .put("album", np.album)
                .put("duration", np.durationMs)
                .put("position", np.positionAt(now))
                .put("playing", np.playing)
            // 把手机已经匹配好的 songId / 封面一起带上：
            // 电脑端用 songId 精确取歌词和封面（不再靠歌名重新猜，避免认错或没封面）
            if (resolved != null) {
                body.put("songId", resolved.songId)
                if (!resolved.cover.isNullOrBlank()) body.put("cover", resolved.cover)
            }
            httpPost(target.trimEnd('/') + "/api/push", body.toString())
            if (MediaRepository.lastError.startsWith("推送失败")) MediaRepository.lastError = ""
        } catch (e: Exception) {
            MediaRepository.lastError = "推送失败：" + (e.message ?: "未知")
        }
    }

    private fun httpPost(urlStr: String, json: String) {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 4000
            conn.readTimeout = 4000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val mgr = getSystemService(NotificationManager::class.java) ?: return
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(CHANNEL_ID, "歌词桥服务", NotificationManager.IMPORTANCE_LOW)
                ch.setShowBadge(false)
                mgr.createNotificationChannel(ch)
            }
        }
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val url = LanInfo.url(PORT)
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("歌词桥运行中")
            .setContentText(url)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val PORT = 8787
        private const val CHANNEL_ID = "ncm_bridge"
        private const val NOTIF_ID = 1001

        @Volatile
        var instance: BridgeService? = null

        val isRunning: Boolean get() = instance != null
    }
}
