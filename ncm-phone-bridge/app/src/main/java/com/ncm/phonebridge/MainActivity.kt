package com.ncm.phonebridge

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var tvAccessState: TextView
    private lateinit var tvServiceState: TextView
    private lateinit var tvUrl: TextView
    private lateinit var tvNowPlaying: TextView
    private lateinit var btnToggle: Button
    private lateinit var etPushTarget: EditText
    private lateinit var tvPushState: TextView
    private val handler = Handler(Looper.getMainLooper())

    private val ticker = object : Runnable {
        override fun run() {
            updateUi()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvAccessState = findViewById(R.id.tvAccessState)
        tvServiceState = findViewById(R.id.tvServiceState)
        tvUrl = findViewById(R.id.tvUrl)
        tvNowPlaying = findViewById(R.id.tvNowPlaying)
        btnToggle = findViewById(R.id.btnToggle)
        etPushTarget = findViewById(R.id.etPushTarget)
        tvPushState = findViewById(R.id.tvPushState)

        etPushTarget.setText(getPushTarget())
        findViewById<Button>(R.id.btnSavePush).setOnClickListener {
            val t = etPushTarget.text.toString().trim()
            savePushTarget(t)
            toast(if (t.isBlank()) "已停用推送" else "已启用推送：$t")
            updateUi()
        }

        findViewById<Button>(R.id.btnAccess).setOnClickListener {
            try {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            } catch (e: Exception) {
                toast("请手动进入：设置 → 通知 → 通知使用权")
            }
        }

        btnToggle.setOnClickListener {
            if (BridgeService.isRunning) {
                stopService(Intent(this, BridgeService::class.java))
            } else {
                val i = Intent(this, BridgeService::class.java)
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
            }
            handler.postDelayed({ updateUi() }, 500)
        }

        findViewById<Button>(R.id.btnCopy).setOnClickListener {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("url", tvUrl.text))
            toast("已复制")
        }

        requestNotifPermission()
    }

    override fun onResume() {
        super.onResume()
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(ticker)
    }

    private fun updateUi() {
        val hasAccess = isNotificationAccessGranted()
        tvAccessState.text = if (hasAccess) "状态：已授权" else "状态：未授权（点下方按钮开启）"
        val running = BridgeService.isRunning
        tvServiceState.text = if (running) "状态：运行中" else "状态：未启动"
        btnToggle.text = if (running) "停止服务" else "启动服务"
        tvUrl.text = if (running) LanInfo.url(BridgeService.PORT) else "—"

        val np = MediaRepository.current
        val sb = StringBuilder()
        if (np.active) {
            sb.append("当前播放：").append(np.title).append(" - ").append(np.artist)
            sb.append("\n进度：")
                .append(np.positionAt(System.currentTimeMillis()) / 1000).append("s / ")
                .append(np.durationMs / 1000).append("s")
            sb.append(if (np.playing) "（播放中）" else "（暂停）")
        } else {
            sb.append("当前播放：—")
        }
        if (MediaRepository.lastError.isNotBlank()) {
            sb.append("\n提示：").append(MediaRepository.lastError)
        }
        tvNowPlaying.text = sb.toString()

        val push = getPushTarget()
        tvPushState.text = if (push.isBlank()) "推送：未启用" else "推送目标：$push"
    }

    private fun pushPrefs() = getSharedPreferences("ncm_push", Context.MODE_PRIVATE)

    private fun getPushTarget(): String = pushPrefs().getString("target", "") ?: ""

    private fun savePushTarget(t: String) {
        pushPrefs().edit().putString("target", t).apply()
    }

    private fun isNotificationAccessGranted(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return flat.contains(packageName)
    }

    private fun requestNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
