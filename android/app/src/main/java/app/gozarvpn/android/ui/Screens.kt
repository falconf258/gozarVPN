package app.gozarvpn.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import app.gozarvpn.android.core.ProxyCores
import app.gozarvpn.android.vpn.GozarVpnService
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.gozarvpn.android.data.*
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import app.gozarvpn.android.vpn.VpnStatus
import app.gozarvpn.android.vpn.VpnUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

fun torModeLabel(m: String) = when (m) {
    "warp" -> "از طریق WARP"; "obfs4" -> "obfs4"; "webtunnel" -> "webtunnel"; "snowflake" -> "snowflake"; "vanilla" -> "پل ساده"; else -> "خودکار"
}

/* ----------------------------- Configs ----------------------------- */

@Composable
fun ConfigsHost(vm: AppViewModel, app: AppState, busy: Boolean, modifier: Modifier = Modifier) {
    var section by remember { mutableStateOf("v2ray") }
    Column(modifier.fillMaxSize()) {
        // five sections don't fit a phone's width: the track scrolls sideways
        val sectionEngine = mapOf("v2ray" to "singbox", "mihomo" to "mihomo", "aether" to "aether", "tor" to "tor", "psiphon" to "psiphon")
        PillTabs(
            listOf("v2ray" to "V2ray / Xray", "mihomo" to "Clash", "aether" to "Aether", "tor" to "Tor", "psiphon" to "سایفون"), section,
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp), colorsOf = { engineColors(sectionEngine[it] ?: it) },
        ) { section = it }
        when (section) {
            "v2ray" -> V2rayScreen(vm, app, busy)
            "mihomo" -> ClashScreen(vm, app, busy)
            "aether" -> AetherScreen(vm, app)
            "tor" -> TorScreen(vm, app)
            "psiphon" -> PsiphonScreen(vm, app)
        }
    }
}

@Composable
fun PsiphonScreen(vm: AppViewModel, app: AppState) {
    val s = app.settings
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GCard {
            H("مسیر")
            ChoiceChips(listOf("aether" to "از طریق Aether (WARP)", "only" to "فقط سایفون"), s.psiphonRoute) { v -> vm.repo.updateSettings { it.copy(psiphonRoute = v) } }
            Hint("«از طریق Aether»: اول WARP وصل می‌شود و سایفون از داخلش می‌رود. وقتی سرورهای سایفون مستقیم باز نمی‌شوند، این بهتر است. «فقط سایفون» بدون WARP است و معمولاً زودتر وصل می‌شود.")
        }
        GCard {
            H("روش اتصال سایفون")
            ChoiceChips(listOf("auto" to "خودکار", "cdn" to "فقط از طریق CDN", "direct" to "مستقیم"), s.psiphonMode) { v -> vm.repo.updateSettings { it.copy(psiphonMode = v) } }
            Hint("اگر در شبکه‌ی شما وصل نمی‌شود، «فقط از طریق CDN» را امتحان کنید.")
        }
        GCard {
            H("کشور خروجی")
            ChoiceChips(listOf("" to "سریع‌ترین") + listOf("DE", "NL", "GB", "FR", "US", "CA", "SE", "FI", "AT", "SG", "JP").map { it to "${flag(it)} $it" }, s.psiphonRegion) { v ->
                vm.repo.updateSettings { it.copy(psiphonRegion = v) }
            }
            Hint("همیشه همه‌ی کشورها در دسترس نیستند. کشورهایی که موجودند موقع اتصال در لاگ می‌آیند (AvailableEgressRegions).")
        }
        Hint("بار اول ممکن است وصل شدن سایفون یکی دو دقیقه طول بکشد. پیشرفتش را در تب لاگ می‌بینید.")
    }
}

