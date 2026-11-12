package com.couples.wallpaper

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

data class NativeChatMessage(
    val id: String,
    val senderId: String,
    val text: String,
    val createdAt: String,
    val media: NativeMediaDescriptor? = null,
    val pinned: Boolean = false,
    val clientMsgId: String = "",
    val keyVersion: Int = 0,
    val kind: String = "text",
)

data class NativeReaction(
    val messageId: String,
    val userId: String,
    val emoji: String,
    val keyVersion: Int,
    val nonce: String,
    val ciphertext: String,
)

data class NativeChatState(
    val loading: Boolean = true,
    val loadingOlder: Boolean = false,
    val sending: Boolean = false,
    val coupleId: String? = null,
    val keyVersion: Int? = null,
    val messages: List<NativeChatMessage> = emptyList(),
    val reactions: List<NativeReaction> = emptyList(),
    val unread: Int = 0,
    val partnerReadUpTo: String? = null,
    val receiptsEnabled: Boolean = true,
    val error: String? = null,
)

class NativeChatViewModel : ViewModel() {
    private val _state = MutableStateFlow(NativeChatState())
    val state: StateFlow<NativeChatState> = _state.asStateFlow()
    private var socket: Socket? = null

    fun load() {
        viewModelScope.launch {
            try {
                val couple = SyncHub.api.get("/couples/me").getJSONObject("couple")
                val coupleId = couple.getString("id")
                val keyVersion = couple.getInt("keyVersion")
                syncKeys()
                val response = SyncHub.api.get("/messages?limit=50")
                _state.value = NativeChatState(
                    loading = false,
                    coupleId = coupleId,
                    keyVersion = keyVersion,
                    messages = decryptMessages(response.getJSONArray("messages"), coupleId),
                    reactions = decryptReactions(response.getJSONArray("reactions"), coupleId),
                )
                loadReadState()
                connectRealtime(coupleId)
            } catch (e: Exception) {
                _state.value = _state.value.copy(loading = false, error = e.message ?: "Could not load messages.")
            }

        }
    }

    private fun connectRealtime(coupleId: String) {
        if (socket?.connected() == true) return
        viewModelScope.launch {
            if (!SyncHub.api.refresh()) return@launch
            val token = SyncHub.api.accessToken ?: return@launch
            val options = IO.Options.builder()
                .setReconnection(true)
                .setTransports(arrayOf("websocket"))
                .setAuth(mapOf("token" to token))
                .build()
            val connection = IO.socket(SyncHub.store.baseUrl.trimEnd('/'), options)
            socket = connection
            connection.on(Socket.EVENT_CONNECT) {
                connection.emit("couple:join", Ack { _ -> })
            }
            connection.on("message:new") { args ->
                val message = args.firstOrNull() as? JSONObject
                if (message != null) decryptMessage(message, coupleId)?.let { decrypted ->
                    _state.value = _state.value.copy(
                        messages = (_state.value.messages + decrypted).distinctBy { it.id }.sortedBy { it.createdAt },
                    )
                }
            }
            connection.on("keys:updated") { load() }
            connection.on("message:read") { args ->
                val read = args.firstOrNull() as? JSONObject
                if (read != null && read.optString("userId") != SyncHub.store.userId) {
                    _state.value = _state.value.copy(partnerReadUpTo = read.optString("upTo").takeIf { it.isNotBlank() })
                }
            }
            connection.on("message:reaction") { args ->
                val reaction = args.firstOrNull() as? JSONObject
                if (reaction != null) {
                    val messageId = reaction.optString("messageId")
                    val userId = reaction.optString("userId")
                    val existing = _state.value.reactions.filterNot { it.messageId == messageId && it.userId == userId }
                    if (reaction.optBoolean("removed")) _state.value = _state.value.copy(reactions = existing)
                    else decryptReaction(reaction, coupleId)?.let { _state.value = _state.value.copy(reactions = existing + it) }
                }
            }
            connection.connect()
        }
    }

