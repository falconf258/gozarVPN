package app.gozarvpn.android.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class StatePersistTest {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }

    @Test
    fun settingsAndSelectionSurviveSaveAndLoad() {
        val s = AppState(
            settings = Settings(
                engine = "mihomo",
                clashProfiles = listOf(ClashProfile("p1", "file", null), ClashProfile("p2", "sub", "https://x/y")),
                clashActive = "p2", clashSelected = "🇩🇪 DE", torMode = "auto",
            ),
            configs = listOf(ConfigEntry("c1", "a", "vless", json = "{}"), ConfigEntry("c2", "b", "vless", json = "{}")),
            activeId = "c2",
            results = mapOf("c1" to TestResult(true, 120)),
        )
        val back = json.decodeFromString(AppState.serializer(), json.encodeToString(AppState.serializer(), s))
        assertEquals(s, back)
    }
}