@Composable
fun ComingSoonCard(title: String, text: String) {
    GCard {
        H(title)
        Hint(text)
        Text("به‌زودی", color = Warn, fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun AetherScreen(vm: AppViewModel, app: AppState) {
    val s = app.settings
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GCard {
            H("هسته‌ی Aether")
            Hint("همان هسته‌ی WARP/MASQUE نسخه‌ی ویندوز است. در خانه موتور Aether را انتخاب کنید و وصل شوید. اتصال اول ممکن است تا یک دقیقه طول بکشد، چون باید اسکن کند و WARP را ثبت کند. پیشرفتش در تب لاگ هست.")
        }
        val set: ((Settings) -> Settings) -> Unit = { f -> vm.repo.updateSettings(f) }
        GCard {
            H("پروتکل")
            ChoiceChips(
                listOf("smart" to "هوشمند", "masque" to "MASQUE", "wireguard" to "WireGuard", "gool" to "WARP×2"),
                s.aetherProtocol,
            ) { v -> set { it.copy(aetherProtocol = v) } }
            Hint("حالت هوشمند MASQUE، WireGuard و WARP×2 (WARP داخل WARP) را به ترتیب امتحان می‌کند و اولین موردی را که واقعاً کار کرد نگه می‌دارد.")
            H("حالت اسکن")
            ChoiceChips(
                listOf("turbo" to "سریع", "balanced" to "متعادل", "thorough" to "کامل", "stealth" to "مخفی", "ironclad" to "ironclad"),
                s.aetherScan.let { if (it == "fast") "turbo" else if (it == "deep") "thorough" else it },
            ) { v -> set { it.copy(aetherScan = v) } }
            H("نسخه‌ی IP")
            ChoiceChips(listOf("4" to "IPv4", "6" to "IPv6", "dual" to "هر دو"), s.aetherIp) { v -> set { it.copy(aetherIp = v) } }
        }
        GCard {
            H("انتقال و ضد DPI")
            H("مبهم‌سازی (Noize)")
            ChoiceChips(
                listOf("off" to "خاموش", "light" to "سبک", "balanced" to "متعادل", "aggressive" to "قوی"),
                s.aetherNoize.let { if (it == "strong") "aggressive" else it },
            ) { v -> set { it.copy(aetherNoize = v) } }
            Hint("بسته‌های بی‌معنی و دست‌دادن جعلی می‌فرستد تا DPI تونل را نشناسد.")
            H("Endpoint")
            var manual by remember(s.aetherPeer) { mutableStateOf(s.aetherPeer.isNotBlank()) }
            ChoiceChips(listOf("auto" to "اسکن خودکار", "manual" to "IP دستی"), if (manual) "manual" else "auto") { v ->
                manual = v == "manual"; if (!manual) set { it.copy(aetherPeer = "") }
            }
            if (manual) SettingField("IP:پورت (مثلاً 162.159.192.1:2408)", s.aetherPeer) { v -> set { it.copy(aetherPeer = v) } }
            SettingField("Keepalive (ثانیه، خالی = پیش‌فرض)", s.aetherKeepalive, number = true) { v -> set { it.copy(aetherKeepalive = v) } }
            SettingSwitch("تکه‌تکه کردن TLS", "دست‌دادن TLS را چند تکه می‌کند تا از DPI رد شود", s.aetherFragment) { v -> set { it.copy(aetherFragment = v) } }
            if (s.aetherFragment) {
                SettingField("اندازه‌ی تکه‌ها (مثلاً 10-60)", s.aetherFragSize) { v -> set { it.copy(aetherFragSize = v) } }
                SettingField("تأخیر بین تکه‌ها، میلی‌ثانیه (مثلاً 5-20)", s.aetherFragDelay) { v -> set { it.copy(aetherFragDelay = v) } }
            }
            SettingSwitch("Encrypted Client Hello (ECH)", "اسم سایت مقصد (SNI) را از DPI پنهان می‌کند. شاید در ایران جواب ندهد. اگر هسته با ECH خطا داد، خودش بدون آن امتحان می‌کند", s.aetherEch) { v -> set { it.copy(aetherEch = v) } }
            SettingSwitch("MASQUE روی HTTP/2", "وقتی UDP/QUIC بسته است، MASQUE را روی TCP می‌برد", s.aetherH2) { v -> set { it.copy(aetherH2 = v) } }
            SettingSwitch("اتصال سریع دوباره", "اول همان endpoint سالم قبلی را امتحان می‌کند", s.aetherQuickReconnect) { v -> set { it.copy(aetherQuickReconnect = v) } }
            SettingField("DNS داخل تونل (خالی = 1.1.1.1, 1.0.0.1)", s.aetherDns) { v -> set { it.copy(aetherDns = v) } }
        }
        GCard {
            H("قوانین مسیر")
            Hint("با کاما جدا کنید. مثال: example.com، full:، keyword:، regexp:، 10.0.0.0/8، port:25 و private. اول مسدودها بررسی می‌شوند، بعد مستقیم‌ها.")
            SettingField("مسدود (هرگز بیرون نروند)", s.aetherRouteBlock) { v -> set { it.copy(aetherRouteBlock = v) } }
            SettingField("مستقیم (بدون تونل)", s.aetherRouteDirect) { v -> set { it.copy(aetherRouteDirect = v) } }
        }
        GCard {
            H("امنیت و پایداری")
            SettingSwitch("جلوگیری از نشت IPv6", "IPv6 هم وارد تونل می‌شود و همان‌جا دور ریخته می‌شود تا از کنار VPN بیرون نرود (برای همه‌ی موتورها)", s.blockIpv6Leak) { v -> set { it.copy(blockIpv6Leak = v) } }
            SettingField("تعداد تلاش برای اتصال دوباره (۰ = خاموش)", s.reconnectAttempts.toString(), number = true) { v -> set { it.copy(reconnectAttempts = v.toIntOrNull()?.coerceIn(0, 20) ?: 0) } }
            SettingSwitch(
                "کیل‌سوییچ",
                "اگر وسط کار اتصال قطع شود یا هسته از کار بیفتد، تونل باز می‌ماند ولی ترافیک بسته می‌شود تا چیزی بیرون از VPN نرود. با وصل شدن دوباره، توقف موقت یا «قطع» دوباره باز می‌شود",
                s.killSwitch,
            ) { v -> set { it.copy(killSwitch = v) } }
            Hint("سایت‌های ایرانی (در حالت «ایران مستقیم»)، لیست مستقیم شما و «برنامه‌های همیشه مستقیم» از اول قرار نیست از VPN بروند، پس بسته هم نمی‌شوند. توقف موقت هم بسته بودن را برمی‌دارد.")
            Hint("اگر می‌خواهید حتی وقتی برنامه بسته است یا گوشی تازه روشن شده هم محافظت شوید، در تنظیمات اندروید برای GozarVpn «VPN همیشه روشن» و «مسدود کردن اتصال‌های بدون VPN» را روشن کنید. با گزینه‌ی دوم ممکن است برنامه‌های همیشه مستقیم اینترنت نداشته باشند.")
            val ctx = LocalContext.current
            OutlinedButton({
                runCatching { ctx.startActivity(android.content.Intent(android.provider.Settings.ACTION_VPN_SETTINGS).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    .onFailure { Toast.makeText(ctx, "تنظیمات VPN باز نشد", Toast.LENGTH_SHORT).show() }
            }, Modifier.fillMaxWidth()) { Text("باز کردن تنظیمات VPN اندروید") }
        }
        GCard {
            H("تنظیمات پیشرفته‌ی هسته")
            SettingSwitch("بدون بررسی داده", "از آزمون عبور داده‌ی خود هسته بعد از اتصال صرف‌نظر می‌کند", s.aetherNoDataCheck) { v -> set { it.copy(aetherNoDataCheck = v) } }
            SettingField("گروه‌های TLS (مثلاً P-256:X25519:P-384)", s.aetherTlsGroups) { v -> set { it.copy(aetherTlsGroups = v) } }
            SettingField("ثانیه‌های اعتبارسنجی (خالی = پیش‌فرض)", s.aetherValidateSecs, number = true) { v -> set { it.copy(aetherValidateSecs = v) } }
            SettingField("ثانیه‌های اتصال دوباره (خالی = پیش‌فرض)", s.aetherReconnectSecs, number = true) { v -> set { it.copy(aetherReconnectSecs = v) } }
            SettingSwitch("بدون امتحان پروفایل دیگر", "اگر پروفایل WireGuard شکست خورد، سراغ پروفایل‌های دیگر نرود", s.aetherNoProfileRetry) { v -> set { it.copy(aetherNoProfileRetry = v) } }
            H("سطح لاگ هسته")
            ChoiceChips(listOf("error" to "error", "warn" to "warn", "info" to "info", "debug" to "debug", "trace" to "trace"), s.aetherLogLevel) { v -> set { it.copy(aetherLogLevel = v) } }
        }
        GCard {
            OutlinedButton({
                val d = Settings()
                set {
                    it.copy(
                        aetherProtocol = d.aetherProtocol, aetherScan = d.aetherScan, aetherNoize = d.aetherNoize, aetherIp = d.aetherIp,
                        aetherPeer = d.aetherPeer, aetherKeepalive = d.aetherKeepalive, aetherH2 = d.aetherH2, aetherFragment = d.aetherFragment,
                        aetherFragSize = d.aetherFragSize, aetherFragDelay = d.aetherFragDelay, aetherEch = d.aetherEch,
                        aetherQuickReconnect = d.aetherQuickReconnect, aetherDns = d.aetherDns, aetherRouteBlock = d.aetherRouteBlock,
                        aetherRouteDirect = d.aetherRouteDirect, aetherNoDataCheck = d.aetherNoDataCheck, aetherTlsGroups = d.aetherTlsGroups,
                        aetherValidateSecs = d.aetherValidateSecs, aetherReconnectSecs = d.aetherReconnectSecs,
                        aetherNoProfileRetry = d.aetherNoProfileRetry, aetherLogLevel = d.aetherLogLevel,
                    )
                }
            }) { Text("بازگرداندن همه‌ی تنظیمات Aether به پیش‌فرض") }
        }
    }
}

@Composable
fun TorScreen(vm: AppViewModel, app: AppState) {
    val s = app.settings
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GCard {
            H("Tor")
            Hint("با پل‌ها (obfs4، webtunnel، snowflake) وصل می‌شود. در خانه موتور Tor را انتخاب کنید و وصل شوید. بالا آمدن Tor معمولاً بین ۳۰ ثانیه تا ۳ دقیقه طول می‌کشد و درصدش (Bootstrapped) در تب لاگ می‌آید.")
        }
        GCard {
            H("روش اتصال")
            ChoiceChips(
                listOf("warp" to "از طریق Aether (WARP)", "auto" to "خودکار", "obfs4" to "obfs4", "webtunnel" to "webtunnel", "snowflake" to "snowflake", "vanilla" to "پل ساده"),
                s.torMode,
            ) { v -> vm.repo.updateSettings { it.copy(torMode = v) } }
            Hint(if (s.torMode == "warp") "اول Aether (همان WARP) وصل می‌شود و Tor همه‌چیز را از داخلش می‌فرستد. پل و DNS ایران لازم ندارد و در ایران معمولاً پایدارترین روش است." else "قبل از هر اتصال، پل‌ها روی همین شبکه امتحان می‌شوند و فقط پل‌های سالم به Tor داده می‌شوند. فهرست پل‌ها از Tor-Bridges-Collector به‌روز می‌شود که هر ساعت تستشان می‌کند.")
            Text("بالا آمدن Tor ممکن است چند دقیقه طول بکشد. پیشرفتش زیر دکمه‌ی اتصال و در تب لاگ پیداست.", color = Warn, fontSize = 12.5.sp)
        }
        GCard {
            H("پل‌های دلخواه")
            Hint("پل‌هایی را که از bridges.torproject.org، ربات تلگرام یا ایمیل گرفته‌اید اینجا بچسبانید، هر خط یک پل (obfs4، webtunnel، snowflake، meek یا پل ساده). لازم نیست اول خط «Bridge» بنویسید.")
            var text by remember(s.torCustomBridges) { mutableStateOf(s.torCustomBridges) }
            OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().heightIn(min = 110.dp), textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                placeholder = { Text("obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0") })
            val verdicts = remember(text) { Bridges.checkAll(text) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button({ vm.repo.updateSettings { it.copy(torCustomBridges = text) } }, enabled = text != s.torCustomBridges) { Text("ذخیره") }
                Spacer(Modifier.width(10.dp))
                if (verdicts.isNotEmpty()) Text("${verdicts.count { it.ok }} پل درست از ${verdicts.size} خط", color = Muted, fontSize = 12.5.sp)
            }
            // one result per line; the cert part is never shown
            for ((i, v) in verdicts.withIndex()) Text(
                "خط ${i + 1}: " + if (v.ok) "✓ ${v.reason}" else "✗ ${v.reason}",
                color = if (v.ok) Good else Bad, fontSize = 12.sp,
            )
            SettingSwitch("فقط پل‌های من", "به‌جای فهرست پل‌های همراه برنامه، فقط همین پل‌ها استفاده شوند", s.torOnlyMine) { v -> vm.repo.updateSettings { it.copy(torOnlyMine = v) } }
            if (s.torMode == "warp" && s.torCustomBridges.isNotBlank()) Text("روش «از طریق Aether (WARP)» از پل استفاده نمی‌کند. برای این پل‌ها روش دیگری را انتخاب کنید.", color = Warn, fontSize = 12.sp)
            Hint("قبل از اتصال، پل‌ها روی همین شبکه امتحان می‌شوند و فقط پل‌های سالم به Tor می‌رسند. پل IPv6 روی شبکه‌ای که IPv6 ندارد کار نمی‌کند.")
        }
    }
}

@Composable
fun ClashScreen(vm: AppViewModel, app: AppState, busy: Boolean) {
    val s = app.settings
    var url by remember { mutableStateOf(s.clashUrl) }
    var pasted by remember { mutableStateOf("") }
    val status by vm.clashStatus.collectAsState()
    val vpn by GozarVpnService.state.collectAsState()
    val connected = vpn.status == VpnStatus.Connected && s.engine == "mihomo"
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GCard {
            H("Clash / mihomo")
            Hint("هر نوع اشتراکی را می‌خواند: Clash YAML، base64 یا لینک‌های vless/vmess/trojan/ss/hysteria2/tuic. همه‌ی سرورها در یک گروه قرار می‌گیرند و mihomo خودش سرور سالم را انتخاب می‌کند. بعد از ذخیره، در خانه موتور Clash را انتخاب کنید و وصل شوید.")
        }
        GCard {
            H("لینک اشتراک")
            OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("https://…") })
            Button({ vm.importClash(url) }, enabled = !busy && url.isNotBlank()) { Text("دریافت و ذخیره") }
        }
        GCard {
            H("از فایل یا متن")
            val ctx = LocalContext.current
            // system file picker: no storage permission; the file is copied into the app
            val picker = androidx.activity.compose.rememberLauncherForActivityResult(
                androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
            ) { uri -> if (uri != null) vm.importClashFile(uri) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ picker.launch(arrayOf("*/*")) }) { Text("انتخاب فایل (yaml / txt)") }
                OutlinedButton({
                    val clip = ctx.getSystemService(ClipboardManager::class.java)?.primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString()
                    if (clip.isNullOrBlank()) Toast.makeText(ctx, "کلیپ‌بورد خالی است", Toast.LENGTH_SHORT).show() else vm.saveClashText(clip, "از کلیپ‌بورد")
                }) { Text("چسباندن از کلیپ‌بورد") }
            }
            OutlinedTextField(pasted, { pasted = it }, Modifier.fillMaxWidth().heightIn(min = 100.dp), placeholder = { Text("proxies: … یا vless://… هر خط یکی") })
            Button({ vm.saveClashText(pasted); pasted = "" }, enabled = pasted.isNotBlank()) { Text("ذخیره از متن") }
        }
        status?.let { (ok, text) -> Text(text, color = if (ok) Good else Bad, fontSize = 13.sp) }
        if (s.clashProfiles.isEmpty()) GCard { EmptyState(Icons.Filled.CloudOff, "پروفایلی ذخیره نشده", "لینک اشتراک Clash را بالا وارد کنید یا فایل yaml را از حافظه‌ی گوشی انتخاب کنید.") }
        if (s.clashProfiles.isNotEmpty()) GCard {
            H("پروفایل‌ها (${s.clashProfiles.size})")
            var renaming by remember { mutableStateOf<ClashProfile?>(null) }
            var renameText by remember { mutableStateOf("") }
            for (p in s.clashProfiles) {
                val active = p.id == s.clashActive
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                        .background(if (active) Orange.copy(alpha = 0.14f) else Color.Transparent)
                        .clickable { vm.setActiveClash(p.id) }.padding(start = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(active, { vm.setActiveClash(p.id) })
                    Column(Modifier.weight(1f)) {
                        Text(p.name, maxLines = 1)
                        Text(if (p.sourceUrl != null) "از لینک" else "از فایل/متن", color = Muted, fontSize = 11.5.sp)
                    }
                    IconButton({ renaming = p; renameText = p.name }) { Icon(Icons.Filled.Edit, "تغییر نام", tint = Muted) }
                    IconButton({ vm.deleteClash(p.id) }) { Icon(Icons.Filled.Delete, "حذف", tint = Muted) }
                }
            }
            if (connected) Hint("تغییر پروفایل از اتصال بعدی اعمال می‌شود.")
            renaming?.let { p ->
                AlertDialog(
                    onDismissRequest = { renaming = null },
                    title = { Text("تغییر نام پروفایل") },
                    text = { OutlinedTextField(renameText, { renameText = it }, singleLine = true) },
                    confirmButton = { TextButton({ vm.renameClash(p.id, renameText); renaming = null }) { Text("ذخیره") } },
                    dismissButton = { TextButton({ renaming = null }) { Text("انصراف") } },
                )
            }
        }
        GCard {
            H("انتخاب خودکار (AUTO)")
            ChoiceChips(
                listOf("url-test" to "سریع‌ترین", "fallback" to "پشتیبان", "load-balance" to "پخش بار"),
                s.clashGroupType.let { if (it == "select") "url-test" else it },
            ) { v -> vm.repo.updateSettings { it.copy(clashGroupType = v) } }
            Hint("AUTO خودش بین سرورها انتخاب می‌کند؛ یا از فهرست پایین یک سرور مشخص را بزنید.")
        }
        ClashServerList(vm, app, connected)
    }
}

