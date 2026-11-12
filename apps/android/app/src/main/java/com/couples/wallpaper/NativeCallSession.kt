package com.couples.wallpaper

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume

/** Native one-to-one audio call. SDP and ICE are encrypted with the same room-key envelope as web calls. */
object NativeCallSession {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _status = kotlinx.coroutines.flow.MutableStateFlow("Idle")
    val status = _status
    @Volatile var active = false
        private set
    private var socket: Socket? = null
    private var pc: PeerConnection? = null
    private var factory: PeerConnectionFactory? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var callId: String? = null
    private var coupleId: String? = null
    private var keyVersion: Int = 0
    private var connected = false
    @Volatile var muted = false
        private set
    private var incomingId: String? = null
    private val queuedIce = mutableListOf<PeerConnection.IceCandidate>()

    fun listen(context: Context) { scope.launch { runCatching { ensureSocket(context.applicationContext) } } }

    fun start(context: Context, type: String) {
        if (active) return
        if (type == "video") { _status.value = "Video calling needs camera preview support and is not ready yet. Use voice call."; return }
        active = true
        _status.value = "Preparing secure call…"
        scope.launch {
            try {
                val me = SyncHub.api.get("/couples/me").getJSONObject("couple")
                coupleId = me.getString("id")
                keyVersion = me.getInt("keyVersion")
                check(SyncHub.store.roomKey(keyVersion) != null) { "Approve this device before calling." }
                ensureSocket(context.applicationContext)
                setupPeer(type, context.applicationContext)
                val id = UUID.randomUUID().toString()
                callId = id
                val ack = emitAck("call:start", JSONObject().put("callId", id).put("type", type))
                val result = ack ?: error("Call setup timed out.")
                check(result.optBoolean("ok")) { "Could not start call${result.optString("error").takeIf { it.isNotBlank() }?.let { ": $it" } ?: "."}" }
                if (result.optString("state") == "offline") error("Your partner is offline right now.")
                _status.value = "Calling…"
            } catch (e: Exception) {
                finish(e.message ?: "Could not start call.")
            }
        }
    }

    private suspend fun ensureSocket(context: Context) {
        if (socket?.connected() == true) return
        val couple = SyncHub.api.get("/couples/me").getJSONObject("couple")
        coupleId = couple.getString("id")
        keyVersion = couple.getInt("keyVersion")
        check(SyncHub.store.roomKey(keyVersion) != null) { "Approve this device before calling." }
        check(SyncHub.api.refresh()) { "Sign in again to place a call." }
        val token = SyncHub.api.accessToken ?: error("Sign in again to place a call.")
        val options = IO.Options.builder().setTransports(arrayOf("websocket")).setAuth(mapOf("token" to token)).setReconnection(true).build()
        socket = IO.socket(SyncHub.store.baseUrl.trimEnd('/'), options).also { s ->
            s.on(Socket.EVENT_CONNECT) { s.emit("couple:join", Ack { }) }
            s.on("call:incoming") { args ->
                val m = args.firstOrNull() as? JSONObject ?: return@on
                if (active) { s.emit("call:reject", JSONObject().put("callId", m.optString("callId")), Ack { }); return@on }
                if (m.optString("type", "audio") == "video") {
                    s.emit("call:reject", JSONObject().put("callId", m.optString("callId")), Ack { })
                    _status.value = "Your partner tried a video call. Android video calling is not ready yet."
                    return@on
                }
                incomingId = m.optString("callId")
                callId = incomingId
                active = true
                _status.value = "Incoming ${m.optString("type", "audio")} call"
            }
            s.on("call:answered") { args ->
                val m = args.firstOrNull() as? JSONObject ?: return@on
                if (m.optString("callId") == callId && incomingId == null) scope.launch { makeOffer() }
            }
            s.on("call:signal") { args ->
                val m = args.firstOrNull() as? JSONObject ?: return@on
                scope.launch { receiveSignal(m) }
            }
            s.on("call:ended") { args ->
                val m = args.firstOrNull() as? JSONObject ?: return@on
                if (m.optString("callId") == callId) finish("Call ended by your partner.")
            }
            s.connect()
        }
        awaitSocket()
    }