    fun loadOlder() {
        val current = _state.value
        val coupleId = current.coupleId ?: return
        val firstId = current.messages.firstOrNull()?.id ?: return
        if (current.loadingOlder) return
        viewModelScope.launch {
            _state.value = current.copy(loadingOlder = true, error = null)
            try {
                val response = SyncHub.api.get("/messages?limit=50&before=$firstId")
                val older = decryptMessages(response.getJSONArray("messages"), coupleId)
                _state.value = _state.value.copy(
                    loadingOlder = false,
                    messages = (older + _state.value.messages).distinctBy { it.id }.sortedBy { it.createdAt },
                    reactions = (_state.value.reactions + decryptReactions(response.getJSONArray("reactions"), coupleId))
                        .distinctBy { it.messageId + "|" + it.userId },
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    loadingOlder = false,
                    error = e.message ?: "Could not load older messages.",
                )
            }
        }
    }

    fun send(text: String) {
        val trimmed = text.trim()
        val current = _state.value
        val coupleId = current.coupleId
        val keyVersion = current.keyVersion
        if (trimmed.isEmpty() || coupleId == null || keyVersion == null || current.sending) return
        viewModelScope.launch {
            _state.value = current.copy(sending = true, error = null)
            try {
                val clientMsgId = UUID.randomUUID().toString()
                val key = SyncHub.store.roomKey(keyVersion) ?: error("This device needs key approval before it can send.")
                val payload = JSONObject()
                    .put("t", "text")
                    .put("text", trimmed)
                    .put("sentAt", System.currentTimeMillis())
                val (nonce, ciphertext) = Crypto.encryptPayload(
                    key,
                    payload,
                    Crypto.messageAad(coupleId, SyncHub.store.userId.orEmpty(), clientMsgId, keyVersion, "text"),
                )
                SyncHub.api.post(
                    "/messages",
                    JSONObject()
                        .put("clientMsgId", clientMsgId)
                        .put("deviceId", SyncHub.store.deviceId)
                        .put("keyVersion", keyVersion)
                        .put("kind", "text")
                        .put("nonce", nonce)
                        .put("ciphertext", ciphertext),
                )
                load()
            } catch (e: Exception) {
                _state.value = _state.value.copy(sending = false, error = e.message ?: "Could not send message.")
            }

        }

    }

    fun sendMedia(resolver: android.content.ContentResolver, uri: android.net.Uri, mime: String) {
        val current = _state.value
        if (current.coupleId == null || current.keyVersion == null || current.sending) return
        viewModelScope.launch {
            _state.value = current.copy(sending = true, error = null)
            try {
                val kind = when {
                    mime.startsWith("image/") -> "image"
                    mime.startsWith("video/") -> "video"
                    mime.startsWith("audio/") -> "audio"
                    else -> error("This file type is not supported.")
                }
                sendMediaDescriptor(NativeMediaUploader.upload(resolver, uri, kind, mime), current)
            } catch (e: Exception) {
                _state.value = _state.value.copy(sending = false, error = e.message ?: "Could not send media.")
            }
        }
    }

