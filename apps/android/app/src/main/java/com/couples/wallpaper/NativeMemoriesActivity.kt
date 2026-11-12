package com.couples.wallpaper

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

private data class NativeMemory(
    val id: String,
    val createdBy: String,
    val clientId: String,
    val type: String,
    val date: String,
    val keyVersion: Int,
    val nonce: String,
    val ciphertext: String,
    val favorite: Boolean,
    val albumId: String?,
    val downloadLocked: Boolean,
    val mediaIds: List<String>,
    val title: String?,
    val text: String?,
    val caption: String?,
    val descriptors: List<NativeMediaDescriptor>,
)

private data class NativeAlbum(val id: String, val createdBy: String, val clientId: String, val name: String)

class NativeMemoriesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        setContent {
            val scope = rememberCoroutineScope()
            var rows by remember { mutableStateOf<List<NativeMemory>>(emptyList()) }
            var albums by remember { mutableStateOf<List<NativeAlbum>>(emptyList()) }
            var selectedAlbumId by remember { mutableStateOf<String?>(null) }
            var albumName by remember { mutableStateOf("") }
            var coupleId by remember { mutableStateOf<String?>(null) }
            var keyVersion by remember { mutableStateOf<Int?>(null) }
            var loading by remember { mutableStateOf(true) }
            var busy by remember { mutableStateOf(false) }
            var error by remember { mutableStateOf<String?>(null) }
            var kind by remember { mutableStateOf("note") }
            var date by remember { mutableStateOf(LocalDate.now().toString()) }
            var title by remember { mutableStateOf("") }
            var content by remember { mutableStateOf("") }
            var attachment by remember { mutableStateOf<NativeMediaDescriptor?>(null) }

