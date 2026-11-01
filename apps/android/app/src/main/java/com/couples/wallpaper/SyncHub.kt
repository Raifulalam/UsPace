package com.couples.wallpaper

import android.content.Context
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

class WireOp(val seq: Long, val clientOpId: String, val senderId: String, val keyVersion: Int, val nonce: String, val ciphertext: String) {
    companion object {
        fun from(o: JSONObject) = WireOp(o.getLong("seq"), o.getString("clientOpId"), o.getString("senderId"), o.getInt("keyVersion"), o.getString("nonce"), o.getString("ciphertext"))
    }
}

/**
 * Keeps one decrypted, ordered copy of the couple's newest canvas and follows the partner's live strokes.
 * It only runs while at least one wallpaper engine (or the setup screen) is visible, to save battery.
 */
object SyncHub {
    enum class Status { SIGNED_OUT, STARTING, WAITING_APPROVAL, NO_COUPLE, LIVE, OFFLINE }

    @Volatile var status = Status.SIGNED_OUT
        private set
    @Volatile var version = 0L // bumped on every visible change; renderers redraw only when it changes
        private set
    @Volatile var scene = Scene(emptyList(), emptyList(), BgOp(DEFAULT_BG_COLOR, "none"))
        private set
    /** Partner's display name (the member who is not me), from /couples/me. Empty until known. */
    @Volatile var partnerName = ""
        private set
    val live = ConcurrentHashMap<String, LiveItem>()

    private lateinit var appCtx: Context
    lateinit var store: Store
        private set
    lateinit var api: Api
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private var refs = 0
    private var job: Job? = null
    private var stopJob: Job? = null

    private val wire = ConcurrentHashMap<Long, WireOp>()
    private val decoded = ConcurrentHashMap<Long, Entry>()
    private val roomKeys = ConcurrentHashMap<Int, ByteArray>()
    @Volatile private var coupleId = ""
    @Volatile private var canvasId: String? = null
    @Volatile private var lastSeq = 0L
    @Volatile private var socket: Socket? = null

    @Synchronized fun init(ctx: Context) {
        if (::store.isInitialized) return
        appCtx = ctx.applicationContext
        store = Store(appCtx)
        api = Api(store)
    }

    fun acquire(ctx: Context) {
        init(ctx)
        synchronized(lock) {
            stopJob?.cancel(); stopJob = null
            refs++
            if (job?.isActive != true) job = scope.launch { runLoop() }
        }
    }

    fun release() {
        synchronized(lock) {
            refs = (refs - 1).coerceAtLeast(0)
            if (refs == 0) stopJob = scope.launch { delay(15_000); synchronized(lock) { if (refs == 0) { job?.cancel(); job = null } } }
        }
    }

    /** Called after sign-in/out so a running loop picks up the change immediately. */
    fun restart() {
        synchronized(lock) {
            job?.cancel(); job = null
            resetCanvas(); roomKeys.clear(); partnerName = ""
            if (refs > 0) job = scope.launch { runLoop() }
        }
    }

    private fun setStatus(s: Status) { if (status != s) { status = s; version++ } }

