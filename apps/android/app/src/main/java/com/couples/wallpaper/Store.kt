package com.couples.wallpaper

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import org.json.JSONObject

/**
 * Everything sensitive (device secret key, room keys, refresh token) lives in EncryptedSharedPreferences,
 * whose key is held by the Android Keystore. Nothing here is ever logged.
 */
class Store(context: Context) {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        "couples_secure",
        MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
        context.applicationContext,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private fun str(k: String) = prefs.getString(k, null)
    private fun put(k: String, v: String?) { prefs.edit().apply { if (v == null) remove(k) else putString(k, v) }.apply() }

    var baseUrl: String
        get() = str("baseUrl") ?: ""
        set(v) = put("baseUrl", v)
    var refreshCookie: String?
        get() = str("rt")
        set(v) = put("rt", v)
    var userId: String?
        get() = str("userId")
        set(v) = put("userId", v)
    var deviceId: String?
        get() = str("deviceId")
        set(v) = put("deviceId", v)
    var devicePub: String?
        get() = str("devicePub")
        set(v) = put("devicePub", v)
    var deviceSecret: String?
        get() = str("deviceSecret")
        set(v) = put("deviceSecret", v)
    /** Privacy default: show a neutral placeholder instead of the drawing while the phone is locked. */
    var hideWhenLocked: Boolean
        get() = prefs.getBoolean("hideWhenLocked", true)
        set(v) { prefs.edit().putBoolean("hideWhenLocked", v).apply() }

    fun hasSession() = !refreshCookie.isNullOrEmpty() && !deviceId.isNullOrEmpty() && !baseUrl.isEmpty()

    @Synchronized fun roomKeys(): Map<Int, String> {
        val o = JSONObject(str("roomKeys") ?: "{}")
        return o.keys().asSequence().associate { it.toInt() to o.getString(it) }
    }
    @Synchronized fun putRoomKey(version: Int, keyB64: String) {
        val o = JSONObject(str("roomKeys") ?: "{}")
        o.put(version.toString(), keyB64)
        put("roomKeys", o.toString())
    }

    /** Forget this device's identity and keys (used when a different user signs in). */
    fun clearDevice() { put("deviceId", null); put("devicePub", null); put("deviceSecret", null); put("roomKeys", null) }

    /** Forget this device completely. The user should also remove it in the web app's Security panel. */
    fun clear() { prefs.edit().clear().apply() }
}