private val FLAG = Regex("[\\uD83C][\\uDDE6-\\uDDFF][\\uD83C][\\uDDE6-\\uDDFF]")

@Composable
fun ClashServerList(vm: AppViewModel, app: AppState, connected: Boolean) {
    val s = app.settings
    val nodes by vm.clashNodes.collectAsState()
    var query by remember { mutableStateOf("") }
    LaunchedEffect(connected, s.clashActive) { vm.loadClashNodes(connected) }
    GCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            H("سرورها (${(nodes.size - 1).coerceAtLeast(0)})")
            Spacer(Modifier.weight(1f))
            TextButton({ vm.loadClashNodes(connected) }) { Text("تازه‌سازی") }
            if (connected) TextButton({ vm.testClashDelays() }) { Text("تست پینگ") }
        }
        // country = flag emoji in the server names; picking one becomes mihomo's group filter
        val flags = nodes.flatMap { n -> FLAG.findAll(n.name).map { it.value }.toList() }.distinct()
        if (flags.isNotEmpty()) {
            H("کشور")
            ChoiceChips(listOf("" to "همه") + flags.map { it to it }, s.clashFilter) { v -> vm.repo.updateSettings { it.copy(clashFilter = v) } }
        }
        SettingField("فیلتر نام (regex، مثلاً Germany|DE)", s.clashFilter) { v -> vm.repo.updateSettings { it.copy(clashFilter = v) } }
        Hint("فیلتر کشور/نام از اتصال بعدی اعمال می‌شود. " + if (connected) "پینگ‌ها از داخل خود mihomo گرفته می‌شوند." else "برای تست پینگ و انتخاب زنده، اول با Clash وصل شوید.")
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("جستجو در نام سرورها") })
        val filterRe = runCatching { s.clashFilter.trim().takeIf { it.isNotEmpty() }?.let { Regex(it) } }.getOrNull()
        val shown = nodes.filter { n ->
            (n.name == "AUTO" || filterRe == null || filterRe.containsMatchIn(n.name)) && (query.isBlank() || n.name.contains(query, ignoreCase = true))
        }
        for (n in shown.take(300)) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                    .background(if (n.current) Orange.copy(alpha = 0.14f) else Color.Transparent)
                    .clickable { vm.selectClash(n.name, connected) }.padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (n.name == "AUTO") "AUTO (انتخاب خودکار)" else n.name, Modifier.weight(1f), maxLines = 1)
                if (n.tested) {
                    val ms = n.delay
                    val tint = when { ms == null -> Bad; ms < 300 -> Good; ms < 800 -> Warn; else -> Bad }
                    Text(ms?.let { "$it ms" } ?: "ناموفق", color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(tint.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp))
                }
                if (n.current) Icon(Icons.Filled.Check, null, tint = Orange, modifier = Modifier.padding(start = 6.dp))
            }
        }
        if (shown.size > 300) Hint("${shown.size - 300} سرور دیگر؛ با جستجو محدود کنید.")
    }
}

