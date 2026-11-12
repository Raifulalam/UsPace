package com.couples.wallpaper

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Color
import android.view.View
import android.view.MotionEvent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.util.UUID

class NativeCanvasActivity : ComponentActivity() {
    override fun onResume() {
        super.onResume()
        SyncHub.acquire(this)
    }

    override fun onPause() {
        SyncHub.release()
        super.onPause()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        setContent {
            var loading by remember { mutableStateOf(true) }
            var error by remember { mutableStateOf<String?>(null) }
            var canvases by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
            var refresh by remember { mutableIntStateOf(0) }
            var newestCanvasId by remember { mutableStateOf<String?>(null) }
            var selectedCanvasId by remember { mutableStateOf<String?>(null) }
            var coupleId by remember { mutableStateOf<String?>(null) }
            var keyVersion by remember { mutableStateOf<Int?>(null) }
            var tool by remember { mutableStateOf("pen") }
            var confirmClear by remember { mutableStateOf(false) }
            val scope = rememberCoroutineScope()
            suspend fun loadCanvases() {
                val items = SyncHub.api.get("/canvases").getJSONArray("canvases")
                canvases = (0 until items.length()).map {
                    val canvas = items.getJSONObject(it)
                    canvas.getString("id") to canvas.optString("name", "Shared canvas")
                }
                newestCanvasId = canvases.lastOrNull()?.first
                if (selectedCanvasId == null) selectedCanvasId = newestCanvasId
                val couple = SyncHub.api.get("/couples/me").getJSONObject("couple")
                coupleId = couple.getString("id")
                keyVersion = couple.getInt("keyVersion")
            }
            suspend fun saveOp(payload: JSONObject) {
                val canvasId = selectedCanvasId ?: newestCanvasId ?: throw IllegalStateException("Start a canvas first.")
                val roomId = coupleId ?: throw IllegalStateException("No active shared space.")
                val version = keyVersion ?: throw IllegalStateException("Room key is not ready.")
                val senderId = SyncHub.store.userId ?: throw IllegalStateException("Sign in again to continue.")
                val deviceId = SyncHub.store.deviceId ?: throw IllegalStateException("This device is not registered.")
                val key = SyncHub.store.roomKey(version) ?: throw IllegalStateException("Approve this device before drawing.")
                val clientOpId = UUID.randomUUID().toString()
                val aad = "couples-canvas-op-v1|$roomId|$canvasId|$senderId|$clientOpId|$version"
                val (nonce, ciphertext) = Crypto.encryptPayload(key, payload, aad)
                SyncHub.api.post("/canvases/$canvasId/ops", JSONObject()
                    .put("clientOpId", clientOpId).put("deviceId", deviceId).put("keyVersion", version)
                    .put("nonce", nonce).put("ciphertext", ciphertext))
            }
            LaunchedEffect(Unit) {
                runCatching { loadCanvases() }.onFailure { error = it.message ?: "Could not load canvases." }
                loading = false
            }
            LaunchedEffect(Unit) {
                while (true) { delay(500); refresh = SyncHub.version.toInt() }
            }
            com.couples.wallpaper.ui.UsPaceTheme {
                Column(
                    Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("Shared canvas", style = MaterialTheme.typography.headlineMedium)
                    Text("Choose a canvas to draw on together.")
                    AndroidView(
                        modifier = Modifier.fillMaxWidth().height(360.dp),
                        factory = { context -> CanvasEditorView(context) { points ->
                            scope.launch {
                                runCatching {
                                    val payload = JSONObject().put("t", "stroke").put("id", UUID.randomUUID().toString()).put("tool", tool)
                                        .put("color", "#7C3AED").put("size", 6).put("pts", org.json.JSONArray(points.toList()))
                                    saveOp(payload)
                                    error = null
                                }.onFailure { error = it.message ?: "Could not save the drawing." }
                            }
                        } },
                        update = { view -> view.tool = tool; if (refresh >= 0) view.invalidate() },
                    )
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("pen", "brush", "eraser").forEach { item ->
                            if (tool == item) Button(onClick = { tool = item }) { Text(item.replaceFirstChar { it.uppercase() }) }
                            else androidx.compose.material3.OutlinedButton(onClick = { tool = item }) { Text(item.replaceFirstChar { it.uppercase() }) }
                        }
                    }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        androidx.compose.material3.OutlinedButton(onClick = {
                            val userId = SyncHub.store.userId
                            val own = SyncHub.scene.visible.lastOrNull { it.senderId == userId && drawableId(it.op) != null }
                            val target = own?.let { drawableId(it.op) }
                            if (target == null) error = "There is no drawing from you to undo."
                            else scope.launch { runCatching { saveOp(JSONObject().put("t", "undo").put("target", target)) }
                                .onFailure { error = it.message ?: "Could not undo." } }
                        }) { Text("Undo my last stroke") }
                        androidx.compose.material3.OutlinedButton(onClick = { confirmClear = true }) { Text("Clear for both") }
                        androidx.compose.material3.OutlinedButton(onClick = {
                            scope.launch { runCatching { saveOp(JSONObject().put("t", "bg").put("color", "#FFF7FB").put("pattern", "hearts")) }
                                .onFailure { error = it.message ?: "Could not change the background." } }
                        }) { Text("Heart background") }
                    }
                    Button(onClick = {
                        scope.launch {
                            runCatching {
                                SyncHub.api.post("/canvases", JSONObject())
                                SyncHub.restart()
                                loadCanvases()
                            }.onFailure { error = it.message ?: "Could not start a canvas." }
                        }
                    }, modifier = Modifier.fillMaxWidth()) { Text("Start a new canvas") }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        androidx.compose.material3.OutlinedButton(onClick = {
                            selectedCanvasId = null
                            SyncHub.followNewestCanvas()
                        }) { Text("Follow newest") }
                        canvases.forEach { canvas ->
                            val selected = selectedCanvasId == canvas.first
                            if (selected) Button(onClick = { selectedCanvasId = canvas.first; SyncHub.selectCanvas(canvas.first) }) { Text(canvas.second) }
                            else androidx.compose.material3.OutlinedButton(onClick = { selectedCanvasId = canvas.first; SyncHub.selectCanvas(canvas.first) }) { Text(canvas.second) }
                        }
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (loading) Text("Loading canvases…")
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(canvases, key = { it.first }) { canvas ->
                            Text(canvas.second + if (canvas.first == selectedCanvasId) " · Selected" else "", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            if (confirmClear) {
                androidx.compose.material3.AlertDialog(
                    onDismissRequest = { confirmClear = false },
                    title = { Text("Clear shared canvas?") },
                    text = { Text("This removes the current picture for both of you and cannot be undone.") },
                    confirmButton = { androidx.compose.material3.TextButton(onClick = {
                        confirmClear = false
                        scope.launch { runCatching { saveOp(JSONObject().put("t", "clear")) }
                            .onFailure { error = it.message ?: "Could not clear canvas." } }
                    }) { Text("Clear") } },
                    dismissButton = { androidx.compose.material3.TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
                )
            }
        }
    }
}

private class CanvasEditorView(context: android.content.Context, private val onStroke: (IntArray) -> Unit) : View(context) {
    private val renderer = CanvasRenderer()
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(124, 58, 237); strokeWidth = 6f; style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val activePoints = ArrayList<Int>(256)
    var tool: String = "pen"

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        renderer.drawScene(canvas, width, height, SyncHub.scene, SyncHub.live.values)
        if (activePoints.size >= 4) {
            canvas.save()
            canvas.scale(width.toFloat() / W, height.toFloat() / H)
            if (tool == "eraser") { strokePaint.color = 0x73A0A0B0; strokePaint.strokeWidth = 18f }
            else { strokePaint.color = Color.rgb(124, 58, 237); strokePaint.strokeWidth = if (tool == "brush") 11f else 6f }
            val path = Path().apply {
                moveTo(activePoints[0].toFloat(), activePoints[1].toFloat())
                for (i in 2 until activePoints.size step 2) lineTo(activePoints[i].toFloat(), activePoints[i + 1].toFloat())
            }
            canvas.drawPath(path, strokePaint)
            canvas.restore()
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (width <= 0 || height <= 0) return false
        val x = (event.x * W / width).toInt().coerceIn(-50, W + 50)
        val y = (event.y * H / height).toInt().coerceIn(-50, H + 50)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { activePoints.clear(); activePoints.add(x); activePoints.add(y); invalidate(); return true }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.historySize) {
                    activePoints.add((event.getHistoricalX(i) * W / width).toInt().coerceIn(-50, W + 50))
                    activePoints.add((event.getHistoricalY(i) * H / height).toInt().coerceIn(-50, H + 50))
                }
                activePoints.add(x); activePoints.add(y)
                if (activePoints.size > MAX_STROKE_COORDS) activePoints.subList(MAX_STROKE_COORDS, activePoints.size).clear()
                invalidate(); return true
            }
            MotionEvent.ACTION_UP -> {
                activePoints.add(x); activePoints.add(y)
                val points = activePoints.toIntArray()
                activePoints.clear(); invalidate()
                if (points.size >= 4) onStroke(points)
                performClick(); return true
            }
            MotionEvent.ACTION_CANCEL -> { activePoints.clear(); invalidate(); return true }
        }
        return true
    }

    override fun performClick(): Boolean { super.performClick(); return true }
}
