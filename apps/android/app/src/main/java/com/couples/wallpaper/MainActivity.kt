package com.couples.wallpaper

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Typeface
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
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
    private var handedOffToApp = false
    private var statusView: TextView? = null
    private var codeView: TextView? = null

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private val ink = Color.rgb(27, 27, 58)
    private val muted = Color.rgb(104, 104, 146)
    private val accent = Color.rgb(124, 58, 237)
    private val surface = Color.rgb(255, 255, 255)
    private val line = Color.rgb(226, 220, 247)
    private val page = Color.rgb(248, 244, 255)

    private fun panelBackground(color: Int, radius: Int = 16, stroke: Int? = null) =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(radius).toFloat()
            stroke?.let { setStroke(dp(1), it) }
        }

    private fun gap(height: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(1, dp(height))
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(18), dp(18), dp(18), dp(18))
        background = panelBackground(surface, 18, line)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(0, dp(8), 0, dp(8))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(this)
        if (SyncHub.store.hasSession()) {
            openOurSpace()
            return
        }
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(28), dp(18), dp(28))
            setBackgroundColor(page)
        }
        window.statusBarColor = page
        window.navigationBarColor = page
        setContentView(ScrollView(this).apply { setBackgroundColor(page); addView(root) })
    }

    override fun onStart() {
        super.onStart()
        if (handedOffToApp) return
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
    private fun title(t: String) = TextView(this).apply {
        text = t; textSize = 25f; setTextColor(ink)
        setTypeface(typeface, Typeface.BOLD); setPadding(0, 0, 0, dp(5))
    }
    private fun body(t: String, size: Float = 15f) = TextView(this).apply {
        text = t; textSize = size; setTextColor(if (size <= 13f) muted else ink)
        setPadding(0, dp(4), 0, dp(4)); setLineSpacing(1.5f, 1f)
    }
    private fun field(hint: String, type: Int = InputType.TYPE_CLASS_TEXT, value: String = "") = EditText(this).apply {
        this.hint = hint; inputType = type; setText(value); setSingleLine()
        textSize = 15f; setTextColor(ink); setHintTextColor(muted)
        setPadding(dp(14), 0, dp(14), 0); background = panelBackground(page, 12, line)
        layoutParams = LinearLayout.LayoutParams(-1, dp(50)).apply { setMargins(0, dp(4), 0, dp(4)) }
    }
    private fun button(t: String, onClick: () -> Unit) = Button(this).apply {
        text = t; textSize = 14f; isAllCaps = false; setTextColor(ink)
        minHeight = dp(48); setPadding(dp(14), 0, dp(14), 0)
        background = panelBackground(Color.TRANSPARENT, 12, line)
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(-1, dp(48)).apply { setMargins(0, dp(4), 0, dp(4)) }
    }

    private fun primaryButton(t: String, onClick: () -> Unit) = button(t, onClick).apply {
        setTextColor(Color.WHITE)
        background = panelBackground(accent, 12)
    }

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
        root.addView(title("Our Space"))
        root.addView(body(if (registerMode) "Create your account and connect this phone as an encrypted device." else "Sign in to keep your shared space and live wallpaper connected."))
        root.addView(gap(8))
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
            addView(button("Terms") { openLegal("/terms") }, LinearLayout.LayoutParams(0, dp(48), 1f))
            addView(button("Privacy") { openLegal("/privacy") }, LinearLayout.LayoutParams(0, dp(48), 1f))
        }
        val err = body("").apply { setTextColor(0xFFC62828.toInt()) }
        val go = primaryButton(if (registerMode) "Create account" else "Sign in") {}
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
                    if (registerMode) signUp(username.text.toString(), email.text.toString(), birthDate.text.toString(), displayName.text.toString(), pw.text.toString())
                    else signIn(id.text.toString(), pw.text.toString())
                }
                catch (e: ApiException) {
                    err.text = when {
                        e.status == 401 -> "Incorrect username or password."
                        e.code == "TOO_MANY_DEVICES" -> "You already have 10 active devices. Remove an old device in Security > Devices, then try again."
                        else -> "Server said: ${e.code}"
                    }
                }
                catch (e: Exception) { err.text = e.message ?: "Could not reach the server. Check the address and your connection." }
                go.isEnabled = true
            }
        }
        val form = card()
        listOf(id, username, email, birthDate, displayName, pw, legal, consent, err, go, switch).forEach { form.addView(it) }
        root.addView(form)
    }

    private fun openLegal(path: String) {
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("${Store.DEFAULT_WEB_BASE}$path")))
    }

    private suspend fun signIn(identifier: String, password: String) {
        val store = SyncHub.store
        val d = SyncHub.api.login(identifier.trim(), password)
        val newId = d.getJSONObject("user").getString("id")
        if (store.userId != null && store.userId != newId) store.clearDevice() // a different person: never reuse the old identity
        store.userId = newId
        ensureDevice()
        SyncHub.restart()
        openOurSpace()
    }

    private suspend fun signUp(username: String, email: String, birthDate: String, displayName: String, password: String) {
        val store = SyncHub.store
        val d = SyncHub.api.register(username.trim(), email.trim(), password, birthDate.trim(), displayName)
        store.userId = d.getJSONObject("user").getString("id")
        ensureDevice()
        SyncHub.restart()
        openOurSpace()
    }

    private fun openOurSpace() {
        handedOffToApp = true
        startActivity(Intent(this, WebAppActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
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
        root.addView(title("Our Space"))
        root.addView(body("Live wallpaper", 13f))
        val statusCard = card()
        statusView = body("").also { statusCard.addView(it) }
        root.addView(statusCard)
        codeView = TextView(this).apply {
            textSize = 24f; gravity = Gravity.CENTER; typeface = Typeface.MONOSPACE
            setPadding(0, dp(12), 0, dp(12)); visibility = View.GONE
        }.also { root.addView(it) }
        root.addView(primaryButton("Set as live wallpaper") { chooseWallpaper() })
        root.addView(button("Open Our Space") { startActivity(Intent(this, WebAppActivity::class.java)) })
        val sw = Switch(this).apply {
            text = "Hide the drawing while my phone is locked"
            isChecked = store.hideWhenLocked
            setPadding(0, dp(16), 0, dp(8))
            setOnCheckedChangeListener { _, on -> store.hideWhenLocked = on }
        }
        val privacyCard = card()
        privacyCard.addView(sw)
        privacyCard.addView(body("When enabled, the lock screen shows a plain heart instead of your partner’s drawing. Your private canvas returns after you unlock.", 13f))
        root.addView(privacyCard)
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
