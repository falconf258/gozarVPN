package app.gozarvpn.android.data

import kotlinx.serialization.Serializable

/** One saved proxy: [outboundJson] is a ready sing-box outbound/endpoint object. */
@Serializable
data class ConfigEntry(
    val id: String,
    val name: String,
    val protocol: String,
    val groupId: String? = null,
    val favorite: Boolean = false,
    /** "outbound" or "endpoint" (WireGuard lives in sing-box `endpoints`). */
    val kind: String = "outbound",
    val json: String,
)

@Serializable
data class Group(
    val id: String,
    val name: String,
    val sourceUrl: String? = null,
    val addedAt: Long = System.currentTimeMillis(),
)

@Serializable
data class TestResult(
    val ok: Boolean,
    val latencyMs: Long? = null,
    val error: String? = null,
    val at: Long = System.currentTimeMillis(),
)

@Serializable
data class ClashProfile(
    val id: String,
    val name: String,
    /** Subscription URL when it came from a link (for refresh), else null (file / clipboard). */
    val sourceUrl: String? = null,
    val addedAt: Long = System.currentTimeMillis(),
)

@Serializable
data class Settings(
    /** "singbox" | "aether" | "mihomo" | "tor" */
    val engine: String = "singbox",
    /** warp (Tor through Aether's WARP tunnel, no bridges) | auto | obfs4 | webtunnel | snowflake | vanilla */
    val torMode: String = "warp",
    /** Preferred Tor exit country code (e.g. de); empty = any. */
    val torExitCountry: String = "",
    /** The user's own bridge lines (one per line) and whether to use only those. */
    val torCustomBridges: String = "",
    val torOnlyMine: Boolean = false,
    /** smart (tries masque -> wireguard -> gool) | masque | wireguard | gool */
    val aetherProtocol: String = "smart",
    val aetherScan: String = "balanced",
    val aetherNoize: String = "balanced",
    /** AETHER_IP: 4 | 6 | dual */
    val aetherIp: String = "4",
    /** Empty = automatic scan; otherwise a forced endpoint (AETHER_PEER, ip:port). */
    val aetherPeer: String = "",
    val aetherKeepalive: String = "",
    // MASQUE over HTTP/2 gets through where UDP/QUIC is blocked (verified working in Iran).
    val aetherH2: Boolean = true,
    // Off by default: with ECH on, the engine exits at once when DNS returns no HTTPS
    // record for its ECH domain (seen from Iran); fragmenting is unverified there.
    val aetherFragment: Boolean = false,
    val aetherFragSize: String = "",
    val aetherFragDelay: String = "",
    val aetherEch: Boolean = false,
    val aetherQuickReconnect: Boolean = true,
    val aetherDns: String = "",
    val aetherRouteBlock: String = "",
    val aetherRouteDirect: String = "",
    val aetherNoDataCheck: Boolean = false,
    val aetherTlsGroups: String = "",
    val aetherValidateSecs: String = "",
    val aetherReconnectSecs: String = "",
    val aetherNoProfileRetry: Boolean = false,
    val aetherLogLevel: String = "info",
    /** Split tunnelling: all | only (just [perAppPackages] use the VPN) | except (all but them). */
    val perAppMode: String = "all",
    val perAppPackages: List<String> = emptyList(),
    /** Traffic routing: all | iran (Iranian sites and IPs direct, the rest via VPN) | custom (only routeProxy via VPN). */
    val routingMode: String = "iran",
    /** Pause the VPN while one of these apps is in front (apps that refuse to run with any VPN on). */
    val autoPauseApps: Boolean = false,
    val autoPausePackages: List<String> = emptyList(),
    /** The user's own lists, one domain / IP / CIDR per line. */
    val routeDirect: String = "",
    val routeProxy: String = "",
    /** Clash/mihomo subscription; the downloaded text lives in files/mihomo/profile.txt. */
    val clashUrl: String = "",
    /** url-test | fallback | load-balance | select */
    val clashGroupType: String = "url-test",
    /** Saved Clash configs (text copied into files/mihomo/profiles/<id>.yaml) and the active one. */
    val clashProfiles: List<ClashProfile> = emptyList(),
    val clashActive: String = "",
    /** Regex that limits which servers the Clash group uses (mihomo `filter`), e.g. "🇩🇪|Germany". */
    val clashFilter: String = "",
    /** Server picked by hand in the Clash list (applied when the group type is select). */
    val clashSelected: String = "",
    /** V2ray/Xray: connect to the fastest tested server and switch when it stops answering. */
    val v2rayAuto: Boolean = false,
    /** Psiphon (run by the Aether core): "aether" = Aether(WARP) -> Psiphon, "only" = plain Psiphon. */
    val psiphonRoute: String = "aether",
    /** auto | cdn (CDN-fronted only, for networks that block the rest) | direct */
    val psiphonMode: String = "auto",
    /** Exit country code (e.g. DE); empty = Psiphon picks the fastest. */
    val psiphonRegion: String = "",
    /** V2ray/Xray: try ClientHello-splitting variants on connect and keep the one that works per server. */
    val dpiSmart: Boolean = false,
    /** Send IPv6 into the tunnel too (dropped there) so it can't leak around the VPN. */
    val blockIpv6Leak: Boolean = true,
    /** Restart a child engine that dies while connected, up to this many times (0 = off). */
    val reconnectAttempts: Int = 5,
    /** When a running connection drops, keep the TUN up as a blackhole instead of letting traffic leak. */
    val killSwitch: Boolean = false,
    /** App updates from GitHub Releases: check on start, and offer test (pre-release) versions too. */
    val autoUpdateCheck: Boolean = true,
    val updateBeta: Boolean = false,
    /** Version the start-up check already announced (so it is announced once). */
    val updateSeen: String = "",
)

@Serializable
data class AppState(
    val settings: Settings = Settings(),
    val configs: List<ConfigEntry> = emptyList(),
    val groups: List<Group> = emptyList(),
    val activeId: String? = null,
    val results: Map<String, TestResult> = emptyMap(),
    /** Anti-DPI profile per config id: picked by hand (always wins) / last one that worked. */
    val dpiManual: Map<String, String> = emptyMap(),
    val dpiLearned: Map<String, String> = emptyMap(),
)
