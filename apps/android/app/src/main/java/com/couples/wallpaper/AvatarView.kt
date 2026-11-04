package com.couples.wallpaper

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.view.View
import kotlin.math.min

/** Round avatar with initials, coloured from a stable seed (like most social apps without a photo). */
class AvatarView(context: Context) : View(context) {
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val fg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textAlign = Paint.Align.CENTER; typeface = Typeface.DEFAULT_BOLD }
    private var initials = "?"

    fun setPerson(name: String, seed: String) {
        initials = initialsOf(name)
        bg.color = PALETTE[(seed.hashCode() and 0x7fffffff) % PALETTE.size]
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val r = min(width, height) / 2f
        canvas.drawCircle(width / 2f, height / 2f, r, bg)
        fg.textSize = r * 0.85f
        canvas.drawText(initials, width / 2f, height / 2f - (fg.descent() + fg.ascent()) / 2f, fg)
    }

    companion object {
        private val PALETTE = intArrayOf(0xFFD946B8.toInt(), 0xFFA855F7.toInt(), 0xFF7C3AED.toInt(), 0xFFEC4899.toInt(), 0xFFDB2777.toInt(), 0xFF9333EA.toInt())
        fun initialsOf(name: String): String {
            val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            return when (parts.size) {
                0 -> "?"
                1 -> parts[0].take(1).uppercase()
                else -> (parts[0].take(1) + parts[1].take(1)).uppercase()
            }
        }
    }
}
