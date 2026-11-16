package app.gozarvpn.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgesTest {
    private val fp = "9AC244E0C4A58A54A3B3FE9912FF1D64C7FBD5AF"

    @Test fun acceptsTheOwnersLineShapes() {
        val v = Bridges.checkAll(
            """
            obfs4 [2a06:1700:0:178:0:6d:73:65]:56713 $fp cert=AAAA iat-mode=2
            Bridge obfs4 85.10.1.2:443 $fp cert=BBBB iat-mode=0
            # a comment

            webtunnel [2001:db8:1::2]:443 $fp url=https://example.org/abc ver=0.0.1
            1.2.3.4:9001 $fp
            """.trimIndent(),
        )
        assertEquals(4, v.size)
        assertTrue(v.all { it.ok })
        assertEquals(listOf("obfs4", "obfs4", "webtunnel", "vanilla"), v.map { it.kind })
        assertFalse(v[1].line.startsWith("Bridge"))
    }

    @Test fun explainsBadLines() {
        assertFalse(Bridges.check("obfs4 1.2.3:443 $fp cert=x iat-mode=0").ok)
        assertFalse(Bridges.check("obfs4 1.2.3.4:443 $fp iat-mode=0").ok)
        assertFalse(Bridges.check("webtunnel [2001:db8::1]:443 $fp ver=1").ok)
    }
}
