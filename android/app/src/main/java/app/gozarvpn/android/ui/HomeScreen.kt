package app.gozarvpn.android.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.gozarvpn.android.core.ProxyCores
import app.gozarvpn.android.data.AppState
import app.gozarvpn.android.data.LogBuffer
import app.gozarvpn.android.data.Tester
import app.gozarvpn.android.vpn.GozarVpnService
import app.gozarvpn.android.vpn.VpnStatus
import app.gozarvpn.android.vpn.VpnUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

val ENGINES = listOf("aether" to "Aether", "singbox" to "V2ray", "mihomo" to "Clash", "tor" to "Tor", "psiphon" to "سایفون")

/** Engines whose Android core is already built into the app. */
val READY_ENGINES = setOf("singbox", "aether", "mihomo", "tor", "psiphon")

private val EXIT_COUNTRIES = listOf("DE", "NL", "GB", "FR", "US", "CA", "SE", "FI", "AT", "CH", "SG", "JP")

@Composable
fun HomeScreen(vm: AppViewModel, app: AppState, vpn: VpnUiState, onToggle: () -> Unit, onReconnect: () -> Unit, modifier: Modifier = Modifier) {
    val s = app.settings
    val engine = s.engine
    val busy = vpn.status == VpnStatus.Connected || vpn.status == VpnStatus.Starting
    val connected = vpn.status == VpnStatus.Connected
    val (c1, c2) = engineColors(engine)
    val stateColor = when (vpn.status) {
        VpnStatus.Connected -> Good; VpnStatus.Starting -> Warn; VpnStatus.Error -> Bad; VpnStatus.Stopped -> Muted; VpnStatus.Paused -> Warn
    }
    val label = when (vpn.status) {
        VpnStatus.Connected -> "متصل"; VpnStatus.Starting -> "در حال اتصال"; VpnStatus.Error -> "خطا"; VpnStatus.Stopped -> "قطع"; VpnStatus.Paused -> "متوقف موقت"
    }

    // Driven by frame time (not the system animation scale) so it also runs
    // on phones where "animator duration scale" is switched off.
    var clock by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) withFrameNanos { clock = it / 1_000_000L } }

    // Ping: one real request through the tunnel (through the engine's SOCKS port in engine
    // modes, since our own app stays outside the TUN there).
    // a child engine's port (Aether, Tor… or an AmneziaWG server in V2ray mode): our app is outside the TUN then
    val enginePort = vpn.socksPort ?: ProxyCores.socksPortFor(engine)
    var pingMs by remember { mutableStateOf<Long?>(null) }
    var pingChecked by remember { mutableStateOf(false) }
    var pingNonce by remember { mutableIntStateOf(0) }
    LaunchedEffect(vpn.status, enginePort, pingNonce) {
        pingMs = null; pingChecked = false
        if (connected) while (true) {
            val r = withContext(Dispatchers.IO) {
                if (enginePort != null) ProxyCores.probeSocks(enginePort) ?: ProxyCores.probeSocks(enginePort, "https://www.gstatic.com/generate_204")
                else Tester.probeTunnel()
            }
            pingMs = r; pingChecked = true
            delay(if (r != null) 20000 else 6000)
        }
    }
    var exit by remember { mutableStateOf<Tester.ExitInfo?>(null) }
    LaunchedEffect(connected, enginePort) {
        exit = null
        if (connected) exit = withContext(Dispatchers.IO) { Tester.exitInfo(enginePort) }
    }

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Header(label, stateColor)
        Spacer(Modifier.height(6.dp))
        ConnectOrb(vpn.status, c1, c2, stateColor, clock, onToggle)
        Spacer(Modifier.height(8.dp))

        // status pill with the exit flag
        Row(
            Modifier.clip(RoundedCornerShape(50)).background(stateColor.copy(alpha = 0.12f))
                .border(1.dp, stateColor.copy(alpha = 0.35f), RoundedCornerShape(50)).padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(stateColor))
            Spacer(Modifier.width(8.dp))
            AnimatedContent(label, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "status") {
                val dots = if (vpn.status == VpnStatus.Starting) ".".repeat(1 + ((clock / 400L) % 3).toInt()) else ""
                Text(it + dots, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = stateColor)
            }
            exit?.takeIf { connected }?.flagCode()?.let { Text("  ${flag(it)}", fontSize = 15.sp) }
        }

        // big session timer (gradient digits) while connected
        val since = vpn.since
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(since) { while (since != null) { now = System.currentTimeMillis(); delay(1000) } }
        Spacer(Modifier.height(6.dp))
        if (connected && since != null) {
            val sec = ((now - since) / 1000).coerceAtLeast(0)
            Text(
                "%02d:%02d:%02d".format(sec / 3600, (sec / 60) % 60, sec % 60),
                style = TextStyle(brush = Brush.horizontalGradient(listOf(c1, c2)), fontSize = 38.sp, fontWeight = FontWeight.Light, fontFamily = FontFamily.Monospace),
            )
        } else {
            Text(when (vpn.status) {
                VpnStatus.Starting -> "برای لغو، دوباره روی دکمه بزنید"
                VpnStatus.Paused -> (vpn.message ?: "VPN متوقف است") + " · برای ادامه روی دکمه بزنید"
                else -> "برای اتصال روی دکمه بزنید"
            }, color = Muted, fontSize = 13.sp)
        }
        val target = when (engine) {
            "singbox" -> app.configs.firstOrNull { it.id == app.activeId }?.name ?: "کانفیگی انتخاب نشده"
            "tor" -> "Tor · ${torModeLabel(s.torMode)}"
            "aether" -> "Aether · ${s.aetherProtocol}"
            "psiphon" -> if (s.psiphonRoute == "only") "فقط سایفون" else "سایفون از طریق Aether"
            else -> s.clashProfiles.firstOrNull { it.id == s.clashActive }?.name ?: "Clash"
        }
        Text(
            target + (exit?.takeIf { connected }?.let { " · ${ltr(it.ip)} (${it.place()})" } ?: ""),
            color = Muted, fontSize = 13.sp, maxLines = 1,
        )
        if (s.routingMode != "all") {
            // which traffic skips the tunnel, at a glance
            Spacer(Modifier.height(6.dp))
            Text(
                if (s.routingMode == "iran") "ایران: مستقیم · بقیه: VPN" else "فقط لیست من از VPN",
                color = Good, fontSize = 12.sp,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(Good.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 3.dp),
            )
        }
        if (vpn.status == VpnStatus.Starting && engine != "singbox") {
            // child cores (Tor/Aether/Psiphon) take a while; show their latest progress line
            val lines by LogBuffer.lines.collectAsState()
            lines.lastOrNull { "[core]" in it }?.substringAfter("[core]")?.trim()?.let { Text(it, color = Muted, fontSize = 12.sp, maxLines = 2) }
        }
        if (connected && pingChecked && pingMs == null) {
            Spacer(Modifier.height(6.dp))
            Text("✗ از ${if (enginePort != null) "مسیر موتور" else "تونل"} پاسخی نمی‌آید؛ لاگ را بفرستید یا تنظیمات را عوض کنید", color = Bad, fontSize = 12.5.sp)
        }
        vpn.warning?.takeIf { connected }?.let { Spacer(Modifier.height(6.dp)); Text("⚠ $it", color = Warn, fontSize = 12.5.sp) }
        if (vpn.status == VpnStatus.Error && vpn.message != null) { Spacer(Modifier.height(6.dp)); Text(vpn.message, color = Bad, fontSize = 12.5.sp) }
        if (vpn.blocked) {
            val ctx = androidx.compose.ui.platform.LocalContext.current
            Spacer(Modifier.height(6.dp))
            Text("🛡 کیل‌سوییچ: اتصال قطع شده و ترافیک بسته است. برای وصل شدن دوباره روی دکمه بزنید.", color = Warn, fontSize = 12.5.sp)
            androidx.compose.material3.TextButton({
                ctx.startService(android.content.Intent(ctx, GozarVpnService::class.java).setAction(GozarVpnService.ACTION_STOP))
            }) { Text("برداشتن مسدودسازی و قطع", color = Bad) }
        }

        Spacer(Modifier.height(14.dp))
        LiveStats(connected, pingMs, pingChecked)
        Spacer(Modifier.height(10.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            QuickAction(Icons.Filled.Bolt, "تست پینگ", c1, connected, Modifier.weight(1f)) { pingNonce++ }
            QuickAction(Icons.Filled.Refresh, "اتصال دوباره", c2, connected, Modifier.weight(1f), onReconnect)
        }
        Spacer(Modifier.height(10.dp))
        GCard {
            H("موتور اتصال")
            PillTabs(ENGINES, engine, enabled = !busy, colorsOf = ::engineColors) { vm.repo.updateSettings { st -> st.copy(engine = it) } }
            EngineOptions(vm, app, busy)
            if (busy) Hint("برای تعویض موتور یا روش، اول قطع کنید.")
        }
        Spacer(Modifier.height(4.dp))
        var privacy by remember { mutableStateOf(false) }
        var donate by remember { mutableStateOf(false) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            androidx.compose.material3.TextButton({ privacy = true }) { Text("🔒 حریم خصوصی", color = Muted, fontSize = 12.5.sp) }
            androidx.compose.material3.TextButton({ donate = true }) { Text("♥ حمایت از سازنده", color = Muted, fontSize = 12.5.sp) }
        }
        if (privacy) PrivacyDialog { privacy = false }
        if (donate) DonateDialog { donate = false }
        // room to scroll the last card fully clear of the bottom bar
        Spacer(Modifier.height(32.dp))
    }
}