            suspend fun load() {
                val room = SyncHub.api.get("/couples/me").getJSONObject("couple")
                coupleId = room.getString("id")
                keyVersion = room.getInt("keyVersion")
                loadRoomKeys()
                val albumItems = SyncHub.api.get("/memories/albums").getJSONArray("albums")
                albums = (0 until albumItems.length()).mapNotNull { i ->
                    val item = albumItems.getJSONObject(i)
                    val author = item.optString("createdBy")
                    val clientId = item.optString("clientAlbumId")
                    val albumVersion = item.optInt("keyVersion", -1)
                    val key = SyncHub.store.roomKey(albumVersion) ?: return@mapNotNull null
                    val rawName = Crypto.decryptRaw(key, item.optString("nonce"), item.optString("ciphertext"), "couples-album-v1|${room.getString("id")}|$author|$clientId|$albumVersion")
                    val name = rawName?.let { runCatching { JSONObject(it).optString("name") }.getOrNull() }?.take(60)
                    if (name.isNullOrBlank()) null else NativeAlbum(item.getString("id"), author, clientId, name)
                }
                val albumQuery = selectedAlbumId?.let { "&albumId=$it" }.orEmpty()
                val items = SyncHub.api.get("/memories?limit=100$albumQuery").getJSONArray("memories")
                rows = (0 until items.length()).mapNotNull { index ->
                    val wire = items.getJSONObject(index)
                    val clientId = wire.getString("clientMemoryId")
                    val author = wire.getString("createdBy")
                    val rowVersion = wire.getInt("keyVersion")
                    val raw = SyncHub.store.roomKey(rowVersion)?.let {
                        Crypto.decryptRaw(it, wire.getString("nonce"), wire.getString("ciphertext"), memoryAad(room.getString("id"), author, clientId, rowVersion, wire.getString("type")))
                    }
                    val payload = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
                    val media = payload?.optJSONArray("media")?.let { arr ->
                        if (arr.length() > 4) return@let emptyList()
                        (0 until arr.length()).mapNotNull mediaItem@{ mi ->
                            val d = arr.optJSONObject(mi) ?: return@mediaItem null
                            val id = d.optString("id")
                            val key = d.optString("key")
                            val mime = d.optString("mime")
                            val size = d.optInt("size", -1)
                            val limit = if (mime.startsWith("video/")) 100 * 1024 * 1024 else 25 * 1024 * 1024
                            if (!Regex("^[a-f0-9]{24}$").matches(id) || mime !in setOf("image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg") || size !in 0..limit || runCatching { Crypto.unb64(key).size != 32 }.getOrDefault(true)) null
                            else NativeMediaDescriptor(id, key, mime, size)
                        }
                    }.orEmpty()
                    val type = wire.getString("type")
                    if (type !in setOf("photo", "video", "voice", "drawing", "message", "note", "letter", "date")) return@mapNotNull null
                    NativeMemory(
                        id = wire.getString("id"), createdBy = author, clientId = clientId,
                        type = type, date = wire.getString("eventDate").take(10),
                        keyVersion = rowVersion, nonce = wire.getString("nonce"), ciphertext = wire.getString("ciphertext"),
                        favorite = wire.optBoolean("favorite"),
                        albumId = wire.optString("albumId").takeUnless { it.isBlank() || it == "null" },
                        downloadLocked = wire.optBoolean("downloadLocked"),
                        mediaIds = wire.optJSONArray("mediaIds")?.strings().orEmpty(),
                        title = payload?.optString("title")?.takeUnless { it.isBlank() || it == "null" },
                        text = payload?.optString("text")?.takeUnless { it.isBlank() || it == "null" },
                        caption = payload?.optString("caption")?.takeUnless { it.isBlank() || it == "null" },
                        descriptors = media,
                    )
                }
                loading = false
            }
            val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
                if (uri != null) scope.launch {
                    busy = true
                    runCatching {
                        val mime = contentResolver.getType(uri).orEmpty()
                        val family = when {
                            mime.startsWith("image/") -> "image"
                            mime.startsWith("video/") -> "video"
                            mime.startsWith("audio/") -> "audio"
                            else -> throw IllegalArgumentException("Choose an image, video, or audio file.")
                        }
                        val expected = when (kind) { "photo" -> "image"; "video" -> "video"; "voice" -> "audio"; else -> throw IllegalArgumentException("This memory type does not take an attachment.") }
                        require(family == expected) { "Choose a file that matches the memory type." }
                        attachment = NativeMediaUploader.upload(contentResolver, uri, family, mime)
                        error = null
                    }.onFailure { error = it.message ?: "Could not attach this file." }
                    busy = false
                }
            }

            LaunchedEffect(Unit) {
                runCatching { load() }.onFailure { error = it.message ?: "Could not load memories."; loading = false }
            }

            com.couples.wallpaper.ui.UsPaceTheme {
                Column(Modifier.fillMaxSize().padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Our Memories", style = MaterialTheme.typography.headlineMedium)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (loading) Text("Loading memoriesâ€¦") else {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Add a memory", style = MaterialTheme.typography.titleMedium)
                                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    OutlinedButton(onClick = { selectedAlbumId = null; scope.launch { load() } }) { Text("All albums") }
                                    albums.forEach { album ->
                                        OutlinedButton(onClick = { selectedAlbumId = album.id; scope.launch { load() } }) { Text(album.name) }
                                    }
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedTextField(albumName, { albumName = it }, label = { Text("Album name") }, singleLine = true, modifier = Modifier.weight(1f))
                                    OutlinedButton(onClick = {
                                        scope.launch {
                                            runCatching {
                                                val roomId = coupleId ?: throw IllegalStateException("No active room.")
                                                val version = keyVersion ?: throw IllegalStateException("Room key is not ready.")
                                                val userId = SyncHub.store.userId ?: throw IllegalStateException("Sign in again.")
                                                val key = SyncHub.store.roomKey(version) ?: throw IllegalStateException("Approve this device first.")
                                                val clientId = UUID.randomUUID().toString()
                                                val (nonce, ciphertext) = Crypto.encryptPayload(key, JSONObject().put("name", albumName.trim().take(60)), "couples-album-v1|$roomId|$userId|$clientId|$version")
                                                SyncHub.api.post("/memories/albums", JSONObject().put("clientAlbumId", clientId).put("keyVersion", version).put("nonce", nonce).put("ciphertext", ciphertext))
                                                albumName = ""; load()
                                            }.onFailure { error = it.message ?: "Could not create album." }
                                        }
                                    }, enabled = albumName.isNotBlank() && !busy) { Text("Create") }
                                }
                                if (selectedAlbumId != null) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        OutlinedButton(onClick = {
                                            scope.launch {
                                                runCatching {
                                                    val album = albums.firstOrNull { it.id == selectedAlbumId } ?: throw IllegalStateException("Choose an album first.")
                                                    val roomId = coupleId ?: throw IllegalStateException("No active room.")
                                                    val version = keyVersion ?: throw IllegalStateException("Room key is not ready.")
                                                    val key = SyncHub.store.roomKey(version) ?: throw IllegalStateException("Approve this device first.")
                                                    val (nonce, ciphertext) = Crypto.encryptPayload(key, JSONObject().put("name", albumName.trim().take(60)), "couples-album-v1|$roomId|${album.createdBy}|${album.clientId}|$version")
                                                    SyncHub.api.patch("/memories/albums/${album.id}", JSONObject().put("keyVersion", version).put("nonce", nonce).put("ciphertext", ciphertext))
                                                    albumName = ""; load()
                                                }.onFailure { error = it.message ?: "Could not rename album." }
                                            }
                                        }, enabled = albumName.isNotBlank() && !busy) { Text("Rename selected") }
                                        OutlinedButton(onClick = {
                                            scope.launch {
                                                runCatching { SyncHub.api.delete("/memories/albums/$selectedAlbumId"); selectedAlbumId = null; load() }
                                                    .onFailure { error = it.message ?: "Could not delete album." }
                                            }
                                        }, enabled = !busy) { Text("Delete selected") }
                                    }
                                }
                                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    listOf("note", "letter", "date", "photo", "video", "voice").forEach { option ->
                                        OutlinedButton(onClick = { kind = option; attachment = null }) { Text(option.replaceFirstChar { it.uppercase() }) }
                                    }
                                }
                                OutlinedTextField(date, { date = it }, label = { Text("Date (YYYY-MM-DD)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                                OutlinedTextField(title, { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                                if (kind == "note" || kind == "letter") {
                                    OutlinedTextField(content, { content = it }, label = { Text(if (kind == "letter") "Your letter" else "Your note") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                                }
                                if (kind in setOf("photo", "video", "voice")) {
                                    OutlinedButton(onClick = { picker.launch(arrayOf("image/*", "video/*", "audio/*")) }, enabled = !busy) {
                                        Text(attachment?.mime ?: "Choose ${kind}")
                                    }
                                }
                                Button(onClick = {
                                    scope.launch {
                                        busy = true
                                        runCatching {
                                            val roomId = coupleId ?: throw IllegalStateException("No active shared space.")
                                            val version = keyVersion ?: throw IllegalStateException("Room key is not ready.")
                                            val author = SyncHub.store.userId ?: throw IllegalStateException("Sign in again to continue.")
                                            val key = SyncHub.store.roomKey(version) ?: throw IllegalStateException("Approve this device before adding memories.")
                                            require(runCatching { LocalDate.parse(date) }.isSuccess) { "Enter a valid date as YYYY-MM-DD." }
                                            val id = UUID.randomUUID().toString()
                                            val payload = JSONObject().put("v", 1)
                                            if (title.isNotBlank()) payload.put("title", title.trim().take(120))
                                            if (content.isNotBlank()) payload.put("text", content.trim().take(20000))
                                            attachment?.let { payload.put("media", JSONArray().put(NativeMediaUploader.descriptorJson(it))) }
                                            when (kind) {
                                                "note", "letter" -> require(content.isNotBlank()) { "Write something before saving." }
                                                "date" -> require(title.isNotBlank()) { "Add a title for this date." }
                                                else -> require(attachment != null) { "Choose an attachment first." }
                                            }
                                            val (nonce, ciphertext) = Crypto.encryptPayload(key, payload, memoryAad(roomId, author, id, version, kind))
                                            val body = JSONObject().put("clientMemoryId", id).put("type", kind).put("eventDate", date)
                                                .put("keyVersion", version).put("nonce", nonce).put("ciphertext", ciphertext)
                                            selectedAlbumId?.let { body.put("albumId", it) }
                                            attachment?.let { body.put("mediaIds", JSONArray().put(it.id)) }
                                            SyncHub.api.post("/memories", body)
                                            title = ""; content = ""; attachment = null
                                            load()
                                        }.onFailure { error = it.message ?: "Could not save memory." }
                                        busy = false
                                    }
                                }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Savingâ€¦" else "Save memory") }
                            }
                        }
                        LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(rows, key = { it.id }) { memory ->
                                Card(Modifier.fillMaxWidth()) {
                                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Text("${memory.type.replaceFirstChar { it.uppercase() }} Â· ${memory.date}", style = MaterialTheme.typography.labelMedium)
                                        memory.albumId?.let { id -> Text("Album: ${albums.firstOrNull { it.id == id }?.name ?: "Saved album"}", style = MaterialTheme.typography.labelSmall) }
                                        Text(memory.title ?: "Memory", style = MaterialTheme.typography.titleMedium)
                                        memory.text?.let { Text(it) }
                                        memory.caption?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                        memory.descriptors.forEach { d ->
                                            if (!memory.downloadLocked) {
                                            var saveDescriptor by remember(memory.id, d.id) { mutableStateOf<NativeMediaDescriptor?>(null) }
                                            val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { target ->
                                                val pending = saveDescriptor; saveDescriptor = null
                                                if (target != null && pending != null) scope.launch {
                                                    runCatching { contentResolver.openOutputStream(target)?.use { it.write(NativeMediaUploader.download(pending)) } ?: throw IllegalStateException("Cannot open destination.") }
                                                        .onFailure { error = it.message ?: "Could not save attachment." }
                                                }
                                            }
                                            OutlinedButton(onClick = { saveDescriptor = d; save.launch("memory-${d.id}.bin") }) { Text("Save attachment (${d.mime})") }
                                            } else Text("Attachment downloads are disabled by the creator.")
                                        }
                                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                            OutlinedButton(onClick = {
                                                scope.launch {
                                                    runCatching {
                                                        SyncHub.api.put("/memories/${memory.id}/favorite", JSONObject().put("favorite", !memory.favorite))
                                                        load()
                                                    }.onFailure { error = it.message ?: "Could not update favorite." }
                                                }
                                            }) { Text(if (memory.favorite) "â˜… Saved" else "â˜† Favorite") }
                                            val moveTarget = if (memory.albumId == selectedAlbumId) null else selectedAlbumId
                                            if (selectedAlbumId != null || memory.albumId != null) OutlinedButton(onClick = {
                                                scope.launch {
                                                    runCatching {
                                                        SyncHub.api.patch("/memories/${memory.id}", JSONObject().put("albumId", moveTarget ?: JSONObject.NULL))
                                                        load()
                                                    }.onFailure { error = it.message ?: "Could not move memory." }
                                                }
                                            }) { Text(if (moveTarget == null) "Unfile" else "Move here") }
                                            OutlinedButton(onClick = {
                                                scope.launch {
                                                    runCatching { SyncHub.api.delete("/memories/${memory.id}"); rows = rows.filterNot { it.id == memory.id } }
                                                        .onFailure { error = it.message ?: "Could not delete memory." }
                                                }
                                            }) { Text("Delete") }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private suspend fun loadRoomKeys() {
        val deviceId = SyncHub.store.deviceId ?: error("This device is not registered.")
        val secret = SyncHub.store.deviceSecret?.let(Crypto::unb64) ?: error("Device key is unavailable.")
        val envelopes = SyncHub.api.get("/keys/envelopes?deviceId=$deviceId").getJSONArray("envelopes")
        for (i in 0 until envelopes.length()) {
            val item = envelopes.getJSONObject(i)
            val version = item.getInt("keyVersion")
            if (SyncHub.store.roomKey(version) != null) continue
            val key = Crypto.unwrapRoomKey(item.getString("nonce"), item.getString("ciphertext"), item.getString("senderPublicKey"), secret) ?: continue
            SyncHub.store.putRoomKey(version, Crypto.b64(key))
        }
    }
}

private fun memoryAad(coupleId: String, createdBy: String, clientMemoryId: String, keyVersion: Int, type: String) =
    "couples-memory-v1|$coupleId|$createdBy|$clientMemoryId|$keyVersion|$type"

private fun JSONArray.strings(): List<String> = (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }
