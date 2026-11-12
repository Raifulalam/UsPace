package com.couples.wallpaper

import android.util.Base64
import com.goterl.lazysodium.SodiumAndroid
import com.goterl.lazysodium.interfaces.SecretStream
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * All libsodium use is isolated here and mirrors packages/crypto (JavaScript) exactly:
 *  - device identity: X25519 keypair (crypto_box)
 *  - room key envelope: crypto_box_easy(roomKey, nonce, recipientPub, senderSecret)
 *  - payloads: XChaCha20-Poly1305 with a caller-supplied AAD string, padded ISO/IEC 7816-4 (block 128)
 *  - base64: standard alphabet WITH padding
 * This file calls the C-style libsodium functions exposed by lazysodium's SodiumAndroid.
 */
object Crypto {
    private val sodium = SodiumAndroid().also { it.sodium_init() }

    fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.DEFAULT)

    /** Returns (publicKey, secretKey). */
    fun newDeviceKeys(): Pair<ByteArray, ByteArray> {
        val pk = ByteArray(32)
        val sk = ByteArray(32)
        check(sodium.crypto_box_keypair(pk, sk) == 0) { "keypair generation failed" }
        return pk to sk
    }

    fun newRoomKey(): ByteArray = ByteArray(32).also { sodium.randombytes_buf(it, it.size) }

    fun wrapRoomKey(roomKey: ByteArray, recipientPublicKey: ByteArray, senderSecretKey: ByteArray): Pair<String, String> {
        require(roomKey.size == 32 && recipientPublicKey.size == 32 && senderSecretKey.size == 32)
        val nonce = ByteArray(24).also { sodium.randombytes_buf(it, it.size) }
        val ciphertext = ByteArray(48)
        check(sodium.crypto_box_easy(ciphertext, roomKey, roomKey.size.toLong(), nonce, recipientPublicKey, senderSecretKey) == 0) {
            "room key wrapping failed"
        }
        return b64(nonce) to b64(ciphertext)
    }

    fun newRecoveryKey(): ByteArray = ByteArray(32).also { sodium.randombytes_buf(it, it.size) }

    fun formatRecoveryKey(key: ByteArray): String {
        require(key.size == 32)
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var buffer = 0
        var bits = 0
        val encoded = StringBuilder(52)
        key.forEach { byte ->
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                encoded.append(alphabet[(buffer shr bits) and 31])
            }
        }
        if (bits > 0) encoded.append(alphabet[(buffer shl (5 - bits)) and 31])
        return encoded.toString().chunked(4).joinToString("-")
    }

    fun parseRecoveryKey(text: String): ByteArray {
        val clean = text.uppercase().filterNot { it.isWhitespace() || it == '-' }
        require(clean.length == 52) { "Recovery key must contain 13 groups of 4 characters." }
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var buffer = 0
        var bits = 0
        val out = ByteArray(32)
        var count = 0
        clean.forEach { char ->
            val value = alphabet.indexOf(char)
            require(value >= 0) { "Recovery key has an invalid character." }
            buffer = (buffer shl 5) or value
            bits += 5
            if (bits >= 8) {
                bits -= 8
                if (count < out.size) out[count++] = (buffer shr bits).toByte()
                buffer = buffer and ((1 shl bits) - 1)
            }
        }
        require(count == 32) { "Recovery key is invalid." }
        return out
    }

    fun createRecoveryBlob(recoveryKey: ByteArray, roomKeys: Map<Int, String>, userId: String): Pair<String, String> {
        require(recoveryKey.size == 32)
        val keys = JSONObject()
        roomKeys.forEach { (version, key) -> keys.put(version.toString(), key) }
        val payload = JSONObject().put("v", 1).put("roomKeys", keys)
        return encryptPayload(recoveryKey, payload, "couples-recovery-v1|$userId")
    }

    fun openRecoveryBlob(recoveryKey: ByteArray, nonce: String, ciphertext: String, userId: String): Map<Int, String> {
        val text = decryptRaw(recoveryKey, nonce, ciphertext, "couples-recovery-v1|$userId")
            ?: throw IllegalArgumentException("Recovery key is incorrect or the backup was damaged.")
        val payload = JSONObject(text)
        require(payload.optInt("v") == 1) { "This recovery backup version is unsupported." }
        val keys = payload.getJSONObject("roomKeys")
        return keys.keys().asSequence().mapNotNull { version ->
            version.toIntOrNull()?.let { it to keys.getString(version) }
        }.toMap().also { require(it.isNotEmpty()) { "This backup contains no room keys." } }
    }

    /** Opens a room-key envelope addressed to this device. Null if it is not for us or was tampered with. */
    fun unwrapRoomKey(nonceB64: String, ciphertextB64: String, senderPublicB64: String, mySecret: ByteArray): ByteArray? {
        val nonce = runCatching { unb64(nonceB64) }.getOrNull() ?: return null
        val ct = runCatching { unb64(ciphertextB64) }.getOrNull() ?: return null
        val pk = runCatching { unb64(senderPublicB64) }.getOrNull() ?: return null
        if (nonce.size != 24 || ct.size != 48 || pk.size != 32 || mySecret.size != 32) return null
        val out = ByteArray(32)
        return if (sodium.crypto_box_open_easy(out, ct, ct.size.toLong(), nonce, pk, mySecret) == 0) out else null
    }

    /** Decrypts an XChaCha20-Poly1305 payload bound to [aad]; returns the JSON text or null if anything is off. */
    fun decryptRaw(key: ByteArray, nonceB64: String, ciphertextB64: String, aad: String): String? {
        val nonce = runCatching { unb64(nonceB64) }.getOrNull() ?: return null
        val ct = runCatching { unb64(ciphertextB64) }.getOrNull() ?: return null
        val ad = aad.toByteArray(Charsets.UTF_8)
        if (key.size != 32 || nonce.size != 24 || ct.size < 16 + 1) return null
        val out = ByteArray(ct.size - 16)
        val outLen = LongArray(1)
        val rc = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, outLen, null, ct, ct.size.toLong(), ad, ad.size.toLong(), nonce, key)
        if (rc != 0) return null
        return unpad(out.copyOf(outLen[0].toInt()))?.toString(Charsets.UTF_8)
    }

    fun encryptPayload(key: ByteArray, payload: JSONObject, aad: String): Pair<String, String> {
        val nonce = ByteArray(24)
        sodium.randombytes_buf(nonce, nonce.size)
        val plain = pad(payload.toString().toByteArray(Charsets.UTF_8))
        val ad = aad.toByteArray(Charsets.UTF_8)
        val out = ByteArray(plain.size + 16)
        val outLen = LongArray(1)
        check(
            sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                out,
                outLen,
                plain,
                plain.size.toLong(),
                ad,
                ad.size.toLong(),
                null,
                nonce,
                key,
            ) == 0
        ) { "payload encryption failed" }
        return b64(nonce) to b64(out)
    }

    fun messageAad(coupleId: String, senderId: String, clientMsgId: String, keyVersion: Int, kind: String) =
        "couples-msg-v1|$coupleId|$senderId|$clientMsgId|$keyVersion|$kind"

    data class EncryptedMedia(val header: ByteArray, val ciphertext: ByteArray)

    fun newMediaKey(): ByteArray = ByteArray(SecretStream.KEYBYTES).also {
        sodium.crypto_secretstream_xchacha20poly1305_keygen(it)
    }

    fun encryptMedia(plain: ByteArray, key: ByteArray, chunkSize: Int = 1024 * 1024): EncryptedMedia {
        require(key.size == SecretStream.KEYBYTES) { "invalid media key" }
        require(chunkSize > 0) { "invalid media chunk size" }
        val header = ByteArray(SecretStream.HEADERBYTES)
        val state = SecretStream.State()
        check(sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, key) == 0) {
            "media encryption initialization failed"
        }
        val output = ByteArrayOutputStream()
        var offset = 0
        while (offset < plain.size || (plain.isEmpty() && offset == 0)) {
            val end = minOf(offset + chunkSize, plain.size)
            val final = end == plain.size
            val message = plain.copyOfRange(offset, end)
            val cipher = ByteArray(message.size + SecretStream.ABYTES)
            check(
                sodium.crypto_secretstream_xchacha20poly1305_push(
                    state,
                    cipher,
                    null,
                    message,
                    message.size.toLong(),
                    null,
                    0,
                    if (final) SecretStream.TAG_FINAL else SecretStream.TAG_MESSAGE,
                ) == 0,
            ) { "media encryption failed" }
            output.write(cipher)
            offset = end
            if (final) break
        }
        return EncryptedMedia(header, output.toByteArray())
    }

    fun decryptMedia(encrypted: EncryptedMedia, key: ByteArray, chunkSize: Int = 1024 * 1024): ByteArray? {
        if (key.size != SecretStream.KEYBYTES || encrypted.header.size != SecretStream.HEADERBYTES || chunkSize <= 0) {
            return null
        }
        val state = SecretStream.State()
        if (sodium.crypto_secretstream_xchacha20poly1305_init_pull(state, encrypted.header, key) != 0) return null
        val output = ByteArrayOutputStream()
        var offset = 0
        while (offset < encrypted.ciphertext.size) {
            val remaining = encrypted.ciphertext.size - offset
            val cipherSize = minOf(chunkSize + SecretStream.ABYTES, remaining)
            if (cipherSize < SecretStream.ABYTES) return null
            val cipher = encrypted.ciphertext.copyOfRange(offset, offset + cipherSize)
            val message = ByteArray(cipherSize - SecretStream.ABYTES)
            val messageLen = LongArray(1)
            val tag = ByteArray(1)
            if (
                sodium.crypto_secretstream_xchacha20poly1305_pull(
                    state,
                    message,
                    messageLen,
                    tag,
                    cipher,
                    cipher.size.toLong(),
                    null,
                    0,
                ) != 0
            ) return null
            output.write(message, 0, messageLen[0].toInt())
            offset += cipherSize
            if (tag[0] == SecretStream.TAG_FINAL) return if (offset == encrypted.ciphertext.size) output.toByteArray() else null
        }
        return null
    }

    internal fun unpad(b: ByteArray): ByteArray? {
        var i = b.size - 1
        while (i >= 0 && b[i] == 0.toByte()) i--
        if (i < 0 || b[i] != 0x80.toByte()) return null
        return b.copyOf(i)
    }

    fun opAad(coupleId: String, canvasId: String, senderId: String, clientOpId: String, keyVersion: Int) =
        "couples-canvas-op-v1|$coupleId|$canvasId|$senderId|$clientOpId|$keyVersion"

    fun liveAad(coupleId: String, canvasId: String, senderId: String, keyVersion: Int) =
        "couples-canvas-live-v1|$coupleId|$canvasId|$senderId|$keyVersion"

    /** Short code shown on both devices during approval; identical algorithm to safetyNumber() in packages/crypto. */
    fun safetyNumber(publicKeysB64: List<String>): String {
        val material = "couples-safety-v1|" + publicKeysB64.sorted().joinToString("|")
        val msg = material.toByteArray(Charsets.UTF_8)
        val h = ByteArray(32)
        sodium.crypto_generichash(h, 32, msg, msg.size.toLong(), null, 0)
        return (0 until 6).joinToString(" ") { i ->
            val n = ((h[i * 4].toLong() and 0xff) shl 24) + ((h[i * 4 + 1].toLong() and 0xff) shl 16) +
                ((h[i * 4 + 2].toLong() and 0xff) shl 8) + (h[i * 4 + 3].toLong() and 0xff)
            (n % 100000).toString().padStart(5, '0')
        }
    }
}
