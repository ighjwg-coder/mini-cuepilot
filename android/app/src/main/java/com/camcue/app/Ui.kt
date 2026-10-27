package com.camcue.app

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.TextView

/** 화면 코드에서 쓰는 작은 도우미 (레이아웃 XML 없이 코드로 화면 구성) */
object Ui {
    const val BG = 0xFF0B0D10.toInt()
    const val PANEL = 0xFF14181D.toInt()
    const val PANEL2 = 0xFF1B2026.toInt()
    const val BORDER = 0xFF2A3038.toInt()
    const val TEXT = 0xFFE8EBEF.toInt()
    const val MUTED = 0xFF8B95A1.toInt()
    const val ACCENT = 0xFF3B82F6.toInt()
    const val OK = 0xFF22C55E.toInt()
    const val BAD = 0xFFEF4444.toInt()

    /** 웹 화면(format.ts)과 같은 카메라 색 */
    val CAMERA_COLORS = mapOf(
        // 웹과 같은 카메라 구분색 (탈리 색인 빨강·초록·노랑·주황 제외)
        1 to 0xFF3B82F6.toInt(), 2 to 0xFF06B6D4.toInt(), 3 to 0xFFA855F7.toInt(), 4 to 0xFFEC4899.toInt(),
        5 to 0xFFE2E8F0.toInt(), 6 to 0xFF818CF8.toInt(), 7 to 0xFFF0ABFC.toInt(), 8 to 0xFF94A3B8.toInt(),
    )

    fun dp(ctx: Context, v: Number): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), ctx.resources.displayMetrics).toInt()

    fun text(ctx: Context, s: CharSequence, sizeSp: Float = 16f, color: Int = TEXT, bold: Boolean = false) =
        TextView(ctx).apply {
            text = s
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            if (bold) typeface = Typeface.DEFAULT_BOLD
        }

    fun box(ctx: Context, fill: Int, stroke: Int = BORDER, strokeDp: Int = 1, radiusDp: Int = 12) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(ctx, radiusDp).toFloat()
        setStroke(dp(ctx, strokeDp), stroke)
    }

    fun button(ctx: Context, label: String, primary: Boolean = false, onClick: (View) -> Unit) = Button(ctx).apply {
        text = label
        isAllCaps = false
        setTextColor(if (primary) Color.WHITE else TEXT)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        typeface = Typeface.DEFAULT_BOLD
        background = box(ctx, if (primary) ACCENT else PANEL2, if (primary) ACCENT else 0xFF4B5563.toInt())
        minHeight = dp(ctx, 52)
        gravity = Gravity.CENTER
        setOnClickListener(onClick)
    }
}
