package app.gozarvpn.android.core

import android.content.Context
import app.gozarvpn.android.data.LogBuffer
import app.gozarvpn.android.data.Settings
import kotlinx.serialization.json.*
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Starts one of the child-process cores and returns its local SOCKS port.
 * Ports match the desktop app (Aether 1819, mihomo 2039, Tor 2059).
 */
object ProxyCores {
    const val AETHER_SOCKS = 1819
    const val MIHOMO_MIXED = 2039
    const val MIHOMO_API = 2041
    const val TOR_SOCKS = 2059
    const val PSIPHON_SOCKS = 1821

    /** SOCKS port of the engine the settings select, or null for the plain sing-box engine. */
    fun socksPortFor(engine: String): Int? = when (engine) {
        "aether" -> AETHER_SOCKS; "tor" -> TOR_SOCKS; "mihomo" -> MIHOMO_MIXED; "psiphon" -> PSIPHON_SOCKS; else -> null
    }

    /**
     * One real HTTPS request through the engine's SOCKS port. Our own app is kept out
     * of the TUN in these modes, so this (not a plain request) is the honest check.
     * Returns the delay in ms, or null; [mustContain] guards against captive/fake answers.
     */
    fun probeSocks(port: Int, url: String = "https://cp.cloudflare.com/generate_204", mustContain: String? = null, timeoutMs: Int = 12_000): Long? = try {
        val t0 = System.nanoTime()
        val proxy = java.net.Proxy(java.net.Proxy.Type.SOCKS, java.net.InetSocketAddress("127.0.0.1", port))
        val c = URL(url).openConnection(proxy) as HttpURLConnection
        c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs; c.instanceFollowRedirects = false
        try {
            val code = c.responseCode
            val body = if (mustContain != null) c.inputStream.bufferedReader().readText() else ""
            if (code in 200..399 && (mustContain == null || body.contains(mustContain))) (System.nanoTime() - t0) / 1_000_000 else null
        } finally { c.disconnect() }
    } catch (_: Throwable) { null }

    /** Polls [probe] until it succeeds or [budgetMs] runs out; logs the outcome. */
    private fun waitForData(label: String, budgetMs: Long, cancelled: () -> Boolean, probe: () -> Long?): Boolean {
        val deadline = System.currentTimeMillis() + budgetMs
        LogBuffer.add("[core] بررسی عبور واقعی ترافیک از $label…")
        while (System.currentTimeMillis() < deadline && !cancelled()) {
            probe()?.let { LogBuffer.add("[core] ترافیک از $label رد می‌شود ($it ms)"); return true }
            Thread.sleep(500)
        }
        LogBuffer.add("[core] در ${budgetMs / 1000} ثانیه هیچ درخواستی از $label رد نشد")
        return false
    }

    /* ------------------------------ Aether ------------------------------ */

    // The Android screen uses friendlier names than the core's CLI values.
    private fun aetherProtocol(v: String) = if (v == "wireguard") "wg" else v
    private fun aetherScan(v: String) = when (v) { "fast" -> "turbo"; "deep" -> "thorough"; else -> v }
    private fun aetherNoize(v: String) = if (v == "strong") "aggressive" else v

