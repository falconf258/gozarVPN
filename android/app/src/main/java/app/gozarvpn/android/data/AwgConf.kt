package app.gozarvpn.android.data

/**
 * WireGuard / AmneziaWG `.conf` text. AmneziaWG adds junk-packet and header options (Jc, Jmin,
 * Jmax, S1-S4, H1-H4, I1-I5) that stock sing-box cannot do, so such configs run in the
 * AmneziaWG engine (wireproxy-awg, a userspace client serving a local SOCKS port).
 * The PrivateKey stays inside the conf text and is never logged.
 */
object AwgConf {
    val AWG_KEYS = setOf("Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4", "I1", "I2", "I3", "I4", "I5")

    private fun sections(conf: String): List<Pair<String, List<String>>> {
        val out = mutableListOf<Pair<String, MutableList<String>>>()
        for (raw in conf.lines()) {
            val line = raw.trim()
            val head = Regex("^\\[(\\w+)]$").matchEntire(line)
            if (head != null) out += head.groupValues[1] to mutableListOf()
            else if (out.isNotEmpty() && line.isNotEmpty() && !line.startsWith("#") && !line.startsWith(";")) out.last().second += line
        }
        return out
    }

    private fun keys(lines: List<String>) = lines.mapNotNull { l -> l.indexOf('=').takeIf { it > 0 }?.let { l.substring(0, it).trim() to l.substring(it + 1).trim() } }

    fun looksLikeConf(text: String) = Regex("^\\s*\\[Interface]", setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE)).containsMatchIn(text) &&
        Regex("^\\s*\\[Peer]", setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE)).containsMatchIn(text)

    fun isAmnezia(conf: String): Boolean =
        sections(conf).filter { it.first.equals("Interface", true) }.flatMap { keys(it.second) }.any { it.first in AWG_KEYS }

    /** Peer endpoint "host:port", or null. */
    fun endpoint(conf: String): String? =
        sections(conf).firstOrNull { it.first.equals("Peer", true) }?.let { keys(it.second).firstOrNull { k -> k.first.equals("Endpoint", true) }?.second }

    /** Checks what the engine needs; null = fine, else a message for the user. */
    fun problem(conf: String): String? {
        val s = sections(conf)
        val iface = s.firstOrNull { it.first.equals("Interface", true) }?.let { keys(it.second).toMap() } ?: return "بخش [Interface] نیست"
        val peer = s.firstOrNull { it.first.equals("Peer", true) }?.let { keys(it.second).toMap() } ?: return "بخش [Peer] نیست"
        if (iface["PrivateKey"].isNullOrBlank()) return "PrivateKey در [Interface] نیست"
        if (iface["Address"].isNullOrBlank()) return "Address در [Interface] نیست"
        if (peer["PublicKey"].isNullOrBlank()) return "PublicKey در [Peer] نیست"
        if (peer["Endpoint"].isNullOrBlank()) return "Endpoint در [Peer] نیست"
        return null
    }

    /**
     * The conf for the engine: only [Interface] and [Peer] kept (any proxy sections the user's file
     * had are dropped), the Endpoint host replaced by [resolve] (Go finds no DNS server on Android),
     * and our own [Socks5] section added.
     */
    fun forProxy(conf: String, socksPort: Int, resolve: (String) -> String = { it }): String = buildString {
        for ((name, lines) in sections(conf)) {
            if (!name.equals("Interface", true) && !name.equals("Peer", true)) continue
            append('[').append(name).append("]\n")
            for (l in lines) {
                val k = l.substringBefore('=').trim()
                if (name.equals("Peer", true) && k.equals("Endpoint", true)) {
                    val ep = l.substringAfter('=').trim()
                    val host = ep.substringBeforeLast(':').removePrefix("[").removeSuffix("]")
                    val port = ep.substringAfterLast(':')
                    val ip = resolve(host)
                    append("Endpoint = ").append(if (':' in ip) "[$ip]" else ip).append(':').append(port).append('\n')
                } else append(l).append('\n')
            }
            append('\n')
        }
        append("[Socks5]\nBindAddress = 127.0.0.1:").append(socksPort).append('\n')
    }
}
