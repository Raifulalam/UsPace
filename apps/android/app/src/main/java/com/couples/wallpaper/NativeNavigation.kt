package com.couples.wallpaper

import android.app.Activity
import android.content.Intent
import android.view.Gravity
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.TextView

/** Slim native bar under the website: Home (the website), Wallpaper (native), Profile (native account screen). */
class NativeNavigation(private val activity: Activity, private val goHome: () -> Unit) {
    private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()

    fun buildBar(textColor: Int, barColor: Int): LinearLayout {
        val bar = LinearLayout(activity)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.setBackgroundColor(barColor)
        val items: List<Pair<String, () -> Unit>> = listOf(
            "Home" to { goHome() },
            "Wallpaper" to { openWallpaper() },
            "Profile" to { openProfile() },
        )
        for ((label, action) in items) {
            val item = TextView(activity)
            item.text = label
            item.textSize = 14f
            item.setTextColor(textColor)
            item.gravity = Gravity.CENTER
            item.contentDescription = label
            item.setOnClickListener { action() }
            val out = TypedValue()
            if (activity.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, out, true)) item.setBackgroundResource(out.resourceId)
            bar.addView(item, LinearLayout.LayoutParams(0, dp(48), 1f))
        }
        return bar
    }

    fun openWallpaper() { activity.startActivity(Intent(activity, WallpaperSetupActivity::class.java)) }
    fun openProfile() { activity.startActivity(Intent(activity, ProfileActivity::class.java)) }
}
