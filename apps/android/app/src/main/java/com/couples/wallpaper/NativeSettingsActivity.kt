package com.couples.wallpaper

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONObject

class NativeSettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        setContent {
            com.couples.wallpaper.ui.UsPaceTheme {
                NativeSettingsScreen(
                    onSaved = { finish() },
                    onLogout = ::logout,
                    onSave = { name, theme, retention, anniversary, done ->
                        NativeSettingsSaver.save(lifecycleScope, name, theme, retention, anniversary, done)
                    },
                )
            }
        }
    }

    private fun logout() {
        lifecycleScope.launch {
            runCatching { PushRegistration.removeCurrentToken() }
            runCatching { SyncHub.api.logout() }
            SyncHub.store.clear()
            SyncHub.api.forget()
            SyncHub.restart()
            startActivity(Intent(this@NativeSettingsActivity, NativeAuthActivity::class.java))
            finishAffinity()
        }
    }
}

@androidx.compose.runtime.Composable
private fun NativeSettingsScreen(
    onSaved: () -> Unit,
    onLogout: () -> Unit,
    onSave: (String, String, String, String, (String?) -> Unit) -> Unit,
) {
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var theme by remember { mutableStateOf("lavender") }
    var retention by remember { mutableStateOf("0") }
    var anniversary by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        runCatching {
            val couple = SyncHub.api.get("/couples/me").getJSONObject("couple")
            name = couple.optString("name", "Our Space")
            theme = couple.optString("theme", "lavender")
            retention = couple.optInt("messageTtlSec", 0).toString()
            anniversary = couple.optString("anniversaryDate", "")
        }.onFailure { message = it.message ?: "Could not load settings." }
        loading = false
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Space settings", style = MaterialTheme.typography.headlineMedium)
        if (loading) {
            Text("Loading…")
        } else {
            message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            OutlinedTextField(name, { name = it }, label = { Text("Space name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(theme, { theme = it }, label = { Text("Theme: rose, lavender, or midnight") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(retention, { retention = it }, label = { Text("Message retention seconds (0 disables expiry)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(anniversary, { anniversary = it }, label = { Text("Anniversary (YYYY-MM-DD, optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Button(
                onClick = {
                    saving = true
                    message = null
                    onSave(name, theme, retention, anniversary) {
                        saving = false
                        it?.let { message = it } ?: onSaved()
                    }
                },
                enabled = !saving && name.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (saving) "Saving…" else "Save changes") }
            OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) { Text("Log out") }
        }
    }
}

private object NativeSettingsSaver {
    fun save(
        scope: kotlinx.coroutines.CoroutineScope,
        name: String,
        theme: String,
        retention: String,
        anniversary: String,
        done: (String?) -> Unit,
    ) {
        scope.launch {
            try {
                val body = JSONObject()
                    .put("name", name.trim())
                    .put("theme", theme.trim())
                    .put("messageTtlSec", retention.toInt())
                if (anniversary.isNotBlank()) body.put("anniversaryDate", anniversary.trim())
                SyncHub.api.patch("/couples/me", body)
                done(null)
            } catch (e: Exception) {
                done(e.message ?: "Could not save settings.")
            }
        }
    }
}
