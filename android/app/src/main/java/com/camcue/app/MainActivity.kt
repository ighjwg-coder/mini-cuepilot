package com.camcue.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * 첫 화면: 같은 Wi-Fi 의 CamCue 서버를 자동으로 찾고, 카메라 번호를 고르면 CueScreen 으로.
 * 마지막에 쓴 서버·카메라를 기억해서, 서버가 하나만 보이면 바로 그 카메라 화면을 연다.
 */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var serverList: LinearLayout
    private lateinit var camLabel: TextView
    private val camButtons = mutableListOf<TextView>()

    private var servers: List<Server> = emptyList()
    private var selected: Server? = null
    private var searching = false
    /** 앱을 막 켰을 때만 자동 접속 (CueScreen 에서 뒤로 오면 고를 수 있게) */
    private var autoOpen = true

    private val prefs by lazy { getSharedPreferences("camcue", Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        autoOpen = savedInstanceState == null
        setContentView(buildUi())
        // 지난번 서버를 먼저 보여 주고, 백그라운드로 다시 찾기
        lastServer()?.let { servers = listOf(it); selected = it; renderServers() }
        search()
    }

    override fun onRestart() {
        super.onRestart()
        autoOpen = false
        renderCameras()
    }

    private fun buildUi(): View {
        val pad = Ui.dp(this, 20)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        col.addView(Ui.text(this, "📹  캠큐  CamCue", 26f, bold = true))
        col.addView(Ui.text(this, "카메라맨용 큐 화면 · v${BuildConfigCompat.versionName(this)}", 14f, Ui.MUTED))

        col.addView(section("1. 캠큐 서버"))
        status = Ui.text(this, "", 15f, Ui.MUTED)
        col.addView(status)
        serverList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(serverList, lp(top = 8))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(Ui.button(this, "↻  다시 찾기") { search() }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(View(this), LinearLayout.LayoutParams(Ui.dp(this, 10), 1))
        row.addView(Ui.button(this, "IP 직접 입력") { manualInput() }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        col.addView(row, lp(top = 10))

        col.addView(section("2. 내 카메라 번호"))
        camLabel = Ui.text(this, "", 14f, Ui.MUTED)
        col.addView(camLabel)
        val grid = GridLayout(this).apply { columnCount = 4 }
        for (n in 1..8) {
            val color = Ui.CAMERA_COLORS[n] ?: Ui.TEXT
            val b = TextView(this).apply {
                text = "CAM\n$n"
                gravity = Gravity.CENTER
                textSize = 20f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setTextColor(color)
                background = Ui.box(this@MainActivity, Ui.PANEL2, color, 2)
                setOnClickListener { openCamera(n) }
            }
            camButtons += b
            grid.addView(b, GridLayout.LayoutParams().apply {
                width = 0
                height = Ui.dp(this@MainActivity, 84)
                columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f)
                setMargins(Ui.dp(this@MainActivity, 4), Ui.dp(this@MainActivity, 4), Ui.dp(this@MainActivity, 4), Ui.dp(this@MainActivity, 4))
            })
        }
        col.addView(grid, lp(top = 8))

        col.addView(
            Ui.text(
                this,
                "· 폰과 캠큐 PC 가 같은 Wi-Fi 여야 합니다 (게스트 Wi-Fi 는 안 될 수 있음)\n" +
                    "· CueScreen 에서 뒤로 가기를 누르면 카메라를 바꿀 수 있습니다\n" +
                    "· 앱 화면에서는 화면이 꺼지지 않고, 내 차례가 되면 진동합니다",
                13f, Ui.MUTED,
            ),
            lp(top = 24),
        )
        renderCameras()
        return ScrollView(this).apply {
            setBackgroundColor(Ui.BG)
            addView(col)
        }
    }

    private fun section(title: String) = Ui.text(this, title, 18f, bold = true).apply {
        setPadding(0, Ui.dp(this@MainActivity, 24), 0, Ui.dp(this@MainActivity, 6))
    }

    private fun lp(top: Int = 0) = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
        topMargin = Ui.dp(this@MainActivity, top)
    }

    // ── 서버 찾기 ──
    private fun search() {
        if (searching) return
        searching = true
        status.text = if (onWifi()) "같은 Wi-Fi 에서 캠큐 서버를 찾는 중…" else "⚠ Wi-Fi 에 연결되어 있지 않습니다. 캠큐 PC 와 같은 Wi-Fi 에 연결하세요."
        status.setTextColor(Ui.MUTED)
        Thread {
            val found = Discovery.find()
            // 지난번 서버가 자동 검색에 안 잡혀도 살아 있으면 목록에 포함
            val last = lastServer()
            val merged = if (last != null && found.none { it.address == last.address }) {
                Discovery.check(last.host, last.port, 1200)?.let { found + it } ?: found
            } else found
            runOnUiThread { onFound(merged) }
        }.start()
    }

    private fun onFound(found: List<Server>) {
        searching = false
        servers = found
        selected = found.firstOrNull { it.address == selected?.address } ?: found.firstOrNull { it.address == lastServer()?.address } ?: found.singleOrNull()
        renderServers()
        if (found.isEmpty()) {
            status.text = "캠큐 서버를 찾지 못했습니다.\n· PC 에서 캠큐가 실행 중인지\n· 같은 Wi-Fi 인지 확인 후 [다시 찾기] 또는 [IP 직접 입력]"
            status.setTextColor(Ui.BAD)
        } else {
            status.text = if (found.size == 1) "서버를 찾았습니다" else "서버 ${found.size}개 — 접속할 서버를 누르세요"
            status.setTextColor(Ui.OK)
        }
        val cam = prefs.getInt("camera", 0)
        if (autoOpen && found.size == 1 && cam in 1..8) {
            autoOpen = false
            openCamera(cam)
        }
    }

    private fun renderServers() {
        serverList.removeAllViews()
        for (s in servers) {
            val on = s.address == selected?.address
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                val p = Ui.dp(this@MainActivity, 14)
                setPadding(p, p, p, p)
                background = Ui.box(this@MainActivity, if (on) 0xFF13233D.toInt() else Ui.PANEL, if (on) Ui.ACCENT else Ui.BORDER, 2)
                setOnClickListener {
                    selected = s
                    autoOpen = false
                    renderServers()
                }
            }
            card.addView(Ui.text(this, (if (on) "✓  " else "") + s.name, 18f, bold = true))
            card.addView(Ui.text(this, "${s.address}   ·   v${s.version}", 14f, Ui.MUTED))
            serverList.addView(card, lp(top = 6))
        }
        renderCameras()
    }

    private fun renderCameras() {
        if (!::camLabel.isInitialized) return
        val enabled = selected != null
        val last = prefs.getInt("camera", 0)
        camLabel.text = if (enabled) "누르면 바로 접속합니다" + (if (last in 1..8) " (지난번: CAM $last)" else "") else "먼저 서버를 찾거나 고르세요"
        camButtons.forEachIndexed { i, b ->
            b.alpha = if (enabled) 1f else 0.35f
            b.isEnabled = enabled
            val color = Ui.CAMERA_COLORS[i + 1] ?: Ui.TEXT
            b.background = Ui.box(this, if (i + 1 == last && enabled) 0xFF222A33.toInt() else Ui.PANEL2, color, if (i + 1 == last) 3 else 2)
        }
    }

    private fun manualInput() {
        val input = EditText(this).apply {
            hint = "예) 192.168.0.10 또는 192.168.0.10:38090"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(lastServer()?.address ?: "")
            setTextColor(Color.BLACK)
        }
        AlertDialog.Builder(this)
            .setTitle("캠큐 PC 주소")
            .setMessage("PC 의 캠큐 서버 창에 표시된 주소를 입력하세요.")
            .setView(input)
            .setPositiveButton("접속") { _, _ ->
                val text = input.text.toString()
                status.text = "$text 확인 중…"
                Thread {
                    val s = Discovery.checkManual(text)
                    runOnUiThread {
                        if (s == null) {
                            status.text = "$text 에서 캠큐 서버를 찾지 못했습니다"
                            status.setTextColor(Ui.BAD)
                        } else {
                            servers = (servers.filter { it.address != s.address } + s)
                            selected = s
                            autoOpen = false
                            status.text = "서버를 찾았습니다"
                            status.setTextColor(Ui.OK)
                            renderServers()
                        }
                    }
                }.start()
            }
            .setNegativeButton("취소", null)
            .show()
    }

    private fun openCamera(n: Int) {
        val s = selected ?: return
        prefs.edit()
            .putInt("camera", n)
            .putString("host", s.host)
            .putInt("port", s.port)
            .putString("name", s.name)
            .putString("version", s.version)
            .putString("proto", s.proto)
            .apply()
        startActivity(
            Intent(this, CueActivity::class.java)
                .putExtra(CueActivity.EXTRA_HOST, s.host)
                .putExtra(CueActivity.EXTRA_PORT, s.port)
                .putExtra(CueActivity.EXTRA_PROTO, s.proto)
                .putExtra(CueActivity.EXTRA_CAMERA, n),
        )
    }

    private fun lastServer(): Server? {
        val host = prefs.getString("host", null) ?: return null
        return Server(
            prefs.getString("name", host) ?: host,
            host,
            prefs.getInt("port", 38080),
            prefs.getString("version", "") ?: "",
            prefs.getString("proto", "http") ?: "http",
        )
    }

    private fun onWifi(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }
}

/** BuildConfig 생성을 끈 상태에서 앱 버전 읽기 */
object BuildConfigCompat {
    fun versionName(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (_: Exception) {
        ""
    }
}
