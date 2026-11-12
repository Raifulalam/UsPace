package com.couples.wallpaper

import android.content.Intent
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
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private data class AccountDevice(val id: String, val label: String, val mine: Boolean, val hasKey: Boolean, val publicKey: String)
private data class AccountSession(val id: String, val device: String, val network: String, val lastActive: String, val current: Boolean)

class NativeAccountActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        setContent {
            val scope = rememberCoroutineScope()
            var displayName by remember { mutableStateOf("") }
            var readReceipts by remember { mutableStateOf(true) }
            var currentPassword by remember { mutableStateOf("") }
            var newPassword by remember { mutableStateOf("") }
            var confirmPassword by remember { mutableStateOf("") }
            var devices by remember { mutableStateOf<List<AccountDevice>>(emptyList()) }
            var sessions by remember { mutableStateOf<List<AccountSession>>(emptyList()) }
            var loading by remember { mutableStateOf(true) }
            var busy by remember { mutableStateOf(false) }
            var error by remember { mutableStateOf<String?>(null) }
            var note by remember { mutableStateOf<String?>(null) }
            var deviceToRemove by remember { mutableStateOf<AccountDevice?>(null) }
            var deviceToApprove by remember { mutableStateOf<AccountDevice?>(null) }
            var sessionToRemove by remember { mutableStateOf<AccountSession?>(null) }
            var hasRecovery by remember { mutableStateOf(false) }
            var recoveryInput by remember { mutableStateOf("") }
            var generatedRecovery by remember { mutableStateOf<String?>(null) }
            var recoverySaved by remember { mutableStateOf(false) }
            val clipboard = LocalClipboardManager.current