@Composable
private fun Header(label: String, color: Color) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        // the app's own logo (same artwork as the launcher icon); scaled to drop the PNG's margin
        androidx.compose.foundation.Image(
            androidx.compose.ui.res.painterResource(app.gozarvpn.android.R.drawable.ic_launcher_fg), "GozarVpn",
            Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).graphicsLayer { scaleX = 1.45f; scaleY = 1.45f },
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("GozarVpn", fontWeight = FontWeight.Bold, fontSize = 19.sp, color = MaterialTheme.colorScheme.onBackground)
            Text("گذر آزاد و امن", color = Muted, fontSize = 11.5.sp)
        }
        Box(Modifier.size(10.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text(label, color = color, fontSize = 12.sp)
    }
}

/** The connect button: engine-coloured orb with state rings (idle glow / connecting arcs / connected waves). */
@Composable
private fun ConnectOrb(status: VpnStatus, c1: Color, c2: Color, stateColor: Color, clock: Long, onToggle: () -> Unit) {
    val wave = 0.5f - 0.5f * kotlin.math.cos(2.0 * Math.PI * ((clock % 3000L) / 3000f)).toFloat()
    val fastWave = 0.5f - 0.5f * kotlin.math.cos(2.0 * Math.PI * ((clock % 1200L) / 1200f)).toFloat()
    val spin = (clock % 1100L) / 1100f * 360f
    val spinBack = 360f - (clock % 1700L) / 1700f * 360f
    // remember when it turned Connected, for a one-off burst
    var connectedAt by remember { mutableLongStateOf(0L) }
    LaunchedEffect(status) { if (status == VpnStatus.Connected) connectedAt = clock }
    val burst = if (connectedAt > 0) ((clock - connectedAt) / 900f).coerceIn(0f, 1f) else 1f
    val scale = when (status) { VpnStatus.Connected -> 1f + 0.03f * wave; VpnStatus.Starting -> 0.96f + 0.05f * fastWave; else -> 1f }
    Box(Modifier.size(232.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val r0 = size.minDimension / 2
            // soft glow in the engine colour behind everything
            drawCircle(Brush.radialGradient(listOf(c1.copy(alpha = if (status == VpnStatus.Connected) 0.42f else 0.22f), Color.Transparent), center, r0))
            // dashed outer dial
            for (k in 0 until 60) rotate(k * 6f) {
                drawLine(Color.White.copy(alpha = if (k % 5 == 0) 0.16f else 0.06f), Offset(center.x, 4.dp.toPx()), Offset(center.x, (if (k % 5 == 0) 12 else 8).dp.toPx()), 1.5.dp.toPx())
            }
            when (status) {
                VpnStatus.Starting -> {
                    val thick = 7.dp.toPx(); val inset = 20.dp.toPx()
                    val arc = Size(size.width - 2 * inset, size.height - 2 * inset)
                    drawCircle(Warn.copy(alpha = 0.10f), radius = r0 - inset, style = Stroke(thick))
                    rotate(spin) { drawArc(Brush.sweepGradient(listOf(Warn.copy(alpha = 0f), Warn, Warn.copy(alpha = 0f))), 0f, 170f, false, Offset(inset, inset), arc, style = Stroke(thick, cap = StrokeCap.Round)) }
                    rotate(spinBack) { drawArc(c1.copy(alpha = 0.7f), 0f, 60f, false, Offset(inset + thick * 1.6f, inset + thick * 1.6f), Size(arc.width - 3.2f * thick, arc.height - 3.2f * thick), style = Stroke(thick * 0.45f, cap = StrokeCap.Round)) }
                }
                VpnStatus.Connected -> {
                    for (r in listOf((clock % 1800L) / 1800f, ((clock + 900L) % 1800L) / 1800f)) {
                        drawCircle(Good.copy(alpha = 0.6f * (1f - r)), radius = r0 * (0.66f + 0.30f * r), style = Stroke(3.dp.toPx()))
                    }
                    if (burst < 1f) drawCircle(Good.copy(alpha = 0.5f * (1f - burst)), radius = r0 * (0.6f + 0.4f * burst))
                    drawCircle(Brush.sweepGradient(listOf(c1, c2, c1)), radius = r0 - 20.dp.toPx(), style = Stroke(2.5.dp.toPx()))
                }
                else -> drawCircle(stateColor.copy(alpha = 0.18f + 0.14f * wave), radius = r0 - 20.dp.toPx(), style = Stroke(2.dp.toPx()))
            }
        }
        Box(
            Modifier.size(146.dp).graphicsLayer { scaleX = scale; scaleY = scale }.clip(CircleShape)
                .background(Brush.linearGradient(if (status == VpnStatus.Stopped || status == VpnStatus.Error) listOf(c1.copy(alpha = 0.55f), c2.copy(alpha = 0.55f)) else listOf(c1, c2)))
                .border(BorderStroke(3.dp, Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.55f), stateColor.copy(alpha = 0.6f)))), CircleShape)
                .clickable(onClick = onToggle),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.PowerSettingsNew, "اتصال", tint = Color.White, modifier = Modifier.size(60.dp)) }
    }
}

