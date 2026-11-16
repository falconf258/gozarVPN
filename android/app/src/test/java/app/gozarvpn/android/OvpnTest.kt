package app.gozarvpn.android

import app.gozarvpn.android.data.Ovpn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OvpnTest {
    private val sample = listOf(
        "client", "dev tun", "proto udp", "remote vpn.example.com 1194", "remote 5.6.7.8 443 tcp",
        "cipher BF-CBC", "comp-lzo", "auth-user-pass /sdcard/pass.txt",
        "script-security 2", "up \"/system/bin/sh -c id\"", "management 0.0.0.0 7505", "plugin evil.so", "dev-node /dev/x",
        "<ca>", "-----BEGIN CERTIFICATE-----", "MIIB", "-----END CERTIFICATE-----", "</ca>",
        "<tls-auth>", "key", "</tls-auth>", "key-direction 1", "# comment",
    ).joinToString("\r\n")

    @Test fun parsesAndHardens() {
        val p = Ovpn.parse(sample)
        assertTrue(p.problems.joinToString(), p.ok)
        assertEquals(listOf(Ovpn.Remote("vpn.example.com", "1194", "udp"), Ovpn.Remote("5.6.7.8", "443", "tcp")), p.remotes)
        assertTrue(p.needsAuth)
        for (d in listOf("script-security", "up", "management", "plugin", "dev-node")) assertTrue(d, d in p.removed)
        val cfg = Ovpn.build(p, listOf("management /x unix"))
        assertFalse(Regex("^(script-security 2|up |plugin|dev-node)", RegexOption.MULTILINE).containsMatchIn(cfg))
        assertTrue(Regex("^auth-user-pass$", RegexOption.MULTILINE).containsMatchIn(cfg))
        assertTrue("data-ciphers-fallback BF-CBC" in cfg && "providers legacy default" in cfg && "allow-compression asym" in cfg)
        assertTrue("<ca>\n-----BEGIN CERTIFICATE-----" in cfg)
        assertTrue(cfg.trimEnd().endsWith("management /x unix"))
    }

    @Test fun refusesServerAndFileRefs() {
        assertFalse(Ovpn.parse("server 10.8.0.0 255.255.255.0\nremote x 1").ok)
        assertFalse(Ovpn.parse("client\nremote x 1194\nca ca.crt").ok)
        assertFalse(Ovpn.parse("client\ndev tun").ok)
    }

    @Test fun inlineCredentialsNeedNoPrompt() {
        assertFalse(Ovpn.parse("client\nremote x\n<ca>\nx\n</ca>\n<auth-user-pass>\nu\np\n</auth-user-pass>").needsAuth)
    }

    @Test fun helpers() {
        assertEquals(listOf("remote", "my host", "1194"), Ovpn.words("remote \"my host\" 1194 # c"))
        assertEquals("10.1.2.3" to 24, Ovpn.cidr4("10.1.2.3/24"))
        assertNull(Ovpn.cidr4("300.1.1.1/8"))
        assertNull(Ovpn.cidr4("example.com"))
        assertEquals(24, Ovpn.maskToPrefix("255.255.255.0"))
        assertEquals(30, Ovpn.maskToPrefix("255.255.255.252"))
        assertTrue(Ovpn.looksLike("client\nremote a.b 1194\n<ca>\n</ca>"))
        assertFalse(Ovpn.looksLike("vless://abc@host:443"))
    }
}
