package com.couples.wallpaper

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.graphics.Typeface
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** Entry point: shows the existing Our Space website (WebView) with a small native bar for wallpaper features. */
class MainActivity : Activity(), WebViewManager.Host {
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorView: LinearLayout
    private lateinit var errorText: TextView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: Pair<String, ByteArray>? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private var showingError = false
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var leaving = false
    private lateinit var headerAvatar: AvatarView
    private lateinit var headerName: TextView
    private lateinit var headerSub: TextView
    private val ready get() = ::webView.isInitialized

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen() // must run before super.onCreate
        super.onCreate(savedInstanceState)
        SyncHub.init(this)
        if (!Account.isSignedIn()) { goToLogin(null); return } // one login, in the app; the website opens already signed in
        WebSession.restorePersisted(SyncHub.store)

        val bg = getColor(R.color.app_bg)
        val ink = getColor(R.color.app_ink)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

        // Edge-to-edge: the window draws behind the system bars; the root pads itself by the bar/keyboard insets.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        val root = FrameLayout(this).apply { setBackgroundColor(bg) }
        webView = WebView(this).apply { setBackgroundColor(bg) }
        val nav = NativeNavigation(this) { loadHome() }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(buildHeader(ink, bg, nav), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(nav.buildBar(ink, bg), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root.addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = android.view.View.GONE }
        root.addView(progress, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)))

        val plumText = getColor(R.color.brand_text)
        errorText = TextView(this).apply { textSize = 16f; setTextColor(getColor(R.color.brand_muted)); gravity = Gravity.CENTER; setPadding(dp(24), 0, dp(24), dp(16)) }
        errorView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setBackgroundResource(R.drawable.bg_plum); visibility = android.view.View.GONE
            isClickable = true
            fun pill(label: String, res: Int, onClick: () -> Unit) = Button(context).apply {
                text = label; isAllCaps = false; setTextColor(Color.WHITE); setBackgroundResource(res); setOnClickListener { onClick() }
                layoutParams = LinearLayout.LayoutParams(dp(240), dp(48)).apply { topMargin = dp(12) }
            }
            addView(TextView(context).apply { text = "Our Space"; textSize = 26f; setTextColor(plumText); gravity = Gravity.CENTER; setPadding(0, 0, 0, dp(12)) })
            addView(errorText)
            addView(pill("Try again", R.drawable.btn_pink) { reloadPage() })
            addView(pill("Wallpaper settings", R.drawable.btn_glass) { nav.openWallpaper() })
        }
        root.addView(errorView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        setContentView(root)
        WindowCompat.getInsetsController(window, root).apply { isAppearanceLightStatusBars = !night; isAppearanceLightNavigationBars = !night }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        WebViewManager(this, webView, this).configure()
        WebAppBridge(onOpenWallpaper = { runOnUiThread { nav.openWallpaper() } }, onSaveImage = { name, bytes -> runOnUiThread { savePng(name, bytes) } })
            .install(webView, "https://" + BuildConfig.WEB_HOST)

        if (savedInstanceState != null) webView.restoreState(savedInstanceState) else loadHome()
    }

    /** Social-app style header: who is signed in, and who they're with. Tap for the profile. */
    private fun buildHeader(ink: Int, bg: Int, nav: NativeNavigation): LinearLayout {
        headerAvatar = AvatarView(this)
        headerName = TextView(this).apply { textSize = 16f; setTextColor(ink); setTypeface(typeface, Typeface.BOLD); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        headerSub = TextView(this).apply { textSize = 12f; setTextColor(ink); alpha = 0.65f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(headerName); addView(headerSub) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(bg)
            setPadding(dp(16), dp(8), dp(16), dp(8))
            addView(headerAvatar, LinearLayout.LayoutParams(dp(40), dp(40)))
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(12) })
            contentDescription = "Profile"
            setOnClickListener { nav.openProfile() }
        }
    }

    private fun bindHeader() {
        val s = SyncHub.store
        val name = s.displayName ?: s.username ?: "Me"
        headerAvatar.setPerson(name, s.userId ?: name)
        headerName.text = name
        headerSub.text = listOfNotNull(s.username?.let { "@$it" }, s.partnerName?.let { "With $it" }).joinToString(" · ")
    }

    private fun goToLogin(message: String?) {
        if (leaving) return
        leaving = true
        startActivity(Intent(this, LoginActivity::class.java).putExtra(LoginActivity.EXTRA_MESSAGE, message).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }

    private fun loadHome() { showingError = false; errorView.visibility = android.view.View.GONE; webView.loadUrl(BuildConfig.WEB_APP_URL) }
    private fun reloadPage() { errorView.visibility = android.view.View.GONE; if (webView.url.isNullOrEmpty()) loadHome() else webView.reload() }

    // ---- WebViewManager.Host ----
    override fun onProgress(percent: Int) {
        progress.progress = percent
        progress.visibility = if (percent in 1..99) android.view.View.VISIBLE else android.view.View.GONE
    }
    override fun onPageError(message: String) { showingError = true; errorText.text = message; errorView.visibility = android.view.View.VISIBLE }
    // The website fell back to its login page. With single sign-in that means the session ended (e.g. "Log out" in the website,
    // or revoked elsewhere), so sign out of the app too. If the website was never linked, let its own login form work.
    override fun onWebSignedOut() {
        if (!SyncHub.store.webLinked || leaving) return
        scope.launch { Account.signOut(this@MainActivity); goToLogin("You were signed out of Our Space. Please sign in again.") }
    }

    override fun onPageOk() { showingError = false; errorView.visibility = android.view.View.GONE }

    override fun chooseFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        return try { startActivityForResult(params.createIntent(), REQ_FILE); true }
        catch (e: Exception) { fileCallback = null; callback.onReceiveValue(null); false }
    }

    private fun savePng(name: String, bytes: ByteArray) {
        pendingSave = name to bytes
        try {
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/png").putExtra(Intent.EXTRA_TITLE, name), REQ_SAVE)
        } catch (e: Exception) { pendingSave = null; Toast.makeText(this, "Could not open the save dialog.", Toast.LENGTH_SHORT).show() }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_FILE -> { fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); fileCallback = null }
            REQ_SAVE -> {
                val save = pendingSave; pendingSave = null
                val uri = data?.data
                if (resultCode == RESULT_OK && uri != null && save != null) {
                    val ok = try { contentResolver.openOutputStream(uri)?.use { it.write(save.second) } != null } catch (e: Exception) { false }
                    Toast.makeText(this, if (ok) "Saved." else "Could not save the file.", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    // Back goes through the website's own history first; only then leaves the app.
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (errorView.visibility == android.view.View.VISIBLE && webView.canGoBack()) { errorView.visibility = android.view.View.GONE; webView.goBack() }
        else if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); if (ready) webView.saveState(outState) }

    override fun onStart() {
        super.onStart()
        if (!ready) return
        bindHeader()
        scope.launch { Account.refreshProfile(); bindHeader() }
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { runOnUiThread { if (showingError) reloadPage() } } // reconnect: retry automatically
        }
        netCallback = cb
        try { cm.registerDefaultNetworkCallback(cb) } catch (_: Exception) {}
    }

    override fun onStop() {
        if (!ready) { super.onStop(); return }
        netCallback?.let { try { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } catch (_: Exception) {} }
        netCallback = null
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        if (!ready) return
        webView.onResume()
        if (!Account.isSignedIn()) goToLogin(null)
    }
    override fun onPause() { if (ready) { webView.onPause(); android.webkit.CookieManager.getInstance().flush() }; super.onPause() }
    override fun onDestroy() {
        scope.cancel()
        if (ready) { (webView.parent as? ViewGroup)?.removeView(webView); webView.destroy() }
        super.onDestroy()
    }

    private companion object { const val REQ_FILE = 1001; const val REQ_SAVE = 1002 }
}
