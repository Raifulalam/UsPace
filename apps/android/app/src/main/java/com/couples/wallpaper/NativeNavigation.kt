package com.couples.wallpaper

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

/** Slim native bar under the website: Home (the website), Wallpaper (native), Settings (native). */
class NativeNavigation(private val activity: Activity, private val goHome: () -> Unit, private val reload: () -> Unit) {
    private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()

    /** Home reloads the website, Wallpaper opens the native wallpaper screen, Settings opens the native settings dialog. */
    fun buildBar(textColor: Int, barColor: Int): LinearLayout {
        val bar = LinearLayout(activity)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.setBackgroundColor(barColor)
        // Lambdas call this class's methods explicitly. (`this::x` inside an apply{} block would point at the view, not at this class.)
        val items: List<Pair<String, () -> Unit>> = listOf(
            "Home" to { goHome() },
            "Wallpaper" to { openWallpaper() },
            "Settings" to { showSettings() },
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

    private fun showSettings() {
        AlertDialog.Builder(activity)
            .setTitle("Settings")
            .setItems(arrayOf("Reload page", "Wallpaper, devices & privacy", "Android app settings")) { _, i ->
                when (i) {
                    0 -> reload()
                    1 -> openWallpaper()
                    2 -> activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)))
                }
            }.show()
    }
}
