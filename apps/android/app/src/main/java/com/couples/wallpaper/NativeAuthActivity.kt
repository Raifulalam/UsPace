package com.couples.wallpaper

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

class NativeAuthActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        if (SyncHub.store.hasSession()) {
            openSpace()
            return
        }
        setContent {
            com.couples.wallpaper.ui.UsPaceTheme {
                NativeAuthScreen(onAuthenticated = ::openSpace)
            }
        }
    }

    private fun openSpace() {
        startActivity(Intent(this, NativeCoupleActivity::class.java))
        finish()
    }
}

@Composable
private fun NativeAuthScreen(onAuthenticated: () -> Unit) {
    val scope = rememberCoroutineScope()
    var registerMode by remember { mutableStateOf(false) }
    var forgotMode by remember { mutableStateOf(false) }
    var resetMode by remember { mutableStateOf(false) }
    var resetToken by remember { mutableStateOf("") }
    var identifier by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var birthDate by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var accepted by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit() {
        if (busy) return
        scope.launch {
            busy = true
            error = null
            try {
                if (forgotMode) {
                    SyncHub.api.requestPasswordReset(email.trim())
                    error = "If that email has an account, a reset link is on its way. Paste the token from that email here to set a new password."
                    forgotMode = false
                    resetMode = true
                    return@launch
                }
                if (resetMode) {
                    require(resetToken.isNotBlank()) { "Enter the reset token from your email." }
                    SyncHub.api.resetPassword(resetToken.trim(), password)
                    resetToken = ""; password = ""; resetMode = false
                    error = "Password reset. Sign in with your new password."
                    return@launch
                }
                if (registerMode && !accepted) {
                    error = "Accept the Terms of Service and Privacy Policy to continue."
                    return@launch
                }
                val store = SyncHub.store
                val response = if (registerMode) {
                    SyncHub.api.register(
                        username.trim(),
                        email.trim(),
                        password,
                        birthDate.trim(),
                        displayName.trim(),
                    )
                } else {
                    SyncHub.api.login(identifier.trim(), password)
                }
                val userId = response.getJSONObject("user").getString("id")
                if (store.userId != null && store.userId != userId) store.clearDevice()
                store.userId = userId
                ensureNativeDevice()
                PushRegistration.registerCurrentToken()
                SyncHub.restart()
                onAuthenticated()
            } catch (e: ApiException) {
                error = when {
                    e.status == 401 -> "Incorrect username or password."
                    e.code == "TOO_MANY_DEVICES" -> "Remove an old device before adding this phone."
                    else -> "Server error: ${e.code}"
                }
            } catch (e: Exception) {
                error = e.message ?: "Could not connect to UsPace."
            } finally {
                busy = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Our Space", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(8.dp))
        Text("A private, end-to-end encrypted place for two.")
        Spacer(Modifier.height(24.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (forgotMode) {
                    Field("Email address", email) { email = it }
                } else if (resetMode) {
                    Field("Reset token from your email", resetToken) { resetToken = it }
                } else if (registerMode) {
                    Field("Username", username) { username = it }
                    Field("Email", email) { email = it }
                    Field("Date of birth (YYYY-MM-DD)", birthDate) { birthDate = it }
                    Field("Display name (optional)", displayName) { displayName = it }
                } else {
                    Field("Username or email", identifier) { identifier = it }
                }
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(if (resetMode) "New password" else "Password") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (registerMode && !forgotMode && !resetMode) {
                    Row {
                        Checkbox(checked = accepted, onCheckedChange = { accepted = it })
                        Text("I agree to the Terms of Service and Privacy Policy", Modifier.padding(top = 12.dp))
                    }
                }
                if (!registerMode && !resetMode && !forgotMode) {
                    OutlinedButton(onClick = { forgotMode = true; error = null }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Forgot password?") }
                    OutlinedButton(onClick = { resetMode = true; error = null }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("I have a reset token") }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(onClick = ::submit, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text(if (busy) "Please wait…" else when { forgotMode -> "Send reset email"; resetMode -> "Reset password"; registerMode -> "Create account"; else -> "Sign in" })
                }
                OutlinedButton(
                    onClick = { registerMode = !registerMode; forgotMode = false; resetMode = false; error = null },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (registerMode) "Already have an account? Sign in" else "Create an account")
                }
            }
        }
    }
}

@Composable
private fun Field(label: String, value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

private suspend fun ensureNativeDevice() {
    val store = SyncHub.store
    if (store.deviceId != null) return
    val (publicKey, secretKey) = Crypto.newDeviceKeys()
    val response = SyncHub.api.post(
        "/devices",
        JSONObject()
            .put("publicKey", Crypto.b64(publicKey))
            .put("label", "Android device (${Build.MODEL})".take(60)),
    )
    store.devicePub = Crypto.b64(publicKey)
    store.deviceSecret = Crypto.b64(secretKey)
    store.deviceId = response.getJSONObject("device").getString("id")
}
