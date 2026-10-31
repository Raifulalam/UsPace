package com.couples.wallpaper

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/** In-progress preview from the partner (never persisted). */
class LiveItem(
    val sid: String, val senderId: String, val isText: Boolean,
    var tool: String = "pen", var color: Int = 0, var size: Int = 4,
    var pts: MutableList<Int> = ArrayList(), var text: String = "", var x: Int = 0, var y: Int = 0,
    @Volatile var lastAt: Long = System.currentTimeMillis(),
)

/** Draws the shared canvas (logical 1000x700 space) fitted and centred on the screen. Mirrors canvasDraw.ts. */
class CanvasRenderer {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val heart = Path()

    fun drawScene(c: Canvas, width: Int, height: Int, scene: Scene, live: Collection<LiveItem>) {
        c.drawColor(scene.bg.color)
        val scale = min(width.toFloat() / W, height.toFloat() / H)
        val ox = (width - W * scale) / 2f
        val oy = (height - H * scale) / 2f
        c.save()
        c.translate(ox, oy)
        c.scale(scale, scale)
        drawPattern(c, scene.bg)
        // Eraser strokes use CLEAR, which must only cut the drawing layer, never the background underneath.
        val layer = c.saveLayer(RectF(0f, 0f, W.toFloat(), H.toFloat()), null)
        for (e in scene.visible) drawEntry(c, e.op)
        c.restoreToCount(layer)
        for (it in live) drawLive(c, it)
        c.restore()
    }

    /** Neutral screen shown when sharing is locked, not set up, or waiting. No drawing content is rendered. */
    fun drawPlaceholder(c: Canvas, width: Int, height: Int, bgColor: Int = DEFAULT_BG_COLOR) {
        c.drawColor(bgColor)
        val r = min(width, height) * 0.16f
        paint.reset(); paint.isAntiAlias = true
        paint.color = 0x33DB2777
        paint.style = Paint.Style.FILL
        heartPath(heart, width / 2f, height / 2f, r)
        c.drawPath(heart, paint)
    }

    private fun heartPath(p: Path, cx: Float, cy: Float, r: Float) {
        p.reset()
        p.moveTo(cx, cy + r * 0.8f)
        p.cubicTo(cx - r, cy + r * 0.1f, cx - r * 0.8f, cy - r * 0.8f, cx, cy - r * 0.35f)
        p.cubicTo(cx + r * 0.8f, cy - r * 0.8f, cx + r, cy + r * 0.1f, cx, cy + r * 0.8f)
        p.close()
    }

    private fun drawPattern(c: Canvas, bg: BgOp) {
        if (bg.pattern == "none") return
        paint.reset(); paint.isAntiAlias = true
        paint.color = 0x2E7864A0
        paint.strokeWidth = 1f
        when (bg.pattern) {
            "dots" -> { paint.style = Paint.Style.FILL; var x = 20; while (x < W) { var y = 20; while (y < H) { c.drawCircle(x.toFloat(), y.toFloat(), 2f, paint); y += 40 }; x += 40 } }
            "grid" -> { var x = 0; while (x <= W) { c.drawLine(x.toFloat(), 0f, x.toFloat(), H.toFloat(), paint); x += 50 }; var y = 0; while (y <= H) { c.drawLine(0f, y.toFloat(), W.toFloat(), y.toFloat(), paint); y += 50 } }
            "lines" -> { var y = 40; while (y <= H) { c.drawLine(0f, y.toFloat(), W.toFloat(), y.toFloat(), paint); y += 40 } }
            "hearts" -> {
                paint.style = Paint.Style.FILL; paint.color = 0x21DB2777
                var row = 0; var y = 45
                while (y < H) { var x = 45 + (row % 2) * 45; while (x < W) { heartPath(heart, x.toFloat(), y.toFloat(), 14f); c.drawPath(heart, paint); x += 90 }; y += 90; row++ }
            }
        }
    }

    private fun drawEntry(c: Canvas, op: Op) {
        when (op) {
            is StrokeOp -> drawStroke(c, op.tool, op.color, op.size, op.pts, false)
            is TextOp -> drawText(c, op.text, op.x, op.y, op.color, op.size)
            is StickerOp -> drawSticker(c, op)
            else -> Unit
        }
    }