    /** Settings -> the engine's documented AETHER_* variables (empty fields = engine default). */
    fun aetherEnv(s: Settings, protocol: String): Map<String, String> = buildMap {
        put("AETHER_SOCKS", "127.0.0.1:$AETHER_SOCKS")
        put("AETHER_PROTOCOL", aetherProtocol(protocol))
        put("AETHER_SCAN", aetherScan(s.aetherScan))
        put("AETHER_NOIZE", aetherNoize(s.aetherNoize))
        put("AETHER_IP", s.aetherIp.removePrefix("v").let { if (it == "both") "dual" else it })
        put("AETHER_LOG_LEVEL", s.aetherLogLevel)
        put("AETHER_MASQUE_HTTP2", if (s.aetherH2) "1" else "0")
        if (s.aetherFragment) put("AETHER_MASQUE_H2_FRAGMENT", "1")
        s.aetherFragSize.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_MASQUE_H2_SIZE", it) }
        s.aetherFragDelay.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_MASQUE_H2_DELAY", it) }
        if (s.aetherEch) put("AETHER_ECH", "auto")
        if (s.aetherQuickReconnect) put("AETHER_QUICK_RECONNECT", "1")
        s.aetherPeer.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_PEER", it); put("AETHER_WG_PEER", it) }
        s.aetherKeepalive.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_WG_KEEPALIVE", it) }
        s.aetherDns.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_DNS", it) }
        s.aetherRouteBlock.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_ROUTE_BLOCK", it) }
        s.aetherRouteDirect.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_ROUTE_DIRECT", it) }
        s.aetherTlsGroups.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_TLS_GROUPS", it) }
        s.aetherValidateSecs.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_MASQUE_VALIDATE_SECS", it); put("AETHER_WG_VALIDATE_SECS", it) }
        s.aetherReconnectSecs.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_MASQUE_RECONNECT_SECS", it); put("AETHER_WG_RECONNECT_SECS", it) }
        if (s.aetherNoDataCheck) { put("AETHER_MASQUE_NO_DATA_CHECK", "1"); put("AETHER_WG_NO_DATA_CHECK", "1") }
        if (s.aetherNoProfileRetry) put("AETHER_WG_NO_PROFILE_RETRY", "1")
        put("RUST_LOG_STYLE", "never"); put("NO_COLOR", "1")
    }

    /** The engine's own docs: a working WARP tunnel answers this with `warp=on`. */
    private fun aetherProbe() = probeSocks(AETHER_SOCKS, "https://www.cloudflare.com/cdn-cgi/trace", mustContain = "warp=")

    fun startAether(ctx: Context, core: ChildCore, s: Settings, cancelled: () -> Boolean): Int {
        val bin = core.nativeBin(ctx, "libaether.so")
        // Its WARP identity files live in this dir, so it doesn't re-register every start.
        val dir = File(ctx.filesDir, "aether")
        // The engine has no automatic transport choice, so "smart" is ours: MASQUE first
        // (over HTTP/2 + fragmenting when UDP is blocked), then WireGuard, then WARP-in-WARP.
        val order = if (s.aetherProtocol == "smart") listOf("masque", "wireguard", "gool") else listOf(s.aetherProtocol)
        var lastError: Throwable? = null
        // with ECH on, the engine exits at once if DNS has no HTTPS record for its ECH
        // domain (seen from Iran); then the same protocol is retried once without ECH
        val attempts = order.flatMap { p -> if (s.aetherEch) listOf(p to true, p to false) else listOf(p to false) }
        var echFailed = false
        for ((p, ech) in attempts) {
            if (cancelled()) error("لغو شد")
            if (!ech && s.aetherEch && !echFailed) continue // ECH attempt didn't fail on ECH; no retry
            echFailed = false
            val env = aetherEnv(s.copy(aetherEch = ech), p)
            LogBuffer.add("[core] Aether با پروتکل $p · " + env.filterKeys { it != "AETHER_SOCKS" }.entries.joinToString(" ") { "${it.key}=${it.value}" })
            try {
                core.start(
                    ctx, listOf(bin.absolutePath), dir, env, AETHER_SOCKS, timeoutMs = if (order.size > 1) 75_000 else 120_000,
                    ready = { it.contains("socks5 server listening on", ignoreCase = true) },
                    isProgress = { it.contains("scan", ignoreCase = true) || it.contains("handshake", ignoreCase = true) },
                    isCancelled = cancelled,
                )
                // a listening socket is not a tunnel: wait for real traffic before saying "connected"
                if (waitForData("Aether ($p)", 45_000, cancelled) { aetherProbe() }) return AETHER_SOCKS
                core.stop()
                lastError = IllegalStateException("Aether با پروتکل $p بالا آمد ولی ترافیکی رد نکرد")
            } catch (t: Throwable) {
                if (cancelled()) throw t
                lastError = t
                LogBuffer.add("[core] Aether با پروتکل $p ناموفق: ${t.message}")
                if (ech && core.lastError?.contains("ECH", ignoreCase = true) == true) {
                    echFailed = true
                    LogBuffer.add("[core] ECH در این شبکه کار نمی‌کند؛ همان پروتکل بدون ECH دوباره امتحان می‌شود")
                }
            }
        }
        throw lastError ?: IllegalStateException("Aether وصل نشد")
    }

