package com.couples.wallpaper.ui

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController

/** Central native route graph used by the Compose application surfaces. */
@Composable
fun NativeNavigation(startDestination: String, destinationContent: @Composable (String) -> Unit) {
    val controller = rememberNavController()
    NavHost(navController = controller, startDestination = startDestination) {
        listOf(
            NativeRoute.Login,
            NativeRoute.Register,
            NativeRoute.Space,
            NativeRoute.Chat,
            NativeRoute.Canvas,
            NativeRoute.Memories,
            NativeRoute.Settings,
            NativeRoute.Calls,
        ).forEach { route ->
            composable(route.value) { destinationContent(route.value) }
        }
    }
}
