package com.couples.wallpaper

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class Iso7816PaddingTest {
    @Test
    fun roundTripsPayloadsAndPreserves128ByteBlockFormat() {
        listOf(0, 1, 126, 127, 128, 129, 255, 256).forEach { size ->
            val input = ByteArray(size) { (it % 251).toByte() }
            val padded = Iso7816Padding.pad(input)
            assertEquals(((size + 1 + 127) / 128) * 128, padded.size)
            assertEquals(0x80.toByte(), padded[size])
            assertArrayEquals(input, checkNotNull(Iso7816Padding.unpad(padded)))
        }
    }

    @Test
    fun rejectsInvalidPadding() {
        assertNull(Iso7816Padding.unpad(ByteArray(128)))
        assertNull(Iso7816Padding.unpad(byteArrayOf(1, 2, 3)))
    }
}