    fun accept(context: Context) {
        if (incomingId == null) return
        scope.launch {
            try {
                setupPeer("audio", context.applicationContext)
                val ack = emitAck("call:answer", JSONObject().put("callId", incomingId))
                check(ack?.optBoolean("ok") == true) { "Could not answer this call." }
                _status.value = "Connecting…"
            } catch (e: Exception) { finish(e.message ?: "Could not answer this call.") }
        }
    }

    fun rejectIncoming() {
        incomingId?.let { socket?.emit("call:reject", JSONObject().put("callId", it), Ack { }) }
        finish("Call declined.")
    }

    fun toggleMute() {
        val track = audioTrack ?: return
        muted = !muted
        track.setEnabled(!muted)
        _status.value = if (muted) "Connected · microphone muted" else "Connected"
    }

    fun close() {
        if (active) hangup()
        socket?.off(); socket?.disconnect(); socket = null
    }

    private suspend fun awaitSocket() = withTimeout(15000) {
        while (socket?.connected() != true) kotlinx.coroutines.delay(100)
    }

    private suspend fun emitAck(event: String, payload: JSONObject): JSONObject? =
        kotlinx.coroutines.withTimeoutOrNull(8000) {
            suspendCancellableCoroutine { cont ->
                socket?.emit(event, payload, Ack { args ->
                    if (cont.isActive) cont.resume(args.firstOrNull() as? JSONObject)
                }) ?: cont.resume(null)
            }
        }

