package com.couples.wallpaper

import android.content.Context
import android.os.Build
import android.webkit.CookieManager
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.IOException

/** Reads the website's login from the WebView's own cookie store. Native code can see httpOnly cookies; page JavaScript cannot. */
object WebSession {
    private val SAFE = Regex("^[A-Za-z0-9_-]{20,200}$")

    /** The website's refresh token, or null if the website is signed out. Only trusted hosts are consulted. Call on the main thread. */
    fun refreshToken(): String? {
        val cm = CookieManager.getInstance()
        for (u in listOf("https://${BuildConfig.WEB_HOST}/api/v1/auth/refresh", "${BuildConfig.API_BASE_URL}/api/v1/auth/refresh")) {
            val header = cm.getCookie(u) ?: continue
            val v = header.split(";").map { it.trim() }.firstOrNull { it.startsWith("rt=") }?.removePrefix("rt=") ?: continue
            if (SAFE.matches(v)) return v
        }
        return null
    }
}

/**
 * Single sign-in: the user logs in once, in the website. Opening native wallpaper features then turns that web login into this app's
 * own session (see POST /auth/native-session), so there is no second login. Tokens never pass through JavaScript.
 */
object NativeSession {
    enum class Result { READY, NEEDS_WEB_LOGIN, OFFLINE, ERROR }

    private val lock = Mutex()

    suspend fun syncFromWeb(ctx: Context): Result = lock.withLock {
        SyncHub.init(ctx)
        val store = SyncHub.store
        val api = SyncHub.api
        val webRt = WebSession.refreshToken() // read on the caller's (main) thread, before any suspension
        if (webRt == null) {
            // The website is signed out, so the app must not stay signed in. (The server also revokes the linked app session on web logout.)
            if (store.refreshCookie != null) { api.dropSession(); SyncHub.restart() }
            return Result.NEEDS_WEB_LOGIN
        }
        store.baseUrl = BuildConfig.API_BASE_URL
        return try {
            val ex = api.exchangeWebSession(webRt)
            val userId = ex.data.getJSONObject("user").getString("id")
            // A different account must never inherit the previous account's device identity or room keys.
            if (store.userId != null && store.userId != userId) store.clearDevice()
            api.adopt(ex)
            store.userId = userId
            ensureDevice(store, api)
            SyncHub.restart()
            Result.READY
        } catch (e: ApiException) {
            if (e.status == 401) { api.dropSession(); SyncHub.restart(); Result.NEEDS_WEB_LOGIN } else Result.ERROR
        } catch (e: IOException) {
            Result.OFFLINE
        } catch (e: Exception) {
            Result.ERROR
        }
    }

    /** Registers this phone as one more encrypted device of the signed-in account. It still needs approval from an existing device. */
    private suspend fun ensureDevice(store: Store, api: Api) {
        if (store.deviceId != null) return
        val (pk, sk) = Crypto.newDeviceKeys()
        val label = "Android live wallpaper (${Build.MODEL})".take(60)
        val res = api.post("/devices", JSONObject().put("publicKey", Crypto.b64(pk)).put("label", label))
        store.devicePub = Crypto.b64(pk)
        store.deviceSecret = Crypto.b64(sk)
        store.deviceId = res.getJSONObject("device").getString("id") // set last: hasSession() needs all of it
    }
}
