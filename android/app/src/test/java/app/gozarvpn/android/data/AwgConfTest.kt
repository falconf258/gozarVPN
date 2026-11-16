package app.gozarvpn.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AwgConfTest {
    // a made-up key, never a real one
    private val conf = """
        [Interface]
        PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
        Address = 172.16.0.2/32, 2606:4700:110:8000::2/128
        DNS = 8.8.8.8
        MTU = 1280
        Jc = 4
        Jmin = 40
        Jmax = 70
        S1 = 0
        S2 = 0
        S3 = 10
        I1 = <b 0xc200000001>

        [Peer]
        PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=
        AllowedIPs = 0.0.0.0/0, ::/0
        Endpoint = engage.example.net:5279
        PersistentKeepalive = 25

        [Socks5]
        BindAddress = 0.0.0.0:1080
    """.trimIndent()

    @Test fun detectsAndPrepares() {
        assertTrue(AwgConf.looksLikeConf(conf))
        assertTrue(AwgConf.isAmnezia(conf))
        assertNull(AwgConf.problem(conf))
        val out = AwgConf.forProxy(conf, 2069) { "203.0.113.10" }
        assertTrue(out.contains("Endpoint = 203.0.113.10:5279"))
        assertTrue(out.contains("I1 = <b 0xc200000001>"))
        // the user's own proxy section is replaced by ours on loopback
        assertFalse(out.contains("0.0.0.0:1080"))
        assertTrue(out.trimEnd().endsWith("[Socks5]\nBindAddress = 127.0.0.1:2069"))
    }

    @Test fun plainWireGuardIsNotAmnezia() {
        val plain = conf.lines().filterNot { it.trim().substringBefore('=').trim() in AwgConf.AWG_KEYS }.joinToString("\n")
        assertFalse(AwgConf.isAmnezia(plain))
        val p = LinkParser.parseSubscription(plain).first.single()
        assertEquals("wireguard", p.protocol)
        assertEquals("amneziawg", LinkParser.parseSubscription(conf).first.single().protocol)
    }
}
