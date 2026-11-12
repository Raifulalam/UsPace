package com.couples.wallpaper

import android.content.ContentResolver
import android.net.Uri
import com.goterl.lazysodium.interfaces.SecretStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

data class NativeMediaDescriptor(
    val id: String,
    val key: String,
    val mime: String,
    val size: Int,
)

object NativeMediaUploader {
    suspend fun upload(
        resolver: ContentResolver,
        uri: Uri,
        kind: String,
        mime: String,
    ): NativeMediaDescriptor = withContext(Dispatchers.IO) {
        require(kind in setOf("image", "video", "audio", "thumb")) { "Unsupported media kind." }
        val plain = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("Could not read the selected media.")
        require(plain.isNotEmpty()) { "The selected media is empty." }
        uploadBytes(plain, kind, mime)
    }

    suspend fun uploadBytes(
        plain: ByteArray,
        kind: String,
        mime: String,
    ): NativeMediaDescriptor = withContext(Dispatchers.IO) {
        require(kind in setOf("image", "video", "audio", "thumb")) { "Unsupported media kind." }
        require(plain.isNotEmpty()) { "The selected media is empty." }
        val key = Crypto.newMediaKey()
        val encrypted = Crypto.encryptMedia(plain, key)
        val ciphertext = encrypted.header + encrypted.ciphertext
        val reservation = SyncHub.api.reserveMedia(kind, ciphertext.size)
        val id = reservation.getJSONObject("asset").getString("id")
        try {
            SyncHub.api.uploadMediaBlob(id, ciphertext)
        } catch (error: Exception) {
            runCatching { SyncHub.api.delete("/media/$id") }
            throw error
        }

        NativeMediaDescriptor(
            id = id,
            key = Crypto.b64(key),
            mime = mime.ifBlank { resolver.mimeType(uri) ?: "application/octet-stream" },
            size = plain.size,
        )
    }

    suspend fun download(descriptor: NativeMediaDescriptor): ByteArray = withContext(Dispatchers.IO) {
        val encrypted = SyncHub.api.downloadMediaBlob(descriptor.id)
        require(encrypted.size >= SecretStream.HEADERBYTES) { "Downloaded media is invalid." }
        val decrypted = Crypto.decryptMedia(
            Crypto.EncryptedMedia(
                header = encrypted.copyOfRange(0, SecretStream.HEADERBYTES),
                ciphertext = encrypted.copyOfRange(SecretStream.HEADERBYTES, encrypted.size),
            ),
            Crypto.unb64(descriptor.key),
        ) ?: error("Downloaded media failed its security check.")
        require(decrypted.size == descriptor.size) { "Downloaded media size does not match its descriptor." }
        decrypted
    }

    private fun ContentResolver.mimeType(uri: Uri): String? = getType(uri)

    fun descriptorJson(descriptor: NativeMediaDescriptor): JSONObject =
        JSONObject()
            .put("id", descriptor.id)
            .put("key", descriptor.key)
            .put("mime", descriptor.mime)
            .put("size", descriptor.size)
}