    private suspend fun setupPeer(type: String, context: Context) {
        val ice = SyncHub.api.get("/calls/ice").getJSONArray("iceServers")
        val servers = (0 until ice.length()).map { i ->
            val item = ice.getJSONObject(i)
            val urls = item.optJSONArray("urls")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: listOf(item.getString("urls"))
            PeerConnection.IceServer.builder(urls).setUsername(item.optString("username")).setPassword(item.optString("credential")).createIceServer()
        }
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        val constraints = MediaConstraints()
        audioSource = factory!!.createAudioSource(constraints)
        audioTrack = factory!!.createAudioTrack("ourspace-audio", audioSource)
        val config = PeerConnection.RTCConfiguration(servers)
        pc = factory!!.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onSignalingChange(s: PeerConnection.SignalingState?) = Unit
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {
                when (s) {
                    PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> {
                        connected = true; _status.value = "Connected"
                        queuedIce.toList().forEach { pc?.addIceCandidate(it) }; queuedIce.clear()
                    }
                    PeerConnection.IceConnectionState.DISCONNECTED -> _status.value = "Reconnecting…"
                    PeerConnection.IceConnectionState.FAILED -> finish("Call connection failed.")
                    else -> Unit
                }
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) = Unit
            override fun onIceCandidate(c: PeerConnection.IceCandidate?) { c?.let { sendSignal(JSONObject().put("t", "ice").put("candidate", JSONObject().put("candidate", it.sdp).put("sdpMid", it.sdpMid).put("sdpMLineIndex", it.sdpMLineIndex))) } }
            override fun onIceCandidatesRemoved(c: Array<out PeerConnection.IceCandidate>?) = Unit
            override fun onAddStream(stream: org.webrtc.MediaStream?) = Unit
            override fun onRemoveStream(stream: org.webrtc.MediaStream?) = Unit
            override fun onDataChannel(channel: org.webrtc.DataChannel?) = Unit
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) = Unit
            override fun onTrack(transceiver: org.webrtc.RtpTransceiver?) = Unit
            override fun onConnectionChange(s: PeerConnection.PeerConnectionState?) = Unit
            override fun onStandardizedIceConnectionChange(s: PeerConnection.IceConnectionState?) = Unit
            override fun onSelectedCandidatePairChanged(event: org.webrtc.CandidatePairChangeEvent?) = Unit
        }) ?: error("Could not create secure call connection.")
        pc!!.addTrack(audioTrack, listOf("ourspace-audio"))
        if (type == "video") throw IllegalStateException("Video calling is not available in this Android build yet. Choose voice call.")
    }

    private suspend fun makeOffer() {
        try {
            val offer = createDescription(true)
            setLocal(offer)
            sendSignal(JSONObject().put("t", "offer").put("sdp", offer.description))
            _status.value = "Connecting…"
        } catch (e: Exception) { finish(e.message ?: "Could not connect call.") }
    }

    private suspend fun receiveSignal(message: JSONObject) {
        if (message.optString("callId") != callId || message.optString("from") == SyncHub.store.userId) return
        val version = message.optInt("keyVersion", -1)
        val key = SyncHub.store.roomKey(version) ?: return
        val aad = "couples-call-v1|$coupleId|$callId|${message.optString("from")}|$version"
        val plain = Crypto.decryptRaw(key, message.optString("nonce"), message.optString("ciphertext"), aad) ?: return
        val payload = runCatching { JSONObject(plain) }.getOrNull() ?: return
        try {
            when (payload.optString("t")) {
                "offer" -> {
                    setRemote(description(false, payload.getString("sdp")))
                    val answer = createDescription(false)
                    setLocal(answer)
                    sendSignal(JSONObject().put("t", "answer").put("sdp", answer.description))
                }
                "answer" -> setRemote(description(true, payload.getString("sdp")))
                "ice" -> {
                    val c = payload.getJSONObject("candidate")
                    val ice = PeerConnection.IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.getString("candidate"))
                    if (connected) pc?.addIceCandidate(ice) else queuedIce.add(ice)
                }
            }
        } catch (_: Exception) { /* Ignore malformed peer setup messages. */ }
    }

    private fun sendSignal(payload: JSONObject) {
        val id = callId ?: return
        val sender = SyncHub.store.userId ?: return
        val version = keyVersion
        val key = SyncHub.store.roomKey(version) ?: return
        val (nonce, ciphertext) = Crypto.encryptPayload(key, payload, "couples-call-v1|$coupleId|$id|$sender|$version")
        socket?.emit("call:signal", JSONObject().put("callId", id).put("keyVersion", version).put("nonce", nonce).put("ciphertext", ciphertext), Ack { })
    }

    private suspend fun createDescription(offer: Boolean): SessionDescription = suspendCancellableCoroutine { cont ->
        val observer = object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription?) { if (d != null && cont.isActive) cont.resume(d) else if (cont.isActive) cont.resume(SessionDescription(if (offer) SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER, "")) }
            override fun onSetSuccess() = Unit
            override fun onCreateFailure(error: String?) { if (cont.isActive) cont.cancel(IllegalStateException(error ?: "SDP failed")) }
            override fun onSetFailure(error: String?) = Unit
        }
        if (offer) pc?.createOffer(observer, MediaConstraints()) else pc?.createAnswer(observer, MediaConstraints())
    }
    private suspend fun setLocal(description: SessionDescription) = suspendCancellableCoroutine<Unit> { cont ->
        pc?.setLocalDescription(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription?) = Unit
            override fun onSetSuccess() { if (cont.isActive) cont.resume(Unit) }
            override fun onCreateFailure(error: String?) = Unit
            override fun onSetFailure(error: String?) { if (cont.isActive) cont.cancel(IllegalStateException(error ?: "SDP setup failed")) }
        }, description) ?: cont.cancel(IllegalStateException("Call ended"))
    }
    private suspend fun setRemote(description: SessionDescription) = suspendCancellableCoroutine<Unit> { cont ->
        pc?.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription?) = Unit
            override fun onSetSuccess() { connected = true; queuedIce.toList().forEach { pc?.addIceCandidate(it) }; queuedIce.clear(); if (cont.isActive) cont.resume(Unit) }
            override fun onCreateFailure(error: String?) = Unit
            override fun onSetFailure(error: String?) { if (cont.isActive) cont.cancel(IllegalStateException(error ?: "SDP setup failed")) }
        }, description) ?: cont.cancel(IllegalStateException("Call ended"))
    }
    private fun description(offer: Boolean, sdp: String) = SessionDescription(if (offer) SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER, sdp)

    fun hangup() {
        callId?.let { socket?.emit("call:end", JSONObject().put("callId", it), Ack { }) }
        finish("Call ended.")
    }

    private fun finish(message: String) {
        active = false
        _status.value = message
        runCatching { pc?.close() }; pc = null
        audioTrack?.dispose(); audioTrack = null
        audioSource?.dispose(); audioSource = null
        factory?.dispose(); factory = null
        // Keep the authenticated socket alive while the Calls screen is open so another incoming call can ring.
        callId = null; connected = false; queuedIce.clear()
        incomingId = null
        muted = false
    }
}
