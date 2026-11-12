package com.couples.wallpaper

import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object PushRegistration {
    private const val TAG = "UsPacePush"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val registrationLock = Mutex()

    suspend fun registerCurrentToken() {
        if (!SyncHub.store.hasSession()) return
        val token = try {
            suspendCancellableCoroutine<String> { continuation ->
                FirebaseMessaging.getInstance().token
                    .addOnSuccessListener { if (continuation.isActive) continuation.resume(it) }
                    .addOnFailureListener { if (continuation.isActive) continuation.resumeWithException(it) }
            }
        } catch (error: Exception) {
            Log.w(TAG, "Unable to obtain Firebase token", error)
            return
        }
        register(token)
    }

    fun onNewToken(token: String) {
        SyncHub.store.fcmToken = token
        if (SyncHub.store.hasSession()) {
            scope.launch { register(token) }
        }
    }

    private suspend fun register(token: String) = registrationLock.withLock {
        val store = SyncHub.store
        val deviceId = store.deviceId ?: return
        if (token.isBlank()) return
        if (store.registeredFcmToken == token) return
        try {
            SyncHub.api.post(
                "/push-tokens",
                JSONObject()
                    .put("token", token)
                    .put("deviceId", deviceId)
                    .put("platform", "android")
            )
            store.registeredFcmToken = token
        } catch (error: Exception) {
            Log.w(TAG, "Unable to register Firebase token", error)
        }
    }

    suspend fun removeCurrentToken() {
        val store = SyncHub.store
        val deviceId = store.deviceId ?: return
        val tokens = listOfNotNull(store.fcmToken, store.registeredFcmToken).distinct()
        for (token in tokens) {
            try {
                SyncHub.api.delete(
                    "/push-tokens",
                    JSONObject().put("token", token).put("deviceId", deviceId)
                )
            } catch (error: Exception) {
                Log.w(TAG, "Unable to remove Firebase token", error)
            }
        }
    }
}