    private suspend fun runLoop() {
        var backoff = 2_000L
        while (scope.isActive) {
            try {
                if (!store.hasSession()) { setStatus(Status.SIGNED_OUT); delay(3_000); continue }
                if (status != Status.LIVE) setStatus(Status.STARTING)
                prepare()
                if (status == Status.WAITING_APPROVAL || status == Status.NO_COUPLE) { delay(8_000); continue }
                val started = System.currentTimeMillis()
                serve()
                // A connection that lived a while resets the backoff; one that died instantly backs off further.
                backoff = if (System.currentTimeMillis() - started > 30_000) 2_000 else (backoff * 2).coerceAtMost(60_000)
                delay(backoff)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 401) { setStatus(Status.SIGNED_OUT); delay(5_000) }
                else { setStatus(Status.OFFLINE); delay(backoff); backoff = (backoff * 2).coerceAtMost(60_000) }
            } catch (e: Exception) {
                setStatus(Status.OFFLINE); delay(backoff); backoff = (backoff * 2).coerceAtMost(60_000)
            }
        }
    }

    // ---------- setup: couple, keys, newest canvas ----------
    private suspend fun prepare() {
        for ((v, k) in store.roomKeys()) roomKeys.putIfAbsent(v, Crypto.unb64(k))
        val couple = try { api.get("/couples/me").getJSONObject("couple") } catch (e: ApiException) {
            if (e.status == 404) { setStatus(Status.NO_COUPLE); return } else throw e
        }
        if (couple.getString("status") != "active") { setStatus(Status.NO_COUPLE); return }
        coupleId = couple.getString("id")
        val members = couple.optJSONArray("members")
        var name = ""
        if (members != null) for (i in 0 until members.length()) {
            val m = members.optJSONObject(i) ?: continue
            if (m.optString("id") != store.userId) { name = m.optString("displayName").ifEmpty { m.optString("username") }; break }
        }
        if (name != partnerName) { partnerName = name; version++ }
        val current = couple.getInt("keyVersion")
        syncKeys()
        if (!roomKeys.containsKey(current)) { setStatus(Status.WAITING_APPROVAL); return }
        val list = api.get("/canvases").getJSONArray("canvases")
        val newest = if (list.length() > 0) list.getJSONObject(list.length() - 1).getString("id") else null
        if (newest != canvasId) { resetCanvas(); canvasId = newest }
    }

    private suspend fun syncKeys() {
        val secret = Crypto.unb64(store.deviceSecret ?: return)
        val r = api.get("/keys/envelopes?deviceId=${store.deviceId}")
        val arr = r.getJSONArray("envelopes")
        for (i in 0 until arr.length()) {
            val e = arr.getJSONObject(i)
            val v = e.getInt("keyVersion")
            if (roomKeys.containsKey(v)) continue
            val key = Crypto.unwrapRoomKey(e.getString("nonce"), e.getString("ciphertext"), e.getString("senderPublicKey"), secret) ?: continue
            roomKeys[v] = key
            store.putRoomKey(v, Crypto.b64(key))
        }
    }

    private fun resetCanvas() {
        wire.clear(); decoded.clear(); live.clear(); lastSeq = 0
        scene = Scene(emptyList(), emptyList(), BgOp(DEFAULT_BG_COLOR, "none")); version++
    }

    // ---------- realtime ----------
    private suspend fun serve() = coroutineScope {
        if (!api.refresh()) throw ApiException(401, "UNAUTHENTICATED") // fresh token for the socket handshake
        val done = CompletableDeferred<Unit>()
        val opts = IO.Options.builder()
            .setReconnection(false) // we reconnect ourselves so every attempt carries a fresh token
            .setTransports(arrayOf("websocket"))
            .setAuth(mapOf("token" to (api.accessToken ?: "")))
            .build()
        val s = IO.socket(store.baseUrl.trim().trimEnd('/'), opts)
        socket = s
        s.on(Socket.EVENT_CONNECT) { scope.launch { try { joinAndCatchUp(s) } catch (e: Exception) { done.complete(Unit) } } }
        s.on(Socket.EVENT_DISCONNECT) { done.complete(Unit) }
        s.on(Socket.EVENT_CONNECT_ERROR) { done.complete(Unit) }
        s.on("canvas:op") { a -> (a.getOrNull(0) as? JSONObject)?.let { onOp(it) } }
        s.on("canvas:live") { a -> (a.getOrNull(0) as? JSONObject)?.let { onLive(it) } }
        s.on("canvas:created") { scope.launch { runCatching { switchToNewest(s) } } }
        s.on("canvas:archived") { scope.launch { runCatching { switchToNewest(s) } } }
        s.on("keys:updated") { scope.launch { runCatching { onKeysUpdated() } } }
        val ticker = launch { while (true) { delay(500); expireLive() } }
        s.connect()
        try { done.await() } finally { ticker.cancel(); s.off(); s.disconnect(); socket = null }
        setStatus(Status.OFFLINE)
    }

    private suspend fun ack(s: Socket, event: String, payload: JSONObject?): JSONObject? = withTimeoutOrNull(6_000) {
        suspendCancellableCoroutine<JSONObject?> { cont ->
            val cb = Ack { args -> if (cont.isActive) cont.resume(args.getOrNull(0) as? JSONObject) }
            if (payload == null) s.emit(event, cb) else s.emit(event, payload, cb)
        }
    }

    private suspend fun joinAndCatchUp(s: Socket) {
        if (ack(s, "couple:join", null)?.optBoolean("ok") != true) throw IllegalStateException("couple join refused")
        joinCanvas(s)
        setStatus(Status.LIVE)
    }

    private suspend fun joinCanvas(s: Socket) {
        val id = canvasId ?: return
        if (ack(s, "canvas:join", JSONObject().put("canvasId", id))?.optBoolean("ok") != true) throw IllegalStateException("canvas join refused")
        catchUp(id)
    }

    private suspend fun catchUp(id: String) {
        var more = true
        while (more) {
            val r = api.get("/canvases/$id/ops?since=$lastSeq&limit=500")
            if (canvasId != id) return
            val ops = r.getJSONArray("ops")
            for (i in 0 until ops.length()) ingest(id, WireOp.from(ops.getJSONObject(i)), false)
            recompute()
            more = r.optBoolean("hasMore") && ops.length() > 0
        }
    }

    private suspend fun switchToNewest(s: Socket) {
        val list = api.get("/canvases").getJSONArray("canvases")
        val newest = if (list.length() > 0) list.getJSONObject(list.length() - 1).getString("id") else null
        if (newest == canvasId) return
        canvasId?.let { s.emit("canvas:leave", JSONObject().put("canvasId", it)) }
        resetCanvas()
        canvasId = newest
        joinCanvas(s)
    }

    private suspend fun onKeysUpdated() {
        val before = roomKeys.size
        syncKeys()
        if (roomKeys.size != before) { // a key we were missing arrived: retry anything that was locked
            val id = canvasId ?: return
            wire.values.filter { !decoded.containsKey(it.seq) }.forEach { ingest(id, it, false) }
            recompute()
        }
    }

    private fun onOp(m: JSONObject) {
        val id = canvasId ?: return
        if (m.optString("canvasId") != id) return
        val op = m.optJSONObject("op") ?: return
        runCatching { ingest(id, WireOp.from(op), true) }
    }

    private fun ingest(canvasId: String, w: WireOp, recomputeNow: Boolean) {
        wire[w.seq] = w
        if (w.seq > lastSeq) lastSeq = w.seq
        if (!decoded.containsKey(w.seq)) {
            val key = roomKeys[w.keyVersion]
            val text = if (key != null) Crypto.decryptRaw(key, w.nonce, w.ciphertext, Crypto.opAad(coupleId, canvasId, w.senderId, w.clientOpId, w.keyVersion)) else null
            val op = text?.let { runCatching { validateOp(JSONObject(it)) }.getOrNull() }
            if (op != null) {
                decoded[w.seq] = Entry(w.seq, w.senderId, op)
                drawableId(op)?.let { live.remove("${w.senderId}:$it") } // committed stroke replaces its preview
            }
        }
        if (recomputeNow) recompute()
    }

    private fun recompute() {
        scene = computeScene(decoded.values.toList())
        version++
    }

    private fun onLive(m: JSONObject) {
        val id = canvasId ?: return
        if (m.optString("canvasId") != id) return
        val sender = m.optString("senderId")
        if (sender.isEmpty() || sender == store.userId) return
        val kv = m.optInt("keyVersion", -1)
        val key = roomKeys[kv] ?: return
        val text = Crypto.decryptRaw(key, m.optString("nonce"), m.optString("ciphertext"), Crypto.liveAad(coupleId, id, sender, kv)) ?: return
        val p = runCatching { validateLive(JSONObject(text)) }.getOrNull() ?: return
        val k = "$sender:${p.sid}"
        when (p) {
            is LiveText -> if (p.text.isEmpty()) live.remove(k) else live[k] = LiveItem(p.sid, sender, true, color = p.color, size = p.size, text = p.text, x = p.x, y = p.y)
            is LiveStroke -> {
                val prev = live[k]
                if (p.start || prev == null || prev.isText) {
                    live[k] = LiveItem(p.sid, sender, false, tool = p.tool, color = p.color, size = p.size, pts = p.pts.toMutableList())
                } else {
                    prev.pts.addAll(p.pts.toList())
                    if (prev.pts.size > 3200) prev.pts.subList(0, prev.pts.size - 3200).clear()
                    prev.lastAt = System.currentTimeMillis()
                }
            }
        }
        version++
    }

    private fun expireLive() {
        val now = System.currentTimeMillis()
        var changed = false
        live.entries.removeAll { (now - it.value.lastAt > 6_000).also { old -> if (old) changed = true } }
        if (changed) version++
    }
}
