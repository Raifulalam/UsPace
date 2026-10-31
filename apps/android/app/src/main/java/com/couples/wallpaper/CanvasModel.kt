package com.couples.wallpaper

import org.json.JSONArray
import org.json.JSONObject

// Kotlin port of packages/canvas-core/src/index.js. Both are run against packages/canvas-core/fixtures/cases.json.
// Pure Kotlin + org.json: no Android classes, so it is unit-testable on the JVM.

const val W = 1000
const val H = 700
const val DEFAULT_BG_COLOR = 0xFFFFF7FB.toInt()
const val MAX_STROKE_COORDS = 3000
const val MAX_LIVE_COORDS = 400
private val TOOLS = setOf("pen", "brush", "eraser")
private val STICKERS = setOf("heart", "star", "flower", "arrow", "spark")
private val PATTERNS = setOf("none", "dots", "grid", "lines", "hearts")
private val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
private val COLOR_RE = Regex("^#[0-9a-fA-F]{6}$")

sealed class Op
class StrokeOp(val id: String, val tool: String, val color: Int, val size: Int, val pts: IntArray) : Op()
class TextOp(val id: String, val text: String, val x: Int, val y: Int, val color: Int, val size: Int) : Op()
class StickerOp(val id: String, val kind: String, val x: Int, val y: Int, val color: Int, val size: Int, val rot: Double) : Op()
class UndoOp(val target: String) : Op()
class RedoOp(val target: String) : Op()
object ClearOp : Op()
class BgOp(val color: Int, val pattern: String) : Op()

class Entry(val seq: Long, val senderId: String, val op: Op)
class Scene(val visible: List<Entry>, val hidden: List<Entry>, val bg: BgOp)

sealed class LivePayload { abstract val sid: String }
class LiveStroke(override val sid: String, val tool: String, val color: Int, val size: Int, val pts: IntArray, val start: Boolean) : LivePayload()
class LiveText(override val sid: String, val text: String, val x: Int, val y: Int, val color: Int, val size: Int) : LivePayload()

// ---------- helpers ----------
private fun num(o: JSONObject, k: String): Double? {
    val v = o.opt(k)
    return if (v is Number && v.toDouble().isFinite()) v.toDouble() else null // JSON strings are NOT numbers
}
private fun str(o: JSONObject, k: String): String? = o.opt(k) as? String
private fun clampInt(n: Double, lo: Int, hi: Int): Int = Math.round(n).coerceIn(lo.toLong(), hi.toLong()).toInt()
private fun cx(n: Double) = clampInt(n, -50, W + 50)
private fun cy(n: Double) = clampInt(n, -50, H + 50)
private fun parseColor(s: String?): Int? =
    if (s != null && COLOR_RE.matches(s)) (0xFF000000L or s.substring(1).toLong(16)).toInt() else null
private fun isUuid(s: String?) = s != null && UUID_RE.matches(s)

private fun cleanPts(arr: JSONArray?, max: Int): IntArray? {
    if (arr == null || arr.length() < 2 || arr.length() % 2 != 0 || arr.length() > max) return null
    val out = IntArray(arr.length())
    for (i in 0 until arr.length()) {
        val v = arr.opt(i)
        if (v !is Number || !v.toDouble().isFinite()) return null
        out[i] = if (i % 2 == 0) cx(v.toDouble()) else cy(v.toDouble())
    }
    return out
}

