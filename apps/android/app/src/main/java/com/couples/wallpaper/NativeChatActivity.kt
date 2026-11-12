package com.couples.wallpaper

import android.Manifest
import android.os.Bundle
import android.content.pm.PackageManager
import android.media.MediaRecorder
import java.io.File
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class NativeChatActivity : ComponentActivity() {
    private val model: NativeChatViewModel by viewModels()
    private var recorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var recordingLimitJob: Job? = null
    private val recording = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        setContent {
            val state by model.state.collectAsState()
            val isRecording by recording
            var draft by remember { mutableStateOf("") }
            var editingMessage by remember { mutableStateOf<NativeChatMessage?>(null) }
            var pendingMedia by remember { mutableStateOf<NativeMediaDescriptor?>(null) }
            val mediaPicker = rememberLauncherForActivityResult(
                ActivityResultContracts.OpenDocument(),
            ) { uri ->
                if (uri != null) {
                    model.sendMedia(contentResolver, uri, contentResolver.getType(uri).orEmpty())
                }
            }
            val saveMediaPicker = rememberLauncherForActivityResult(
                ActivityResultContracts.CreateDocument("application/octet-stream"),
            ) { destination ->
                val descriptor = pendingMedia
                pendingMedia = null
                if (destination != null && descriptor != null) {
                    model.saveMedia(contentResolver, descriptor, destination)
                }
            }
            LaunchedEffect(state.messages.lastOrNull()?.id) { model.markRead() }
            com.couples.wallpaper.ui.UsPaceTheme {
                Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text("Chat", style = MaterialTheme.typography.headlineMedium)
                    }
                    if (state.unread > 0) Text("${state.unread} unread message(s)")
                    state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    OutlinedButton(
                        onClick = model::loadOlder,
                        enabled = !state.loadingOlder && state.messages.isNotEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (state.loadingOlder) "Loading older messages…" else "Load older messages") }
                    LazyColumn(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(state.messages, key = { it.id }) { message ->
                            Column(Modifier.fillMaxWidth().padding(10.dp)) {
                                Text(message.text)
                                message.media?.let { media ->
                                    Button(
                                        onClick = {
                                            startActivity(
                                                Intent(this@NativeChatActivity, NativeMediaPreviewActivity::class.java)
                                                    .putExtra(NativeMediaPreviewActivity.EXTRA_ID, media.id)
                                                    .putExtra(NativeMediaPreviewActivity.EXTRA_KEY, media.key)
                                                    .putExtra(NativeMediaPreviewActivity.EXTRA_MIME, media.mime)
                                                    .putExtra(NativeMediaPreviewActivity.EXTRA_SIZE, media.size),
                                            )
                                        },
                                    ) { Text("Open attachment") }
                                    Button(
                                        onClick = {
                                            pendingMedia = media
                                            saveMediaPicker.launch("uspace-${media.id}.bin")
                                        },
                                    ) { Text("Save attachment") }
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = { model.togglePin(message) }) {
                                        Text(if (message.pinned) "Unpin" else "Pin")
                                    }
                                    if (message.senderId == SyncHub.store.userId) {
                                        if (message.kind == "text") {
                                            OutlinedButton(onClick = {
                                                editingMessage = message
                                                draft = message.text
                                            }) { Text("Edit") }
                                        }
                                        OutlinedButton(onClick = { model.deleteMessage(message.id) }) {
                                            Text("Delete")
                                        }
                                    }
                                }
                                val count = state.reactions.count { it.messageId == message.id }
                                Button(onClick = { model.toggleHeart(message.id) }) {
                                    Text("❤️ ${if (count > 0) count else ""}")
                                }
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { if (isRecording) stopVoiceRecording() else startVoiceRecording() },
                            enabled = !state.sending,
                        ) { Text(if (isRecording) "Stop voice" else "Voice") }
                        Button(
                            onClick = { mediaPicker.launch(arrayOf("image/*", "video/*", "audio/*")) },
                            enabled = !state.sending,
                        ) { Text("Attach") }
                        OutlinedTextField(
                            value = draft,
                            onValueChange = { draft = it },
                            label = { Text("Message") },
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            onClick = {
                                editingMessage?.let { model.editMessage(it, draft) } ?: model.send(draft)
                                editingMessage = null
                                draft = ""
                            },
                            enabled = !state.sending && draft.isNotBlank(),
                        ) { Text(if (editingMessage == null) "Send" else "Update") }
                    }
                    editingMessage?.let {
                        TextButton(onClick = { editingMessage = null; draft = "" }) { Text("Cancel edit") }
                    }
                }

            }
            LaunchedEffect(Unit) { model.load() }
        }
    }

    private fun startVoiceRecording() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), VOICE_PERMISSION_REQUEST)
            return
        }
        val file = File.createTempFile("uspace-voice-", ".m4a", cacheDir)
        recordingFile = file
        try {
            recorder = MediaRecorder(this).apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
        } catch (_: Exception) {
            recorder?.release()
            recorder = null
            file.delete()
            recordingFile = null
            return
        }
        recording.value = true
        recordingLimitJob = lifecycleScope.launchWhenStarted {
            delay(MAX_VOICE_DURATION_MS)
            if (recording.value) stopVoiceRecording()
        }
    }

    private fun stopVoiceRecording() {
        val active = recorder ?: return
        val file = recordingFile
        recorder = null
        recordingFile = null
        recordingLimitJob?.cancel()
        recordingLimitJob = null
        recording.value = false
        runCatching { active.stop() }
        active.release()
        if (file != null && file.exists()) {
            val bytes = file.readBytes()
            file.delete()
            if (bytes.isNotEmpty()) model.sendVoice(bytes)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == VOICE_PERMISSION_REQUEST && results.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            startVoiceRecording()
        }
    }

    override fun onDestroy() {
        recorder?.let { runCatching { it.stop() }; it.release() }
        recorder = null
        recordingLimitJob?.cancel()
        recordingLimitJob = null
        recordingFile?.delete()
        recordingFile = null
        super.onDestroy()
    }

    companion object {
        private const val VOICE_PERMISSION_REQUEST = 4101
        private const val MAX_VOICE_DURATION_MS = 5 * 60 * 1000L
    }
}