@Composable
fun V2rayScreen(vm: AppViewModel, app: AppState, busy: Boolean) {
    var subUrl by remember { mutableStateOf("") }
    var subName by remember { mutableStateOf("") }
    var pasted by remember { mutableStateOf("") }
    var confirmGroup by remember { mutableStateOf<String?>(null) }
    var renameGroup by remember { mutableStateOf<Group?>(null) }
    var renameText by remember { mutableStateOf("") }
    val expanded = remember { mutableStateListOf<String>() }
    val favorites = app.configs.filter { it.favorite }
    val run by vm.testRun.collectAsState()
    fun ranked(list: List<ConfigEntry>): List<ConfigEntry> {
        if (list.none { app.results.containsKey(it.id) }) return list
        return list.sortedBy { c ->
            val r = app.results[c.id]
            when { r == null -> Long.MAX_VALUE / 2; r.ok -> r.latencyMs ?: 0L; else -> Long.MAX_VALUE }
        }
    }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            GCard {
                H("تست کانفیگ‌ها")
                Hint("اتصال TCP/TLS (و WebSocket) هر سرور را امتحان می‌کند. کانفیگ‌های WireGuard تست نمی‌شوند. نتیجه ذخیره می‌شود و با تست بعدی عوض می‌شود.")
                val r = run
                if (r != null) {
                    LinearProgressIndicator(progress = { if (r.total == 0) 0f else r.done / r.total.toFloat() }, modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${r.done} از ${r.total}", color = Muted, fontSize = 13.sp)
                        Spacer(Modifier.weight(1f))
                        TextButton({ vm.cancelTest() }) { Text("لغو", color = Bad) }
                    }
                } else {
                    val okCount = app.configs.count { app.results[it.id]?.ok == true }
                    val tested = app.configs.count { app.results.containsKey(it.id) }
                    if (tested > 0) Text("$okCount سالم از $tested تست‌شده", color = Muted, fontSize = 13.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({ vm.testConfigs(app.configs) }, enabled = app.configs.isNotEmpty()) { Text("تست همه (${app.configs.size})") }
                        val fastest = app.configs.filter { app.results[it.id]?.ok == true }.minByOrNull { app.results[it.id]?.latencyMs ?: Long.MAX_VALUE }
                        if (fastest != null) OutlinedButton({ vm.repo.setActive(fastest.id); vm.repo.updateSettings { it.copy(v2rayAuto = false) } }) { Text("انتخاب سریع‌ترین") }
                    }
                }
            }
        }
        if (app.configs.isEmpty()) item {
            GCard { EmptyState(Icons.Filled.CloudOff, "هنوز کانفیگی ندارید", "لینک سابسکریپشن یا لینک‌های vless / vmess / trojan / ss را در کارت‌های پایین اضافه کنید.") }
        }
        item {
            GCard {
                SettingSwitch(
                    "انتخاب خودکار",
                    "موقع اتصال سریع‌ترین سرور سالم انتخاب می‌شود و اگر ۱۰ بار پشت سر هم جواب ندهد، سرور خودکار عوض می‌شود. اگر خودتان روی سروری بزنید، همان انتخاب می‌شود و این گزینه خاموش می‌شود.",
                    app.settings.v2rayAuto,
                ) { v -> vm.repo.updateSettings { it.copy(v2rayAuto = v) } }
            }
        }
        item {
            GCard {
                SettingSwitch(
                    "ضد DPI هوشمند",
                    "موقع اتصال چند روش تکه‌کردن دست‌دادن TLS را با یک درخواست واقعی امتحان می‌کند و روشی را که جواب داد برای همان سرور یادش می‌ماند. اتصال اول ممکن است چند ثانیه بیشتر طول بکشد.",
                    app.settings.dpiSmart,
                ) { v -> vm.repo.updateSettings { it.copy(dpiSmart = v) } }
                val cur = app.configs.firstOrNull { it.id == app.activeId }
                if (cur != null && Dpi.applies(cur)) {
                    val manual = app.dpiManual[cur.id]
                    val learned = app.dpiLearned[cur.id]
                    Hint("روش برای «${cur.name}»" + if (manual == null && learned != null) " · آخرین روش موفق: ${Dpi.label(learned)}" else "")
                    // a manual pick always wins over the automatic choice
                    ChoiceChips(listOf("auto" to "خودکار") + Dpi.PROFILES.map { it to Dpi.label(it) }, manual ?: "auto") { p ->
                        vm.repo.setDpiManual(cur.id, p.takeIf { it != "auto" })
                    }
                } else if (cur != null) Hint("سرور انتخاب‌شده TLS ندارد و این گزینه رویش اثری ندارد.")
            }
        }
        item {
            GCard {
                H("افزودن ساب")
                OutlinedTextField(subName, { subName = it }, label = { Text("نام (اختیاری)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(subUrl, { subUrl = it }, label = { Text("لینک سابسکریپشن") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button({ vm.importSubscription(subUrl, subName); subUrl = "" }, enabled = subUrl.isNotBlank() && !busy) {
                    Text(if (busy) "در حال دریافت…" else "دریافت و افزودن")
                }
                val st by vm.subStatus.collectAsState()
                st?.let { (ok, text) -> Text(text, color = if (ok) Good else Bad, fontSize = 12.5.sp, lineHeight = 19.sp) }
            }
        }
        item {
            GCard {
                H("افزودن لینک")
                Hint("vless، vmess، trojan، ss و wireguard (هر خط یک لینک)، یا متن کامل فایل .conf (WireGuard یا AmneziaWG) یا .ovpn (OpenVPN). OpenVPN در ایران راحت شناسایی می‌شود؛ «ایران مستقیم» برای آن بر اساس IP و از اندروید ۱۳ کار می‌کند.")
                OutlinedTextField(pasted, { pasted = it }, label = { Text("لینک‌ها") }, modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button({ vm.importText(pasted, subName); pasted = "" }, enabled = pasted.isNotBlank()) { Text("افزودن") }
                    // WireGuard / AmneziaWG .conf files: picked with the system file picker, no storage permission
                    val ctx = LocalContext.current
                    val picker = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()) { uri ->
                        if (uri != null) runCatching { ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes().toString(Charsets.UTF_8) } }
                            .onSuccess { vm.importText(it, subName) }
                            .onFailure { Toast.makeText(ctx, "فایل خوانده نشد", Toast.LENGTH_SHORT).show() }
                    }
                    OutlinedButton({ picker.launch(arrayOf("*/*")) }) { Text("فایل .conf / .ovpn") }
                }
            }
        }
        item {
            GCard {
                H("WARP رایگان Cloudflare")
                Hint("یک اکانت WARP رایگان می‌سازد و به‌صورت کانفیگ WireGuard به لیست اضافه می‌کند.")
                Button({ vm.addWarp() }, enabled = !busy) { Text(if (busy) "در حال ساخت…" else "ساخت و افزودن WARP") }
            }
        }
        if (favorites.isNotEmpty()) {
            item { Text("⭐ علاقه‌مندی‌ها (${favorites.size})", color = Warn, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp)) }
            items(ranked(favorites), key = { "fav-" + it.id }) { ConfigRow(it, app, vm) }
        }
        for (g in app.groups) {
            val rows = app.configs.filter { it.groupId == g.id }
            val open = g.id in expanded
            item(key = "g-" + g.id) {
                GroupHeader(
                    g.name, rows.size, rows.count { app.results[it.id]?.ok == true }, open, run != null,
                    onToggle = { if (open) expanded.remove(g.id) else expanded.add(g.id) },
                    canRefresh = g.sourceUrl != null && !busy,
                    onTest = { vm.testConfigs(rows) },
                    onRefresh = { vm.refreshGroup(g) },
                    onRename = { renameGroup = g; renameText = g.name },
                    onDelete = { confirmGroup = g.id },
                )
            }
            if (open) items(ranked(rows), key = { it.id }) { ConfigRow(it, app, vm) }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }

    renameGroup?.let { g ->
        AlertDialog(
            onDismissRequest = { renameGroup = null },
            title = { Text("تغییر نام گروه") },
            text = { OutlinedTextField(renameText, { renameText = it }, singleLine = true) },
            confirmButton = { TextButton({ if (renameText.isNotBlank()) vm.repo.renameGroup(g.id, renameText.trim()); renameGroup = null }) { Text("ذخیره") } },
            dismissButton = { TextButton({ renameGroup = null }) { Text("انصراف") } },
        )
    }
    confirmGroup?.let { gid ->
        val g = app.groups.firstOrNull { it.id == gid }
        AlertDialog(
            onDismissRequest = { confirmGroup = null },
            title = { Text("حذف گروه") },
            text = { Text("گروه «${g?.name}» با تمام کانفیگ‌هایش حذف شود؟") },
            confirmButton = { TextButton({ vm.repo.deleteGroup(gid); confirmGroup = null }) { Text("حذف", color = Bad) } },
            dismissButton = { TextButton({ confirmGroup = null }) { Text("انصراف") } },
        )
    }
}

