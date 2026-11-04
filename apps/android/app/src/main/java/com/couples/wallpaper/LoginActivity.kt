package com.couples.wallpaper

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** The only place the user types a password. Sign in or create an account; the website inside the app opens already signed in. */
class LoginActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var root: LinearLayout
    private var registering = false
    private var busy = false
    private var notice: String? = null

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private val ink by lazy { getColor(R.color.brand_text) }
    private val muted by lazy { getColor(R.color.brand_muted) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(this)
        notice = intent.getStringExtra(EXTRA_MESSAGE)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(dp(24), dp(40), dp(24), dp(32)) }
        setContentView(ScrollView(this).apply { addView(root); setBackgroundResource(R.drawable.bg_plum); fitsSystemWindows = true; isFillViewport = true })
        window.statusBarColor = Color.TRANSPARENT; window.navigationBarColor = Color.TRANSPARENT
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (Account.isSignedIn()) { openApp(); return }
        render()
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    private fun label(t: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        this.text = t; textSize = size; setTextColor(color); gravity = Gravity.CENTER
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun input(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint; inputType = type; setSingleLine()
        setTextColor(ink); setHintTextColor(muted); setBackgroundResource(R.drawable.field_glass)
        setPadding(dp(16), dp(12), dp(16), dp(12))
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
    }

    private fun pill(t: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        this.text = t; isAllCaps = false; setTextColor(Color.WHITE)
        setBackgroundResource(if (primary) R.drawable.btn_pink else R.drawable.btn_glass)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(14) }
        setOnClickListener { onClick() }
    }

    private fun render() {
        root.removeAllViews()
        root.addView(ImageView(this).apply { setImageResource(R.drawable.ic_heart); layoutParams = LinearLayout.LayoutParams(dp(96), dp(96)) })
        root.addView(label("Our Space", 28f, ink, bold = true))
        root.addView(label(if (registering) "Create your account" else "Private, just the two of you.", 15f, muted))
        notice?.let { root.addView(label(it, 14f, 0xFFFFB3C1.toInt())) }

        val name = if (registering) input("Your name", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS) else null
        val user = input(if (registering) "Username" else "Username or email", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        val email = if (registering) input("Email", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS) else null
        val pass = input(if (registering) "Password (10+ characters)" else "Password", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val birth = if (registering) input("Birth date (YYYY-MM-DD)", InputType.TYPE_CLASS_DATETIME or InputType.TYPE_DATETIME_VARIATION_DATE) else null
        val error = label("", 14f, 0xFFFF8A9B.toInt()).also { it.visibility = View.GONE }
        listOfNotNull(name, user, email, pass, birth).forEach { root.addView(it) }
        root.addView(error)

        val go = pill(if (registering) "Create account" else "Log in", true) {}
        go.setOnClickListener {
            if (busy) return@setOnClickListener
            val id = user.text.toString(); val pw = pass.text.toString()
            val problem = when {
                id.isBlank() || pw.isEmpty() -> "Enter your ${if (registering) "details" else "username and password"}."
                registering && (email!!.text.isBlank() || name!!.text.isBlank()) -> "Fill in every field."
                registering && !Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(birth!!.text.toString().trim()) -> "Use the birth date format YYYY-MM-DD."
                else -> null
            }
            if (problem != null) { error.text = problem; error.visibility = View.VISIBLE; return@setOnClickListener }
            busy = true; go.isEnabled = false; go.text = if (registering) "Creating account…" else "Signing in…"; error.visibility = View.GONE
            scope.launch {
                try {
                    if (registering) Account.signUp(this@LoginActivity, id, email!!.text.toString(), pw, birth!!.text.toString(), name!!.text.toString())
                    else Account.signIn(this@LoginActivity, id, pw)
                    openApp()
                } catch (e: Account.AuthFailure) {
                    busy = false; go.isEnabled = true; go.text = if (registering) "Create account" else "Log in"
                    error.text = e.message; error.visibility = View.VISIBLE
                }
            }
        }
        root.addView(go)
        root.addView(pill(if (registering) "I already have an account" else "Create an account", false) { registering = !registering; notice = null; render() })
        if (!registering) root.addView(TextView(this).apply {
            this.text = "Forgot password?"; textSize = 14f; setTextColor(muted); gravity = Gravity.CENTER; setPadding(0, dp(18), 0, dp(8))
            setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WEB_APP_URL.trimEnd('/') + "/forgot"))) }
        })
    }

    private fun openApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    companion object { const val EXTRA_MESSAGE = "message" }
}
