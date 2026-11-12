package com.couples.wallpaper.ui

sealed class NativeRoute(val value: String) {
    data object Login : NativeRoute("login")
    data object Register : NativeRoute("register")
    data object Space : NativeRoute("space")
    data object Chat : NativeRoute("chat")
    data object Canvas : NativeRoute("canvas")
    data object Memories : NativeRoute("memories")
    data object Settings : NativeRoute("settings")
    data object Calls : NativeRoute("calls")
}