    fun saveMedia(
        resolver: android.content.ContentResolver,
        descriptor: NativeMediaDescriptor,
        destination: android.net.Uri,
    ) {
        viewModelScope.launch {
            try {
                resolver.openOutputStream(destination)?.use { it.write(NativeMediaUploader.download(descriptor)) }
                    ?: error("Could not open the selected destination.")
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "Could not save attachment.")
            }
        }
    }

    fun sendVoice(bytes: ByteArray) {
        val current = _state.value
        if (current.coupleId == null || current.keyVersion == null || current.sending) return
        viewModelScope.launch {
            _state.value = current.copy(sending = true, error = null)
            try {
                sendMediaDescriptor(NativeMediaUploader.uploadBytes(bytes, "audio", "audio/mp4"), current, true)
            } catch (e: Exception) {
                _state.value = _state.value.copy(sending = false, error = e.message ?: "Could not send voice message.")
            }
        }
    }

    private suspend fun sendMediaDescriptor(
        descriptor: NativeMediaDescriptor,
        current: NativeChatState,
        voice: Boolean = false,
    ) {
        val coupleId = current.coupleId ?: error("No active space.")
        val keyVersion = current.keyVersion ?: error("No active key.")
        val clientMsgId = UUID.randomUUID().toString()
        val key = SyncHub.store.roomKey(keyVersion) ?: error("This device needs key approval before it can send.")
        val payload = JSONObject()
            .put("t", "media")
            .put("media", NativeMediaUploader.descriptorJson(descriptor).put("voice", voice))
            .put("sentAt", System.currentTimeMillis())
        val (nonce, ciphertext) = Crypto.encryptPayload(
            key,
            payload,
            Crypto.messageAad(coupleId, SyncHub.store.userId.orEmpty(), clientMsgId, keyVersion, "media"),
        )
        SyncHub.api.post(
            "/messages",
            JSONObject()
                .put("clientMsgId", clientMsgId)
                .put("deviceId", SyncHub.store.deviceId)
                .put("keyVersion", keyVersion)
                .put("kind", "media")
                .put("nonce", nonce)
                .put("ciphertext", ciphertext)
                .put("mediaIds", org.json.JSONArray().put(descriptor.id)),
        )
        load()
    }

    fun toggleHeart(messageId: String) {
        val current = _state.value
        val mine = current.reactions.firstOrNull {
            it.messageId == messageId && it.userId == SyncHub.store.userId
        }
        viewModelScope.launch {
            try {
                if (mine != null) {
                    SyncHub.api.delete("/messages/$messageId/reaction")
                    _state.value = _state.value.copy(
                        reactions = current.reactions.filterNot {
                            it.messageId == messageId && it.userId == SyncHub.store.userId
                        },
                    )
                } else {
                    val coupleId = current.coupleId ?: return@launch
                    val version = current.keyVersion ?: return@launch
                    val key = SyncHub.store.roomKey(version) ?: error("This device needs key approval.")
                    val aad = reactionAad(coupleId, messageId, SyncHub.store.userId.orEmpty(), version)
                    val (nonce, ciphertext) = Crypto.encryptPayload(key, JSONObject().put("emoji", "❤️"), aad)
                    SyncHub.api.put(
                        "/messages/$messageId/reaction",
                        JSONObject().put("keyVersion", version).put("nonce", nonce).put("ciphertext", ciphertext),
                    )
                    load()
                }
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "Could not update reaction.")
            }
        }
    }

    fun markRead() {
        val last = _state.value.messages.lastOrNull()?.id ?: return
        viewModelScope.launch {
            try {
                SyncHub.api.put("/messages/read", JSONObject().put("upTo", last))
                _state.value = _state.value.copy(unread = 0)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "Could not update read state.")
            }

        }
    }

    fun deleteMessage(messageId: String) {
        viewModelScope.launch {
            try {
                SyncHub.api.delete("/messages/$messageId")
                load()
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "Could not delete message.")
            }
        }
    }

    fun editMessage(message: NativeChatMessage, text: String) {
        val replacement = text.trim()
        if (replacement.isEmpty() || message.clientMsgId.isEmpty() || message.kind != "text") return
        viewModelScope.launch {
            try {
                val coupleId = _state.value.coupleId ?: error("No active space.")
                val key = SyncHub.store.roomKey(message.keyVersion) ?: error("This device needs key approval.")
                val payload = JSONObject().put("t", "text").put("text", replacement).put("sentAt", System.currentTimeMillis())
                val (nonce, ciphertext) = Crypto.encryptPayload(
                    key,
                    payload,
                    Crypto.messageAad(coupleId, SyncHub.store.userId.orEmpty(), message.clientMsgId, message.keyVersion, message.kind),
                )
                SyncHub.api.patch(
                    "/messages/${message.id}",
                    JSONObject().put("keyVersion", message.keyVersion).put("nonce", nonce).put("ciphertext", ciphertext),
                )
                load()
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "Could not edit message.")
            }
        }
    }

    fun togglePin(message: NativeChatMessage) {
        viewModelScope.launch {
            try {
                if (message.pinned) SyncHub.api.delete("/messages/${message.id}/pin")
                else SyncHub.api.put("/messages/${message.id}/pin")
                load()
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "Could not update pinned message.")
            }
        }
    }

    private suspend fun syncKeys() {
        val deviceId = SyncHub.store.deviceId ?: error("This device is not registered.")
        val secret = SyncHub.store.deviceSecret?.let(Crypto::unb64) ?: error("This device key is unavailable.")
        val response = SyncHub.api.get("/keys/envelopes?deviceId=$deviceId")
        val envelopes = response.getJSONArray("envelopes")
        for (index in 0 until envelopes.length()) {
            val envelope = envelopes.getJSONObject(index)
            val version = envelope.getInt("keyVersion")
            if (SyncHub.store.roomKey(version) != null) continue
            val key = Crypto.unwrapRoomKey(
                envelope.getString("nonce"),
                envelope.getString("ciphertext"),
                envelope.getString("senderPublicKey"),
                secret,
            ) ?: continue
            SyncHub.store.putRoomKey(version, Crypto.b64(key))
        }

    }

    private suspend fun loadReadState() {
        val read = SyncHub.api.get("/messages/read-state")
        _state.value = _state.value.copy(
            unread = read.optInt("unread", 0),
            partnerReadUpTo = read.optString("partner").takeIf { it.isNotBlank() && it != "null" },
            receiptsEnabled = read.optBoolean("receiptsEnabled", true),
        )
    }

    private fun reactionAad(coupleId: String, messageId: String, userId: String, keyVersion: Int) =
        "couples-reaction-v1|$coupleId|$messageId|$userId|$keyVersion"

    private fun decryptReactions(items: org.json.JSONArray, coupleId: String): List<NativeReaction> =
        (0 until items.length()).mapNotNull { decryptReaction(items.getJSONObject(it), coupleId) }

    private fun decryptReaction(item: JSONObject, coupleId: String): NativeReaction? {
        val messageId = item.optString("messageId").takeIf { it.isNotBlank() } ?: return null
        val userId = item.optString("userId").takeIf { it.isNotBlank() } ?: return null
        val keyVersion = item.optInt("keyVersion", -1)
        val key = SyncHub.store.roomKey(keyVersion) ?: return null
        val plain = Crypto.decryptRaw(
            key,
            item.optString("nonce"),
            item.optString("ciphertext"),
            reactionAad(coupleId, messageId, userId, keyVersion),
        ) ?: return null
        val emoji = runCatching { JSONObject(plain).optString("emoji") }.getOrNull()
            ?.takeIf { it == "❤️" } ?: return null
        return NativeReaction(messageId, userId, emoji, keyVersion, item.getString("nonce"), item.getString("ciphertext"))
    }

    private fun decryptMessages(items: org.json.JSONArray, coupleId: String): List<NativeChatMessage> =
        (0 until items.length()).mapNotNull { decryptMessage(items.getJSONObject(it), coupleId) }

    private fun decryptMessage(item: JSONObject, coupleId: String): NativeChatMessage? {
        if (item.optBoolean("deleted") || item.isNull("nonce") || item.isNull("ciphertext")) return null
        val clientMsgId = item.optString("clientMsgId").takeIf { it.isNotBlank() } ?: return null
        val keyVersion = item.optInt("keyVersion", -1)
        val key = SyncHub.store.roomKey(keyVersion) ?: return null
        val plain = Crypto.decryptRaw(
            key,
            item.getString("nonce"),
            item.getString("ciphertext"),
            Crypto.messageAad(coupleId, item.getString("senderId"), clientMsgId, keyVersion, item.getString("kind")),
        ) ?: return null
        val payload = runCatching { JSONObject(plain) }.getOrNull() ?: return null
        val media = if (payload.optString("t") == "media") {
            val mediaJson = payload.optJSONObject("media") ?: return null
            NativeMediaDescriptor(
                id = mediaJson.getString("id"),
                key = mediaJson.getString("key"),
                mime = mediaJson.getString("mime"),
                size = mediaJson.getInt("size"),
            )
        } else null
        val text = payload.optString("text").takeIf { it.isNotBlank() }
            ?: if (media != null) "Attachment" else return null
        return NativeChatMessage(
            item.getString("id"),
            item.getString("senderId"),
            text,
            item.getString("createdAt"),
            media,
            item.optBoolean("pinned", false),
            clientMsgId,
            keyVersion,
            item.optString("kind", "text"),
        )
    }

    override fun onCleared() {
        socket?.off()
        socket?.disconnect()
        socket = null
        super.onCleared()
    }
}
