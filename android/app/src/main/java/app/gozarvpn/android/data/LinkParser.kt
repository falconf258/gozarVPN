package app.gozarvpn.android.data

import android.util.Base64
import kotlinx.serialization.json.*
import java.net.URLDecoder

/**
 * Port of the desktop vpnLinkParser.js: share links (vless, vmess, trojan,
 * ss, wireguard) -> sing-box outbound / endpoint JSON.
 */
object LinkParser {
    data class Parsed(val remark: String, val protocol: String, val kind: String, val json: String)

    private fun dec(s: String): String = try { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { s }

    private fun b64(s: String): String {
        var t = s.trim().replace('-', '+').replace('_', '/')
        while (t.length % 4 != 0) t += "="
        return String(Base64.decode(t, Base64.DEFAULT), Charsets.UTF_8)
    }

    /** Tolerant share-link splitter (java.net.URI rejects many real-world links). */
    class Link(val userInfo: String?, val host: String, val port: Int, val rawQuery: String?, val rawFragment: String?) {
        companion object {
            fun parse(link: String): Link {
                var rest = link.substringAfter("://")
                val hash = rest.indexOf('#')
                val frag = if (hash >= 0) rest.substring(hash + 1) else null
                if (hash >= 0) rest = rest.substring(0, hash)
                val q = rest.indexOf('?')
                val query = if (q >= 0) rest.substring(q + 1) else null
                if (q >= 0) rest = rest.substring(0, q)
                rest = rest.trimEnd('/')
                val at = rest.lastIndexOf('@')
                val userInfo = if (at >= 0) rest.substring(0, at) else null
                val hp = rest.substring(at + 1)
                val host: String
                var port = -1
                if (hp.startsWith("[")) {
                    val end = hp.indexOf(']')
                    require(end > 0) { "bad host" }
                    host = hp.substring(1, end)
                    hp.substring(end + 1).removePrefix(":").toIntOrNull()?.let { port = it }
                } else {
                    val c = hp.lastIndexOf(':')
                    if (c >= 0) { host = hp.substring(0, c); port = hp.substring(c + 1).toIntOrNull() ?: -1 } else host = hp
                }
                require(host.isNotEmpty()) { "no host" }
                return Link(userInfo, host, port, query, frag)
            }
        }
    }

    private fun query(u: Link): Map<String, String> =
        (u.rawQuery ?: "").split("&").filter { it.isNotEmpty() }.associate {
            val i = it.indexOf('=')
            if (i < 0) dec(it) to "" else dec(it.substring(0, i)) to dec(it.substring(i + 1))
        }

    private fun transport(p: Map<String, String>): JsonObject? {
        val net = p["type"] ?: p["net"] ?: "tcp"
        val host = p["host"]
        return when (net) {
            "ws" -> buildJsonObject {
                put("type", "ws"); put("path", dec(p["path"] ?: "/"))
                if (!host.isNullOrEmpty()) put("headers", buildJsonObject { put("Host", host) })
            }
            "grpc" -> buildJsonObject { put("type", "grpc"); put("service_name", p["serviceName"] ?: p["path"] ?: "") }
            "httpupgrade" -> buildJsonObject {
                put("type", "httpupgrade"); put("path", dec(p["path"] ?: "/"))
                if (!host.isNullOrEmpty()) put("host", host)
            }
            "h2", "http" -> buildJsonObject {
                put("type", "http"); put("path", dec(p["path"] ?: "/"))
                if (!host.isNullOrEmpty()) put("host", buildJsonArray { add(host) })
            }
            else -> null
        }
    }

    // sing-box's uTLS names; Xray forks add others (e.g. "unsafe" = plain Go TLS
    // with the custom cipher list in `cs`), which sing-box rejects outright.
    private val UTLS_FINGERPRINTS = setOf("chrome", "firefox", "edge", "safari", "360", "qq", "ios", "android", "random", "randomized")

    private fun utls(fp: String?): JsonObject? =
        fp?.lowercase()?.takeIf { it in UTLS_FINGERPRINTS }?.let { buildJsonObject { put("enabled", true); put("fingerprint", it) } }

    // Go's tls.CipherSuites(); sing-box refuses the whole config on any other name
    // (e.g. the *_CBC_SHA256 suites these links also list), checked with sing-box 1.14.4.
    private val GO_CIPHER_SUITES = setOf(
        "TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256",
        "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA", "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA",
        "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA", "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
        "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
        "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
        "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256", "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
    )

    private fun cipherSuites(cs: String?): JsonArray? =
        cs?.split(':', ',')?.map { it.trim() }?.filter { it in GO_CIPHER_SUITES }?.takeIf { it.isNotEmpty() }
            ?.let { list -> buildJsonArray { list.forEach { add(it) } } }

    private fun tls(p: Map<String, String>, defaultSni: String?): JsonObject? {
        val security = p["security"] ?: "none"
        if (security == "none" || security.isEmpty()) return null
        return buildJsonObject {
            put("enabled", true)
            (p["sni"] ?: defaultSni)?.let { put("server_name", it) }
            put("insecure", p["allowInsecure"] in setOf("1", "true") || p["insecure"] in setOf("1", "true"))
            val fp = utls(p["fp"])
            fp?.let { put("utls", it) }
            // cipher_suites only takes effect without uTLS (uTLS dictates its own list)
            if (fp == null) cipherSuites(p["cs"])?.let { put("cipher_suites", it) }
            // Xray's fm=/fragment= split the ClientHello to slip past DPI; sing-box's equivalent
            if (p["fm"]?.contains("fragment") == true || !p["fragment"].isNullOrEmpty()) {
                put("fragment", true); put("record_fragment", true)
            }
            if (security == "reality") {
                put("reality", buildJsonObject {
                    put("enabled", true); put("public_key", p["pbk"] ?: ""); put("short_id", p["sid"] ?: "")
                })
            }
            p["alpn"]?.takeIf { it.isNotEmpty() }?.let { a -> put("alpn", buildJsonArray { a.split(",").forEach { add(dec(it)) } }) }
        }
    }

    private fun obj(remark: String, protocol: String, o: JsonObject, kind: String = "outbound") =
        Parsed(remark, protocol, kind, o.toString())

    private fun parseVless(link: String): Parsed {
        val u = Link.parse(link); val p = query(u)
        val server = u.host; val port = if (u.port > 0) u.port else 443
        val o = buildJsonObject {
            put("type", "vless"); put("tag", "proxy"); put("server", server); put("server_port", port)
            put("uuid", dec(u.userInfo ?: ""))
            p["flow"]?.takeIf { it.isNotEmpty() }?.let { put("flow", it) }
            p["packetEncoding"]?.takeIf { it == "xudp" || it == "packetaddr" }?.let { put("packet_encoding", it) }
            tls(p, server)?.let { put("tls", it) }
            transport(p)?.let { put("transport", it) }
        }
        return obj(dec(u.rawFragment ?: "").ifEmpty { "$server:$port" }, "vless", o)
    }

    private fun parseTrojan(link: String): Parsed {
        val u = Link.parse(link); val p = query(u)
        val server = u.host; val port = if (u.port > 0) u.port else 443
        val o = buildJsonObject {
            put("type", "trojan"); put("tag", "proxy"); put("server", server); put("server_port", port)
            put("password", dec(u.userInfo ?: ""))
            if (p["security"] != "none") {
                put("tls", tls(p, server) ?: buildJsonObject { put("enabled", true); put("server_name", p["sni"] ?: server) })
            }
            transport(p)?.let { put("transport", it) }
        }
        return obj(dec(u.rawFragment ?: "").ifEmpty { "$server:$port" }, "trojan", o)
    }

    private fun parseVmess(link: String): Parsed {
        val j = Json.parseToJsonElement(b64(link.removePrefix("vmess://"))).jsonObject
        fun s(k: String) = j[k]?.jsonPrimitive?.contentOrNull
        val server = s("add") ?: error("vmess: no server"); val port = s("port")?.toIntOrNull() ?: 443
        val net = s("net") ?: "tcp"; val host = s("host"); val path = s("path")
        val o = buildJsonObject {
            put("type", "vmess"); put("tag", "proxy"); put("server", server); put("server_port", port)
            put("uuid", s("id") ?: ""); put("security", s("scy") ?: "auto"); put("alter_id", s("aid")?.toIntOrNull() ?: 0)
            when (net) {
                "ws" -> put("transport", buildJsonObject {
                    put("type", "ws"); put("path", path ?: "/")
                    if (!host.isNullOrEmpty()) put("headers", buildJsonObject { put("Host", host) })
                })
                "grpc" -> put("transport", buildJsonObject { put("type", "grpc"); put("service_name", path ?: "") })
                "h2" -> put("transport", buildJsonObject {
                    put("type", "http"); put("path", path ?: "/")
                    if (!host.isNullOrEmpty()) put("host", buildJsonArray { add(host) })
                })
            }
            if (s("tls") == "tls") put("tls", buildJsonObject {
                put("enabled", true); put("server_name", s("sni") ?: host ?: server); put("insecure", false)
            })
        }
        return obj(s("ps") ?: "$server:$port", "vmess", o)
    }

    private fun parseShadowsocks(link: String): Parsed {
        var rest = link.removePrefix("ss://")
        val h = rest.indexOf('#')
        val remark = if (h >= 0) dec(rest.substring(h + 1)) else ""
        if (h >= 0) rest = rest.substring(0, h)
        val method: String; val password: String; val server: String; val port: Int
        val at = rest.indexOf('@')
        if (at >= 0) {
            val userinfo = rest.substring(0, at)
            val hostPart = rest.substring(at + 1).split('?', '/')[0]
            val decoded = if (userinfo.contains(':')) dec(userinfo) else runCatching { b64(userinfo) }.getOrDefault(userinfo)
            method = decoded.substringBefore(':'); password = decoded.substringAfter(':')
            server = hostPart.substringBeforeLast(':'); port = hostPart.substringAfterLast(':').toInt()
        } else {
            val m = Regex("^(.+?):(.+)@(.+):(\\d+)$").matchEntire(b64(rest.split('?', '/')[0])) ?: error("bad ss link")
            method = m.groupValues[1]; password = m.groupValues[2]; server = m.groupValues[3]; port = m.groupValues[4].toInt()
        }
        val o = buildJsonObject {
            put("type", "shadowsocks"); put("tag", "proxy"); put("server", server); put("server_port", port)
            put("method", method); put("password", password)
        }
        return obj(remark.ifEmpty { "$server:$port" }, "shadowsocks", o)
    }

    /** wireguard://PRIVATEKEY@host:port?publickey=..&address=..&reserved=1,2,3&mtu=1280#name */
    private fun parseWireGuard(link: String): Parsed {
        val clean = link.replace("&amp;", "&").replace("&#34;", "").replace("&quot;", "").trim()
        val u = Link.parse(clean); val p = query(u)
        val priv = dec(u.userInfo ?: "").replace(' ', '+')
        val pub = (p["publickey"] ?: p["public_key"] ?: "").replace(' ', '+')
        require(priv.isNotEmpty() && pub.isNotEmpty()) { "wireguard: key missing" }
        val port = if (u.port > 0) u.port else 51820
        val addrs = (p["address"] ?: p["ip"] ?: "172.16.0.2/32").split(",").map { it.trim() }.filter { it.isNotEmpty() }
            .map { if (it.contains('/')) it else if (it.contains(':')) "$it/128" else "$it/32" }
        val reserved = (p["reserved"] ?: "").split(",").mapNotNull { it.trim().toIntOrNull() }
        val o = buildJsonObject {
            put("type", "wireguard"); put("tag", "proxy"); put("system", false); put("mtu", p["mtu"]?.toIntOrNull() ?: 1280)
            put("address", buildJsonArray { addrs.forEach { add(it) } })
            put("private_key", priv)
            put("peers", buildJsonArray {
                add(buildJsonObject {
                    put("address", u.host); put("port", port); put("public_key", pub)
                    put("allowed_ips", buildJsonArray { add("0.0.0.0/0"); add("::/0") })
                    p["presharedkey"]?.takeIf { it.isNotEmpty() }?.let { put("pre_shared_key", it.replace(' ', '+')) }
                    p["keepalive"]?.toIntOrNull()?.let { put("persistent_keepalive_interval", it) }
                    if (reserved.size == 3) put("reserved", buildJsonArray { reserved.forEach { add(it) } })
                })
            })
        }
        return obj(dec(u.rawFragment ?: "").ifEmpty { "${u.host}:$port" }, "wireguard", o, kind = "endpoint")
    }

    fun parseLink(raw: String): Parsed {
        val l = raw.trim()
        // "Sni-Spoofing" links point at a helper app on the phone itself, which we don't ship
        if (Regex("^\\w+://[^@]*@(127\\.0\\.0\\.1|localhost|\\[::1\\]):").containsMatchIn(l)) error("این کانفیگ به یک برنامه‌ی کمکی محلی (127.0.0.1) نیاز دارد و پشتیبانی نمی‌شود")
        return when {
            l.startsWith("vless://") -> parseVless(l)
            l.startsWith("trojan://") -> parseTrojan(l)
            l.startsWith("vmess://") -> parseVmess(l)
            l.startsWith("ss://") -> parseShadowsocks(l)
            l.startsWith("wireguard://") || l.startsWith("wg://") -> parseWireGuard(l)
            else -> error("لینک پشتیبانی‌نشده")
        }
    }

    /* ---- Xray-core JSON array subscriptions (BPB "app=xray", v2rayN format) ---- */

    private fun JsonObject.str(k: String): String? = this[k]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.int(k: String): Int? = this[k]?.jsonPrimitive?.intOrNull
    private fun JsonObject.obj(k: String): JsonObject? = this[k] as? JsonObject
    private fun JsonObject.arr(k: String): JsonArray? = this[k] as? JsonArray

    private fun xrayStream(ss: JsonObject?, o: MutableMap<String, JsonElement>) {
        if (ss == null) return
        when (val net = ss.str("network")) {
            "ws" -> ss.obj("wsSettings")?.let { ws ->
                val host = ws.str("host") ?: ws.obj("headers")?.str("Host")
                o["transport"] = buildJsonObject {
                    put("type", "ws"); put("path", ws.str("path") ?: "/")
                    if (!host.isNullOrEmpty()) put("headers", buildJsonObject { put("Host", host) })
                }
            }
            "grpc" -> o["transport"] = buildJsonObject {
                put("type", "grpc"); put("service_name", ss.obj("grpcSettings")?.str("serviceName") ?: "")
            }
            "h2", "http" -> ss.obj("httpSettings")?.let { h ->
                o["transport"] = buildJsonObject {
                    put("type", "http"); put("path", h.str("path") ?: h.arr("path")?.firstOrNull()?.jsonPrimitive?.contentOrNull ?: "/")
                    h.arr("host")?.let { put("host", it) }
                }
            }
            "httpupgrade" -> ss.obj("httpupgradeSettings")?.let { h ->
                o["transport"] = buildJsonObject {
                    put("type", "httpupgrade"); put("path", h.str("path") ?: "/")
                    h.str("host")?.takeIf { it.isNotEmpty() }?.let { put("host", it) }
                }
            }
            "tcp", null -> {}
            else -> error("انتقال $net در sing-box پشتیبانی نمی‌شود")
        }
        when (ss.str("security")) {
            "tls" -> {
                val t = ss.obj("tlsSettings")
                o["tls"] = buildJsonObject {
                    put("enabled", true)
                    t?.str("serverName")?.takeIf { it.isNotEmpty() }?.let { put("server_name", it) }
                    put("insecure", t?.get("allowInsecure")?.jsonPrimitive?.booleanOrNull == true)
                    val fp = utls(t?.str("fingerprint"))
                    fp?.let { put("utls", it) }
                    if (fp == null) cipherSuites(t?.str("cipherSuites"))?.let { put("cipher_suites", it) }
                    t?.arr("alpn")?.takeIf { it.isNotEmpty() }?.let { put("alpn", it) }
                }
            }
            "reality" -> {
                val r = ss.obj("realitySettings")
                o["tls"] = buildJsonObject {
                    put("enabled", true)
                    r?.str("serverName")?.takeIf { it.isNotEmpty() }?.let { put("server_name", it) }
                    // REALITY requires uTLS; fall back to chrome for unknown names
                    put("utls", utls(r?.str("fingerprint")) ?: utls("chrome")!!)
                    put("reality", buildJsonObject { put("enabled", true); put("public_key", r?.str("publicKey") ?: ""); put("short_id", r?.str("shortId") ?: "") })
                }
            }
        }
    }

    private fun parseXrayEntry(entry: JsonObject): Parsed? {
        val out = entry.arr("outbounds")?.map { it.jsonObject }
            ?.firstOrNull { it.str("protocol") in setOf("vless", "vmess", "trojan", "shadowsocks") } ?: return null
        val protocol = out.str("protocol")!!
        val settings = out.obj("settings") ?: JsonObject(emptyMap())
        val m = mutableMapOf<String, JsonElement>()
        m["type"] = JsonPrimitive(protocol); m["tag"] = JsonPrimitive("proxy")
        val server: String; val port: Int
        if (protocol == "vless" || protocol == "vmess") {
            val v = settings.arr("vnext")?.firstOrNull()?.jsonObject ?: return null
            val user = v.arr("users")?.firstOrNull()?.jsonObject ?: JsonObject(emptyMap())
            server = v.str("address") ?: return null; port = v.int("port") ?: 443
            m["uuid"] = JsonPrimitive(user.str("id") ?: "")
            if (protocol == "vless") user.str("flow")?.takeIf { it.isNotEmpty() }?.let { m["flow"] = JsonPrimitive(it) }
            else { m["security"] = JsonPrimitive(user.str("security") ?: "auto"); m["alter_id"] = JsonPrimitive(user.int("alterId") ?: 0) }
        } else {
            val sv = settings.arr("servers")?.firstOrNull()?.jsonObject ?: return null
            server = sv.str("address") ?: return null; port = sv.int("port") ?: 443
            m["password"] = JsonPrimitive(sv.str("password") ?: "")
            if (protocol == "shadowsocks") m["method"] = JsonPrimitive(sv.str("method") ?: "")
        }
        m["server"] = JsonPrimitive(server); m["server_port"] = JsonPrimitive(port)
        xrayStream(out.obj("streamSettings"), m)
        if (protocol == "trojan" && "tls" !in m) m["tls"] = buildJsonObject { put("enabled", true); put("server_name", server) }
        // BPB "fragment" profiles chain the proxy through a freedom outbound with settings.fragment
        val fragmented = entry.arr("outbounds")?.any {
            val o = it as? JsonObject
            o?.str("protocol") == "freedom" && o.obj("settings")?.obj("fragment") != null
        } == true
        val tlsObj = m["tls"] as? JsonObject
        if (fragmented && tlsObj != null) m["tls"] = JsonObject(tlsObj + mapOf("fragment" to JsonPrimitive(true), "record_fragment" to JsonPrimitive(true)))
        val remark = entry.str("remarks") ?: "$server:$port"
        return Parsed(remark, protocol, "outbound", JsonObject(m).toString())
    }

    private fun parseXrayArray(text: String): Pair<List<Parsed>, Int>? {
        val arr = try { Json.parseToJsonElement(text) as? JsonArray } catch (_: Exception) { null } ?: return null
        if (arr.isEmpty() || (arr[0] as? JsonObject)?.get("outbounds") !is JsonArray) return null
        var failed = 0
        val ok = arr.mapNotNull { e ->
            runCatching { parseXrayEntry(e.jsonObject) }
                .onFailure { LogBuffer.add("خواندن کانفیگ ناموفق: ${it.message}") }
                .getOrNull().also { if (it == null) failed++ }
        }
        return ok to failed
    }

    /** Xray JSON array, plain list of links, or a single base64 blob that decodes to one. Returns parsed + failed count. */
    /**
     * A WireGuard / AmneziaWG .conf file. AmneziaWG ones keep their whole text for the AmneziaWG
     * engine (kind "awg"); plain WireGuard becomes a sing-box endpoint like a wireguard:// link.
     */
    fun parseConf(text: String, name: String? = null): Parsed {
        AwgConf.problem(text)?.let { error(it) }
        val ep = AwgConf.endpoint(text) ?: "?"
        if (AwgConf.isAmnezia(text)) {
            val json = buildJsonObject { put("conf", text.trim()) }.toString()
            return Parsed(name ?: "AmneziaWG · $ep", "amneziawg", "awg", json)
        }
        val kv = text.lines().map { it.trim() }.filter { '=' in it && !it.startsWith("#") }
            .associate { it.substringBefore('=').trim().lowercase() to it.substringAfter('=').trim() }
        val enc = { s: String -> java.net.URLEncoder.encode(s, "UTF-8") }
        val link = buildString {
            append("wireguard://").append(enc(kv["privatekey"] ?: "")).append('@').append(ep)
            append("?publickey=").append(enc(kv["publickey"] ?: ""))
            append("&address=").append(enc(kv["address"] ?: ""))
            kv["mtu"]?.let { append("&mtu=").append(it) }
            kv["presharedkey"]?.let { append("&presharedkey=").append(enc(it)) }
            kv["persistentkeepalive"]?.let { append("&keepalive=").append(it) }
            append('#').append(enc(name ?: "WireGuard · $ep"))
        }
        return parseWireGuard(link)
    }

    /** An .ovpn file becomes one entry (kind "openvpn") that keeps the whole text. */
    fun parseOvpn(text: String, name: String? = null): Parsed {
        val p = Ovpn.parse(text)
        if (!p.ok) error(p.problems.joinToString("\u061B "))
        val r = p.remotes.first()
        val json = buildJsonObject { put("ovpn", text.trim()) }.toString()
        return Parsed(name ?: "OpenVPN \u00B7 ${r.host}", "openvpn", "openvpn", json)
    }

    fun parseSubscription(text: String): Pair<List<Parsed>, Int> {
        var body = text.trim().removePrefix("\uFEFF")
        // an OpenVPN .ovpn file: kept whole for the OpenVPN engine
        if (Ovpn.looksLike(body)) return runCatching { listOf(parseOvpn(body)) to 0 }
            .getOrElse { LogBuffer.add("\u062E\u0648\u0627\u0646\u062F\u0646 \u0641\u0627\u06CC\u0644 OpenVPN \u0646\u0627\u0645\u0648\u0641\u0642: ${it.message}"); emptyList<Parsed>() to 1 }
        // a pasted .conf file (WireGuard or AmneziaWG)
        if (AwgConf.looksLikeConf(body)) return runCatching { listOf(parseConf(body)) to 0 }
            .getOrElse { LogBuffer.add("خواندن فایل کانفیگ ناموفق: ${it.message}"); emptyList<Parsed>() to 1 }
        parseXrayArray(body)?.let { return it }
        if (!Regex("^(vless|vmess|trojan|ss|wireguard|wg)://", RegexOption.MULTILINE).containsMatchIn(body)) {
            body = runCatching { b64(body) }.getOrDefault(body)
        }
        var failed = 0
        // '#' lines are subscription metadata (#profile-title: ...), not configs
        val ok = body.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.mapNotNull {
            runCatching { parseLink(it) }.onFailure { failed++; LogBuffer.add("خواندن کانفیگ ناموفق: ${it.message}") }.getOrNull()
        }
        return ok to failed
    }
}
