package app.gozarvpn.android.core

import app.gozarvpn.android.data.ConfigEntry
import kotlinx.serialization.json.*

/** Builds the sing-box config the Android VPN runs: one TUN inbound -> the chosen proxy. */
object SingboxConfig {
    const val LOG_FILE = "box.log"

    /**
     * Traffic routing. [mode]: "all" (everything through the VPN), "iran" (Iranian domains and IPs
     * direct, the rest through the VPN) or "custom" (only [proxy] through the VPN, the rest direct).
     * [direct]/[proxy] are the user's own entries: domains (suffix match) or IPs / CIDRs.
     * [rulesDir] holds geosite-ir.srs / geoip-ir.srs (see IranRules).
     */
    data class Routing(val mode: String = "all", val direct: List<String> = emptyList(), val proxy: List<String> = emptyList(), val rulesDir: String = "")

    private val IP_LIKE = Regex("^[0-9a-fA-F:.]+(/\\d+)?$")
    private fun cidr(e: String) = if ('/' in e) e else if (':' in e) "$e/128" else "$e/32"

    /** One sing-box rule matching the user's entries (null when there are none). */
    private fun listRule(entries: List<String>, outbound: String): JsonObject? {
        val clean = entries.map { it.trim().lowercase().trimStart('.') }.filter { it.isNotEmpty() }
        val ips = clean.filter { IP_LIKE.matches(it) && ('.' in it || ':' in it) && it.any(Char::isDigit) && !it.any { c -> c in 'g'..'z' } }
        val domains = clean - ips.toSet()
        if (ips.isEmpty() && domains.isEmpty()) return null
        return buildJsonObject {
            if (domains.isNotEmpty()) put("domain_suffix", buildJsonArray { domains.forEach { add(it) } })
            if (ips.isNotEmpty()) put("ip_cidr", buildJsonArray { ips.forEach { add(cidr(it)) } })
            put("outbound", outbound)
        }
    }

    /** Which apps the TUN takes: [include] only those, or everything but [exclude] (never both). */
    data class Split(val include: List<String> = emptyList(), val exclude: List<String> = emptyList())

    /**
     * Per-app split tunnelling. Engine modes must keep our own app out (its engine child
     * processes dial the real network); in plain V2ray mode it stays in, because the health
     * check and anti-DPI probe measure the tunnel with our app's own requests.
     */
    fun split(mode: String, packages: List<String>, ownPackage: String, engineMode: Boolean): Split {
        val picked = packages.filter { it != ownPackage }.distinct()
        return when {
            mode == "only" && picked.isNotEmpty() -> Split(include = picked + if (engineMode) emptyList() else listOf(ownPackage))
            mode == "except" -> Split(exclude = picked + if (engineMode) listOf(ownPackage) else emptyList())
            else -> Split(exclude = if (engineMode) listOf(ownPackage) else emptyList())
        }
    }

    fun forEntry(entry: ConfigEntry, blockIpv6: Boolean = true, split: Split = Split(), routing: Routing = Routing()): String =
        build(Json.parseToJsonElement(entry.json).jsonObject, isEndpoint = entry.kind == "endpoint", split = split, socksEngine = false, blockIpv6 = blockIpv6, routing = routing)

    /**
     * TUN -> a child core's local SOCKS port (Aether / Tor / mihomo). [ownPackage] is
     * kept out of the TUN so the child's own connections go straight to the network.
     */
    fun forLocalSocks(port: Int, ownPackage: String, blockIpv6: Boolean = true, split: Split = Split(exclude = listOf(ownPackage)), routing: Routing = Routing()): String = build(
        buildJsonObject { put("type", "socks"); put("server", "127.0.0.1"); put("server_port", port); put("version", "5") },
        isEndpoint = false, split = split, socksEngine = true, blockIpv6 = blockIpv6, routing = routing,
    )