    /* ----------------------------- AmneziaWG ----------------------------- */

    const val AWG_SOCKS = 2069

    /**
     * AmneziaWG (WireGuard with junk/header obfuscation) through wireproxy-awg, shipped as
     * libawg.so: it reads the conf plus a [Socks5] section and serves a local SOCKS port.
     * The conf (with its PrivateKey) is written only to app-private storage, never logged.
     */
    fun startAwg(ctx: Context, core: ChildCore, conf: String, cancelled: () -> Boolean, port: Int = AWG_SOCKS): Int {
        val bin = core.nativeBin(ctx, "libawg.so")
        val dir = File(ctx.filesDir, "awg").apply { mkdirs() }
        // Go on Android finds no DNS server, so the endpoint is resolved here first
        val text = app.gozarvpn.android.data.AwgConf.forProxy(conf, port) { host ->
            runCatching { java.net.InetAddress.getByName(host).hostAddress }.getOrNull() ?: host
        }
        val file = File(dir, "awg-$port.conf").apply { writeText(text) }
        LogBuffer.add("[core] AmneziaWG به ${app.gozarvpn.android.data.AwgConf.endpoint(conf) ?: "?"}")
        core.start(
            ctx, listOf(bin.absolutePath, "-c", file.absolutePath), dir, emptyMap(), port, timeoutMs = 30_000,
            ready = { true }, // the SOCKS port opening is the readiness signal; the probe below proves the handshake
            isProgress = { it.contains("handshake", ignoreCase = true) },
            isCancelled = cancelled,
        )
        if (waitForData("AmneziaWG", 30_000, cancelled) { probeSocks(port) }) return port
        core.stop()
        error("AmneziaWG بالا آمد ولی ترافیکی رد نکرد (دست‌دادن با سرور انجام نشد؛ شاید سرور در دسترس نیست یا کانفیگ منقضی شده)")
    }

    /* ------------------------------ Psiphon ------------------------------ */

    /**
     * Psiphon is run by the Aether core itself (its --psiphon / --psiphon-only modes, with the
     * public Psiphon config built in); we only ship psiphon-tunnel-core as libpsiphon.so.
     * Either way the Psiphon SOCKS proxy ends up on [PSIPHON_SOCKS].
     */
    /**
     * A Psiphon left running by an earlier session keeps its database locked and the next start
     * dies with "psiphon stopped before it was ready" (reproduced on Windows); end our own leftovers.
     */
    private fun killLeftoverPsiphon() {
        File("/proc").listFiles()?.forEach { d ->
            val pid = d.name.toIntOrNull() ?: return@forEach
            val cmd = runCatching { File(d, "cmdline").readText() }.getOrNull() ?: return@forEach
            if ("libpsiphon.so" in cmd) {
                LogBuffer.add("[core] سایفون باقی‌مانده از اجرای قبلی بسته شد (pid $pid)")
                runCatching { android.os.Process.killProcess(pid) }
            }
        }
    }

