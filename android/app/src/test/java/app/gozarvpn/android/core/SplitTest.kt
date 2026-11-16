package app.gozarvpn.android.core

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SplitTest {
    private val own = "app.gozarvpn.android"

    @Test fun engineModeKeepsOwnAppOut() {
        assertEquals(SingboxConfig.Split(include = listOf("a")), SingboxConfig.split("only", listOf("a", own), own, engineMode = true))
        assertEquals(SingboxConfig.Split(exclude = listOf("b", own)), SingboxConfig.split("except", listOf("b"), own, engineMode = true))
        assertEquals(SingboxConfig.Split(exclude = listOf(own)), SingboxConfig.split("all", listOf("b"), own, engineMode = true))
        // "only" with nothing picked = everything (never an empty include list)
        assertEquals(SingboxConfig.Split(exclude = listOf(own)), SingboxConfig.split("only", emptyList(), own, engineMode = true))
    }

    @Test fun v2rayModeKeepsOwnAppIn() {
        assertEquals(SingboxConfig.Split(include = listOf("a", own)), SingboxConfig.split("only", listOf("a"), own, engineMode = false))
        assertEquals(SingboxConfig.Split(exclude = listOf("b")), SingboxConfig.split("except", listOf("b", own), own, engineMode = false))
    }

    @Test fun tunGetsOnlyOneList() {
        val tun = Json.parseToJsonElement(SingboxConfig.forLocalSocks(1819, own, split = SingboxConfig.Split(include = listOf("a")))).jsonObject["inbounds"]!!.jsonArray[0].jsonObject
        assertEquals(listOf("a"), tun["include_package"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertNull(tun["exclude_package"])
    }
}