@Composable
private fun QuickAction(icon: ImageVector, text: String, tint: Color, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier.clip(RoundedCornerShape(16.dp)).background(tint.copy(alpha = if (enabled) 0.14f else 0.05f))
            .border(1.dp, tint.copy(alpha = if (enabled) 0.35f else 0.12f), RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (enabled) tint else Muted, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = if (enabled) MaterialTheme.colorScheme.onSurface else Muted)
    }
}

/** Live numbers while connected: ping, down/up speed with session totals. */
@Composable
fun LiveStats(connected: Boolean, pingMs: Long?, pingChecked: Boolean) {
    var down by remember { mutableLongStateOf(0L) }
    var up by remember { mutableLongStateOf(0L) }
    var totalDown by remember { mutableLongStateOf(0L) }
    var totalUp by remember { mutableLongStateOf(0L) }
    LaunchedEffect(connected) {
        down = 0; up = 0; totalDown = 0; totalUp = 0
        if (!connected) return@LaunchedEffect
        // the tunnel's outer traffic (and the engine child processes) all run under our uid
        val uid = android.os.Process.myUid()
        val rx0 = android.net.TrafficStats.getUidRxBytes(uid); val tx0 = android.net.TrafficStats.getUidTxBytes(uid)
        var lastRx = rx0; var lastTx = tx0
        while (true) {
            delay(1000)
            val rx = android.net.TrafficStats.getUidRxBytes(uid); val tx = android.net.TrafficStats.getUidTxBytes(uid)
            if (rx < 0 || tx < 0) break // counters unsupported on this device
            down = rx - lastRx; up = tx - lastTx; lastRx = rx; lastTx = tx
            totalDown = rx - rx0; totalUp = tx - tx0
        }
    }
    GCard {
        Row(Modifier.fillMaxWidth()) {
            val pingTint = when { pingMs == null -> Muted; pingMs < 400 -> Good; pingMs < 1000 -> Warn; else -> Bad }
            StatCell(Icons.Filled.NetworkCheck, "پینگ", when { !connected -> "—"; !pingChecked -> "…"; pingMs == null -> "✗"; else -> ltr("$pingMs ms") }, null, pingTint, Modifier.weight(1f))
            StatCell(Icons.Filled.ArrowDownward, "دانلود", if (connected) ltr("${fmtBytes(down)}/s") else "—", if (connected) "مجموع ${ltr(fmtBytes(totalDown))}" else null, Color(0xFF38BDF8), Modifier.weight(1f))
            StatCell(Icons.Filled.ArrowUpward, "آپلود", if (connected) ltr("${fmtBytes(up)}/s") else "—", if (connected) "مجموع ${ltr(fmtBytes(totalUp))}" else null, Rose, Modifier.weight(1f))
        }
    }
}

