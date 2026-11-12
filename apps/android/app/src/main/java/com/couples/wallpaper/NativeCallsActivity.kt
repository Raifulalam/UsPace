package com.couples.wallpaper

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Card
import androidx.compose.material3.Text
import androidx.compose.material3.OutlinedButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

private data class NativeCallRow(
    val id: String,
    val type: String,
    val status: String,
    val createdAt: String,
)

private data class NativeCallsState(
    val loading: Boolean = true,
    val calls: List<NativeCallRow> = emptyList(),
    val error: String? = null,
)

private class NativeCallsViewModel : ViewModel() {
    private val _state = MutableStateFlow(NativeCallsState())
    val state = _state.asStateFlow()

    fun load() {
        viewModelScope.launch {
            try {
                val items = SyncHub.api.get("/calls/history?limit=50").getJSONArray("calls")
                _state.value = NativeCallsState(
                    loading = false,
                    calls = (0 until items.length()).map {
                        val call = items.getJSONObject(it)
                        NativeCallRow(
                            id = call.getString("id"),
                            type = call.optString("type", "audio"),
                            status = call.optString("status", "unknown"),
                            createdAt = call.optString("createdAt", ""),
                        )
                    },
                )
            } catch (e: Exception) {
                _state.value = NativeCallsState(loading = false, error = e.message ?: "Could not load call history.")
            }
        }
    }
}

class NativeCallsActivity : ComponentActivity() {
    override fun onDestroy() {
        NativeCallSession.close()
        super.onDestroy()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        NativeCallSession.listen(applicationContext)
        setContent {
            val model: NativeCallsViewModel = viewModel()
            val state by model.state.collectAsState()
            val videoCall by NativeCallSession.videoCall.collectAsState()
            val cameraEnabled by NativeCallSession.cameraEnabled.collectAsState()
            var requestedCallType by remember { mutableStateOf("audio") }
            val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
                if (grants[Manifest.permission.RECORD_AUDIO] == true && requestedCallType == "accept" && (!NativeCallSession.videoCall.value || grants[Manifest.permission.CAMERA] == true)) NativeCallSession.accept(this@NativeCallsActivity)
                else if (grants[Manifest.permission.RECORD_AUDIO] == true && requestedCallType == "audio") NativeCallSession.start(this@NativeCallsActivity, "audio")
                else if (requestedCallType == "video" && grants[Manifest.permission.RECORD_AUDIO] == true && grants[Manifest.permission.CAMERA] == true) NativeCallSession.start(this@NativeCallsActivity, "video")
            }
            fun beginCall(type: String) {
                requestedCallType = type
                val required = if (type == "video") arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA) else arrayOf(Manifest.permission.RECORD_AUDIO)
                if (required.all { ContextCompat.checkSelfPermission(this@NativeCallsActivity, it) == PackageManager.PERMISSION_GRANTED }) NativeCallSession.start(this@NativeCallsActivity, type)
                else permissionLauncher.launch(required)
            }
            com.couples.wallpaper.ui.UsPaceTheme {
                Column(
                    Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("Calls", style = MaterialTheme.typography.headlineMedium)
                    Text("Call history and native calling")
                    OutlinedButton(onClick = { beginCall("audio") }, enabled = !NativeCallSession.active) { Text("Start voice call") }
                    OutlinedButton(onClick = { beginCall("video") }, enabled = !NativeCallSession.active) { Text("Start video call") }
                    NativeCallSession.status.collectAsState().value.let { callStatus ->
                        if (callStatus != "Idle") {
                            Text(callStatus)
                            if (videoCall) {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    AndroidView(
                                        factory = { context -> org.webrtc.SurfaceViewRenderer(context).also(NativeCallSession::attachLocalRenderer) },
                                        modifier = Modifier.weight(1f).height(180.dp),
                                        onRelease = NativeCallSession::detachLocalRenderer,
                                    )
                                    AndroidView(
                                        factory = { context -> org.webrtc.SurfaceViewRenderer(context).also(NativeCallSession::attachRemoteRenderer) },
                                        modifier = Modifier.weight(1f).height(180.dp),
                                        onRelease = NativeCallSession::detachRemoteRenderer,
                                    )
                                }
                            }
                            if (callStatus.startsWith("Incoming")) {
                                OutlinedButton(onClick = {
                                    requestedCallType = "accept"
                                    val permissions = if (videoCall) arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA) else arrayOf(Manifest.permission.RECORD_AUDIO)
                                    if (permissions.all { ContextCompat.checkSelfPermission(this@NativeCallsActivity, it) == PackageManager.PERMISSION_GRANTED }) NativeCallSession.accept(this@NativeCallsActivity)
                                    else permissionLauncher.launch(permissions)
                                }) { Text(if (videoCall) "Answer video call" else "Answer voice call") }
                                OutlinedButton(onClick = { NativeCallSession.rejectIncoming() }) { Text("Decline") }
                            }
                            if (callStatus.startsWith("Connected")) OutlinedButton(onClick = { NativeCallSession.toggleMute() }) {
                                Text(if (NativeCallSession.muted) "Unmute microphone" else "Mute microphone")
                            }
                            if (videoCall && callStatus.startsWith("Connected")) {
                                OutlinedButton(onClick = { NativeCallSession.toggleCamera() }) { Text(if (cameraEnabled) "Turn camera off" else "Turn camera on") }
                                OutlinedButton(onClick = { NativeCallSession.switchCamera() }) { Text("Switch camera") }
                            }
                            OutlinedButton(onClick = { NativeCallSession.hangup() }) { Text("End call") }
                        }
                    }
                    state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (state.loading) Text("Loading call historyâ€¦")
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(state.calls, key = { it.id }) { call ->
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(16.dp)) {
                                Text("${call.type.replaceFirstChar { it.uppercase() }} Â· ${call.status} Â· ${call.createdAt}")
                                }
                            }
                        }
                    }
                    LaunchedEffect(Unit) { model.load() }
                }
            }
        }
    }
}
