package app.gozarvpn.android.ui

import android.content.pm.ApplicationInfo
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.gozarvpn.android.core.IranRules
import app.gozarvpn.android.core.ProxyCores
import app.gozarvpn.android.data.AppState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Settings card: which traffic goes through the VPN (Iran direct, custom lists, rule updates, tester). */
@Composable
fun RoutingCard(vm: AppViewModel, app: AppState, connected: Boolean, onReconnect: () -> Unit) {
    val s = app.settings
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var changed by remember { mutableStateOf(false) }
    var version by remember { mutableStateOf("") }
    var updateMsg by remember { mutableStateOf<String?>(null) }
    var testHost by remember { mutableStateOf("") }
    var testResult by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { version = withContext(Dispatchers.IO) { runCatching { IranRules.version(ctx) }.getOrDefault("?") } }
    val set: ((app.gozarvpn.android.data.Settings) -> app.gozarvpn.android.data.Settings) -> Unit = { f -> vm.repo.updateSettings(f); if (connected) changed = true }
    val lines = { t: String -> t.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") } }

    GCard {
        H("مسیر ترافیک")
        ChoiceChips(listOf("iran" to "ایران مستقیم، بقیه VPN", "all" to "همه از VPN", "custom" to "فقط لیست من از VPN"), s.routingMode) { v -> set { it.copy(routingMode = v) } }
        Hint(when (s.routingMode) {
            "iran" -> "سایت‌های ‎.ir و سایت‌ها و آی‌پی‌های ایرانی مستقیم (بیرون از VPN) باز می‌شوند و بقیه، مثل تلگرام و یوتیوب، از VPN. برنامه‌های بانکی را در «تونل‌سازی انتخابی» هم بیرون بگذارید."
            "custom" -> "فقط دامنه‌ها و آی‌پی‌های لیست «همیشه از VPN» از تونل می‌روند؛ بقیه مستقیم."
            else -> "همه‌ی ترافیک از VPN می‌رود."
        })
        if (s.routingMode == "iran") Text("قوانین ایران: نسخه‌ی $version", color = Muted, fontSize = 12.sp)
        SettingField("همیشه مستقیم (هر خط یک دامنه یا آی‌پی)", s.routeDirect) { v -> set { it.copy(routeDirect = v) } }
        SettingField("همیشه از VPN (هر خط یک دامنه یا آی‌پی)", s.routeProxy) { v -> set { it.copy(routeProxy = v) } }
        Hint("مثال: example.com (زیردامنه‌ها را هم می‌گیرد) یا 1.2.3.4 یا 5.6.0.0/16. لیست «همیشه از VPN» بر بقیه اولویت دارد.")
        if (s.routingMode == "iran") Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton({
                updateMsg = "در حال دریافت…"
                scope.launch {
                    // while connected, go through the engine's SOCKS port: GitHub/jsDelivr may be filtered directly
                    val port = if (connected) ProxyCores.socksPortFor(s.engine) else null
                    updateMsg = withContext(Dispatchers.IO) {
                        runCatching { "به‌روز شد (${IranRules.update(ctx, port)})" }.getOrElse { "به‌روزرسانی نشد: ${it.message?.take(120)}" }
                    }
                    version = withContext(Dispatchers.IO) { IranRules.version(ctx) }
                    if (connected) changed = true
                }
            }) { Text("به‌روزرسانی قوانین") }
            Spacer(Modifier.width(8.dp))
            updateMsg?.let { Text(it, color = Muted, fontSize = 12.sp, modifier = Modifier.weight(1f)) }
        }
        // apps that never use the VPN (banking apps etc.): the same list as split tunnelling's "all except"
        H("برنامه‌های همیشه مستقیم")
        var picking by remember { mutableStateOf(false) }
        val directApps = if (s.perAppMode == "except") s.perAppPackages else emptyList()
        val pm = ctx.packageManager
        if (directApps.isEmpty()) Hint("هیچ برنامه‌ای. برنامه‌های بانکی (مثل سپینو، همراه‌بانک‌ها) را اینجا اضافه کنید تا اصلاً از VPN رد نشوند.")
        for (p in directApps) Row(verticalAlignment = Alignment.CenterVertically) {
            val label = remember(p) { runCatching { pm.getApplicationLabel(pm.getApplicationInfo(p, 0)).toString() }.getOrDefault(p) }
            Text(label, fontSize = 13.sp, modifier = Modifier.weight(1f))
            TextButton({ set { st -> st.copy(perAppPackages = st.perAppPackages - p) } }) { Text("حذف", color = Bad) }
        }
        OutlinedButton({ picking = true }) { Text("افزودن برنامه به «مستقیم»") }
        if (picking) AppPicker(directApps, onDismiss = { picking = false }) { picked ->
            set { st -> st.copy(perAppMode = "except", perAppPackages = picked) }
            picking = false
        }
        Hint("بعضی برنامه‌های بانکی تا وقتی هر VPNی روشن باشد باز نمی‌شوند، حتی اگر خودشان بیرون از تونل باشند، چون از خود اندروید می‌پرسند VPN روشن است یا نه. برای این‌ها فقط قطع موقت VPN جواب می‌دهد.")
        H("این دامنه از کجا می‌رود؟")
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(testHost, { testHost = it; testResult = null }, Modifier.weight(1f), singleLine = true, placeholder = { Text("مثلاً bmi.ir") })
            Spacer(Modifier.width(8.dp))
            Button({
                scope.launch {
                    val why = withContext(Dispatchers.IO) {
                        when (s.routingMode) {
                            "all" -> null
                            "custom" -> {
                                val h = testHost.trim().lowercase()
                                if (lines(s.routeProxy).any { e -> val x = e.lowercase().trimStart('.'); h == x || h.endsWith(".$x") }) null else "خارج از لیست «همیشه از VPN»"
                            }
                            else -> IranRules.explain(ctx, testHost, lines(s.routeDirect), lines(s.routeProxy))
                        }
                    }
                    testResult = if (why == null) "از VPN" else "مستقیم: $why"
                }
            }, enabled = testHost.isNotBlank()) { Text("بررسی") }
        }
        testResult?.let { Text(it, color = if (it.startsWith("مستقیم")) Good else MaterialTheme.colorScheme.primary, fontSize = 13.sp) }
        Hint("این بررسی فقط دامنه را نگاه می‌کند. سایتی که فقط آی‌پی ایرانی دارد هم موقع اتصال مستقیم باز می‌شود.")
        if (connected && changed) Row(verticalAlignment = Alignment.CenterVertically) {
            Text("تغییر از اتصال بعدی اعمال می‌شود.", color = Warn, fontSize = 12.5.sp, modifier = Modifier.weight(1f))
            TextButton({ changed = false; onReconnect() }) { Text("اتصال دوباره") }
        }
    }
}

