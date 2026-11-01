package com.couples.wallpaper

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.Settings
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

/** Slim native bar under the website: Home (the website), Wallpaper (native), Settings (native). */
class NativeNavigation(private val activity: Activity, private val goHome: () -> Unit, private val reload: () -> Unit) {
    private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()

    fun buildBar(textColor: Int, background: Int): LinearLayout = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        setBackgroundColor(background)
        listOf("Home" to goHome, "Wallpaper" to this::openWallpaper, "Settings" to this::showSettings).forEach { (label, action) ->
            addView(TextView(activity).apply {
                text = label; textSize = 14f; setTextColor(textColor); gravity = Gravity.CENTER
                contentDescription = label
                setOnClickListener { action() }
                val out = android.util.TypedValue()
                if (activity.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, out, true)) setBackgroundResource(out.resourceId)
            }, LinearLayout.LayoutParams(0, dp(48), 1f))
        }
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
