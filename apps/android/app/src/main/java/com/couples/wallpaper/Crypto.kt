package com.couples.wallpaper

import android.util.Base64
import com.goterl.lazysodium.SodiumAndroid

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
