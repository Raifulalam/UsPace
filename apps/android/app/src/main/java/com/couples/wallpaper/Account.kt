package com.couples.wallpaper

import android.content.Context
import android.os.Build
import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException

/** The website's login cookie inside the app's WebView. Native code can read httpOnly cookies; page JavaScript cannot. */
object WebSession {
    private val SAFE = Regex("^[A-Za-z0-9_-]{20,200}$")
    private fun urls() = listOf("https://${BuildConfig.WEB_HOST}/", BuildConfig.API_BASE_URL + "/")

    /** The website's refresh token, or null if the website is signed out. Call on the main thread. */
    fun refreshToken(): String? {
        val cm = CookieManager.getInstance()
        for (u in urls()) {
            val v = cm.getCookie(u + "api/v1/auth/refresh")?.split(";")?.map { it.trim() }?.firstOrNull { it.startsWith("rt=") }?.removePrefix("rt=") ?: continue
            if (SAFE.matches(v)) return v
        }
        return null
    }

    /** Restores the persisted handoff session when WebView cookies were cleared. Main thread. */
    fun restorePersisted(store: Store) {
        if (refreshToken() != null) return
        val token = store.webRefreshToken ?: return
        val remaining = ((store.webRefreshExpiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
        if (remaining == 0L) return
        inject(token, remaining)
    }

    /** Gives the website a session so it opens already signed in. The deployed web and API hosts are cross-site. Main thread. */
    fun inject(refreshToken: String, maxAgeSeconds: Long) {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        for (u in urls()) cm.setCookie(u, "rt=$refreshToken; Max-Age=$maxAgeSeconds; Path=/api/v1/auth; Secure; HttpOnly; SameSite=None")
        cm.flush()
    }

    fun clear() {
        val cm = CookieManager.getInstance()
        for (u in urls()) cm.setCookie(u, "rt=; Max-Age=0; Path=/api/v1/auth; Secure; HttpOnly; SameSite=None")
        cm.flush()
    }
}

/**
 * One account, one login. The user signs in here (natively). The same credentials, used once and never stored, create two independent
 * sessions: one for the app (wallpaper, Keystore-backed) and one handed to the website inside the app.
 */
object Account {
    enum class Kind { BAD_CREDENTIALS, LOCKED, TAKEN, UNDERAGE, INVALID, RATE_LIMITED, OFFLINE, OTHER }
    class AuthFailure(val kind: Kind, override val message: String) : Exception(message)

    /** Set by [signIn]/[signUp]: did the website session get linked? */
    @Volatile var lastWebLinked = false
        private set

    fun isSignedIn(): Boolean { val s = SyncHub.store; return !s.refreshCookie.isNullOrEmpty() && s.userId != null }

    fun displayName(): String = SyncHub.store.displayName ?: SyncHub.store.username ?: "Me"

    suspend fun signIn(ctx: Context, identifier: String, password: String) {
        SyncHub.init(ctx)
        SyncHub.store.baseUrl = BuildConfig.API_BASE_URL
        try { establish(SyncHub.api.login(identifier.trim(), password), identifier.trim(), password) } catch (e: Exception) { throw map(e) }
    }

    suspend fun signUp(ctx: Context, username: String, email: String, password: String, birthDate: String, displayName: String) {
        SyncHub.init(ctx)
        SyncHub.store.baseUrl = BuildConfig.API_BASE_URL
        val body = JSONObject().put("username", username.trim()).put("email", email.trim()).put("password", password).put("birthDate", birthDate.trim())
        if (displayName.isNotBlank()) body.put("displayName", displayName.trim())
        try { establish(SyncHub.api.register(body), username.trim(), password) } catch (e: Exception) { throw map(e) }
    }

    private suspend fun establish(d: JSONObject, identifier: String, password: String) {
        val store = SyncHub.store
        val api = SyncHub.api
        val u = d.getJSONObject("user")
        val id = u.getString("id")
        if (store.userId != null && store.userId != id) {
            store.clearDevice()
            store.webRefreshToken = null
            store.webRefreshExpiresAt = 0L
            store.partnerName = null
        } // never inherit another account's keys or web session
        store.userId = id
        store.username = u.getString("username")
        store.displayName = u.optString("displayName").ifEmpty { u.getString("username") }
        runCatching { ensureDevice() } // wallpaper screen retries if this fails
        var linked = false
        try {
            val w = api.loginForWeb(identifier, password)
            store.webRefreshToken = w.refreshToken
            store.webRefreshExpiresAt = System.currentTimeMillis() + w.maxAgeSeconds * 1000
            withContext(Dispatchers.Main) { WebSession.inject(w.refreshToken, w.maxAgeSeconds) }
            linked = true
        } catch (_: Exception) { /* website will show its own login as a fallback */ }
        store.webLinked = linked
        lastWebLinked = linked
        SyncHub.restart()
    }

    /** Registers this phone as one more encrypted device of the account. It still needs approval from an existing device. */
    suspend fun ensureDevice() {
        val store = SyncHub.store
        val api = SyncHub.api
        if (store.deviceId != null) return
        val (pk, sk) = Crypto.newDeviceKeys()
        val res = api.post("/devices", JSONObject().put("publicKey", Crypto.b64(pk)).put("label", "Android live wallpaper (${Build.MODEL})".take(60)))
        store.devicePub = Crypto.b64(pk)
        store.deviceSecret = Crypto.b64(sk)
        store.deviceId = res.getJSONObject("device").getString("id") // set last: hasSession() needs all of it
    }

    /** Refreshes the name shown in the app header and the partner's name. Silent on failure. */
    suspend fun refreshProfile() {
        val store = SyncHub.store
        val api = SyncHub.api
        try {
            val u = api.get("/auth/me").getJSONObject("user")
            store.username = u.getString("username")
            store.displayName = u.optString("displayName").ifEmpty { u.getString("username") }
        } catch (_: Exception) {}
        val c = loadCouple()
        val me = store.userId
        val members = c?.optJSONArray("members")
        var partner = ""
        if (members != null) for (i in 0 until members.length()) {
            val m = members.optJSONObject(i) ?: continue
            if (m.optString("id") != me) { partner = m.optString("displayName").ifEmpty { m.optString("username") }; break }
        }
        if (c != null || store.partnerName != null) store.partnerName = partner.ifEmpty { null }
    }

    suspend fun loadCouple(): JSONObject? = try { SyncHub.api.get("/couples/me").getJSONObject("couple") } catch (_: Exception) { null }

    /** Signs out of everything: the app session, the website session, and the website's cookie. Device keys stay on the phone. */
    suspend fun signOut(ctx: Context) {
        SyncHub.init(ctx)
        val api = SyncHub.api
        val store = SyncHub.store
        val webRt = withContext(Dispatchers.Main) { WebSession.refreshToken() }
        api.logout()
        if (webRt != null) api.logoutWeb(webRt)
        withContext(Dispatchers.Main) { WebSession.clear() }
        api.dropSession()
        store.webRefreshToken = null
        store.webRefreshExpiresAt = 0L
        store.displayName = null; store.username = null; store.partnerName = null; store.webLinked = false
        lastWebLinked = false
        SyncHub.restart()
    }

    private fun map(e: Throwable): AuthFailure = when (e) {
        is AuthFailure -> e
        is ApiException -> when {
            e.code == "INVALID_CREDENTIALS" -> AuthFailure(Kind.BAD_CREDENTIALS, "Incorrect username/email or password.")
            e.code == "ACCOUNT_LOCKED" -> AuthFailure(Kind.LOCKED, "Too many failed attempts. Try again later.")
            e.code == "ACCOUNT_SUSPENDED" -> AuthFailure(Kind.OTHER, "This account isn’t active.")
            e.code == "UNDERAGE" -> AuthFailure(Kind.UNDERAGE, "You must be old enough to use this app.")
            e.code == "ALREADY_EXISTS" -> AuthFailure(Kind.TAKEN, "That username or email is already taken.")
            e.status == 429 -> AuthFailure(Kind.RATE_LIMITED, "Too many attempts. Please wait a few minutes.")
            e.status == 400 -> AuthFailure(Kind.INVALID, "Please check your details. The password needs at least 10 characters.")
            else -> AuthFailure(Kind.OTHER, "Something went wrong (${e.code}).")
        }
        is IOException -> AuthFailure(Kind.OFFLINE, "Can’t reach the server. Check your connection.")
        else -> AuthFailure(Kind.OTHER, "Something went wrong (${e.javaClass.simpleName}).")
    }
}