            suspend fun load() {
                val profile = SyncHub.api.get("/auth/me").getJSONObject("user")
                displayName = profile.optString("displayName", "")
                readReceipts = profile.optBoolean("readReceipts", true)
                val deviceData = SyncHub.api.get("/keys/couple-devices")
                val list = deviceData.getJSONArray("devices")
                devices = (0 until list.length()).map { i ->
                    val d = list.getJSONObject(i)
                    AccountDevice(d.getString("id"), d.optString("label", "Android device"), d.optBoolean("isMine"), d.optBoolean("hasKey"), d.getString("publicKey"))
                }
                val sessionList = SyncHub.api.get("/users/me/sessions").getJSONArray("sessions")
                sessions = (0 until sessionList.length()).map { i ->
                    val s = sessionList.getJSONObject(i)
                    AccountSession(s.getString("id"), s.optString("device", "Unknown device"), s.optString("network", ""), s.optString("lastActive", ""), s.optBoolean("current"))
                }
                hasRecovery = try {
                    SyncHub.api.get("/keys/recovery")
                    true
                } catch (e: ApiException) {
                    if (e.status == 404) false else throw e
                }
                loading = false
            }
            val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
                if (uri != null) scope.launch {
                    runCatching {
                        val data = SyncHub.api.get("/users/me/export")
                        contentResolver.openOutputStream(uri)?.use { it.write(data.toString().toByteArray(Charsets.UTF_8)) }
                            ?: throw IllegalStateException("Could not open export destination.")
                    }.onFailure { error = it.message ?: "Could not export account data." }
                }
            }
            LaunchedEffect(Unit) {
                runCatching { load() }.onFailure { error = it.message ?: "Could not load account security."; loading = false }
            }

            fun perform(block: suspend () -> Unit) {
                if (busy) return
                scope.launch {
                    busy = true; error = null; note = null
                    runCatching { block() }.onSuccess { if (note == null) note = "Changes saved." }
                        .onFailure { error = it.message ?: "The request failed." }
                    busy = false
                }
            }

            com.couples.wallpaper.ui.UsPaceTheme {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Account & security", style = MaterialTheme.typography.headlineMedium)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    note?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
                    if (loading) Text("Loading security…") else {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Profile", style = MaterialTheme.typography.titleMedium)
                                OutlinedTextField(displayName, { displayName = it }, label = { Text("Display name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                                CheckboxRow("Read receipts", readReceipts) { readReceipts = it }
                                Button(onClick = { perform {
                                    SyncHub.api.patch("/users/me", JSONObject().put("displayName", displayName.trim()).put("readReceipts", readReceipts))
                                    note = "Profile updated."
                                } }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Save profile") }
                            }
                        }
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Change password", style = MaterialTheme.typography.titleMedium)
                                OutlinedTextField(currentPassword, { currentPassword = it }, label = { Text("Current password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                                OutlinedTextField(newPassword, { newPassword = it }, label = { Text("New password (10+ characters)") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                                OutlinedTextField(confirmPassword, { confirmPassword = it }, label = { Text("Confirm new password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                                Button(onClick = { perform {
                                    require(newPassword == confirmPassword) { "The new passwords do not match." }
                                    require(newPassword.length >= 10) { "Use at least 10 characters." }
                                    val result = SyncHub.api.post("/users/me/password", JSONObject().put("currentPassword", currentPassword).put("newPassword", newPassword))
                                    SyncHub.api.setAccessToken(result.getString("accessToken"))
                                    currentPassword = ""; newPassword = ""; confirmPassword = ""
                                    note = "Password changed. Other sessions have been signed out."
                                } }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Change password") }
                            }
                        }
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Trusted devices", style = MaterialTheme.typography.titleMedium)
                                devices.forEach { d ->
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Column(Modifier.weight(1f)) {
                                            Text(d.label)
                                            Text(if (d.hasKey) "Has current room key" else "Waiting for approval", style = MaterialTheme.typography.bodySmall)
                                        }
                                        if (d.mine && d.id != SyncHub.store.deviceId) TextButton(onClick = { deviceToRemove = d }, enabled = !busy) { Text("Remove") }
                                        if (!d.hasKey && SyncHub.store.roomKeys().isNotEmpty()) TextButton(onClick = { deviceToApprove = d }, enabled = !busy) { Text("Approve") }
                                    }
                                }
                                Text("Removing one of your devices rotates the room key for the remaining trusted devices.", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Sessions", style = MaterialTheme.typography.titleMedium)
                                sessions.forEach { s ->
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Column(Modifier.weight(1f)) {
                                            Text(s.device + if (s.current) " · This device" else "")
                                            Text("${s.network} · ${s.lastActive}", style = MaterialTheme.typography.bodySmall)
                                        }
                                        if (!s.current) TextButton(onClick = { sessionToRemove = s }) { Text("Revoke") }
                                    }
                                }
                                OutlinedButton(onClick = {
                                    perform {
                                        SyncHub.api.post("/users/me/sessions/revoke-all")
                                        SyncHub.store.clear(); SyncHub.api.forget(); SyncHub.restart()
                                        startActivity(Intent(this@NativeAccountActivity, NativeAuthActivity::class.java)); finishAffinity()
                                    }
                                }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Sign out all devices") }
                            }
                        }
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Recovery key", style = MaterialTheme.typography.titleMedium)
                                Text(if (hasRecovery) "An encrypted room-key backup exists. Store your recovery key offline." else "No backup exists. Losing all approved devices without a recovery key makes encrypted history unrecoverable.")
                                Button(onClick = {
                                    perform {
                                        val recoveryKey = Crypto.newRecoveryKey()
                                        val userId = SyncHub.store.userId ?: throw IllegalStateException("Sign in again.")
                                        val (nonce, ciphertext) = Crypto.createRecoveryBlob(recoveryKey, SyncHub.store.roomKeys(), userId)
                                        SyncHub.api.put("/keys/recovery", JSONObject().put("version", 1).put("nonce", nonce).put("ciphertext", ciphertext))
                                        generatedRecovery = Crypto.formatRecoveryKey(recoveryKey)
                                        recoverySaved = false
                                        hasRecovery = true
                                    }
                                }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (hasRecovery) "Create a new recovery key" else "Create recovery key") }
                                if (hasRecovery) {
                                    OutlinedTextField(recoveryInput, { recoveryInput = it }, label = { Text("Existing recovery key") }, modifier = Modifier.fillMaxWidth())
                                    OutlinedButton(onClick = {
                                        perform {
                                            val parsed = Crypto.parseRecoveryKey(recoveryInput)
                                            val userId = SyncHub.store.userId ?: throw IllegalStateException("Sign in again.")
                                            val (nonce, ciphertext) = Crypto.createRecoveryBlob(parsed, SyncHub.store.roomKeys(), userId)
                                            SyncHub.api.put("/keys/recovery", JSONObject().put("version", 1).put("nonce", nonce).put("ciphertext", ciphertext))
                                            recoveryInput = ""
                                            note = "Recovery backup refreshed."
                                        }
                                    }, enabled = !busy && recoveryInput.length >= 52, modifier = Modifier.fillMaxWidth()) { Text("Refresh backup after key rotation") }
                                    OutlinedButton(onClick = {
                                        perform {
                                            val userId = SyncHub.store.userId ?: throw IllegalStateException("Sign in again.")
                                            val blob = SyncHub.api.get("/keys/recovery")
                                            val restored = Crypto.openRecoveryBlob(Crypto.parseRecoveryKey(recoveryInput), blob.getString("nonce"), blob.getString("ciphertext"), userId)
                                            restored.forEach { (version, key) -> SyncHub.store.putRoomKey(version, key) }
                                            SyncHub.restart(); load(); recoveryInput = ""
                                            note = "Room keys restored to this device."
                                        }
                                    }, enabled = !busy && recoveryInput.length >= 52, modifier = Modifier.fillMaxWidth()) { Text("Restore room keys") }
                                }
                            }
                        }
                        Button(onClick = { export.launch("our-space-account-data.json") }, modifier = Modifier.fillMaxWidth()) { Text("Export account data") }
                        OutlinedButton(onClick = {
                            perform {
                                val result = SyncHub.api.post("/users/me/deletion", JSONObject().put("password", currentPassword))
                                note = "Account deletion is scheduled for ${result.optString("scheduledFor")}."
                                SyncHub.store.clear(); SyncHub.api.forget(); SyncHub.restart()
                                startActivity(Intent(this@NativeAccountActivity, NativeAuthActivity::class.java)); finishAffinity()
                            }
                        }, enabled = !busy && currentPassword.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Delete account (enter current password above)") }
                    }
                }
            }

            deviceToRemove?.let { target ->
                AlertDialog(
                    onDismissRequest = { deviceToRemove = null },
                    title = { Text("Remove device?") },
                    text = { Text("${target.label} will lose access to new messages. The room key will rotate to the devices that already hold it.") },
                    confirmButton = { TextButton(onClick = {
                        deviceToRemove = null
                        perform { revokeAndRotate(target); load() }
                    }) { Text("Remove and rotate") } },
                    dismissButton = { TextButton(onClick = { deviceToRemove = null }) { Text("Cancel") } },
                )
            }
            deviceToApprove?.let { target ->
                AlertDialog(
                    onDismissRequest = { deviceToApprove = null },
                    title = { Text("Approve ${target.label}?") },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Compare this code with the code shown on that device, using a trusted channel. Approving gives it access to your room keys and message history.")
                            Text(Crypto.safetyNumber(listOf(target.publicKey)), style = MaterialTheme.typography.headlineSmall)
                        }
                    },
                    confirmButton = { TextButton(onClick = {
                        deviceToApprove = null
                        perform {
                            val senderDeviceId = SyncHub.store.deviceId ?: throw IllegalStateException("This device is not registered.")
                            val secret = SyncHub.store.deviceSecret?.let(Crypto::unb64) ?: throw IllegalStateException("Device secret is unavailable.")
                            val envelopes = JSONArray()
                            SyncHub.store.roomKeys().forEach { (version, keyText) ->
                                val (nonce, ciphertext) = Crypto.wrapRoomKey(Crypto.unb64(keyText), Crypto.unb64(target.publicKey), secret)
                                envelopes.put(JSONObject().put("keyVersion", version).put("deviceId", target.id).put("nonce", nonce).put("ciphertext", ciphertext))
                            }
                            require(envelopes.length() > 0) { "This device does not hold any room keys to share." }
                            SyncHub.api.put("/keys/envelopes", JSONObject().put("senderDeviceId", senderDeviceId).put("envelopes", envelopes))
                            load()
                        }
                    }) { Text("I verified the code · Approve") } },
                    dismissButton = { TextButton(onClick = { deviceToApprove = null }) { Text("Cancel") } },
                )
            }
            sessionToRemove?.let { target ->
                AlertDialog(
                    onDismissRequest = { sessionToRemove = null },
                    title = { Text("Revoke session?") },
                    text = { Text("That session will need to sign in again.") },
                    confirmButton = { TextButton(onClick = {
                        sessionToRemove = null
                        perform { SyncHub.api.delete("/users/me/sessions/${target.id}"); load() }
                    }) { Text("Revoke") } },
                    dismissButton = { TextButton(onClick = { sessionToRemove = null }) { Text("Cancel") } },
                )
            }
            generatedRecovery?.let { recovery ->
                AlertDialog(
                    onDismissRequest = { if (recoverySaved) generatedRecovery = null },
                    title = { Text("Save your recovery key") },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("This key is shown once. Store it offline; it is the only way to restore encrypted history if all approved devices are lost.")
                            Text(recovery, style = MaterialTheme.typography.titleMedium)
                            TextButton(onClick = { clipboard.setText(AnnotatedString(recovery)) }) { Text("Copy recovery key") }
                            CheckboxRow("I saved it somewhere safe", recoverySaved) { recoverySaved = it }
                        }
                    },
                    confirmButton = { TextButton(onClick = { if (recoverySaved) generatedRecovery = null }, enabled = recoverySaved) { Text("Done") } },
                )
            }
        }
    }

    private suspend fun revokeAndRotate(target: AccountDevice) {
        val before = SyncHub.api.get("/keys/couple-devices")
        val oldVersion = before.getInt("keyVersion")
        val oldKey = SyncHub.store.roomKey(oldVersion) ?: throw IllegalStateException("This device does not hold the current room key, so it cannot safely rotate keys.")
        val deviceId = SyncHub.store.deviceId ?: throw IllegalStateException("This device is not registered.")
        val secret = SyncHub.store.deviceSecret?.let(Crypto::unb64) ?: throw IllegalStateException("Device secret is unavailable.")
        val deviceList = before.getJSONArray("devices")
        val trusted = (0 until deviceList.length()).map { deviceList.getJSONObject(it) }
            .filter { it.optBoolean("hasKey") && it.getString("id") != target.id }
        require(trusted.any { it.getString("id") == deviceId }) { "This device is not listed among the trusted recipients; refusing to remove a device without a safe rotation path." }
        val deleted = SyncHub.api.delete("/devices/${target.id}")
        val newVersion = deleted.optInt("keyVersion", 0)
        if (newVersion == 0) throw IllegalStateException("The room key version did not advance.")
        val freshKey = Crypto.newRoomKey()
        val envelopes = JSONArray()
        trusted.forEach { device ->
            val (nonce, ciphertext) = Crypto.wrapRoomKey(freshKey, Crypto.unb64(device.getString("publicKey")), secret)
            envelopes.put(JSONObject().put("keyVersion", newVersion).put("deviceId", device.getString("id")).put("nonce", nonce).put("ciphertext", ciphertext))
        }
        require(envelopes.length() > 0) { "There are no remaining trusted devices to receive the rotated room key." }
        SyncHub.api.put("/keys/envelopes", JSONObject().put("senderDeviceId", deviceId).put("envelopes", envelopes))
        SyncHub.store.putRoomKey(oldVersion, Crypto.b64(oldKey))
        SyncHub.store.putRoomKey(newVersion, Crypto.b64(freshKey))
        SyncHub.restart()
    }
}

@androidx.compose.runtime.Composable
private fun CheckboxRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        androidx.compose.material3.Checkbox(checked = checked, onCheckedChange = onCheckedChange)
        Text(label, modifier = Modifier.padding(top = 12.dp))
    }
}
