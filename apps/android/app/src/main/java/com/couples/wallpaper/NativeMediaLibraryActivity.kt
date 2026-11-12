package com.couples.wallpaper

import android.content.Intent
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import org.json.JSONObject

private data class LibraryItem(val descriptor: NativeMediaDescriptor, val date: String, val source: String, val canSave: Boolean, val label: String)

class NativeMediaLibraryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        setContent {
            val scope = rememberCoroutineScope()
            var items by remember { mutableStateOf<List<LibraryItem>>(emptyList()) }
            var filter by remember { mutableStateOf("all") }
            var loading by remember { mutableStateOf(true) }
            var error by remember { mutableStateOf<String?>(null) }
            var saving by remember { mutableStateOf<LibraryItem?>(null) }
            suspend fun load() {
                val couple = SyncHub.api.get("/couples/me").getJSONObject("couple")
                val coupleId = couple.getString("id")
                val deviceId = SyncHub.store.deviceId ?: throw IllegalStateException("This phone is not registered.")
                val secret = SyncHub.store.deviceSecret?.let(Crypto::unb64) ?: throw IllegalStateException("Device key is unavailable.")
                val envelopes = SyncHub.api.get("/keys/envelopes?deviceId=$deviceId").getJSONArray("envelopes")
                for (i in 0 until envelopes.length()) {
                    val e = envelopes.getJSONObject(i); val version = e.getInt("keyVersion")
                    if (SyncHub.store.roomKey(version) == null) {
                        Crypto.unwrapRoomKey(e.getString("nonce"), e.getString("ciphertext"), e.getString("senderPublicKey"), secret)
                            ?.let { SyncHub.store.putRoomKey(version, Crypto.b64(it)) }
                    }
                }
                val found = ArrayList<LibraryItem>()
                val memories = SyncHub.api.get("/memories?limit=100").getJSONArray("memories")
                for (i in 0 until memories.length()) {
                    val wire = memories.getJSONObject(i)
                    val version = wire.optInt("keyVersion", -1)
                    val key = SyncHub.store.roomKey(version) ?: continue
                    val author = wire.optString("createdBy")
                    val clientId = wire.optString("clientMemoryId")
                    val plain = Crypto.decryptRaw(key, wire.optString("nonce"), wire.optString("ciphertext"), "couples-memory-v1|$coupleId|$author|$clientId|$version|${wire.optString("type")}") ?: continue
                    val payload = runCatching { JSONObject(plain) }.getOrNull() ?: continue
                    val media = payload.optJSONArray("media") ?: continue
                    for (j in 0 until media.length()) {
                        val descriptor = parseDescriptor(media.optJSONObject(j)) ?: continue
                        val title = payload.optString("title").takeUnless { it.isBlank() || it == "null" } ?: wire.optString("type")
                        found += LibraryItem(descriptor, wire.optString("eventDate").take(10), "Memory", !wire.optBoolean("downloadLocked"), title)
                    }
                }
                val messages = SyncHub.api.get("/messages?limit=100").getJSONArray("messages")
                for (i in 0 until messages.length()) {
                    val wire = messages.getJSONObject(i)
                    if (wire.optBoolean("deleted") || wire.isNull("nonce") || wire.isNull("ciphertext")) continue
                    val version = wire.optInt("keyVersion", -1)
                    val key = SyncHub.store.roomKey(version) ?: continue
                    val author = wire.optString("senderId"); val clientId = wire.optString("clientMsgId"); val kind = wire.optString("kind")
                    val aad = Crypto.messageAad(coupleId, author, clientId, version, kind)
                    val plain = Crypto.decryptRaw(key, wire.optString("nonce"), wire.optString("ciphertext"), aad) ?: continue
                    val payload = runCatching { JSONObject(plain) }.getOrNull() ?: continue
                    if (payload.optString("t") != "media") continue
                    val descriptor = parseDescriptor(payload.optJSONObject("media")) ?: continue
                    found += LibraryItem(descriptor, wire.optString("createdAt"), "Chat attachment", true, "Chat attachment")
                }
                items = found.distinctBy { it.descriptor.id }
            }
            val savePicker = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { destination: Uri? ->
                val item = saving; saving = null
                if (destination != null && item != null) scope.launch {
                    runCatching {
                        contentResolver.openOutputStream(destination)?.use { it.write(NativeMediaUploader.download(item.descriptor)) }
                            ?: throw IllegalStateException("Could not open the selected destination.")
                    }.onFailure { error = it.message ?: "Could not save the file." }
                }
            }
            LaunchedEffect(Unit) {
                runCatching { load() }.onFailure { error = it.message ?: "Could not load media." }
                loading = false
            }
            val shown = items.filter { item ->
                when (filter) { "image" -> item.descriptor.mime.startsWith("image/"); "video" -> item.descriptor.mime.startsWith("video/"); "audio" -> item.descriptor.mime.startsWith("audio/"); else -> true }
            }
            com.couples.wallpaper.ui.UsPaceTheme {
                Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Media library", style = MaterialTheme.typography.headlineMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("all", "image", "video", "audio").forEach { type ->
                            OutlinedButton(onClick = { filter = type }) { Text(type.replaceFirstChar { it.uppercase() }) }
                        }
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (loading) Text("Loading encrypted mediaâ€¦")
                    if (!loading && shown.isEmpty()) Text("No media matches this filter.")
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(shown, key = { it.descriptor.id }) { item ->
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(item.label, style = MaterialTheme.typography.titleMedium)
                                    Text("${item.descriptor.mime} Â· ${item.date}", style = MaterialTheme.typography.bodySmall)
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        OutlinedButton(onClick = {
                                            startActivity(Intent(this@NativeMediaLibraryActivity, NativeMediaPreviewActivity::class.java)
                                                .putExtra(NativeMediaPreviewActivity.EXTRA_ID, item.descriptor.id)
                                                .putExtra(NativeMediaPreviewActivity.EXTRA_KEY, item.descriptor.key)
                                                .putExtra(NativeMediaPreviewActivity.EXTRA_MIME, item.descriptor.mime)
                                                .putExtra(NativeMediaPreviewActivity.EXTRA_SIZE, item.descriptor.size))
                                        }) { Text("Open") }
                                        if (item.canSave) OutlinedButton(onClick = { saving = item; savePicker.launch("our-space-${item.descriptor.id}.bin") }) { Text("Save") }
                                        else Text("Saving is disabled")
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

private fun parseDescriptor(value: JSONObject?): NativeMediaDescriptor? {
    if (value == null) return null
    val id = value.optString("id")
    val key = value.optString("key")
    val mime = value.optString("mime")
    val size = value.optInt("size", -1)
    val max = if (mime.startsWith("video/")) 100 * 1024 * 1024 else 25 * 1024 * 1024
    if (!Regex("^[a-f0-9]{24}$").matches(id) || mime !in setOf("image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg") || size !in 0..max) return null
    if (runCatching { Crypto.unb64(key).size != 32 }.getOrDefault(true)) return null
    return NativeMediaDescriptor(id, key, mime, size)
}
