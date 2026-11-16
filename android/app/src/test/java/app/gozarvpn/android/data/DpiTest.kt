package app.gozarvpn.android.data

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class DpiTest {
    private val tlsEntry = ConfigEntry("1", "a", "vless", json = """{"type":"vless","server":"e.com","server_port":443,"tls":{"enabled":true,"server_name":"e.com"}}""")
    private val plainEntry = ConfigEntry("2", "b", "vless", json = """{"type":"vless","server":"e.com","server_port":80}""")

    @Test fun candidatesOrder() {
        assertEquals(listOf("both"), Dpi.candidates("both", "record", smart = true)) // manual wins
        assertEquals(listOf("none"), Dpi.candidates(null, "record", smart = false))
        assertEquals(listOf("record", "none", "fragment", "both"), Dpi.candidates(null, "record", smart = true))
    }

    @Test fun applySetsTlsFlags() {
        val tls = Json.parseToJsonElement(Dpi.apply(tlsEntry, "both").json).jsonObject["tls"]!!.jsonObject
        assertEquals(true, tls["fragment"]!!.jsonPrimitive.boolean)
        assertEquals(true, tls["record_fragment"]!!.jsonPrimitive.boolean)
        assertEquals("e.com", tls["server_name"]!!.jsonPrimitive.content)
        assertEquals(tlsEntry, Dpi.apply(tlsEntry, "none"))
        assertFalse(Dpi.applies(plainEntry))
        assertEquals(plainEntry, Dpi.apply(plainEntry, "fragment"))
    }
}