// ---------- validation of DECRYPTED payloads (a partner's client is not trusted to be well-formed) ----------
fun validateOp(o: JSONObject?): Op? {
    if (o == null) return null
    when (str(o, "t")) {
        "stroke" -> {
            val id = str(o, "id"); val tool = str(o, "tool")
            if (!isUuid(id) || tool == null || tool !in TOOLS) return null
            val color = parseColor(str(o, "color")) ?: return null
            val size = num(o, "size") ?: return null
            val pts = cleanPts(o.optJSONArray("pts"), MAX_STROKE_COORDS) ?: return null
            return StrokeOp(id!!, tool, color, clampInt(size, 1, 64), pts)
        }
        "text" -> {
            val id = str(o, "id"); val text = str(o, "text")
            if (!isUuid(id) || text == null || text.isEmpty() || text.length > 280) return null
            val x = num(o, "x") ?: return null; val y = num(o, "y") ?: return null
            val color = parseColor(str(o, "color")) ?: return null
            val size = num(o, "size") ?: return null
            return TextOp(id!!, text, cx(x), cy(y), color, clampInt(size, 8, 160))
        }
        "sticker" -> {
            val id = str(o, "id"); val kind = str(o, "kind")
            if (!isUuid(id) || kind == null || kind !in STICKERS) return null
            val x = num(o, "x") ?: return null; val y = num(o, "y") ?: return null
            val color = parseColor(str(o, "color")) ?: return null
            val size = num(o, "size") ?: return null
            val rot = (num(o, "rot") ?: 0.0).coerceIn(-360.0, 360.0)
            return StickerOp(id!!, kind, cx(x), cy(y), color, clampInt(size, 16, 320), rot)
        }
        "undo" -> { val t = str(o, "target"); return if (isUuid(t)) UndoOp(t!!) else null }
        "redo" -> { val t = str(o, "target"); return if (isUuid(t)) RedoOp(t!!) else null }
        "clear" -> return ClearOp
        "bg" -> {
            val color = parseColor(str(o, "color")) ?: return null
            val pattern = str(o, "pattern")
            return if (pattern != null && pattern in PATTERNS) BgOp(color, pattern) else null
        }
        else -> return null
    }
}

fun validateLive(o: JSONObject?): LivePayload? {
    if (o == null) return null
    val sid = str(o, "sid")
    if (!isUuid(sid)) return null
    when (str(o, "k")) {
        "stroke" -> {
            val tool = str(o, "tool")
            if (tool == null || tool !in TOOLS) return null
            val color = parseColor(str(o, "color")) ?: return null
            val size = num(o, "size") ?: return null
            val pts = cleanPts(o.optJSONArray("pts"), MAX_LIVE_COORDS) ?: return null
            return LiveStroke(sid!!, tool, color, clampInt(size, 1, 64), pts, o.opt("start") == true)
        }
        "text" -> {
            val text = str(o, "text")
            if (text == null || text.length > 280) return null // empty text = "remove my preview"
            val x = num(o, "x") ?: return null; val y = num(o, "y") ?: return null
            val color = parseColor(str(o, "color")) ?: return null
            val size = num(o, "size") ?: return null
            return LiveText(sid!!, text, cx(x), cy(y), color, clampInt(size, 8, 160))
        }
        else -> return null
    }
}

// ---------- scene ----------
private class Vote(val hidden: Boolean, val by: String)

/** Ops apply in seq order; `clear` wipes earlier drawings; undo/redo only affect the sender's own drawings. */
fun computeScene(entries: List<Entry>): Scene {
    val seen = HashSet<Long>()
    val list = entries.filter { seen.add(it.seq) }.sortedBy { it.seq }
    var drawables = ArrayList<Entry>()
    val votes = HashMap<String, Vote>()
    var bg = BgOp(DEFAULT_BG_COLOR, "none")
    for (e in list) {
        when (val op = e.op) {
            is StrokeOp, is TextOp, is StickerOp -> drawables.add(e)
            is UndoOp -> votes[op.target] = Vote(true, e.senderId)
            is RedoOp -> votes[op.target] = Vote(false, e.senderId)
            is ClearOp -> drawables = ArrayList()
            is BgOp -> bg = op
        }
    }
    val visible = ArrayList<Entry>()
    val hidden = ArrayList<Entry>()
    for (d in drawables) {
        val v = votes[drawableId(d.op)]
        if (v != null && v.hidden && v.by == d.senderId) hidden.add(d) else visible.add(d)
    }
    return Scene(visible, hidden, bg)
}

fun drawableId(op: Op): String? = when (op) {
    is StrokeOp -> op.id
    is TextOp -> op.id
    is StickerOp -> op.id
    else -> null
}
