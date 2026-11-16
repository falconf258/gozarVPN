package app.gozarvpn.android.data

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LinkParserTest {
    private fun tlsOf(link: String) =
        Json.parseToJsonElement(LinkParser.parseLink(link).json).jsonObject["tls"]!!.jsonObject

    @Test
    fun unsafeFingerprintBecomesPlainTlsWithGoCipherSuites() {
        val tls = tlsOf(
            "vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=tls&type=ws" +
                "&host=example.com&path=%2F&sni=example.com&alpn=http%2F1.1&fp=unsafe" +
                "&cs=TLS_AES_256_GCM_SHA384%3ATLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256%3ATLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256" +
                "&fm=%7B%22tcp%22%3A%5B%7B%22type%22%3A%22fragment%22%7D%5D%7D#x"
        )
        assertFalse("utls must be dropped for fp=unsafe", "utls" in tls)
        assertEquals(listOf("TLS_AES_256_GCM_SHA384", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"),
            tls["cipher_suites"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertTrue(tls["fragment"]!!.jsonPrimitive.boolean)
        assertTrue(tls["record_fragment"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun knownFingerprintKeepsUtlsAndIgnoresCs() {
        val tls = tlsOf("trojan://pw@example.com:443?security=tls&type=ws&sni=example.com&fp=chrome&cs=TLS_AES_128_GCM_SHA256&fragment=tlshello,5,94,1,0#y")
        assertEquals("chrome", tls["utls"]!!.jsonObject["fingerprint"]!!.jsonPrimitive.content)
        assertFalse("cipher_suites" in tls)
        assertTrue(tls["fragment"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun localhostSniSpoofingLinksAreRejected() {
        assertTrue(runCatching { LinkParser.parseLink("vless://id@127.0.0.1:40443?security=tls#Sni-Spoofing") }.isFailure)
    }

    /** Parses a real subscription file (if present) and writes one sing-box config per link for `sing-box check`. */
    @Test
    fun dumpSubscriptionForSingboxCheck() {
        val src = File(System.getenv("GOZAR_SUB_FILE") ?: return)
        val out = File(System.getenv("GOZAR_SUB_OUT") ?: return).apply { deleteRecursively(); mkdirs() }
        val (ok, failed) = LinkParser.parseSubscription(src.readText())
        ok.forEachIndexed { i, p ->
            val cfg = buildJsonObject {
                put("log", buildJsonObject { put("level", "error") })
                put(if (p.kind == "endpoint") "endpoints" else "outbounds", buildJsonArray { add(Json.parseToJsonElement(p.json)) })
            }
            File(out, "%03d-%s.json".format(i, p.protocol)).writeText(cfg.toString())
        }
        File(out, "summary.txt").writeText("parsed=${ok.size} failed=$failed\n" + LogBuffer.lines.value.distinctBy { it.substring(10) }.joinToString("\n") + "\n")
    }
}