@Composable
private fun StatCell(icon: ImageVector, title: String, value: String, sub: String?, tint: Color, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        IconTile(icon, tint, 38)
        Text(value, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, color = MaterialTheme.colorScheme.onSurface)
        Text(title, color = Muted, fontSize = 11.5.sp)
        if (sub != null) Text(sub, color = Muted, fontSize = 10.5.sp, maxLines = 1)
    }
}

/** Mode / region rows for the selected engine, right on the home screen. */
@Composable
private fun EngineOptions(vm: AppViewModel, app: AppState, busy: Boolean) {
    val s = app.settings
    val set: ((app.gozarvpn.android.data.Settings) -> app.gozarvpn.android.data.Settings) -> Unit = { vm.repo.updateSettings(it) }
    val countries = listOf("" to "سریع‌ترین / خودکار") + EXIT_COUNTRIES.map { it to "${flag(it)} $it" }
    when (s.engine) {
        "tor" -> {
            OptionRow(Icons.Filled.Route, "روش", listOf("warp", "auto", "obfs4", "webtunnel", "snowflake", "vanilla").map { it to torModeLabel(it) }, s.torMode, !busy) { v -> set { it.copy(torMode = v) } }
            OptionRow(Icons.Filled.Public, "منطقه‌ی خروج", countries, s.torExitCountry.uppercase(), !busy) { v -> set { it.copy(torExitCountry = v) } }
        }
        "psiphon" -> {
            OptionRow(Icons.Filled.Route, "مسیر", listOf("aether" to "از طریق Aether (WARP)", "only" to "فقط سایفون"), s.psiphonRoute, !busy) { v -> set { it.copy(psiphonRoute = v) } }
            OptionRow(Icons.Filled.Tune, "روش", listOf("auto" to "خودکار", "cdn" to "فقط CDN", "direct" to "مستقیم"), s.psiphonMode, !busy) { v -> set { it.copy(psiphonMode = v) } }
            OptionRow(Icons.Filled.Public, "منطقه‌ی خروج", countries, s.psiphonRegion, !busy) { v -> set { it.copy(psiphonRegion = v) } }
        }
        "aether" -> OptionRow(Icons.Filled.Tune, "پروتکل", listOf("smart" to "هوشمند", "masque" to "MASQUE", "wireguard" to "WireGuard", "gool" to "WARP×2"), s.aetherProtocol, !busy) { v -> set { it.copy(aetherProtocol = v) } }
        "singbox" -> {
            InfoLine(Icons.Filled.Dns, "سرور", if (s.v2rayAuto) "خودکار (سریع‌ترین سالم)" else app.configs.firstOrNull { it.id == app.activeId }?.name ?: "انتخاب نشده")
            OptionRow(Icons.Filled.Shield, "ضد DPI هوشمند", listOf("on" to "روشن", "off" to "خاموش"), if (s.dpiSmart) "on" else "off", true) { v -> set { it.copy(dpiSmart = v == "on") } }
        }
        "mihomo" -> InfoLine(Icons.Filled.Dns, "پروفایل", s.clashProfiles.firstOrNull { it.id == s.clashActive }?.name ?: "بدون پروفایل")
    }
}

