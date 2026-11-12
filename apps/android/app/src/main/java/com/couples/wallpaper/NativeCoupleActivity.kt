package com.couples.wallpaper

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class NativeCoupleActivity : ComponentActivity() {
    private val model: NativeCoupleViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        setContent {
            val state by model.state.collectAsState()
            UsPaceCoupleScreen(
                state = state,
                model = model,
                onContinue = {
                    startActivity(Intent(this@NativeCoupleActivity, NativeChatActivity::class.java))
                },
                onOpenCalls = {
                    startActivity(Intent(this@NativeCoupleActivity, NativeCallsActivity::class.java))
                },
                onOpenCanvas = {
                    startActivity(Intent(this@NativeCoupleActivity, NativeCanvasActivity::class.java))
                },
                onOpenMemories = {
                    startActivity(Intent(this@NativeCoupleActivity, NativeMemoriesActivity::class.java))
                },
                onOpenMedia = {
                    startActivity(Intent(this@NativeCoupleActivity, NativeMediaLibraryActivity::class.java))
                },
                onSettings = {
                    startActivity(Intent(this@NativeCoupleActivity, NativeSettingsActivity::class.java))
                },
                onAccount = {
                    startActivity(Intent(this@NativeCoupleActivity, NativeAccountActivity::class.java))
                },
                onWallpaper = {
                    startActivity(Intent(this@NativeCoupleActivity, MainActivity::class.java))
                },
            )
            LaunchedEffect(Unit) { model.load() }
        }
    }
}

@androidx.compose.runtime.Composable
private fun UsPaceCoupleScreen(
    state: NativeCoupleState,
    model: NativeCoupleViewModel,
    onContinue: () -> Unit,
    onOpenCalls: () -> Unit,
    onOpenCanvas: () -> Unit,
    onOpenMemories: () -> Unit,
    onOpenMedia: () -> Unit,
    onSettings: () -> Unit,
    onAccount: () -> Unit,
    onWallpaper: () -> Unit,
) {
    var roomName by remember { mutableStateOf("Our Space") }
    var inviteCode by remember { mutableStateOf("") }

    com.couples.wallpaper.ui.UsPaceTheme {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Text(
                    if (state.coupleId == null) "Welcome — set up your space" else state.coupleName,
                    style = MaterialTheme.typography.headlineMedium,
                )
                Spacer(Modifier.height(4.dp))
                Text("Your private space is shared only after your partner confirms the connection.")
            }
            state.error?.let { message ->
                item { Text(message, color = MaterialTheme.colorScheme.error) }
            }
            if (state.loading) {
                item { Text("Loading…") }
            } else if (state.coupleId == null) {
                if (state.waitingForInvitation) {
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(18.dp)) {
                                Text("Request sent", style = MaterialTheme.typography.titleMedium)
                                Text("Waiting for your partner to confirm you. This page checks automatically.")
                            }
                        }
                    }
                } else {
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("Create a shared space", style = MaterialTheme.typography.titleMedium)
                                Text("Start a space, then invite your partner to confirm the connection.")
                            }
                        }
                    }
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("Start a new space", style = MaterialTheme.typography.titleMedium)
                                OutlinedTextField(
                                    roomName,
                                    { roomName = it },
                                    label = { Text("Room name") },
                                    singleLine = true,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                Button(
                                    onClick = { model.create(roomName) },
                                    enabled = roomName.isNotBlank(),
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text("Create our space") }
                            }
                        }
                    }
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("Join with an invite code", style = MaterialTheme.typography.titleMedium)
                                OutlinedTextField(
                                    inviteCode,
                                    { inviteCode = it.uppercase() },
                                    label = { Text("Invite code") },
                                    singleLine = true,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                OutlinedButton(
                                    onClick = { model.accept(inviteCode) },
                                    enabled = inviteCode.trim().length >= 10,
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text("Send join request") }
                            }
                        }
                    }
                }
            } else {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Your space is ready", style = MaterialTheme.typography.titleMedium)
                            Button(onClick = onContinue, modifier = Modifier.fillMaxWidth()) { Text("Chat") }
                            OutlinedButton(onClick = onOpenCanvas, modifier = Modifier.fillMaxWidth()) { Text("Shared canvas") }
                            OutlinedButton(onClick = onOpenMemories, modifier = Modifier.fillMaxWidth()) { Text("Memories") }
                            OutlinedButton(onClick = onOpenMedia, modifier = Modifier.fillMaxWidth()) { Text("Media library") }
                            OutlinedButton(onClick = onOpenCalls, modifier = Modifier.fillMaxWidth()) { Text("Calls") }
                            TextButton(onClick = onSettings, modifier = Modifier.fillMaxWidth()) { Text("Settings") }
                            TextButton(onClick = onAccount, modifier = Modifier.fillMaxWidth()) { Text("Account & security") }
                            TextButton(onClick = onWallpaper, modifier = Modifier.fillMaxWidth()) { Text("Live wallpaper setup") }
                        }
                    }
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("Invite your partner", style = MaterialTheme.typography.titleMedium)
                            state.issuedCode?.let { code ->
                                Text("Share this code privately. It is shown only once:")
                                Text(code, style = MaterialTheme.typography.headlineSmall)
                            }
                            Button(onClick = model::issueInvite, modifier = Modifier.fillMaxWidth()) {
                                Text("Create invite code")
                            }
                        }
                    }
                }
                items(state.invitations) { invitation ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (invitation.status == "accepted" && invitation.inviteeName != null) {
                                Text("${invitation.inviteeName} (@${invitation.inviteeUsername}) wants to join.")
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(onClick = { model.confirm(invitation.id) }) { Text("Confirm") }
                                    OutlinedButton(onClick = { model.reject(invitation.id) }) { Text("Decline") }
                                }
                            } else {
                                Text("Unused invitation${invitation.expiresAt?.let { " · expires $it" } ?: ""}")
                                OutlinedButton(onClick = { model.revoke(invitation.id) }) { Text("Revoke") }
                            }
                        }
                    }
                }
                item {
                    OutlinedButton(onClick = model::leave, modifier = Modifier.fillMaxWidth()) {
                        Text("Delete this room")
                    }
                }
            }
        }
    }
}