/**
 * Installed apps that look Iranian banking / payment / government apps, as suggestions for the
 * per-app bypass list. A heuristic (package or label), never applied without the user's tap.
 */
fun iranianAppSuggestions(ctx: android.content.Context): List<Pair<String, String>> {
    val pm = ctx.packageManager
    // Persian app names of Iranian banks, payment, government and everyday services
    val label = Regex("بانک|بانكی|پرداخت|کارت|همراه\\s?بانک|موبایل\\s?بانک|سپه|ملت|ملی|صادرات|سپینو|تجارت|رسالت|پاسارگاد|پارسیان|سامان|آینده|مهر|شهر|اقتصاد نوین|کشاورزی|مسکن|رفاه|توسعه|سرمایه|کارآفرین|ایران\\s?زمین|شاپرک|زرین|دولت|مالیات|روبیکا|ایتا|سروش|اسنپ|دیجی|بازار|مایکت|دیوار|شیپور|آپارات" +
        // short names only as whole words, or they would match inside unrelated app names
        "|(^|\\s)(دی|سینا|بلو|تاپ|آپ|سکه|ثنا|عدل|شاد|بله|گپ)(\\s|$)")
    // package names: ir.* plus the banks and services above in English
    val pkg = Regex("^ir\\.|\\.ir\\.|bank|pardakht|payment|melli|mellat|saderat|sepino|sepah|tejarat|pasargad|parsian|refah|keshavarzi|maskan|shahr|ayandeh|sinabank|karafarin|saman|eghtesad|enbank|postbank|resalat|iranzamin|tosee|sarmayeh|mobillet|bluebank|\\bblu\\b|shaparak|behpardakht|sadad|asanpardakht|zarinpal|mydigipay|snapp|digikala|cafebazaar|farsroid|myket|divar|sheypoor|aparat|rubika|eitaa|bale\\.|soroush|\\bgap\\b")
    return pm.getInstalledApplications(0).asSequence()
        .filter { it.packageName != ctx.packageName && it.flags and ApplicationInfo.FLAG_SYSTEM == 0 }
        .map { it.packageName to pm.getApplicationLabel(it).toString() }
        .filter { (p, l) -> pkg.containsMatchIn(p.lowercase()) || label.containsMatchIn(l) }
        .sortedBy { it.second }.toList()
}