@Composable
private fun InfoLine(icon: ImageVector, title: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = Muted, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(title, color = Muted, fontSize = 13.sp)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 13.sp, maxLines = 1, modifier = Modifier.widthIn(max = 200.dp))
    }
}

/** A labelled value that opens a small menu of choices. */
@Composable
private fun OptionRow(icon: ImageVector, title: String, options: List<Pair<String, String>>, selected: String, enabled: Boolean, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = Muted, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(title, color = Muted, fontSize = 13.sp)
        Spacer(Modifier.weight(1f))
        Box {
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(Color(0x1FFFFFFF)).clickable(enabled = enabled) { open = true }
                    .padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(options.firstOrNull { it.first == selected }?.second ?: selected, fontSize = 13.sp, maxLines = 1)
                Icon(Icons.Filled.ArrowDropDown, null, tint = Muted, modifier = Modifier.size(18.dp))
            }
            DropdownMenu(open, { open = false }) {
                for ((v, l) in options) DropdownMenuItem(
                    text = { Text(l, fontWeight = if (v == selected) FontWeight.Bold else FontWeight.Normal) },
                    onClick = { open = false; onSelect(v) },
                )
            }
        }
    }
}

/** Keeps "150.6 KB/s" / "155 ms" in that order inside right-to-left text (a left-to-right isolate). */
fun ltr(s: String) = "\u2066$s\u2069"

fun fmtBytes(b: Long): String = when {
    b < 1024 -> "$b B"
    b < 1024 * 1024 -> "%.1f KB".format(b / 1024.0)
    b < 1024L * 1024 * 1024 -> "%.1f MB".format(b / 1048576.0)
    else -> "%.2f GB".format(b / 1073741824.0)
}

/** Country code -> flag emoji (regional indicator letters). */
fun flag(cc: String): String = if (cc.length != 2 || !cc.all { it.isLetter() }) ""
    else cc.uppercase().map { String(Character.toChars(0x1F1E6 + (it - 'A'))) }.joinToString("")
