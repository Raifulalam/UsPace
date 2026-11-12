package com.couples.wallpaper

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class UsPaceFirebaseMessagingService : FirebaseMessagingService() {
    companion object {
        private const val CHANNEL_ID = "messages"
        private const val NOTIFICATION_ID = 1101
    }

    override fun onNewToken(token: String) {
        SyncHub.init(applicationContext)
        PushRegistration.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        SyncHub.init(applicationContext)
        val type = message.data["type"] ?: return
        val eventId = message.data["eventId"].orEmpty()
        if (!SyncHub.store.markNotificationIfNew(eventId)) return
        val destination = message.data["notificationDestination"] ?: "/space?view=chat"
        val body = when (type) {
            "new_message" -> "You have a new message"
            "incoming_call" -> "Your partner is calling."
            "invitation" -> "You have a new couple invitation."
            "device_change" -> "Your shared space devices changed."
            "canvas_activity" -> "Your partner updated the shared canvas."
            "memory_activity" -> "Your partner added something to Memories."
            else -> message.notification?.body ?: "You have a new UsPace notification."
        }

        createChannel()
        val tapIntent = NativeDestination.intent(this, destination)
        val pendingIntent = PendingIntent.getActivity(
            this,
            eventId.hashCode(),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(this)
        }
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle("UsPace")
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        getSystemService(NotificationManager::class.java).notify(
            if (eventId.isBlank()) NOTIFICATION_ID else eventId.hashCode(),
            notification
        )
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "New messages from your partner"
            }
        )
    }
}
