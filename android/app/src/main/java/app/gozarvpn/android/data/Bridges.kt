package app.gozarvpn.android.data

/**
 * The user's own Tor bridge lines (from bridges.torproject.org, the Telegram bot, email…).
 * Accepts obfs4, webtunnel, snowflake, meek_lite and plain ("vanilla") lines, with or without
 * the "Bridge " prefix, IPv4 or bracketed IPv6. Each line gets a verdict the user can read.
 */
object Bridges {
    data class Verdict(val line: String, val ok: Boolean, val kind: String, val reason: String)

    val TRANSPORTS = setOf("obfs4", "webtunnel", "snowflake", "meek_lite")
    private val FP = Regex("^[0-9A-Fa-f]{40}$")
    private val V4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3}):(\\d{1,5})$")
    private val V6 = Regex("^\\[([0-9A-Fa-f:.]+)]:(\\d{1,5})$")

    /** Non-empty, non-comment lines of [text], one verdict each. */
    fun checkAll(text: String): List<Verdict> = text.lines().map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") && !it.startsWith("//") }.map { check(it) }

    fun check(raw: String): Verdict {
        val line = raw.removePrefix("Bridge ").removePrefix("bridge ").trim().replace(Regex("\\s+"), " ")
        val parts = line.split(' ')
        val kind = if (parts[0] in TRANSPORTS) parts[0] else "vanilla"
        val addr = if (kind == "vanilla") parts[0] else parts.getOrNull(1) ?: return Verdict(line, false, kind, "آدرس پل نیست")
        val addrOk = when {
            V4.matchEntire(addr)?.let { m -> m.groupValues.subList(1, 5).all { it.toInt() in 0..255 } && m.groupValues[5].toInt() in 1..65535 } == true -> true
            V6.matchEntire(addr)?.let { it.groupValues[2].toInt() in 1..65535 } == true -> true
            else -> false
        }
        if (!addrOk) return Verdict(line, false, kind, "آدرس «$addr» درست نیست (باید IP:پورت یا [IPv6]:پورت باشد)")
        val rest = parts.drop(if (kind == "vanilla") 1 else 2)
        val fp = rest.firstOrNull { FP.matches(it) }
        val opts = rest.filter { '=' in it }.associate { it.substringBefore('=') to it.substringAfter('=') }
        return when (kind) {
            "obfs4" -> when {
                fp == null -> Verdict(line, false, kind, "اثرانگشت ۴۰ رقمی پل نیست")
                opts["cert"].isNullOrEmpty() -> Verdict(line, false, kind, "بخش cert= نیست")
                opts["iat-mode"] !in setOf("0", "1", "2") -> Verdict(line, false, kind, "iat-mode باید 0، 1 یا 2 باشد")
                else -> Verdict(line, true, kind, "obfs4 · ${if (addr.startsWith("[")) "IPv6" else "IPv4"}")
            }
            "webtunnel" -> {
                val url = opts["url"]
                when {
                    url == null || !url.startsWith("https://") -> Verdict(line, false, kind, "بخش url=https://… نیست")
                    // the address of a webtunnel line is only a placeholder (often 2001:db8::); the url host is what is dialled
                    else -> Verdict(line, true, kind, "webtunnel · ${runCatching { java.net.URI(url).host }.getOrNull() ?: "?"}")
                }
            }
            "vanilla" -> if (fp == null) Verdict(line, false, kind, "اثرانگشت ۴۰ رقمی پل نیست") else Verdict(line, true, kind, "پل ساده")
            else -> Verdict(line, true, kind, kind)
        }
    }
}
