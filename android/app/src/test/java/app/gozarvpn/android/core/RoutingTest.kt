package app.gozarvpn.android.core

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RoutingTest {
    private val iran = SingboxConfig.Routing("iran", direct = listOf("example.com", "10.1.2.3"), proxy = listOf("youtube.com"), rulesDir = "/tmp/rules")

    @Test fun iranModeOrdersRules() {
        val cfg = Json.parseToJsonElement(SingboxConfig.forLocalSocks(1819, "app.gozarvpn.android", routing = iran)).jsonObject
        val route = cfg["route"]!!.jsonObject
        val rules = route["rules"]!!.jsonArray.map { it.jsonObject }
        // VPN list first, then direct list, then .ir and the rule-sets, all before the UDP/QUIC limits
        val outs = rules.mapNotNull { it["outbound"]?.jsonPrimitive?.content }
        assertEquals(listOf("proxy", "direct", "direct", "direct", "direct"), outs)
        assertTrue(rules[2]["domain_suffix"].toString().contains("youtube.com"))
        assertTrue(rules[3]["ip_cidr"].toString().contains("10.1.2.3/32"))
        assertEquals("proxy", route["final"]!!.jsonPrimitive.content)
        assertEquals(2, route["rule_set"]!!.jsonArray.size)
        // Iranian names resolve locally, before the FakeIP catch-all
        val dns = cfg["dns"]!!.jsonObject["rules"]!!.jsonArray.map { it.jsonObject["server"]!!.jsonPrimitive.content }
        assertEquals(listOf("fakeip", "local", "local", "fakeip"), dns)
    }

    @Test fun customModeEndsDirect() {
        val cfg = Json.parseToJsonElement(SingboxConfig.forLocalSocks(1819, "app.gozarvpn.android", routing = SingboxConfig.Routing("custom", proxy = listOf("telegram.org")))).jsonObject
        assertEquals("direct", cfg["route"]!!.jsonObject["final"]!!.jsonPrimitive.content)
        assertEquals("local", cfg["dns"]!!.jsonObject["final"]!!.jsonPrimitive.content)
        assertNull(cfg["route"]!!.jsonObject["rule_set"])
    }

    @Test fun writeForSingboxCheck() {
        val out = File(System.getProperty("java.io.tmpdir"), "gozar-cfg").apply { mkdirs() }
        File(out, "iran-socks.json").writeText(SingboxConfig.forLocalSocks(1819, "app.gozarvpn.android", routing = iran))
        File(out, "custom-socks.json").writeText(SingboxConfig.forLocalSocks(1819, "app.gozarvpn.android", routing = SingboxConfig.Routing("custom", proxy = listOf("telegram.org"))))
    }
}