/**
 * Settings card: pause the VPN while chosen apps are in front (banking apps that refuse to run
 * with any VPN on). Needs Usage access, which only the user can grant in system settings.
 */
@Composable
fun AutoPauseCard(vm: AppViewModel, app: AppState) {
    val s = app.settings
    val ctx = LocalContext.current
    var granted by remember { mutableStateOf(hasUsageAccess(ctx)) }
    // re-check when the user comes back from the settings page
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) granted = hasUsageAccess(ctx) }
        lifecycle.addObserver(obs); onDispose { lifecycle.removeObserver(obs) }
    }
    var picking by remember { mutableStateOf(false) }
    val pm = ctx.packageManager
    GCard {
        H("توقف خودکار VPN برای برنامه‌های خاص")
        Hint("بعضی برنامه‌های بانکی (مثل سپینو) تا وقتی هر VPNی روشن باشد باز نمی‌شوند، حتی اگر بیرون از تونل باشند. وقتی یکی از برنامه‌های این لیست باز شود، VPN خودش متوقف می‌شود و چند ثانیه بعد از بستن آن برنامه دوباره وصل می‌شود.")
        SettingSwitch("فعال", "از اتصال بعدی اعمال می‌شود", s.autoPauseApps) { v -> vm.repo.updateSettings { it.copy(autoPauseApps = v) } }
        if (!granted) {
            Text("برای فهمیدن این‌که کدام برنامه باز است، اجازه‌ی «دسترسی به اطلاعات استفاده» (Usage access) لازم است.", color = Warn, fontSize = 12.5.sp)
            OutlinedButton({
                runCatching { ctx.startActivity(android.content.Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }) { Text("باز کردن تنظیمات اجازه") }
            Hint("در صفحه‌ای که باز می‌شود GozarVpn را پیدا کنید و «اجازه» را روشن کنید، بعد برگردید.")
        } else Text("✓ اجازه‌ی Usage access داده شده", color = Good, fontSize = 12.5.sp)
        if (s.autoPausePackages.isEmpty()) Hint("هنوز برنامه‌ای انتخاب نشده.")
        for (p in s.autoPausePackages) Row(verticalAlignment = Alignment.CenterVertically) {
            val label = remember(p) { runCatching { pm.getApplicationLabel(pm.getApplicationInfo(p, 0)).toString() }.getOrDefault(p) }
            Text(label, fontSize = 13.sp, modifier = Modifier.weight(1f))
            TextButton({ vm.repo.updateSettings { it.copy(autoPausePackages = it.autoPausePackages - p) } }) { Text("حذف", color = Bad) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ picking = true }) { Text("انتخاب برنامه‌ها") }
            TextButton({
                val add = iranianAppSuggestions(ctx).map { it.first }
                vm.repo.updateSettings { it.copy(autoPausePackages = (it.autoPausePackages + add).distinct()) }
            }) { Text("افزودن برنامه‌های بانکی پیدا شده") }
        }
        if (picking) AppPicker(s.autoPausePackages, onDismiss = { picking = false }) { picked ->
            vm.repo.updateSettings { it.copy(autoPausePackages = picked) }
            picking = false
        }
        Hint("وصل شدن دوباره چند ثانیه طول می‌کشد (با Aether بین ۵ تا ۳۰ ثانیه). اگر برنامه‌ی بانکی در پس‌زمینه بماند و دوباره بررسی کند، ممکن است باز هم پیام بدهد. برای توقف دستی، دکمه‌ی «توقف ۵ دقیقه» در اعلان یا کاشی GozarVpn در منوی بالای گوشی را بزنید.")
    }
}

fun hasUsageAccess(ctx: android.content.Context): Boolean {
    val ops = ctx.getSystemService(android.app.AppOpsManager::class.java)
    @Suppress("DEPRECATION")
    val mode = if (android.os.Build.VERSION.SDK_INT >= 29) ops.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), ctx.packageName)
        else ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), ctx.packageName)
    return mode == android.app.AppOpsManager.MODE_ALLOWED
}
