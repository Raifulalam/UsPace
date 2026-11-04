package com.couples.wallpaper

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/** Configures the WebView that shows the existing Our Space website. Nothing here ever sees tokens or keys. */
class WebViewManager(private val activity: Activity, private val webView: WebView, private val host: Host) {
    interface Host {
        fun onProgress(percent: Int)
        fun onPageError(message: String)
        fun onPageOk()
        fun onWebSignedOut()
        fun chooseFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean
    }

    private var failed = false

    @Suppress("SetJavaScriptEnabled")
    fun configure() {
        webView.settings.apply {
            javaScriptEnabled = true // required: the site is a Next.js/React app
            domStorageEnabled = true // required: IndexedDB/localStorage hold the web device's encryption keys
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
            setGeolocationEnabled(false)
            userAgentString = userAgentString + " OurSpaceAndroid/" + BuildConfig.VERSION_NAME
        }
        webView.overScrollMode = WebView.OVER_SCROLL_NEVER
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            // Required because the deployed web and API hosts are cross-site.
            setAcceptThirdPartyCookies(webView, BuildConfig.ALLOW_THIRD_PARTY_COOKIES)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (TrustPolicy.isTrusted(url, BuildConfig.WEB_HOST)) return false // stay in the app
                if (TrustPolicy.mayOpenExternally(url)) {
                    try { activity.startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                }
                return true // never load untrusted pages inside the WebView
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { failed = false }

            override fun onPageFinished(view: WebView, url: String) { if (!failed) host.onPageOk() }

            // The website is a single-page app, so watch history changes: landing on /login means its session ended.
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if (!TrustPolicy.isTrusted(url, BuildConfig.WEB_HOST)) return
                val path = try { java.net.URI(url).path } catch (_: Exception) { null }
                if (path == "/login" || path == "/login/") host.onWebSignedOut()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) { failed = true; host.onPageError("Can’t reach Our Space. Check your connection and try again.") }
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 500) { failed = true; host.onPageError("Our Space is having trouble right now. Please try again in a moment.") }
            }

            // Never proceed(): certificate problems stop the page.
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel(); failed = true
                host.onPageError("A secure connection could not be made, so the page was not loaded.")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                activity.recreate(); return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) { host.onProgress(newProgress) }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() } // camera/mic not used by the site
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                host.chooseFiles(callback, params)
        }
    }
}
