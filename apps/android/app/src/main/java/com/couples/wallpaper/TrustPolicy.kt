package com.couples.wallpaper

import java.net.URI

/** Pure (JVM-testable) rule for which URLs may load inside the WebView. Everything else goes to the system browser. */
object TrustPolicy {
    fun isTrusted(url: String, trustedHost: String): Boolean {
        val u = try { URI(url) } catch (e: Exception) { return false }
        if (u.scheme?.lowercase() != "https") return false
        if (u.rawUserInfo != null) return false
        if (u.port != -1 && u.port != 443) return false
        return u.host?.equals(trustedHost, ignoreCase = true) == true
    }

    /** Only these schemes may be handed to another app. javascript:, intent:, file:, content: are dropped. */
    fun mayOpenExternally(url: String): Boolean {
        val scheme = try { URI(url).scheme?.lowercase() } catch (e: Exception) { null }
        return scheme == "https" || scheme == "http" || scheme == "mailto" || scheme == "tel"
    }
}