@Composable
private fun GroupHeader(
    title: String, count: Int, okCount: Int, open: Boolean, testing: Boolean,
    canRefresh: Boolean, onToggle: () -> Unit, onTest: () -> Unit, onRefresh: () -> Unit, onRename: () -> Unit, onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp).clickable(onClick = onToggle),
    ) {
        Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null, tint = Muted)
            Spacer(Modifier.width(6.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.Bold, maxLines = 1)
                Text(if (okCount > 0) "$count کانفیگ · $okCount سالم" else "$count کانفیگ", color = Muted, fontSize = 12.sp)
            }
            IconButton(onTest, enabled = !testing) { Icon(Icons.Filled.Speed, "تست گروه", tint = if (testing) Muted else Orange) }
            Box {
                IconButton({ menu = true }) { Icon(Icons.Filled.MoreVert, "گزینه‌ها", tint = Muted) }
                DropdownMenu(menu, { menu = false }) {
                    if (canRefresh) DropdownMenuItem({ Text("به‌روزرسانی از لینک") }, { menu = false; onRefresh() })
                    DropdownMenuItem({ Text("تغییر نام") }, { menu = false; onRename() })
                    DropdownMenuItem({ Text("حذف گروه", color = Bad) }, { menu = false; onDelete() })
                }
            }
        }
    }
}

