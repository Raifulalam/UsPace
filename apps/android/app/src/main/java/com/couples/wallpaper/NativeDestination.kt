package com.couples.wallpaper

import android.content.Context
import android.content.Intent

object NativeDestination {
    fun intent(context: Context, destination: String?): Intent {
        val path = destination.orEmpty().lowercase()
        val target = when {
            "memories" in path -> NativeMemoriesActivity::class.java
            "media" in path -> NativeMediaLibraryActivity::class.java
            "canvas" in path -> NativeCanvasActivity::class.java
            "call" in path -> NativeCallsActivity::class.java
            "settings" in path || "security" in path -> NativeAccountActivity::class.java
            "chat" in path -> NativeChatActivity::class.java
            else -> NativeCoupleActivity::class.java
        }
        return Intent(context, target).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}
