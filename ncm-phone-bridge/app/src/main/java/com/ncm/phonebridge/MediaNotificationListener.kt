package com.ncm.phonebridge

import android.content.ComponentName
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.io.ByteArrayOutputStream

class MediaNotificationListener : NotificationListenerService() {

    override fun onListenerConnected() {
        instance = this
        refresh()
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        refresh()
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        refresh()
    }

    fun refresh() {
        try {
            val mgr = getSystemService(MediaSessionManager::class.java) ?: return
            val cn = ComponentName(this, MediaNotificationListener::class.java)
            val sessions = mgr.getActiveSessions(cn)
            if (sessions.isEmpty()) {
                MediaRepository.current = NowPlaying(active = false)
                MediaRepository.lastError = "无媒体会话"
                return
            }
            val controller = pickBest(sessions)
            if (controller == null) {
                MediaRepository.current = NowPlaying(active = false)
                MediaRepository.lastError = "会话无标题"
                return
            }
            val md = controller.metadata
            val pb = controller.playbackState
            val playing = pb?.state == PlaybackState.STATE_PLAYING
            val title = md?.getString(MediaMetadata.METADATA_KEY_TITLE).orEmpty()
            val artist = md?.getString(MediaMetadata.METADATA_KEY_ARTIST).orEmpty()
            val album = md?.getString(MediaMetadata.METADATA_KEY_ALBUM).orEmpty()
            val duration = md?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L

            var speed = 0f
            var pos = 0L
            if (pb != null) {
                pos = pb.position
                if (playing) {
                    speed = pb.playbackSpeed.takeIf { it > 0f } ?: 1f
                    val elapsed = SystemClock.elapsedRealtime() - pb.lastPositionUpdateTime
                    if (elapsed > 0) pos += (elapsed * speed).toLong()
                }
            }
            if (pos < 0) pos = 0
            if (duration > 0 && pos > duration) pos = duration

            val np = NowPlaying(
                active = title.isNotBlank(),
                playing = playing,
                title = title,
                artist = artist,
                album = album,
                durationMs = duration,
                positionMs = pos,
                sampledAtMs = System.currentTimeMillis(),
                speed = speed,
                packageName = controller.packageName ?: ""
            )
            MediaRepository.current = np
            MediaRepository.lastError = ""

            val key = np.key
            if (key != MediaRepository.albumArtKey) {
                val bmp = md?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
                    ?: md?.getBitmap(MediaMetadata.METADATA_KEY_ART)
                MediaRepository.setAlbumArt(key, bmp?.toJpeg())
            }
        } catch (e: Exception) {
            MediaRepository.lastError = e.message ?: "读取失败"
        }
    }

    /**
     * 下发播放控制。返回 ASCII 错误码，中文文案由电脑端映射。
     *
     * 为什么能控制：本 App 持有「通知使用权」，所以 getActiveSessions() 拿到的
     * MediaController 是可用状态，可以直接调 transportControls。
     * 注意 Android 不回报播放器是否真的执行了 —— skipToNext() 返回 void，
     * 所以这里只能保证「指令已发出」。
     */
    fun applyControl(action: String): String {
        return try {
            val mgr = getSystemService(MediaSessionManager::class.java) ?: return "no-manager"
            val cn = ComponentName(this, MediaNotificationListener::class.java)
            val controller = pickBest(mgr.getActiveSessions(cn)) ?: return "no-session"
            val tc = controller.transportControls ?: return "no-session"
            when (action) {
                "next" -> tc.skipToNext()
                "prev" -> tc.skipToPrevious()
                "toggle" -> {
                    val playing = controller.playbackState?.state == PlaybackState.STATE_PLAYING
                    if (playing) tc.pause() else tc.play()
                }
                "play" -> tc.play()
                "pause" -> tc.pause()
                else -> return "bad-action"
            }
            // 指令发出去后立刻刷一次状态，页面不用等下一次轮询
            refresh()
            "ok"
        } catch (e: Exception) {
            "exception"
        }
    }

    private fun pickBest(sessions: List<MediaController>): MediaController? {
        val valid = sessions.filter {
            !it.metadata?.getString(MediaMetadata.METADATA_KEY_TITLE).isNullOrBlank()
        }
        if (valid.isEmpty()) return null
        val playing = valid.filter { it.playbackState?.state == PlaybackState.STATE_PLAYING }
        val pool = if (playing.isNotEmpty()) playing else valid
        pool.firstOrNull { (it.packageName ?: "").contains("cloudmusic", true) }?.let { return it }
        pool.firstOrNull { (it.packageName ?: "").contains("music", true) }?.let { return it }
        pool.firstOrNull { (it.packageName ?: "").contains("netease", true) }?.let { return it }
        return pool.firstOrNull()
    }

    companion object {
        @Volatile
        var instance: MediaNotificationListener? = null

        /** 给 HTTP 服务用的入口：监听服务没连上时返回 no-listener */
        fun sendControl(action: String): String = instance?.applyControl(action) ?: "no-listener"
    }
}

private fun Bitmap.toJpeg(quality: Int = 88): ByteArray? {
    return try {
        val out = ByteArrayOutputStream()
        compress(Bitmap.CompressFormat.JPEG, quality, out)
        out.toByteArray()
    } catch (e: Exception) {
        null
    }
}