@Composable
private fun ConfigRow(c: ConfigEntry, app: AppState, vm: AppViewModel) {
    val active = c.id == app.activeId
    val result: TestResult? = app.results[c.id]
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = if (active) BorderStroke(1.dp, Orange) else null,
        shape = RoundedCornerShape(14.dp),
        // a manual pick always wins over automatic selection
        modifier = Modifier.fillMaxWidth().clickable { vm.repo.setActive(c.id); vm.repo.updateSettings { it.copy(v2rayAuto = false) } },
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(c.name, maxLines = 1)
                Text(c.protocol.uppercase() + (if (active) " · فعال" else ""), color = Muted, fontSize = 12.sp)
            }
            if (result != null) {
                val ms = result.latencyMs ?: 0L
                val tint = when { !result.ok -> Bad; ms < 300 -> Good; ms < 800 -> Warn; else -> Bad }
                Text(
                    if (result.ok) "$ms ms" else "ناموفق", color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(tint.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
            if (c.kind == "openvpn") OvpnCredsButton(c)
            IconButton({ vm.repo.toggleFavorite(c.id) }) {
                Icon(if (c.favorite) Icons.Filled.Star else Icons.Filled.StarBorder, "علاقه‌مندی", tint = if (c.favorite) Warn else Muted)
            }
            IconButton({ vm.repo.deleteConfig(c.id) }) { Icon(Icons.Filled.Delete, "حذف", tint = Muted) }
        }
    }
}

