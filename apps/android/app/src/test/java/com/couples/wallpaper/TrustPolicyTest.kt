package com.couples.wallpaper

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustPolicyTest {
    private val host = "wespc.vercel.app"

    @Test fun trustedPagesStayInApp() {
        assertTrue(TrustPolicy.isTrusted("https://wespc.vercel.app/login", host))
        assertTrue(TrustPolicy.isTrusted("https://WESPC.vercel.app/space?x=1", host))
        assertTrue(TrustPolicy.isTrusted("https://wespc.vercel.app:443/", host))
    }

    @Test fun lookalikesAndDowngradesAreNotTrusted() {
        assertFalse(TrustPolicy.isTrusted("http://wespc.vercel.app/", host))
        assertFalse(TrustPolicy.isTrusted("https://wespc.vercel.app.evil.com/", host))
        assertFalse(TrustPolicy.isTrusted("https://evil.com/wespc.vercel.app", host))
        assertFalse(TrustPolicy.isTrusted("https://wespc.vercel.app@evil.com/", host))
        assertFalse(TrustPolicy.isTrusted("https://evil.com\\@wespc.vercel.app/", host))
        assertFalse(TrustPolicy.isTrusted("https://wespc.vercel.app:8443/", host))
        assertFalse(TrustPolicy.isTrusted("javascript:alert(1)", host))
        assertFalse(TrustPolicy.isTrusted("", host))
    }

    @Test fun onlySafeSchemesLeaveTheApp() {
        assertTrue(TrustPolicy.mayOpenExternally("https://example.com"))
        assertTrue(TrustPolicy.mayOpenExternally("mailto:a@b.c"))
        assertFalse(TrustPolicy.mayOpenExternally("intent://x#Intent;end"))
        assertFalse(TrustPolicy.mayOpenExternally("file:///sdcard/x"))
        assertFalse(TrustPolicy.mayOpenExternally("javascript:alert(1)"))
    }
}
