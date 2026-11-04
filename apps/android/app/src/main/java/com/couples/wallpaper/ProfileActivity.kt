package com.couples.wallpaper

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Account screen: who you are, who you're with, and sign out. */
class ProfileActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var root: LinearLayout
    private lateinit var avatar: AvatarView
    private lateinit var nameView: TextView
    private lateinit var handleView: TextView
    private lateinit var coupleView: TextView

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private val ink by lazy { getColor(R.color.brand_text) }
    private val muted by lazy { getColor(R.color.brand_muted) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(this)
        if (!Account.isSignedIn()) { startActivity(Intent(this, LoginActivity::class.java)); finish(); return }
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(dp(20), dp(32), dp(20), dp(32)) }
        setContentView(ScrollView(this).apply { addView(root); setBackgroundResource(R.drawable.bg_plum); fitsSystemWindows = true })
        window.statusBarColor = Color.TRANSPARENT; window.navigationBarColor = Color.TRANSPARENT

        avatar = AvatarView(this).also { root.addView(it, LinearLayout.LayoutParams(dp(96), dp(96))) }
        nameView = TextView(this).apply { textSize = 24f; setTextColor(ink); setTypeface(typeface, Typeface.BOLD); gravity = Gravity.CENTER; setPadding(0, dp(12), 0, 0) }.also { root.addView(it) }
        handleView = TextView(this).apply { textSize = 14f; setTextColor(muted); gravity = Gravity.CENTER }.also { root.addView(it) }
        coupleView = TextView(this).apply {
            textSize = 15f; setTextColor(ink); setBackgroundResource(R.drawable.field_glass); setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(24) }
        }.also { root.addView(it) }
        button("Live wallpaper", true) { startActivity(Intent(this, WallpaperSetupActivity::class.java)) }
        button("Back to Our Space", false) { finish() }
        button("Sign out", false) { confirmSignOut() }
        bind()
        scope.launch { Account.refreshProfile(); bind(); showCouple(Account.loadCouple()) }
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    private fun button(t: String, primary: Boolean, onClick: () -> Unit) {
        root.addView(Button(this).apply {
            this.text = t; isAllCaps = false; setTextColor(Color.WHITE)
            setBackgroundResource(if (primary) R.drawable.btn_pink else R.drawable.btn_glass)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(12) }
            setOnClickListener { onClick() }
        })
    }

    private fun bind() {
        val s = SyncHub.store
        val name = s.displayName ?: s.username ?: "Me"
        avatar.setPerson(name, s.userId ?: name)
        nameView.text = name
        handleView.text = s.username?.let { "@$it" } ?: ""
        if (coupleView.text.isNullOrEmpty()) coupleView.text = s.partnerName?.let { "In a couple with $it" } ?: "Loading…"
    }

    private fun showCouple(c: org.json.JSONObject?) {
        val partner = SyncHub.store.partnerName
        coupleView.text = when {
            c == null -> "No couple yet. Create or join one in Our Space."
            c.optString("status") != "active" -> "${c.optString("name", "Our Space")}\nWaiting for your partner to join."
            else -> "${c.optString("name", "Our Space")}\nWith ${partner ?: "your partner"}"
        }
    }

    private fun confirmSignOut() {
        AlertDialog.Builder(this)
            .setTitle("Sign out?")
            .setMessage("You’ll be signed out of Our Space and the live wallpaper on this phone.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Sign out") { _, _ ->
                scope.launch {
                    Account.signOut(this@ProfileActivity)
                    startActivity(Intent(this@ProfileActivity, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                }
            }.show()
    }
}