/** Username/password of an OpenVPN config that asks for them (kept encrypted with the Android Keystore). */
@Composable
private fun OvpnCredsButton(c: ConfigEntry) {
    val ctx = LocalContext.current
    val needs = remember(c.json) {
        runCatching { Ovpn.parse(kotlinx.serialization.json.Json.parseToJsonElement(c.json).jsonObject["ovpn"]!!.jsonPrimitive.content).needsAuth }.getOrDefault(false)
    }
    if (!needs) return
    var has by remember(c.id) { mutableStateOf(OvpnCreds.has(ctx, c.id)) }
    var open by remember { mutableStateOf(false) }
    IconButton({ open = true }) { Icon(Icons.Filled.Key, "نام کاربری و رمز", tint = if (has) Good else Warn) }
    if (open) {
        var user by remember { mutableStateOf(OvpnCreds.load(ctx, c.id)?.first ?: "") }
        var pass by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text("نام کاربری و رمز OpenVPN") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Hint("روی همین گوشی و رمزنگاری‌شده نگه داشته می‌شود. اگر نام کاربری را خالی بگذارید، پاک می‌شود.")
                    OutlinedTextField(user, { user = it }, label = { Text("نام کاربری") }, singleLine = true)
                    OutlinedTextField(
                        pass, { pass = it }, label = { Text("رمز") }, singleLine = true,
                        visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    )
                }
            },
            confirmButton = {
                TextButton({
                    runCatching { OvpnCreds.save(ctx, c.id, user.trim(), pass) }
                        .onFailure { Toast.makeText(ctx, "ذخیره نشد: ${it.message}", Toast.LENGTH_SHORT).show() }
                    has = OvpnCreds.has(ctx, c.id); open = false
                }) { Text("ذخیره") }
            },
            dismissButton = { TextButton({ open = false }) { Text("انصراف") } },
        )
    }
}

