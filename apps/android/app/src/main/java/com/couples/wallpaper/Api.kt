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

    private fun base() = store.baseUrl.trim().trimEnd('/')

    fun forget() { accessToken = null }
    fun setAccessToken(value: String) { accessToken = value }

    suspend fun login(identifier: String, password: String): JSONObject {
        val d = raw("POST", "/auth/login", JSONObject().put("identifier", identifier).put("password", password), false, true)
        accessToken = d.getString("accessToken")
        return d
    }

    suspend fun register(username: String, email: String, password: String, birthDate: String, displayName: String?): JSONObject {
        val body = JSONObject()
            .put("username", username)
            .put("email", email)
            .put("password", password)
            .put("birthDate", birthDate)
            .put("termsAccepted", true)
            .put("privacyAccepted", true)
        if (!displayName.isNullOrBlank()) body.put("displayName", displayName.trim())
        val d = raw("POST", "/auth/register", body, false, true)
        accessToken = d.getString("accessToken")
        return d
    }

    suspend fun requestPasswordReset(email: String): JSONObject =
        raw("POST", "/auth/password/forgot", JSONObject().put("email", email), false)

    suspend fun resetPassword(token: String, password: String): JSONObject =
        raw("POST", "/auth/password/reset", JSONObject().put("token", token).put("password", password), false)

    /** Refreshes the session. Returns false if it is gone (the user must sign in again). */
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
    suspend fun put(path: String, body: JSONObject? = null) = call("PUT", path, body)
    suspend fun patch(path: String, body: JSONObject? = null) = call("PATCH", path, body)
    suspend fun delete(path: String, body: JSONObject? = null) = call("DELETE", path, body)

    suspend fun reserveMedia(kind: String, sizeBytes: Int): JSONObject =
        post("/media", JSONObject().put("kind", kind).put("sizeBytes", sizeBytes))

    suspend fun uploadMediaBlob(id: String, ciphertext: ByteArray): JSONObject {
        if (accessToken == null && !refresh()) throw ApiException(401, "UNAUTHENTICATED")
        return try {
            uploadMediaBlobRaw(id, ciphertext)
        } catch (e: ApiException) {
            if (e.status == 401 && refresh()) uploadMediaBlobRaw(id, ciphertext) else throw e
        }
    }

    suspend fun downloadMediaBlob(id: String): ByteArray {
        if (accessToken == null && !refresh()) throw ApiException(401, "UNAUTHENTICATED")
        return try {
            downloadMediaBlobRaw(id)
        } catch (e: ApiException) {
            if (e.status == 401 && refresh()) downloadMediaBlobRaw(id) else throw e
        }
    }

    private suspend fun downloadMediaBlobRaw(id: String): ByteArray = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(base() + "/api/v1/media/" + id + "/blob")
            .header("Authorization", "Bearer " + (accessToken ?: ""))
            .get()
            .build()
        client.newCall(request).execute().use { resp ->
            val body = resp.body
            if (!resp.isSuccessful || body == null) {
                val text = body?.string().orEmpty()
                val code = runCatching { JSONObject(text).getJSONObject("error").getString("code") }
                    .getOrDefault("HTTP_${resp.code}")
                throw ApiException(resp.code, code)
            }
            body.bytes()
        }
    }

    private suspend fun uploadMediaBlobRaw(id: String, ciphertext: ByteArray): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(base() + "/api/v1/media/" + id + "/blob")
            .header("Authorization", "Bearer " + (accessToken ?: ""))
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", ciphertext.size.toString())
            .put(ciphertext.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        client.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val code = runCatching { JSONObject(text).getJSONObject("error").getString("code") }
                    .getOrDefault("HTTP_${resp.code}")
                throw ApiException(resp.code, code)
            }
            if (resp.code == 204 || text.isEmpty()) JSONObject()
            else JSONObject(text).optJSONObject("data") ?: JSONObject()
        }
    }

    suspend fun logout() {
        try {
            raw("POST", "/auth/logout", null, false)
        } finally {
            accessToken = null
        }
    }

    private suspend fun call(method: String, path: String, body: JSONObject?): JSONObject {
        if (accessToken == null && !refresh()) throw ApiException(401, "UNAUTHENTICATED")
        try {
            return raw(method, path, body, true)
        } catch (e: ApiException) {
            if (e.status == 401 && refresh()) return raw(method, path, body, true)
            throw e
        }
    }

    private suspend fun raw(method: String, path: String, body: JSONObject?, auth: Boolean, sharedSession: Boolean = false): JSONObject = withContext(Dispatchers.IO) {
        val rb = Request.Builder().url(base() + "/api/v1" + path)
        if (sharedSession) {
            rb.header("X-Shared-Session", "android-webview")
            rb.header("User-Agent", "OurSpaceAndroid")
        }
        if (auth) accessToken?.let { rb.header("Authorization", "Bearer $it") }
        val req = when (method) {
            "GET" -> rb.get()
            "DELETE" -> rb.delete((body?.toString() ?: "{}").toRequestBody(json))
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