    fun startPsiphon(ctx: Context, core: ChildCore, s: Settings, cancelled: () -> Boolean): Int {
        killLeftoverPsiphon()
        val bin = core.nativeBin(ctx, "libaether.so")
        val psiphon = core.nativeBin(ctx, "libpsiphon.so")
        val only = s.psiphonRoute == "only"
        // our "smart" order is for plain Aether; under Psiphon MASQUE (HTTP/2 by default) is used
        val protocol = if (s.aetherProtocol == "smart") "masque" else s.aetherProtocol
        val env = aetherEnv(s, protocol) + buildMap {
            put("AETHER_PSIPHON_BIN", psiphon.absolutePath)
            put("AETHER_PSIPHON_DIR", File(ctx.filesDir, "psiphon").absolutePath)
            put("AETHER_PSIPHON_MODE", s.psiphonMode)
            s.psiphonRegion.trim().takeIf { it.isNotEmpty() }?.let { put("AETHER_PSIPHON_REGION", it.uppercase()) }
            // psiphon-only serves Psiphon on Aether's own --bind; move that to the Psiphon port
            if (only) put("AETHER_SOCKS", "127.0.0.1:$PSIPHON_SOCKS") else put("AETHER_PSIPHON_BIND", "127.0.0.1:$PSIPHON_SOCKS")
        }
        val flag = if (only) "--psiphon-only" else "--psiphon"
        LogBuffer.add("[core] سایفون (${if (only) "فقط سایفون" else "از طریق Aether با $protocol"}) · " +
            env.filterKeys { it.startsWith("AETHER_PSIPHON_MODE") || it.startsWith("AETHER_PSIPHON_REGION") }.entries.joinToString(" ") { "${it.key}=${it.value}" })
        core.start(
            // ~5 s with a cached server list, but a first start measured 70-115 s (fresh list, blocked meek fronts)
            ctx, listOf(bin.absolutePath, flag), File(ctx.filesDir, "aether"), env, PSIPHON_SOCKS, timeoutMs = 180_000,
            ready = { true }, // Psiphon's own lines vary; the open port plus a real request decide
            isProgress = { it.contains("psiphon", ignoreCase = true) || it.contains("scan", ignoreCase = true) },
            isCancelled = cancelled,
        )
        if (waitForData("سایفون", 60_000, cancelled) { probeSocks(PSIPHON_SOCKS) }) return PSIPHON_SOCKS
        core.stop()
        error("سایفون بالا آمد ولی ترافیکی رد نکرد" + if (!only) "؛ «فقط سایفون» یا حالت CDN را امتحان کنید" else "؛ حالت CDN را امتحان کنید")
    }

    /* -------------------------------- Tor -------------------------------- */

    private val BRIDGE_KINDS = listOf("obfs4", "webtunnel", "vanilla", "snowflake")
    private val COLLECTOR = mapOf(
        "obfs4" to "obfs4_tested.txt", "webtunnel" to "webtunnel_tested.txt", "vanilla" to "vanilla_tested.txt",
    )
    private const val COLLECTOR_BASE = "https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/refs/heads/main/bridge/"

