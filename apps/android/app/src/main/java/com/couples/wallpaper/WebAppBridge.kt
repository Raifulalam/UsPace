package com.couples.wallpaper

import android.net.Uri
import android.util.Base64
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * The only channel from the page to native code. Uses an origin-restricted message listener (not addJavascriptInterface),
 * so only the trusted origin's top frame can talk to it. It exposes NO keys, tokens or cookies, and accepts only two messages:
 *   {"type":"openWallpaper"}                         -> open the native wallpaper screen
 *   {"type":"saveImage","name":"x.png","data":"<base64 PNG>"} -> let the user save their own drawing
 */
class WebAppBridge(private val onOpenWallpaper: () -> Unit, private val onSaveImage: (String, ByteArray) -> Unit) {
    fun install(webView: WebView, trustedOrigin: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return // page then simply has no native features
        WebViewCompat.addWebMessageListener(webView, "OurSpaceNative", setOf(trustedOrigin),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
                    if (!isMainFrame || sourceOrigin.toString() != trustedOrigin) return
                    val text = message.data ?: return
                    if (text.length > MAX_CHARS) return
                    val o = try { JSONObject(text) } catch (_: Exception) { return }
                    when (o.optString("type")) {
                        "openWallpaper" -> onOpenWallpaper()
                        "saveImage" -> {
                            val bytes = try { Base64.decode(o.optString("data"), Base64.DEFAULT) } catch (_: Exception) { return }
                            if (!isPng(bytes)) return
                            val name = o.optString("name").replace(Regex("[^A-Za-z0-9._-]"), "_").take(60).ifEmpty { "our-drawing.png" }
                            onSaveImage(name, bytes)
                        }
                    }
                }
            })
    }

    private fun isPng(b: ByteArray) = b.size > 8 && b[0] == 0x89.toByte() && b[1] == 0x50.toByte() && b[2] == 0x4E.toByte() && b[3] == 0x47.toByte()
    private companion object { const val MAX_CHARS = 12_000_000 }
}
