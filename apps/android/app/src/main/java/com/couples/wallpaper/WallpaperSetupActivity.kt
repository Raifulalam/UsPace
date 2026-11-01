package com.couples.wallpaper

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Native wallpaper screen. There is no login form here: the account comes from the website's login (single sign-in, see NativeSession).
 * It then shows device status and the approval code, and lets the user pick the live wallpaper.
 */
class WallpaperSetupActivity : Activity() {
    private enum class Phase { SYNCING, READY, NEEDS_WEB_LOGIN, OFFLINE, ERROR }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var root: LinearLayout
    private var ticker: Job? = null
    private var phase = Phase.SYNCING
    private var shownKey = ""
    private var statusView: TextView? = null
    private var codeView: TextView? = null

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(this)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(32), dp(20), dp(32)) }
        val scroll = ScrollView(this).apply { addView(root); setBackgroundResource(R.drawable.bg_plum); fitsSystemWindows = true }
        setContentView(scroll)
        window.statusBarColor = Color.TRANSPARENT; window.navigationBarColor = Color.TRANSPARENT
    }

    override fun onStart() {
        super.onStart()
        SyncHub.acquire(this) // keep the sync running while this screen is visible so status is live
        ticker = scope.launch { while (isActive) { render(); delay(1000) } }
        linkAccount()
    }

    override fun onStop() {
        ticker?.cancel()
        SyncHub.release()
        super.onStop()
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    /** Turns the website's login into this app's session. Runs on the main thread (it reads the WebView cookie store first). */
    private fun linkAccount() {
        phase = Phase.SYNCING
        scope.launch {
            phase = when (NativeSession.syncFromWeb(this@WallpaperSetupActivity)) {
                NativeSession.Result.READY -> Phase.READY
                NativeSession.Result.NEEDS_WEB_LOGIN -> Phase.NEEDS_WEB_LOGIN
                NativeSession.Result.OFFLINE -> Phase.OFFLINE
                NativeSession.Result.ERROR -> Phase.ERROR
            }
            render()
        }
    }

    // ---------- UI building blocks ----------
    private val textColor by lazy { getColor(R.color.brand_text) }
    private val mutedColor by lazy { getColor(R.color.brand_muted) }
    private fun title(t: String) = TextView(this).apply { text = t; textSize = 26f; setTextColor(textColor); setTypeface(typeface, Typeface.BOLD); setPadding(0, 0, 0, dp(8)) }
    private fun body(t: String, size: Float = 15f) = TextView(this).apply { text = t; textSize = size; setTextColor(mutedColor); setPadding(0, dp(6), 0, dp(6)) }
    private fun button(t: String, primary: Boolean = true, onClick: () -> Unit) = Button(this).apply {
        text = t; isAllCaps = false; setTextColor(Color.WHITE)
        setBackgroundResource(if (primary) R.drawable.btn_pink else R.drawable.btn_glass)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(12) }
        setOnClickListener { onClick() }
    }

    private fun humanStatus(): String = when (SyncHub.status) {
        SyncHub.Status.SIGNED_OUT -> "Connecting your account…"
        SyncHub.Status.STARTING -> "Connecting…"
        SyncHub.Status.WAITING_APPROVAL -> "Waiting for approval. Open Our Space on your other device and approve “Android live wallpaper” when the banner appears. The code on both screens must match."
        SyncHub.Status.NO_COUPLE -> "Your couple room isn’t active yet. Finish setting it up in Our Space."
        SyncHub.Status.LIVE -> "Connected. Your partner’s drawing will appear live on this phone’s wallpaper."
        SyncHub.Status.OFFLINE -> "Offline. Retrying…"
    }

    private fun render() {
        val key = phase.name
        if (key != shownKey) { shownKey = key; when (phase) {
            Phase.SYNCING -> buildMessage("Our Space Wallpaper", "Connecting your Our Space account…", null)
            Phase.NEEDS_WEB_LOGIN -> buildMessage("Sign in to Our Space", "Your wallpaper uses the same account as the app. Sign in once in Our Space (or sign in again if your session expired), then open Wallpaper again. There is no separate login.", "Open Our Space" to { goToWeb() })
            Phase.OFFLINE -> buildMessage("You’re offline", "Couldn’t reach the server. Check your connection and try again.", "Try again" to { linkAccount() })
            Phase.ERROR -> buildMessage("Something went wrong", "Couldn’t link your account to the wallpaper. Try again; if it keeps happening, sign out and back in to Our Space.", "Try again" to { linkAccount() })
            Phase.READY -> buildMain()
        } }
        if (phase == Phase.READY) {
            statusView?.text = humanStatus()
            val waiting = SyncHub.status == SyncHub.Status.WAITING_APPROVAL
            codeView?.visibility = if (waiting) View.VISIBLE else View.GONE
            if (waiting) SyncHub.store.devicePub?.let { codeView?.text = Crypto.safetyNumber(listOf(it)) }
        }
    }

    private fun buildMessage(heading: String, message: String, action: Pair<String, () -> Unit>?) {
        root.removeAllViews()
        root.addView(title(heading))
        root.addView(body(message))
        if (action != null) root.addView(button(action.first, onClick = action.second))
        root.addView(button("Back", primary = false) { finish() })
    }

    private fun goToWeb() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    private fun buildMain() {
        root.removeAllViews()
        val store = SyncHub.store
        root.addView(title("Our Space Wallpaper"))
        statusView = body("").also { root.addView(it) }
        codeView = TextView(this).apply {
            textSize = 24f; gravity = Gravity.CENTER; typeface = Typeface.MONOSPACE; setTextColor(textColor)
            setPadding(0, dp(12), 0, dp(12)); visibility = View.GONE
        }.also { root.addView(it) }
        root.addView(button("Set as live wallpaper") { chooseWallpaper() })
        val sw = Switch(this).apply {
            text = "Hide the drawing while my phone is locked"; setTextColor(textColor)
            isChecked = store.hideWhenLocked
            setPadding(0, dp(16), 0, dp(8))
            setOnCheckedChangeListener { _, on -> store.hideWhenLocked = on }
        }
        root.addView(sw)
        root.addView(body("With this on (recommended), the lock screen shows a plain heart instead of your partner’s drawing, so nobody nearby can see it. It is shown again once you unlock.", 13f))
        root.addView(button("Forget this phone’s wallpaper keys", primary = false) { forgetPhone() })
        root.addView(body("Removes this phone’s wallpaper keys and session. To stop sharing completely, also remove “Android live wallpaper” from Security → Devices in Our Space. Signing out of Our Space also ends the wallpaper’s session.", 13f))
    }

    private fun chooseWallpaper() {
        val component = ComponentName(this, LoveWallpaperService::class.java)
        try {
            startActivity(Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER).putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, component))
        } catch (e: Exception) {
            startActivity(Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER)) // some launchers only offer the chooser
        }
    }

    private fun forgetPhone() {
        scope.launch {
            SyncHub.store.clear()
            SyncHub.api.forget()
            SyncHub.restart()
            finish() // reopening Wallpaper links the account again and registers a fresh device that needs approval
        }
    }
}
