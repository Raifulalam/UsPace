package com.couples.wallpaper

import android.Manifest
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.app.Activity

/**
 * Hosts the existing React application. Authentication is shared by copying only the
 * httpOnly refresh cookie into WebView's cookie store; access tokens never cross the boundary.
 */
class WebAppActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorPanel: LinearLayout
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileRequest = 1001
    private val capabilityRequest = 1002

    private fun webUrl(): String {
        val base = SyncHub.store.baseUrl.trim().trimEnd('/')
        val configured = intent.getStringExtra(EXTRA_WEB_URL)
        return configured?.takeIf { it.isNotBlank() } ?: base.replace(Regex(":4000$"), ":3000")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncHub.init(applicationContext)
        if (!SyncHub.store.hasSession()) {
            finish()
            return
        }
        buildUi()
        configureWebView()
        prepareNotifications()
        transferRefreshCookie()
        webView.loadUrl(webUrl())
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal)
        errorPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(40, 40, 40, 40)
        }
        val message = TextView(this).apply { text = "Could not load Our Space. Check your connection and server address." }
        val retry = Button(this).apply { text = "Retry"; setOnClickListener { errorPanel.visibility = View.GONE; webView.reload() } }
        errorPanel.addView(message)
        errorPanel.addView(retry)
        webView = WebView(this)
        root.addView(progress, LinearLayout.LayoutParams(-1, 6))
        root.addView(errorPanel, LinearLayout.LayoutParams(-1, -2))
        root.addView(webView, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString OurSpaceAndroid"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = Uri.parse(webUrl()).host
                if (request.url.host == host) return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                progress.visibility = View.VISIBLE
                errorPanel.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    progress.visibility = View.GONE
                    errorPanel.visibility = View.VISIBLE
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val needsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    val needsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                    if (hasCapabilityPermissions(needsCamera, needsMic)) {
                        request.grant(request.resources)
                    } else {
                        pendingPermissionRequest = request
                        requestPermissions(capabilityPermissions(needsCamera, needsMic), capabilityRequest)
                    }
                }
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(params.createIntent(), fileRequest)
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }
        }
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val request = DownloadManager.Request(Uri.parse(url))
                .setMimeType(mimeType)
                .addRequestHeader("User-Agent", userAgent)
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url).orEmpty())
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "our-space-${System.currentTimeMillis()}")
            getSystemService(DownloadManager::class.java).enqueue(request)
        }
    }

    private var pendingPermissionRequest: PermissionRequest? = null

    private fun capabilityPermissions(camera: Boolean, mic: Boolean): Array<String> {
        val result = mutableListOf<String>()
        if (camera) result += Manifest.permission.CAMERA
        if (mic) result += Manifest.permission.RECORD_AUDIO
        if (Build.VERSION.SDK_INT >= 33) result += Manifest.permission.POST_NOTIFICATIONS
        return result.toTypedArray()
    }

    private fun hasCapabilityPermissions(camera: Boolean, mic: Boolean): Boolean {
        val cameraOk = !camera || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        val micOk = !mic || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        return cameraOk && micOk
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == capabilityRequest) {
            val request = pendingPermissionRequest
            pendingPermissionRequest = null
            if (request != null && hasCapabilityPermissions(
                    request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE),
                    request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                )
            ) request.grant(request.resources) else request?.deny()
        }
    }

    private fun transferRefreshCookie() {
        val cookie = SyncHub.store.refreshCookie ?: return
        val base = SyncHub.store.baseUrl.trim().trimEnd('/')
        CookieManager.getInstance().setCookie(base, "rt=$cookie; Path=/api/v1/auth; HttpOnly; SameSite=Strict")
        CookieManager.getInstance().flush()
    }

    private fun prepareNotifications() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel("our-space", "Our Space", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Messages and call notifications"
                }
            )
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1003)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == fileRequest) {
            fileCallback?.onReceiveValue(
                if (resultCode == RESULT_OK) WebChromeClient.FileChooserParams.parseResult(resultCode, data) else null
            )
            fileCallback = null
        }
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_WEB_URL = "webUrl"
    }
}
