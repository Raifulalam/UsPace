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
        private const val MESSAGE_ID_KEY = "messageId"
        private const val NOTIFICATION_ID = 1101
    }

    override fun onNewToken(token: String) {
        SyncHub.init(applicationContext)
        PushRegistration.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        SyncHub.init(applicationContext)
        val type = message.data["type"] ?: return
        if (type != "new_message") return
        val messageId = message.data[MESSAGE_ID_KEY].orEmpty()
        if (!SyncHub.store.markNotificationIfNew(messageId)) return

        createChannel()
        val tapIntent = Intent(this, WebAppActivity::class.java)
            .putExtra(WebAppActivity.EXTRA_NOTIFICATION_DESTINATION, "/space")
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pendingIntent = PendingIntent.getActivity(
            this,
            messageId.hashCode(),
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
            .setContentText("You received a new message.")
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        getSystemService(NotificationManager::class.java).notify(
            if (messageId.isBlank()) NOTIFICATION_ID else messageId.hashCode(),
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