    private fun drawLive(c: Canvas, it: LiveItem) {
        if (it.isText) { if (it.text.isNotEmpty()) drawText(c, it.text, it.x, it.y, it.color, it.size) }
        else if (it.pts.size >= 2) drawStroke(c, it.tool, it.color, it.size, it.pts.toIntArray(), true)
    }

    private fun drawStroke(c: Canvas, tool: String, color: Int, size: Int, pts: IntArray, preview: Boolean) {
        paint.reset(); paint.isAntiAlias = true
        paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
        paint.strokeWidth = when (tool) { "brush" -> size * 1.8f; "eraser" -> size * 3f; else -> size.toFloat() }
        paint.color = color
        if (tool == "brush") paint.alpha = 166
        if (tool == "eraser") {
            if (preview) paint.color = 0x73A0A0B0 else paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
        }
        if (pts.size == 2) {
            paint.style = Paint.Style.FILL
            c.drawCircle(pts[0].toFloat(), pts[1].toFloat(), paint.strokeWidth / 2f, paint)
            return
        }
        paint.style = Paint.Style.STROKE
        val p = Path()
        p.moveTo(pts[0].toFloat(), pts[1].toFloat())
        var i = 2
        while (i < pts.size - 2) { // smooth through midpoints, same as the web renderer
            p.quadTo(pts[i].toFloat(), pts[i + 1].toFloat(), (pts[i] + pts[i + 2]) / 2f, (pts[i + 1] + pts[i + 3]) / 2f)
            i += 2
        }
        p.lineTo(pts[pts.size - 2].toFloat(), pts[pts.size - 1].toFloat())
        c.drawPath(p, paint)
    }

    private fun drawText(c: Canvas, text: String, x: Int, y: Int, color: Int, size: Int) {
        paint.reset(); paint.isAntiAlias = true
        paint.color = color; paint.textSize = size.toFloat(); paint.style = Paint.Style.FILL
        text.split('\n').forEachIndexed { i, line -> c.drawText(line, x.toFloat(), y - paint.ascent() + i * size * 1.2f, paint) }
    }

    private fun drawSticker(c: Canvas, s: StickerOp) {
        c.save()
        c.translate(s.x.toFloat(), s.y.toFloat())
        c.rotate(s.rot.toFloat())
        val r = s.size / 2f
        paint.reset(); paint.isAntiAlias = true; paint.style = Paint.Style.FILL; paint.color = s.color
        when (s.kind) {
            "heart" -> { heartPath(heart, 0f, 0f, r); c.drawPath(heart, paint) }
            "star", "spark" -> {
                val n = if (s.kind == "star") 5 else 4
                val inner = if (s.kind == "star") 0.45f else 0.25f
                val p = Path()
                for (i in 0 until n * 2) {
                    val a = (PI * i / n - PI / 2).toFloat()
                    val rr = if (i % 2 == 0) r else r * inner
                    if (i == 0) p.moveTo(cos(a) * rr, sin(a) * rr) else p.lineTo(cos(a) * rr, sin(a) * rr)
                }
                p.close(); c.drawPath(p, paint)
            }
            "flower" -> {
                for (i in 0 until 5) { val a = (2 * PI * i / 5).toFloat(); c.drawCircle(cos(a) * r * 0.5f, sin(a) * r * 0.5f, r * 0.45f, paint) }
                paint.color = 0xFFFDE68A.toInt(); c.drawCircle(0f, 0f, r * 0.28f, paint)
            }
            "arrow" -> {
                val pts = floatArrayOf(-1f, -0.15f, 0.3f, -0.15f, 0.3f, -0.5f, 1f, 0f, 0.3f, 0.5f, 0.3f, 0.15f, -1f, 0.15f)
                val p = Path()
                for (i in pts.indices step 2) if (i == 0) p.moveTo(pts[i] * r, pts[i + 1] * r) else p.lineTo(pts[i] * r, pts[i + 1] * r)
                p.close(); c.drawPath(p, paint)
            }
        }
        c.restore()
    }
}
