package app.gozarvpn.android.data

import kotlinx.serialization.json.*

/**
 * Smart anti-DPI for V2ray/Xray: ClientHello splitting variants (sing-box tls.fragment /
 * tls.record_fragment) tried with a real request until one passes. "none" = the link as-is.
 */
object Dpi {
    val PROFILES = listOf("none", "record", "fragment", "both")

    fun label(p: String) = when (p) {
        "none" -> "بدون تغییر"; "record" -> "تکه‌کردن رکورد"; "fragment" -> "تکه‌کردن بسته"; "both" -> "هر دو"; else -> "خودکار"
    }

    /** Only TLS (incl. REALITY) outbounds have a ClientHello to split. */
    fun applies(e: ConfigEntry): Boolean = e.kind == "outbound" && runCatching {
        Json.parseToJsonElement(e.json).jsonObject["tls"]?.jsonObject?.get("enabled")?.jsonPrimitive?.booleanOrNull == true
    }.getOrDefault(false)

    fun apply(e: ConfigEntry, p: String): ConfigEntry {
        if (p == "none" || !applies(e)) return e
        val o = Json.parseToJsonElement(e.json).jsonObject
        val tls = o["tls"]!!.jsonObject.toMutableMap()
        tls["fragment"] = JsonPrimitive(p == "fragment" || p == "both")
        tls["record_fragment"] = JsonPrimitive(p == "record" || p == "both")
        return e.copy(json = JsonObject(o + ("tls" to JsonObject(tls))).toString())
    }

    /** Order to try: a manual pick alone (it always wins); else the last one that worked first. */
    fun candidates(manual: String?, learned: String?, smart: Boolean): List<String> = when {
        manual != null -> listOf(manual)
        !smart -> listOf("none")
        else -> (listOfNotNull(learned) + PROFILES).distinct()
    }
}
