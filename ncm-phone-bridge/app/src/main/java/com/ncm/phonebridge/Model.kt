package com.ncm.phonebridge

data class NowPlaying(
    val active: Boolean = false,
    val playing: Boolean = false,
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val durationMs: Long = 0L,
    val positionMs: Long = 0L,
    val sampledAtMs: Long = 0L,
    val speed: Float = 1f,
    val packageName: String = ""
) {
    val key: String get() = "$title|$artist"

    fun positionAt(nowMs: Long): Long {
        if (!playing) return positionMs
        val dt = (nowMs - sampledAtMs).coerceAtLeast(0L)
        var p = positionMs + (dt * speed).toLong()
        if (durationMs > 0 && p > durationMs) p = durationMs
        return p
    }
}

object MediaRepository {
    @Volatile
    var current: NowPlaying = NowPlaying()

    @Volatile
    var albumArt: ByteArray? = null

    @Volatile
    var albumArtKey: String = ""

    @Volatile
    var lastError: String = ""

    fun setAlbumArt(key: String, bytes: ByteArray?) {
        albumArtKey = key
        albumArt = bytes
    }
}
