package com.couples.wallpaper

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.webkit.CookieManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Setup screen: sign in, register this phone as a device, wait for approval, then pick the live wallpaper. */
class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var root: LinearLayout
    private var ticker: Job? = null
    private var shownKey = ""
    private var registerMode = false
    private var statusView: TextView? = null
    private var codeView: TextView? = null

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(this)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(32), dp(20), dp(32)) }
        setContentView(ScrollView(this).apply { addView(root) })
    }

    override fun onStart() {
        super.onStart()
        SyncHub.acquire(this) // keep the sync running while this screen is visible so status is live
        ticker = scope.launch { while (isActive) { render(); delay(1000) } }
    }

    override fun onStop() {
        ticker?.cancel()
        SyncHub.release()
        super.onStop()
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    // ---------- UI building blocks ----------
    private fun title(t: String) = TextView(this).apply { text = t; textSize = 26f; setTypeface(typeface, Typeface.BOLD); setPadding(0, 0, 0, dp(8)) }
    private fun body(t: String, size: Float = 15f) = TextView(this).apply { text = t; textSize = size; setPadding(0, dp(6), 0, dp(6)) }
    private fun field(hint: String, type: Int = InputType.TYPE_CLASS_TEXT, value: String = "") = EditText(this).apply { this.hint = hint; inputType = type; setText(value); setSingleLine() }
    private fun button(t: String, onClick: () -> Unit) = Button(this).apply { text = t; setOnClickListener { onClick() } }

    private fun humanStatus(): String = when (SyncHub.status) {
        SyncHub.Status.SIGNED_OUT -> "Not signed in."
        SyncHub.Status.STARTING -> "Connecting…"
        SyncHub.Status.WAITING_APPROVAL -> "Waiting for approval. Open Our Space on your other device and approve “Android live wallpaper” when the banner appears. The code on both screens must match."
        SyncHub.Status.NO_COUPLE -> "Your couple room isn’t active yet. Finish setting it up in Our Space."
        SyncHub.Status.LIVE -> "Connected. Your partner’s drawing will appear live on this phone’s wallpaper."
        SyncHub.Status.OFFLINE -> "Offline. Retrying…"
    }

    private fun render() {
        val store = SyncHub.store
        val key = if (!store.hasSession()) "login" else "main"
        if (key != shownKey) { shownKey = key; if (key == "login") buildLogin() else buildMain() }
        if (key == "main") {
            statusView?.text = humanStatus()
            val waiting = SyncHub.status == SyncHub.Status.WAITING_APPROVAL
            codeView?.visibility = if (waiting) View.VISIBLE else View.GONE
            if (waiting) store.devicePub?.let { codeView?.text = Crypto.safetyNumber(listOf(it)) }
        }
    }

    private fun buildLogin() {
        root.removeAllViews()
        val store = SyncHub.store
        root.addView(title("Our Space Wallpaper"))
        root.addView(body(if (registerMode) "Create your Our Space account. This phone becomes one more encrypted device; your partner approves it before it can see anything." else "Sign in with your Our Space account. This phone becomes one more encrypted device; your partner approves it before it can see anything."))
        val url = field("Server address", InputType.TYPE_TEXT_VARIATION_URI, store.baseUrl.ifEmpty { "http://10.0.2.2:4000" })
        val id = field("Username or email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val username = field("Username (3-24 letters, numbers, _ or .)")
        val email = field("Email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val birthDate = field("Date of birth (YYYY-MM-DD)")
        val displayName = field("Display name (optional)")
        val pw = field("Password", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val consent = CheckBox(this).apply {
            text = "I agree to the Terms of Service and Privacy Policy"
            isChecked = false
            visibility = if (registerMode) View.VISIBLE else View.GONE
        }
        val legal = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = if (registerMode) View.VISIBLE else View.GONE
            addView(button("View Terms") { openLegal("/terms") })
            addView(button("View Privacy") { openLegal("/privacy") })
        }
        val err = body("").apply { setTextColor(0xFFC62828.toInt()) }
        val go = button(if (registerMode) "Create account" else "Sign in") {}
        val switch = button(if (registerMode) "Already have an account? Sign in" else "New here? Create an account") {
            registerMode = !registerMode
            shownKey = ""
        }
        id.visibility = if (registerMode) View.GONE else View.VISIBLE
        username.visibility = if (registerMode) View.VISIBLE else View.GONE
        email.visibility = if (registerMode) View.VISIBLE else View.GONE
        birthDate.visibility = if (registerMode) View.VISIBLE else View.GONE
        displayName.visibility = if (registerMode) View.VISIBLE else View.GONE
        consent.visibility = if (registerMode) View.VISIBLE else View.GONE
        legal.visibility = if (registerMode) View.VISIBLE else View.GONE
        go.setOnClickListener {
            go.isEnabled = false; err.text = ""
            scope.launch {
                try {
                    if (registerMode && !consent.isChecked) throw IllegalArgumentException("Please accept the Terms of Service and Privacy Policy.")
                    if (registerMode) signUp(url.text.toString(), username.text.toString(), email.text.toString(), birthDate.text.toString(), displayName.text.toString(), pw.text.toString())
                    else signIn(url.text.toString(), id.text.toString(), pw.text.toString())
                }
                catch (e: ApiException) { err.text = if (e.status == 401) "Incorrect username or password." else "Server said: ${e.code}" }
                catch (e: Exception) { err.text = e.message ?: "Could not reach the server. Check the address and your connection." }
                go.isEnabled = true
            }
        }
        listOf(url, id, username, email, birthDate, displayName, pw, legal, consent, err, go, switch).forEach { root.addView(it) }
    }

    private fun openLegal(path: String) {
        val base = SyncHub.store.baseUrl.trim().trimEnd('/').replace(Regex(":4000$"), ":3000")
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("$base$path")))
    }

    private suspend fun signIn(url: String, identifier: String, password: String) {
        val store = SyncHub.store
        store.baseUrl = url.trim()
        val d = SyncHub.api.login(identifier.trim(), password)
        val newId = d.getJSONObject("user").getString("id")
        if (store.userId != null && store.userId != newId) store.clearDevice() // a different person: never reuse the old identity
        store.userId = newId
        ensureDevice()
        SyncHub.restart()
        shownKey = "" // force the screen to rebuild
    }

    private suspend fun signUp(url: String, username: String, email: String, birthDate: String, displayName: String, password: String) {
        val store = SyncHub.store
        store.baseUrl = url.trim()
        val d = SyncHub.api.register(username.trim(), email.trim(), password, birthDate.trim(), displayName)
        store.userId = d.getJSONObject("user").getString("id")
        ensureDevice()
        SyncHub.restart()
        shownKey = ""
    }

    private suspend fun ensureDevice() {
        val store = SyncHub.store
        if (store.deviceId != null) return
        val (pk, sk) = Crypto.newDeviceKeys()
        val label = "Android live wallpaper (${Build.MODEL})".take(60)
        val res = SyncHub.api.post("/devices", JSONObject().put("publicKey", Crypto.b64(pk)).put("label", label))
        store.devicePub = Crypto.b64(pk)
        store.deviceSecret = Crypto.b64(sk)
        store.deviceId = res.getJSONObject("device").getString("id") // set last: hasSession() needs all of it
    }

    private fun buildMain() {
        root.removeAllViews()
        val store = SyncHub.store
        root.addView(title("Our Space Wallpaper"))
        statusView = body("").also { root.addView(it) }
        codeView = TextView(this).apply {
            textSize = 24f; gravity = Gravity.CENTER; typeface = Typeface.MONOSPACE
            setPadding(0, dp(12), 0, dp(12)); visibility = View.GONE
        }.also { root.addView(it) }
        root.addView(button("Set as live wallpaper") { chooseWallpaper() })
        root.addView(button("Open Our Space") { startActivity(Intent(this, WebAppActivity::class.java)) })
        val sw = Switch(this).apply {
            text = "Hide the drawing while my phone is locked"
            isChecked = store.hideWhenLocked
            setPadding(0, dp(16), 0, dp(8))
            setOnCheckedChangeListener { _, on -> store.hideWhenLocked = on }
        }
        root.addView(sw)
        root.addView(body("With this on (recommended), the lock screen shows a plain heart instead of your partner’s drawing, so nobody nearby can see it. It is shown again once you unlock.", 13f))
        root.addView(button("Sign out and forget this phone") { signOut() })
        root.addView(body("Also remove “Android live wallpaper” from Security → Devices in Our Space, so your partner’s devices stop sharing new keys with it.", 13f))
    }

    private fun chooseWallpaper() {
        val component = ComponentName(this, LoveWallpaperService::class.java)
        try {
            startActivity(Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER).putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, component))
        } catch (e: Exception) {
            startActivity(Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER)) // some launchers only offer the chooser
        }
    }

    private fun signOut() {
        scope.launch {
            SyncHub.store.clear()
            SyncHub.api.forget()
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            SyncHub.restart()
            shownKey = ""
        }
    }
}