    private fun build(proxy: JsonObject, isEndpoint: Boolean, split: Split, socksEngine: Boolean, blockIpv6: Boolean, routing: Routing): String {
        val iran = routing.mode == "iran" && routing.rulesDir.isNotEmpty()
        val custom = routing.mode == "custom"
        val proxyRule = listRule(routing.proxy, "proxy")
        val directRule = listRule(routing.direct, "direct")
        // names that leave directly must resolve directly too (real IPs, never a fake one)
        val directDomains = buildJsonArray {
            if (iran) add("ir")
            routing.direct.map { it.trim().lowercase().trimStart('.') }.filter { it.isNotEmpty() && !IP_LIKE.matches(it) }.forEach { add(it) }
        }
        val cfg = buildJsonObject {
            // info still logs every inbound/outbound connection; debug only added noise
            put("log", buildJsonObject { put("level", "info"); put("timestamp", true); put("output", LOG_FILE) })
            // apps cache fake IPs across restarts; without a stored mapping sing-box logs
            // "missing fakeip record" and those connections fail (seen in the Clash log)
            put("experimental", buildJsonObject {
                if (socksEngine) put("cache_file", buildJsonObject { put("enabled", true); put("path", "cache.db"); put("store_fakeip", true) })
                // loopback-only stats endpoint (with a per-run secret) for the data-usage history
                put("clash_api", buildJsonObject { put("external_controller", "127.0.0.1:${TrafficApi.PORT}"); put("secret", TrafficApi.secret) })
            })
            put("dns", buildJsonObject {
                put("servers", buildJsonArray {
                    add(buildJsonObject { put("type", "https"); put("tag", "remote"); put("server", "1.1.1.1"); put("detour", "proxy") })
                    add(buildJsonObject { put("type", "udp"); put("tag", "bootstrap"); put("server", "1.1.1.1") })
                    // the phone's own resolver: Iranian sites get their in-country addresses
                    if (iran || custom || directDomains.isNotEmpty()) add(buildJsonObject { put("type", "local"); put("tag", "local") })
                    // engines resolve names themselves (Tor must); apps get a fake IP and we
                    // forward the original domain to the engine instead of DNS-over-the-engine
                    if (socksEngine) add(buildJsonObject { put("type", "fakeip"); put("tag", "fakeip"); put("inet4_range", "198.18.0.0/15") })
                })
                put("rules", buildJsonArray {
                    // the user's VPN list keeps the normal (tunnelled) resolution
                    proxyRule?.get("domain_suffix")?.let { d -> add(buildJsonObject { put("domain_suffix", d); put("server", if (socksEngine) "fakeip" else "remote") }) }
                    if (directDomains.isNotEmpty()) add(buildJsonObject { put("domain_suffix", directDomains); put("server", "local") })
                    if (iran) add(buildJsonObject { put("rule_set", buildJsonArray { add("geosite-ir") }); put("server", "local") })
                    // custom mode: only the VPN list is tunnelled, so everything else resolves locally (final)
                    if (socksEngine && !custom) add(buildJsonObject { put("query_type", buildJsonArray { add("A"); add("AAAA") }); put("server", "fakeip") })
                })
                put("final", if (custom) "local" else "remote")
                put("strategy", "ipv4_only")
            })
            put("inbounds", buildJsonArray {
                add(buildJsonObject {
                    put("type", "tun"); put("tag", "tun-in")
                    // an IPv6 address pulls IPv6 into the tunnel (where it is dropped) instead of leaking past it
                    put("address", buildJsonArray { add("172.19.0.1/30"); if (blockIpv6) add("fdfe:dcba:9876::1/126") })
                    // Engine modes exclude our own app from the VPN. The "system"/"mixed" stack
                    // terminates app TCP on a kernel socket inside our app, whose replies then
                    // bypass the TUN and the handshake never completes (0.5.0 logs: SYN retries,
                    // no inbound TCP at all). gVisor keeps TCP in userspace, so only the
                    // loopback hop to the engine is a real socket.
                    put("mtu", 9000); put("auto_route", true); put("stack", if (socksEngine) "gvisor" else "mixed")
                    if (split.include.isNotEmpty()) put("include_package", buildJsonArray { split.include.forEach { add(it) } })
                    else if (split.exclude.isNotEmpty()) put("exclude_package", buildJsonArray { split.exclude.forEach { add(it) } })
                })
            })
            put("outbounds", buildJsonArray {
                if (!isEndpoint) add(JsonObject(proxy + ("tag" to JsonPrimitive("proxy"))))
                add(buildJsonObject { put("type", "direct"); put("tag", "direct") })
            })
            if (isEndpoint) put("endpoints", buildJsonArray { add(JsonObject(proxy + ("tag" to JsonPrimitive("proxy")))) })
            put("route", buildJsonObject {
                put("auto_detect_interface", true)
                put("default_domain_resolver", "bootstrap")
                if (iran) put("rule_set", buildJsonArray {
                    for (tag in listOf("geosite-ir", "geoip-ir")) add(buildJsonObject {
                        put("type", "local"); put("tag", tag); put("format", "binary"); put("path", "${routing.rulesDir}/$tag.srs")
                    })
                })
                put("rules", buildJsonArray {
                    add(buildJsonObject { put("action", "sniff") })
                    add(buildJsonObject { put("protocol", "dns"); put("action", "hijack-dns") })
                    // routing choices come before the UDP/IPv6 limits: direct traffic can carry both.
                    // Order: the user's VPN list, the user's direct list, then the Iran rules.
                    proxyRule?.let { add(it) }
                    directRule?.let { add(it) }
                    if (iran) {
                        add(buildJsonObject { put("domain_suffix", buildJsonArray { add("ir") }); put("outbound", "direct") })
                        add(buildJsonObject { put("rule_set", buildJsonArray { add("geosite-ir"); add("geoip-ir") }); put("outbound", "direct") })
                    }
                    if (socksEngine) {
                        // Tor (and some engines) can't carry UDP: refuse QUIC at once so apps
                        // like YouTube fall back to TCP instead of waiting on a dead UDP path
                        add(buildJsonObject { put("protocol", "quic"); put("action", "reject") })
                        add(buildJsonObject { put("network", "udp"); put("port", 443); put("action", "reject") })
                    }
                    if (blockIpv6) add(buildJsonObject { put("ip_version", 6); put("action", "reject") })
                    add(buildJsonObject { put("ip_is_private", true); put("outbound", "direct") })
                })
                put("final", if (custom) "direct" else "proxy")
            })
        }
        return cfg.toString()
    }

    /** The config with credentials masked, for the log. */
    fun redacted(config: String): String =
        config.replace(Regex(""""(uuid|password|private_key|pre_shared_key|public_key|short_id)":"[^"]*""""), "\"$1\":\"***\"")
}
