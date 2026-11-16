package app.gozarvpn.android.core

import app.gozarvpn.android.data.ConfigEntry
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SingboxConfigTest {
    @Test
    fun socksEngineConfigUsesFakeIpRejectsQuicAndExcludesOwnApp() {
        val cfg = Json.parseToJsonElement(SingboxConfig.forLocalSocks(2059, "app.gozarvpn.android")).jsonObject
        val tun = cfg["inbounds"]!!.jsonArray[0].jsonObject
        assertEquals("app.gozarvpn.android", tun["exclude_package"]!!.jsonArray[0].jsonPrimitive.content)
        val rules = cfg["route"]!!.jsonObject["rules"]!!.jsonArray.map { it.jsonObject }
        assertTrue(rules.any { it["protocol"]?.jsonPrimitive?.content == "quic" && it["action"]?.jsonPrimitive?.content == "reject" })
        assertTrue(cfg["dns"]!!.jsonObject["servers"]!!.jsonArray.any { it.jsonObject["type"]?.jsonPrimitive?.content == "fakeip" })
    }

    @Test
    fun redactionMasksCredentials() {
        val red = SingboxConfig.redacted("""{"uuid":"abc","password":"p","server":"s"}""")
        assertEquals("""{"uuid":"***","password":"***","server":"s"}""", red)
    }

    /** Writes the generated configs for `sing-box check` when GOZAR_CFG_OUT is set. */
    @Test
    fun dumpForSingboxCheck() {
        val out = File(System.getenv("GOZAR_CFG_OUT") ?: return).apply { mkdirs() }
        File(out, "socks.json").writeText(SingboxConfig.forLocalSocks(2059, "app.gozarvpn.android"))
        val vless = ConfigEntry("1", "x", "vless", json = """{"type":"vless","tag":"proxy","server":"example.com","server_port":443,"uuid":"11111111-2222-3333-4444-555555555555"}""")
        File(out, "v2ray.json").writeText(SingboxConfig.forEntry(vless))
    }
}
