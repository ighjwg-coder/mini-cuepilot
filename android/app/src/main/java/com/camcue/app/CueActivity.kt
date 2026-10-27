package com.camcue.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast

/**
 * CueScreen 전체 화면. 서버의 /cam/N 웹 화면을 그대로 띄우고, 앱이 하는 일:
 *  - 화면 꺼짐 방지 (브라우저의 HTTP 접속에서는 보장되지 않던 부분)
 *  - 진동 (웹 화면이 window.CamCueApp.vibrate 로 요청)
 *  - 서버가 꺼지거나 PC IP 가 바뀌면 자동으로 다시 찾아 재접속
 *  - 화면 방향 고정 (웹 화면 설정에서 선택), 뒤로 가기는 두 번 눌러야 닫힘
 */
class CueActivity : Activity() {
    companion object {
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_PROTO = "proto"
        const val EXTRA_CAMERA = "camera"
        private const val HEALTH_MS = 4000L
    }

    private lateinit var web: WebView
    private lateinit var overlay: TextView
    private val main = Handler(Looper.getMainLooper())
    private var host = ""
    private var port = 38080
    private var proto = "http"
    private var camera = 1
    private var failures = 0
    private var stopped = false
    private var checking = false
    private var lastBack = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        host = intent.getStringExtra(EXTRA_HOST) ?: run { finish(); return }
        port = intent.getIntExtra(EXTRA_PORT, 38080)
        proto = intent.getStringExtra(EXTRA_PROTO) ?: "http"
        camera = intent.getIntExtra(EXTRA_CAMERA, 1)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.textZoom = 100
            addJavascriptInterface(Bridge(this@CueActivity), "CamCueApp")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = false

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) showOverlay("캠큐 서버에 연결할 수 없습니다\n다시 찾는 중…")
                }

                override fun onPageFinished(view: WebView, url: String) {
                    if (failures == 0) hideOverlay()
                }
            }
        }
        overlay = TextView(this).apply {
            setBackgroundColor(0xE60B0D10.toInt())
            setTextColor(Color.WHITE)
            textSize = 22f
            gravity = Gravity.CENTER
            visibility = View.GONE
            setOnClickListener { reconnect() }
        }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(web, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            // FrameLayout 자체의 overlay 속성과 이름이 겹치므로 명시
            addView(this@CueActivity.overlay, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        })
        web.loadUrl(url())
    }

    private fun url() = "$proto://$host:$port/cam/$camera"

    // 생방송 중 손이 스쳐 큐 화면이 닫히지 않도록 2초 안에 두 번 눌러야 닫는다
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val now = System.currentTimeMillis()
        if (now - lastBack < 2000) {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        } else {
            lastBack = now
            Toast.makeText(this, "한 번 더 누르면 큐 화면을 닫습니다", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        stopped = false
        immersive()
        web.onResume()
        main.postDelayed(healthLoop, HEALTH_MS)
    }

    override fun onPause() {
        super.onPause()
        stopped = true
        main.removeCallbacks(healthLoop)
        web.onPause()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    @Suppress("DEPRECATION")
    private fun immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
        }
    }

    // ── 서버 상태 확인 → 끊기면 다시 찾아서 재접속 ──
    private val healthLoop = object : Runnable {
        override fun run() {
            if (stopped || checking) return
            checking = true
            Thread {
                val ok = Discovery.check(host, port, 2000) != null
                runOnUiThread {
                    checking = false
                    if (stopped) return@runOnUiThread
                    if (ok) {
                        if (failures > 0) {
                            failures = 0
                            hideOverlay()
                            web.loadUrl(url())
                        }
                        main.postDelayed(this, HEALTH_MS)
                    } else {
                        failures++
                        // 웹 화면도 자체 재연결을 하므로 2번 연속 실패부터 안내 + 서버 다시 찾기
                        if (failures >= 2) reconnect() else main.postDelayed(this, 1500)
                    }
                }
            }.start()
        }
    }

    private fun reconnect() {
        if (stopped) return
        showOverlay("캠큐 서버 연결 끊김\n같은 Wi-Fi 에서 다시 찾는 중…\n\n(화면을 누르면 바로 다시 시도)")
        main.removeCallbacks(healthLoop)
        Thread {
            // 같은 주소가 살아났는지 먼저, 아니면 네트워크에서 다시 찾기 (PC IP·포트가 바뀐 경우)
            val same = Discovery.check(host, port, 1500)
            val next = same ?: Discovery.find().let { list -> list.firstOrNull { it.host == host } ?: list.singleOrNull() }
            runOnUiThread {
                if (stopped) return@runOnUiThread
                if (next != null) {
                    host = next.host
                    port = next.port
                    proto = next.proto
                    getSharedPreferences("camcue", Context.MODE_PRIVATE).edit()
                        .putString("host", host).putInt("port", port).putString("name", next.name).apply()
                    failures = 0
                    hideOverlay()
                    web.loadUrl(url())
                    main.postDelayed(healthLoop, HEALTH_MS)
                } else {
                    showOverlay("캠큐 서버를 찾지 못했습니다\nPC 의 캠큐 실행·Wi-Fi 를 확인하세요\n\n5초 후 다시 찾습니다 (누르면 바로)")
                    main.postDelayed({ reconnect() }, 5000)
                }
            }
        }.start()
    }

    private fun showOverlay(msg: String) {
        overlay.text = msg
        overlay.visibility = View.VISIBLE
    }

    private fun hideOverlay() {
        overlay.visibility = View.GONE
    }

    /** 웹 화면(CueScreen)에서 window.CamCueApp 으로 부르는 기능 */
    class Bridge(private val ctx: Activity) {
        @JavascriptInterface
        fun vibrate(pattern: String) {
            val parts = pattern.split(',').mapNotNull { it.trim().toLongOrNull() }.filter { it in 0..5000 }
            if (parts.isEmpty()) return
            val vib: Vibrator = if (Build.VERSION.SDK_INT >= 31) {
                (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            // 패턴: 진동,쉼,진동… → Android 형식은 [대기, 진동, 쉼, 진동…]
            val timings = longArrayOf(0) + parts.toLongArray()
            if (Build.VERSION.SDK_INT >= 26) {
                vib.vibrate(VibrationEffect.createWaveform(timings, -1))
            } else {
                @Suppress("DEPRECATION")
                vib.vibrate(timings, -1)
            }
        }

        @JavascriptInterface
        fun version(): String = BuildConfigCompat.versionName(ctx)

        /** auto / portrait / landscape — 카메라에 비스듬히 달아도 화면이 돌아가지 않게 */
        @JavascriptInterface
        fun setOrientation(mode: String) {
            val o = when (mode) {
                "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            ctx.runOnUiThread { if (ctx.requestedOrientation != o) ctx.requestedOrientation = o }
        }
    }
}
