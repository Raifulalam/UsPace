package com.couples.wallpaper

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, val code: String) : Exception("$code ($status)")

/** Minimal REST client. The refresh token is the server's httpOnly `rt` cookie, persisted in encrypted storage. */
class Api(private val store: Store) {
    @Volatile var accessToken: String? = null
        private set
    private val refreshLock = Mutex() // refresh tokens are single-use: never refresh concurrently
    private val json = "application/json".toMediaType()

    private val jar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            cookies.firstOrNull { it.name == "rt" }?.let { store.refreshCookie = if (it.expiresAt <= System.currentTimeMillis()) null else it.value }
        }
        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val v = store.refreshCookie ?: return emptyList()
            if (!url.encodedPath.startsWith("/api/v1/auth")) return emptyList()
            return listOf(Cookie.Builder().name("rt").value(v).domain(url.host).path("/api/v1/auth").httpOnly().build())
        }
    }
    private val client = OkHttpClient.Builder()
        .cookieJar(jar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // Used only for the one-time web-session exchange; it carries no cookies of its own.
    private val bare = client.newBuilder().cookieJar(CookieJar.NO_COOKIES).build()

    class WebLogin(val refreshToken: String, val maxAgeSeconds: Long)

    private fun failure(resp: okhttp3.Response, text: String): ApiException {
        val code = runCatching { JSONObject(text).getJSONObject("error").getString("code") }.getOrDefault("HTTP_${resp.code}")
        return ApiException(resp.code, code)
    }

    /**
     * A second, independent login (its own token family) whose refresh cookie is handed to the website inside the app, so the user
     * types the password once. Uses a client with no cookie jar so it never touches this app's own session.
     */
    suspend fun loginForWeb(identifier: String, password: String): WebLogin = withContext(Dispatchers.IO) {
        val url = base() + "/api/v1/auth/login"
        require(url.startsWith("https://") || BuildConfig.DEBUG) { "https required" }
        val req = Request.Builder().url(url).post(JSONObject().put("identifier", identifier).put("password", password).toString().toRequestBody(json)).build()
        bare.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw failure(resp, text)
            val c = Cookie.parseAll(resp.request.url, resp.headers).firstOrNull { it.name == "rt" } ?: throw ApiException(502, "NO_SESSION_COOKIE")
            WebLogin(c.value, ((c.expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(60))
        }
    }

    /** Registers an account. The returned session becomes this app's session (the refresh cookie is saved by the cookie jar). */
    suspend fun register(body: JSONObject): JSONObject {
        val d = raw("POST", "/auth/register", body, false)
        accessToken = d.getString("accessToken")
        return d
    }

    /** Ends this app's session on the server (best effort). */
    suspend fun logout() { try { raw("POST", "/auth/logout", null, false) } catch (_: Exception) {} }

    /** Ends the website's session on the server, using its refresh token. Best effort. */
    suspend fun logoutWeb(webRefreshToken: String) = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(base() + "/api/v1/auth/logout").header("Cookie", "rt=$webRefreshToken").post("{}".toRequestBody(json)).build()
            bare.newCall(req).execute().close()
        } catch (_: Exception) {}
    }

    /** Drops this app's session tokens (memory and storage). Device keys are untouched. */
    suspend fun dropSession() = refreshLock.withLock { store.refreshCookie = null; accessToken = null }

    private fun base() = store.baseUrl.trim().trimEnd('/')

    fun forget() { accessToken = null }

    suspend fun login(identifier: String, password: String): JSONObject {
        val d = raw("POST", "/auth/login", JSONObject().put("identifier", identifier).put("password", password), false)
        accessToken = d.getString("accessToken")
        return d
    }

    /** Rotates the session. Returns false if the session is gone (user must sign in again). */
    suspend fun refresh(): Boolean = refreshLock.withLock {
        try {
            accessToken = raw("POST", "/auth/refresh", null, false).getString("accessToken")
            true
        } catch (e: ApiException) {
            accessToken = null
            if (e.status == 401) store.refreshCookie = null
            false
        }
    }

    suspend fun get(path: String) = call("GET", path, null)
    suspend fun post(path: String, body: JSONObject? = null) = call("POST", path, body)

    private suspend fun call(method: String, path: String, body: JSONObject?): JSONObject {
        if (accessToken == null && !refresh()) throw ApiException(401, "UNAUTHENTICATED")
        try {
            return raw(method, path, body, true)
        } catch (e: ApiException) {
            if (e.status == 401 && refresh()) return raw(method, path, body, true)
            throw e
        }
    }

    private suspend fun raw(method: String, path: String, body: JSONObject?, auth: Boolean): JSONObject = withContext(Dispatchers.IO) {
        val rb = Request.Builder().url(base() + "/api/v1" + path)
        if (auth) accessToken?.let { rb.header("Authorization", "Bearer $it") }
        val req = when (method) {
            "GET" -> rb.get()
            "DELETE" -> rb.delete()
            else -> rb.method(method, (body?.toString() ?: "{}").toRequestBody(json))
        }.build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val code = runCatching { JSONObject(text).getJSONObject("error").getString("code") }.getOrDefault("HTTP_${resp.code}")
                throw ApiException(resp.code, code)
            }
            if (resp.code == 204 || text.isEmpty()) JSONObject() else JSONObject(text).optJSONObject("data") ?: JSONObject()
        }
    }
}