/* ------------------------------- Logs ------------------------------- */

@Composable
fun LogScreen(modifier: Modifier = Modifier) {
    val lines by LogBuffer.lines.collectAsState()
    Column(modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            H("لاگ")
            Spacer(Modifier.weight(1f))
            val ctx = LocalContext.current
            TextButton({
                val text = lines.joinToString("\n")
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("GozarVpn log", text))
                Toast.makeText(ctx, if (text.isEmpty()) "لاگ خالی است" else "لاگ کپی شد (${lines.size} خط)", Toast.LENGTH_SHORT).show()
            }, enabled = lines.isNotEmpty()) { Text("کپی لاگ") }
            TextButton({ LogBuffer.clear() }) { Text("پاک کردن") }
        }
        if (lines.isEmpty()) Hint("هنوز چیزی ثبت نشده. لاگ فقط در حافظه است و روی گوشی ذخیره نمی‌شود.")
        LazyColumn(Modifier.fillMaxSize(), reverseLayout = true) {
            items(lines.asReversed()) { Text(it, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Muted) }
        }
    }
}

/* ------------------------------- More ------------------------------- */

@Composable
fun MoreScreen(vm: AppViewModel, app: AppState, connected: Boolean, onReconnect: () -> Unit, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val version = remember { runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "-" }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GCard {
            H("GozarVpn")
            Hint("نسخه‌ی $version · نسخه‌ی اندروید در حال تکمیل است.")
            Text("این برنامه توسط Ali (hermoso) ساخته و نگه‌داری می‌شود.", fontSize = 13.5.sp)
        }
        UpdateCard(vm, app)
        RoutingCard(vm, app, connected, onReconnect)
        AutoPauseCard(vm, app)
        SplitTunnelCard(vm, app, connected, onReconnect)
        GCard {
            H("تنظیمات")
            InfoRow("موتور فعال", ENGINES.firstOrNull { it.first == app.settings.engine }?.second ?: "-")
            InfoRow("روش Tor", torModeLabel(app.settings.torMode))
            InfoRow("پروتکل Aether", app.settings.aetherProtocol)
            Hint("تنظیمات هر موتور در تب «کانفیگ‌ها» است.")
        }
        GCard {
            H("ارتباط با سازنده")
            InfoRow("تلگرام", "@falconf2")
            InfoRow("ایمیل", "blackidea09@gmail.com")
        }
        GCard {
            H("درباره‌ی هسته‌ها")
            Hint("هسته‌های اتصال (sing-box، Aether، Tor، mihomo و بقیه) پروژه‌های متن‌باز جداگانه‌ای هستند که دیگران ساخته‌اند. GozarVpn فقط برایشان رابط کاربری درست کرده و مالکشان نیست.")
        }
    }
}
