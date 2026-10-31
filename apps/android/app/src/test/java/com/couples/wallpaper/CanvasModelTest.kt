package com.couples.wallpaper

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** Runs the exact same cases as packages/canvas-core/tests/fixtures.test.js, so the two ports cannot drift apart. */
class CanvasModelTest {
    private val fixtures: JSONObject = JSONObject(
        javaClass.classLoader!!.getResourceAsStream("cases.json")!!.bufferedReader().use { it.readText() }
    )

    private fun list(a: JSONArray) = (0 until a.length()).map { a.getJSONObject(it) }
    private fun strings(a: JSONArray) = (0 until a.length()).map { a.getString(it) }
    private fun colorOf(hex: String) = (0xFF000000L or hex.substring(1).toLong(16)).toInt()

    @Test fun sceneCases() {
        for (k in list(fixtures.getJSONArray("scene"))) {
            val name = k.getString("name")
            val entries = list(k.getJSONArray("entries")).map {
                val op = validateOp(it.getJSONObject("op"))
                assertNotNull("$name: fixture op must be valid", op)
                Entry(it.getLong("seq"), it.getString("senderId"), op!!)
            }
            val s = computeScene(entries)
            assertEquals("$name: visible", strings(k.getJSONArray("visible")), s.visible.map { drawableId(it.op) })
            assertEquals("$name: hidden", strings(k.getJSONArray("hidden")), s.hidden.map { drawableId(it.op) })
            val bg = k.getJSONObject("bg")
            assertEquals("$name: bg colour", colorOf(bg.getString("color")), s.bg.color)
            assertEquals("$name: bg pattern", bg.getString("pattern"), s.bg.pattern)
        }
    }

    @Test fun validateOpCases() {
        for (k in list(fixtures.getJSONArray("validate"))) {
            val name = k.getString("name")
            val op = validateOp(k.getJSONObject("op"))
            assertEquals("$name: validity", k.getBoolean("valid"), op != null)
            if (op != null && k.has("expectPts")) {
                assertEquals("$name: pts", (0 until k.getJSONArray("expectPts").length()).map { k.getJSONArray("expectPts").getInt(it) }, (op as StrokeOp).pts.toList())
            }
            if (op != null && k.has("expectSize")) {
                val size = when (op) { is StrokeOp -> op.size; is StickerOp -> op.size; else -> -1 }
                assertEquals("$name: size", k.getInt("expectSize"), size)
            }
        }
    }

    @Test fun validateLiveCases() {
        for (k in list(fixtures.getJSONArray("validateLive"))) {
            assertEquals(k.getString("name"), k.getBoolean("valid"), validateLive(k.getJSONObject("payload")) != null)
        }
    }
}