    private fun bridgeLines(text: String) = text.lines().map { it.trim().removePrefix("Bridge ").trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") }

    /** Fresh tested lists if GitHub answers quickly, else the last good copy, else the bundled seed. */
    private fun loadBridges(ctx: Context): Map<String, List<String>> {
        val cache = File(ctx.filesDir, "tor/bridges").apply { mkdirs() }
        return BRIDGE_KINDS.associateWith { kind ->
            val cached = File(cache, "$kind.txt")
            COLLECTOR[kind]?.let { name ->
                runCatching {
                    val c = URL(COLLECTOR_BASE + name).openConnection() as HttpURLConnection
                    c.connectTimeout = 6000; c.readTimeout = 8000
                    try { if (c.responseCode == 200) c.inputStream.bufferedReader().readText() else null } finally { c.disconnect() }
                }.getOrNull()?.let { bridgeLines(it) }?.takeIf { it.size >= 5 }?.let { fresh ->
                    cached.writeText(fresh.joinToString("\n"))
                    LogBuffer.add("[Tor] فهرست تازه‌ی پل‌های $kind دریافت شد (${fresh.size})")
                }
            }
            val fromCache = if (cached.exists()) bridgeLines(cached.readText()) else emptyList()
            fromCache.ifEmpty { ctx.assets.open("bridges/$kind.txt").bufferedReader().use { bridgeLines(it.readText()) } }
        }
    }

    /** Where to test a bridge line, or null when it can never work from here. */
    private fun bridgeTarget(line: String): Pair<String, Int>? {
        val parts = line.split(Regex("\\s+"))
        if (parts.firstOrNull() == "webtunnel") {
            // the address in webtunnel lines is a placeholder; the real endpoint is the url= host
            val url = parts.firstOrNull { it.startsWith("url=") }?.removePrefix("url=") ?: return null
            return runCatching { URL(url).let { it.host to (if (it.port > 0) it.port else 443) } }.getOrNull()
        }
        if (parts.firstOrNull() == "snowflake" || parts.firstOrNull() == "meek_lite") return null // brokered/fronted: nothing to dial directly
        val addr = if (Regex(":\\d+$").containsMatchIn(parts[0])) parts[0] else parts.getOrNull(1) ?: return null
        val host = addr.substringBeforeLast(':').removePrefix("[").removeSuffix("]")
        val port = addr.substringAfterLast(':').toIntOrNull() ?: return null
        // 2001:db8::/32 is documentation space (fake entries in public lists); real IPv6 is kept and
        // simply fails the connect test on networks without IPv6 (many Iranian mobile networks)
        if (host.lowercase().startsWith("2001:db8:")) return null
        return host to port
    }

    /**
     * Quick reachability pre-test (30 at a time, 3 s each) so Tor only gets bridges that
     * answer from this network. Lists are tested from abroad; many are blocked in Iran, and
     * webtunnel hosts often resolve to Iran's block-page address (10.10.34.x).
     */
    private fun liveBridges(lines: List<String>, keep: Int, cancelled: () -> Boolean): List<String> {
        if (lines.isEmpty()) return emptyList()
        val pool = java.util.concurrent.Executors.newFixedThreadPool(30)
        try {
            val jobs = lines.shuffled().take(150).map { line ->
                pool.submit<Pair<String, Long>?> {
                    if (cancelled()) return@submit null
                    val (host, port) = bridgeTarget(line) ?: return@submit null
                    runCatching {
                        val ip = java.net.InetAddress.getByName(host)
                        if (ip.isSiteLocalAddress || ip.isLoopbackAddress || ip.isAnyLocalAddress) return@runCatching null // poisoned DNS
                        val t0 = System.nanoTime()
                        java.net.Socket().use { it.connect(java.net.InetSocketAddress(ip, port), 3000) }
                        line to (System.nanoTime() - t0) / 1_000_000
                    }.getOrNull()
                }
            }
            return jobs.mapNotNull { runCatching { it.get(8, java.util.concurrent.TimeUnit.SECONDS) }.getOrNull() }
                .sortedBy { it.second }.take(keep).map { it.first }
        } finally { pool.shutdownNow() }
    }

    /**
     * The user's own bridges (pre-tested like the lists; snowflake/meek lines pass untested), then,
     * unless [onlyMine], the built-in choice for the mode. Cert values never reach the log.
     */
    private fun withCustomBridges(s: Settings, builtIn: () -> List<String>, cancelled: () -> Boolean): List<String> {
        val mine = app.gozarvpn.android.data.Bridges.checkAll(s.torCustomBridges).filter { it.ok }
        if (mine.isEmpty()) return builtIn()
        val untested = mine.filter { it.kind == "snowflake" || it.kind == "meek_lite" }.map { it.line }
        val live = liveBridges(mine.filter { it.kind != "snowflake" && it.kind != "meek_lite" }.map { it.line }, 30, cancelled)
        LogBuffer.add("[Tor] پل‌های شما: ${live.size + untested.size} از ${mine.size} پل از این شبکه جواب داد")
        val own = live + untested
        if (s.torOnlyMine) {
            if (own.isEmpty()) error("هیچ‌کدام از پل‌های شما از این شبکه جواب نداد (پل IPv6 روی شبکه‌ی بدون IPv6 کار نمی‌کند). پل دیگری اضافه کنید یا «فقط پل‌های من» را خاموش کنید.")
            return own
        }
        return own + builtIn()
    }

    private fun pickBridges(all: Map<String, List<String>>, mode: String, cancelled: () -> Boolean): List<String> {
        fun live(kind: String, n: Int) = liveBridges(all[kind] ?: emptyList(), n, cancelled).also {
            LogBuffer.add("[Tor] پیش‌آزمون پل‌های $kind: ${it.size} پل از این شبکه جواب داد")
        }
        return when (mode) {
            "obfs4", "webtunnel", "vanilla" -> live(mode, 20)
            "snowflake" -> (all["snowflake"] ?: emptyList()).take(4) // brokered via domain fronting; nothing to pre-test
            else -> live("obfs4", 15) + live("webtunnel", 8) + live("vanilla", 8)
        }
    }

    /**
     * [aether] is a second child slot, used only by the "warp" mode: Aether starts first and
     * Tor dials every relay through its SOCKS port, so no bridges or local DNS are involved.
     */
    fun startTor(ctx: Context, core: ChildCore, aether: ChildCore, s: Settings, cancelled: () -> Boolean): Int {
        val tor = core.nativeBin(ctx, "libtor.so")
        val lyrebird = core.nativeBin(ctx, "liblyrebird.so")
        val dir = File(ctx.filesDir, "tor")
        val data = File(dir, "data").apply { mkdirs() }
        val viaWarp = s.torMode == "warp"
        val bridges = if (viaWarp) emptyList() else withCustomBridges(s, { if (s.torOnlyMine) emptyList() else pickBridges(loadBridges(ctx), s.torMode, cancelled) }, cancelled)
        if (viaWarp) {
            LogBuffer.add("[Tor] روش «از طریق Aether»: اول Aether وصل می‌شود")
            startAether(ctx, aether, s, cancelled)
        } else if (bridges.isEmpty()) {
            error("هیچ پلی از این شبکه جواب نداد. روش «از طریق Aether (WARP)» را امتحان کنید.")
        }
        val torrc = buildList {
            add("DataDirectory ${data.absolutePath}")
            add("SocksPort 127.0.0.1:$TOR_SOCKS")
            add("ClientOnly 1"); add("AvoidDiskWrites 1"); add("SafeSocks 0"); add("Log notice stdout")
            // preferred exit country; StrictNodes 0 still lets Tor use others when none are up
            s.torExitCountry.trim().lowercase().takeIf { it.length == 2 }?.let { add("ExitNodes {$it}"); add("StrictNodes 0") }
            if (viaWarp) {
                add("Socks5Proxy 127.0.0.1:$AETHER_SOCKS")
            } else {
                add("UseBridges 1")
                // one lyrebird binary serves every pluggable transport in Tor 15
                add("ClientTransportPlugin meek_lite,obfs4,webtunnel,snowflake exec ${lyrebird.absolutePath}")
                bridges.forEach { add("Bridge $it") }
            }
        }
        val torrcFile = File(dir, "torrc").apply { writeText(torrc.joinToString("\n") + "\n") }
        LogBuffer.add("[Tor] روش ${s.torMode}، " + if (viaWarp) "بدون پل، از طریق WARP" else "${bridges.size} پل سالم")
        core.start(
            ctx, listOf(tor.absolutePath, "-f", torrcFile.absolutePath), dir, emptyMap(), TOR_SOCKS, timeoutMs = 300_000,
            ready = { it.contains("Bootstrapped 100%") },
            isProgress = { it.contains("Bootstrapped") },
            isCancelled = cancelled,
        )
        // Bootstrapped 100% means circuits exist, not that exits answer; check before "connected"
        if (!waitForData("Tor", 150_000, cancelled) { probeSocks(TOR_SOCKS, timeoutMs = 25_000) }) {
            core.stop(); aether.stop()
            error("Tor بالا آمد ولی هیچ صفحه‌ای از آن باز نشد. روش «از طریق Aether (WARP)» یا روش پل دیگری را امتحان کنید.")
        }
        return TOR_SOCKS
    }

    /* ------------------------------- mihomo ------------------------------- */

    fun clashProfileFile(ctx: Context, id: String) = File(ctx.filesDir, "mihomo/profiles/$id.yaml")

    /** The active saved profile; falls back to the single profile.txt older versions kept. */
    fun mihomoProfile(ctx: Context, s: Settings): File =
        s.clashActive.takeIf { it.isNotEmpty() }?.let { clashProfileFile(ctx, it) }?.takeIf { it.exists() }
            ?: File(ctx.filesDir, "mihomo/profile.txt")

    /**
     * Same approach as desktop: the saved subscription (Clash YAML, base64 or links)
     * becomes a file proxy-provider and every node goes into one url-test group.
     * The config is JSON, which mihomo accepts as YAML.
     */
    fun startMihomo(ctx: Context, core: ChildCore, s: Settings, cancelled: () -> Boolean): Int {
        val bin = core.nativeBin(ctx, "libmihomo.so")
        val profile = mihomoProfile(ctx, s)
        if (!profile.exists() || profile.length() == 0L) error("هنوز پروفایل Clash اضافه نشده. از «کانفیگ‌ها › Clash» یک لینک یا متن اضافه کنید.")
        val dir = File(ctx.filesDir, "mihomo")
        val test = "https://www.gstatic.com/generate_204"
        val filter = s.clashFilter.trim()
        // GOZAR is what the user picks from (AUTO or one server); AUTO does the
        // automatic choice. The optional filter (country) applies to both.
        val auto = buildJsonObject {
            put("name", "AUTO"); put("type", if (s.clashGroupType == "select") "url-test" else s.clashGroupType)
            put("use", buildJsonArray { add("sub") }); put("url", test); put("interval", 120); put("tolerance", 50); put("lazy", false)
            if (filter.isNotEmpty()) put("filter", filter)
        }
        val pick = buildJsonObject {
            put("name", "GOZAR"); put("type", "select")
            put("proxies", buildJsonArray { add("AUTO") }); put("use", buildJsonArray { add("sub") })
            if (filter.isNotEmpty()) put("filter", filter)
        }
        mihomoSecret = java.util.UUID.randomUUID().toString()
        val cfg = buildJsonObject {
            put("mixed-port", MIHOMO_MIXED); put("bind-address", "127.0.0.1"); put("allow-lan", false)
            put("mode", "rule"); put("log-level", "info"); put("ipv6", false)
            put("external-controller", "127.0.0.1:$MIHOMO_API"); put("secret", mihomoSecret)
            put("profile", buildJsonObject { put("store-selected", true) })
            put("dns", buildJsonObject {
                put("enable", true); put("ipv6", false); put("enhanced-mode", "redir-host")
                put("nameserver", buildJsonArray { add("1.1.1.1"); add("8.8.8.8") })
                put("proxy-server-nameserver", buildJsonArray { add("1.1.1.1"); add("8.8.8.8") })
            })
            put("proxy-providers", buildJsonObject {
                put("sub", buildJsonObject {
                    put("type", "file"); put("path", profile.absolutePath)
                    put("health-check", buildJsonObject { put("enable", true); put("url", test); put("interval", 300); put("lazy", false) })
                })
            })
            put("proxy-groups", buildJsonArray { add(auto); add(pick) })
            put("rules", buildJsonArray { add("IP-CIDR,127.0.0.0/8,DIRECT"); add("MATCH,GOZAR") })
        }
        val cfgFile = File(dir.apply { mkdirs() }, "config.yaml").apply { writeText(cfg.toString()) }
        LogBuffer.add("[core] mihomo: گروه ${auto["type"]}، فیلتر «${filter.ifEmpty { "-" }}»، انتخاب «${s.clashSelected.ifEmpty { "AUTO" }}»")
        core.start(
            ctx, listOf(bin.absolutePath, "-d", dir.absolutePath, "-f", cfgFile.absolutePath), dir, emptyMap(), MIHOMO_MIXED,
            timeoutMs = 30_000,
            ready = { it.contains("Mixed(http+socks) proxy listening at", ignoreCase = true) || it.contains("proxy listening at", ignoreCase = true) },
            isCancelled = cancelled,
        )
        if (s.clashSelected.isNotEmpty()) runCatching { mihomoSelect(s.clashSelected) }
            .onFailure { LogBuffer.add("[core] انتخاب «${s.clashSelected}» ناموفق: ${it.message}") }
        if (!waitForData("Clash", 45_000, cancelled) { probeSocks(MIHOMO_MIXED) }) {
            core.stop()
            error("Clash بالا آمد ولی هیچ سروری از این پروفایل جواب نداد. سرور یا پروفایل دیگری را امتحان کنید.")
        }
        return MIHOMO_MIXED
    }

    /* ------------------------- mihomo REST controller ------------------------- */

    @Volatile private var mihomoSecret: String = ""

    private fun mihomoApi(method: String, path: String, body: String? = null, timeoutMs: Int = 8000): String {
        val c = URL("http://127.0.0.1:$MIHOMO_API$path").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
        c.requestMethod = method; c.connectTimeout = 3000; c.readTimeout = timeoutMs
        c.setRequestProperty("Authorization", "Bearer $mihomoSecret")
        if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
        try {
            val code = c.responseCode
            val text = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.readText() ?: ""
            if (code >= 400) error("mihomo API $code: ${text.take(120)}")
            return text
        } finally { c.disconnect() }
    }

    data class ClashNode(val name: String, val type: String, val delay: Int?)

    /** Servers of the running GOZAR group (first = what it currently uses). */
    fun mihomoNodes(): Pair<String?, List<ClashNode>> {
        val all = Json.parseToJsonElement(mihomoApi("GET", "/proxies")).jsonObject["proxies"]?.jsonObject ?: return null to emptyList()
        val group = all["GOZAR"]?.jsonObject ?: return null to emptyList()
        val now = group["now"]?.jsonPrimitive?.contentOrNull
        val names = group["all"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
        return now to names.map { n ->
            val p = all[n]?.jsonObject
            val hist = p?.get("history")?.jsonArray
            ClashNode(n, p?.get("type")?.jsonPrimitive?.contentOrNull ?: "", hist?.lastOrNull()?.jsonObject?.get("delay")?.jsonPrimitive?.intOrNull?.takeIf { it > 0 })
        }
    }

    fun mihomoSelect(name: String) { mihomoApi("PUT", "/proxies/GOZAR", buildJsonObject { put("name", name) }.toString()) }

    /** Delay of one server through mihomo itself, or null on timeout/failure. */
    fun mihomoDelay(name: String): Int? = runCatching {
        val q = "/proxies/" + java.net.URLEncoder.encode(name, "UTF-8").replace("+", "%20") +
            "/delay?timeout=5000&url=" + java.net.URLEncoder.encode("https://www.gstatic.com/generate_204", "UTF-8")
        Json.parseToJsonElement(mihomoApi("GET", q, timeoutMs = 7000)).jsonObject["delay"]?.jsonPrimitive?.intOrNull
    }.getOrNull()

    /** Server names straight from the saved profile (works while disconnected). */
    fun clashNamesFromProfile(ctx: Context, s: Settings): List<String> {
        val f = mihomoProfile(ctx, s)
        if (!f.exists()) return emptyList()
        var text = f.readText()
        if (!text.contains("proxies:") && !text.contains("://")) {
            text = runCatching { String(android.util.Base64.decode(text.trim(), android.util.Base64.DEFAULT)) }.getOrDefault(text)
        }
        val yaml = Regex("""^\s*-\s*(?:\{\s*)?name:\s*["']?([^"',}\r\n]+)""", RegexOption.MULTILINE).findAll(text).map { it.groupValues[1].trim() }
        val links = text.lines().filter { "://" in it && "#" in it }.map {
            runCatching { java.net.URLDecoder.decode(it.substringAfterLast('#').replace("+", "%2B"), "UTF-8") }.getOrDefault(it.substringAfterLast('#')).trim()
        }
        return (yaml + links).filter { it.isNotEmpty() }.distinct().toList()
    }
}
