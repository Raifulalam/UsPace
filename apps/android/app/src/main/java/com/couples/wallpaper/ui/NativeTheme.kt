package com.couples.wallpaper.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF7C3AED),
    secondary = Color(0xFF8B5CF6),
    background = Color(0xFFF8F4FF),
    surface = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFC4B5FD),
    secondary = Color(0xFFA78BFA),
)

@Composable
fun UsPaceTheme(darkTheme: Boolean = false, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
