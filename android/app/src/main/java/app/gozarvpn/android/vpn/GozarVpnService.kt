package app.gozarvpn.android.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Handler
import android.os.Looper
import app.gozarvpn.android.core.ChildCore
import app.gozarvpn.android.core.CoreEngine
import app.gozarvpn.android.core.CoreEngines
import app.gozarvpn.android.core.ProxyCores
import app.gozarvpn.android.core.LibboxEngine
import app.gozarvpn.android.core.SingboxConfig
import app.gozarvpn.android.data.Dpi
import app.gozarvpn.android.data.LogBuffer
import app.gozarvpn.android.data.Tester
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import app.gozarvpn.android.data.Repo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

enum class VpnStatus { Stopped, Starting, Connected, Error, Paused }

data class VpnUiState(
    val status: VpnStatus = VpnStatus.Stopped,
    val message: String? = null,
    val since: Long? = null,
    /** Shown while connected when the server stops answering (manual pick: no auto switch). */
    val warning: String? = null,
    /** Local SOCKS port of the running child engine (our own app is outside the TUN then), else null. */
    val socksPort: Int? = null,
    /** Kill switch engaged: the connection dropped and all tunnelled traffic is blackholed. */
    val blocked: Boolean = false,
)

class GozarVpnService : VpnService() {
    @Volatile private var engine: CoreEngine? = null
    /** Aether / Tor / mihomo child process (unused for the plain sing-box engine). */
    private val child = ChildCore("core")
    /** Aether running underneath Tor in the Tor-over-WARP mode. */
    private val child2 = ChildCore("core")
    // Starting the core blocks for a while; doing it on the main thread froze the UI
    // (no "connecting" animation). A new start or a stop bumps the generation so a
    // start that finishes late knows it was cancelled.
    private val worker = Executors.newSingleThreadExecutor()
    private val generation = AtomicInteger(0)
    private val main = Handler(Looper.getMainLooper())

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { shutdown(); return START_NOT_STICKY }
            ACTION_PAUSE -> { pause(intent.getIntExtra(EXTRA_MINUTES, 5) * 60_000L, null); return START_NOT_STICKY }
            ACTION_RESUME -> { resume(manual = true); return START_NOT_STICKY }
        }
        pausedUntil = 0; pausedFor = null; main.removeCallbacks(resumeTask)
        startForeground(NOTIFICATION_ID, buildNotification("در حال اتصال…"))
        startRecorder()
        autoExclude.clear() // a user-started connect gives every server a fresh chance
        val gen = generation.incrementAndGet()
        worker.execute { connect(gen, retriesLeft = null) }
        return START_NOT_STICKY
    }

    /* ----------------------------- pausing ----------------------------- */

    // 0 = not paused; Long.MAX_VALUE = until the app in [pausedFor] leaves the foreground
    @Volatile private var pausedUntil = 0L
    @Volatile private var pausedFor: String? = null
    private val resumeTask = Runnable { resume(manual = false) }

    /**
     * Turns the VPN off without leaving: the service stays in the foreground (so it may resume
     * on its own; a background start would be refused) and the engine is started again later
     * with the same settings. [ms] 0 = until [forApp] leaves the foreground.
     */
    private fun pause(ms: Long, forApp: String?) {
        if (_state.value.status == VpnStatus.Stopped) return
        generation.incrementAndGet()
        runCatching { worker.execute { stopEngine() } }
        releaseBlock() // pausing means "let traffic through without the VPN"
        main.removeCallbacks(resumeTask)
        pausedFor = forApp
        pausedUntil = if (ms > 0) System.currentTimeMillis() + ms else Long.MAX_VALUE
        if (ms > 0) main.postDelayed(resumeTask, ms)
        val text = if (forApp != null) "VPN برای «$forApp» متوقف شد؛ بعد از بستنش دوباره وصل می‌شود" else "VPN تا ${ms / 60_000} دقیقه متوقف است"
        LogBuffer.add(text)
        _state.value = VpnUiState(VpnStatus.Paused, message = text, since = pausedUntil.takeIf { it != Long.MAX_VALUE })
        runCatching { startForeground(NOTIFICATION_ID, buildNotification(text)) }
    }

    private fun resume(manual: Boolean) {
        if (_state.value.status != VpnStatus.Paused) return
        main.removeCallbacks(resumeTask)
        // a hand-resume while a listed app is open must not be paused again straight away
        if (manual) overrideApp = foregroundPackage()
        pausedUntil = 0; pausedFor = null
        LogBuffer.add("ادامه‌ی اتصال بعد از توقف موقت")
        runCatching { startForeground(NOTIFICATION_ID, buildNotification("در حال اتصال…")) }
        val gen = generation.incrementAndGet()
        worker.execute { connect(gen, retriesLeft = null) }
    }

    /* --------------- auto-pause while listed apps are open --------------- */

    @Volatile private var watcherOn = false
    @Volatile private var overrideApp: String? = null

    /** Latest app in the foreground, from Usage access (null without the permission). */
    private fun foregroundPackage(): String? = runCatching {
        val usm = getSystemService(android.app.usage.UsageStatsManager::class.java)
        val now = System.currentTimeMillis()
        val events = usm.queryEvents(now - 60_000, now)
        val e = android.app.usage.UsageEvents.Event()
        var last: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            if (e.eventType == android.app.usage.UsageEvents.Event.ACTIVITY_RESUMED) last = e.packageName
        }
        last
    }.getOrNull()

    /**
     * Some banking apps refuse to run while any VPN is on, even when excluded from the tunnel
     * (Android lets every app see that a VPN exists). While such an app is in front, the VPN is
     * paused; ~6 s after it leaves, the same connection comes back. Polls every 1.5 s.
     */
    private fun startAppWatcher() {
        if (watcherOn) return
        watcherOn = true
        Thread {
            var leftAt = 0L
            while (watcherOn) {
                Thread.sleep(1500)
                val s = Repo.get(applicationContext).state.value.settings
                if (!s.autoPauseApps || s.autoPausePackages.isEmpty()) continue
                val fg = foregroundPackage() ?: continue
                if (fg != overrideApp) overrideApp = null
                val listed = fg in s.autoPausePackages
                val status = _state.value.status
                if (listed && fg != overrideApp && (status == VpnStatus.Connected || status == VpnStatus.Starting) && pausedFor == null) {
                    val label = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(fg, 0)).toString() }.getOrDefault(fg)
                    main.post { pause(0, label) }
                    leftAt = 0
                } else if (status == VpnStatus.Paused && pausedUntil == Long.MAX_VALUE) {
                    if (listed) leftAt = 0
                    else {
                        if (leftAt == 0L) leftAt = System.currentTimeMillis()
                        if (System.currentTimeMillis() - leftAt > 6000) { leftAt = 0; main.post { resume(manual = false) } }
                    }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    /* ----------------------------- data usage ----------------------------- */

    @Volatile private var recorderOn = false
    /** Engine name the history files usage under (set on each connect). */
    @Volatile private var usageEngine = "singbox"

    /**
     * Every 15 s while the service runs (connected, paused or blocked): adds this app's own network
     * bytes (Android's per-app counter, so engines and checks included) and the tunnel bytes
     * (sing-box's counters) to the local history. Saved every minute and when the service stops.
     */
    private fun startRecorder() {
        if (recorderOn) return
        recorderOn = true
        Thread {
            val log = app.gozarvpn.android.data.TrafficLog.get(applicationContext)
            val uid = android.os.Process.myUid()
            var rx = android.net.TrafficStats.getUidRxBytes(uid)
            var tx = android.net.TrafficStats.getUidTxBytes(uid)
            var tun: Pair<Long, Long>? = null
            var lastSave = System.currentTimeMillis()
            fun step() {
                val r = android.net.TrafficStats.getUidRxBytes(uid)
                val t = android.net.TrafficStats.getUidTxBytes(uid)
                // UNSUPPORTED (-1) or a counter reset (reboot) adds nothing for that step
                val nd = if (r >= 0 && rx >= 0 && r >= rx) r - rx else 0
                val nu = if (t >= 0 && tx >= 0 && t >= tx) t - tx else 0
                rx = r; tx = t
                val now = app.gozarvpn.android.core.TrafficApi.totals()
                // a new sing-box (reconnect) restarts its counters; that step is skipped
                val (td, tu) = tun?.let { last -> if (now != null && now.first >= last.first && now.second >= last.second) (now.first - last.first) to (now.second - last.second) else 0L to 0L } ?: (0L to 0L)
                tun = now
                log.add(usageEngine, nd, nu, td, tu)
                if (System.currentTimeMillis() - lastSave >= 60_000) { runCatching { log.flush() }; lastSave = System.currentTimeMillis() }
            }
            while (recorderOn) {
                runCatching { Thread.sleep(15_000) }
                runCatching { step() }
            }
            runCatching { step(); log.flush() }
        }.apply { isDaemon = true; name = "usage-recorder" }.start()
    }

    /* ----------------------------- kill switch ----------------------------- */

    /** TUN that is never read: everything routed into it is dropped. */
    @Volatile private var blackhole: android.os.ParcelFileDescriptor? = null

    /**
     * Swaps in the blackhole TUN (Android replaces our current interface with it, so there is no
     * gap). Our own app stays outside so engines can reconnect; always-direct apps stay direct.
     */
    private fun holdBlock(): Boolean {
        if (blackhole != null) return true
        val s = Repo.get(applicationContext).state.value.settings
        val split = SingboxConfig.split(s.perAppMode, s.perAppPackages, packageName, engineMode = true)
        return runCatching {
            val b = Builder().setSession("GozarVpn").addAddress("172.19.0.1", 30).addRoute("0.0.0.0", 0)
                .addAddress("fdfe:dcba:9876::1", 126).addRoute("::", 0)
            if (split.include.isNotEmpty()) split.include.forEach { runCatching { b.addAllowedApplication(it) } }
            else split.exclude.forEach { runCatching { b.addDisallowedApplication(it) } }
            blackhole = b.establish()
            blackhole != null
        }.getOrElse { LogBuffer.add("کیل‌سوییچ: ساخت تونل مسدودکننده نشد: ${it.message}"); false }
    }

    private fun releaseBlock() {
        val p = blackhole ?: return
        blackhole = null
        runCatching { p.close() }
    }

    /**
     * A running connection failed for good. With the kill switch on, traffic stays blocked
     * (the service keeps running) until the user reconnects, pauses or disconnects.
     */
    private fun failed(gen: Int, message: String, label: String) {
        val ks = Repo.get(applicationContext).state.value.settings.killSwitch
        if (ks && (blackhole != null || _state.value.status == VpnStatus.Connected) && holdBlock()) {
            runCatching { worker.execute { stopEngine() } }
            LogBuffer.add("کیل‌سوییچ: اتصال قطع شد، ترافیک مسدود است")
            setState(VpnUiState(VpnStatus.Error, message, blocked = true), label)
            return
        }
        setState(VpnUiState(VpnStatus.Error, message), label)
        main.post { if (generation.get() == gen) shutdown(keepError = true) }
    }

    /** Every state change also updates the notification (it used to stay on "connecting"). */
    private fun setState(s: VpnUiState, engineLabel: String = "") {
        _state.value = s
        val text = when (s.status) {
            VpnStatus.Starting -> "در حال اتصال… $engineLabel".trim()
            VpnStatus.Connected -> "متصل · $engineLabel".trimEnd(' ', '·')
            VpnStatus.Error -> if (s.blocked) "اتصال قطع شد، ترافیک مسدود است" else "خطا: ${s.message ?: ""}".take(120)
            VpnStatus.Stopped, VpnStatus.Paused -> return
        }
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text)) }
    }

    /** Runs on [worker]. [retriesLeft] is null for a user-started connect. */
    private fun connect(gen: Int, retriesLeft: Int?) {
        val begun = System.currentTimeMillis()
        var label = ""
        try {
            val repo = Repo.get(applicationContext)
            val settings = repo.state.value.settings
            // a reconnect of a live (or blocked) connection: keep traffic blocked while it restarts
            if (settings.killSwitch && (_state.value.status == VpnStatus.Connected || _state.value.blocked)) holdBlock()
            stopEngine()
            val engineName = settings.engine
            label = ENGINE_LABELS[engineName] ?: engineName
            setState(VpnUiState(VpnStatus.Starting), label)
            LogBuffer.add("اتصال با موتور $engineName")
            val cancelled = { generation.get() != gen }
            val entry = if (engineName == "singbox") (if (settings.v2rayAuto) pickAuto(repo) else repo.activeConfig())
                ?: throw IllegalStateException("کانفیگی انتخاب نشده است.") else null
            val dpi = if (entry != null && Dpi.applies(entry)) {
                val st = repo.state.value
                Dpi.candidates(st.dpiManual[entry.id], st.dpiLearned[entry.id], settings.dpiSmart)
            } else listOf("none")
            val lines = { s: String -> s.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") } }
            val routing = SingboxConfig.Routing(
                settings.routingMode, lines(settings.routeDirect), lines(settings.routeProxy),
                if (settings.routingMode == "iran") app.gozarvpn.android.core.IranRules.ensure(this).absolutePath else "",
            )
            if (settings.routingMode != "all") LogBuffer.add("مسیر ترافیک: " + if (settings.routingMode == "iran") "ایران مستقیم، بقیه از VPN" else "فقط لیست من از VPN")
            // an AmneziaWG entry runs as a child engine like Aether, so our own app must stay outside the TUN
            val awg = entry?.kind == "awg"
            usageEngine = when { awg -> "awg"; entry?.kind == "openvpn" -> "openvpn"; else -> engineName }
            val split = SingboxConfig.split(settings.perAppMode, settings.perAppPackages, packageName, engineMode = engineName != "singbox" || awg)
            if (settings.perAppMode != "all") LogBuffer.add("تونل‌سازی انتخابی: " + if (split.include.isNotEmpty()) "فقط ${split.include.size} برنامه" else "همه به‌جز ${split.exclude.size} برنامه")
            // an OpenVPN entry: the OpenVPN process gets its tunnel from us directly (no sing-box);
            // its sockets are protected, so our own app stays inside the tunnel for the health check
            if (entry?.kind == "openvpn") {
                label = "OpenVPN"
                val text = kotlinx.serialization.json.Json.parseToJsonElement(entry.json).jsonObject["ovpn"]!!.jsonPrimitive.content
                if (settings.routingMode == "custom") LogBuffer.add("حالت «فقط لیست من از VPN» با OpenVPN پشتیبانی نمی‌شود؛ همه‌چیز (به‌جز ایران و لیست مستقیم) از تونل می‌رود")
                val mine = lines(settings.routeDirect)
                if (mine.any { app.gozarvpn.android.data.Ovpn.cidr4(it) == null }) LogBuffer.add("با OpenVPN فقط IP / محدوده‌ی IP لیست مستقیم کار می‌کند، نه دامنه")
                val direct = mine.filter { app.gozarvpn.android.data.Ovpn.cidr4(it) != null } +
                    if (settings.routingMode == "iran") app.gozarvpn.android.core.IranRules.cidrsV4(this) else emptyList()
                val e = app.gozarvpn.android.core.OpenVpnEngine(
                    this, text, app.gozarvpn.android.data.OvpnCreds.load(this, entry.id),
                    SingboxConfig.split(settings.perAppMode, settings.perAppPackages, packageName, engineMode = false),
                    direct, settings.blockIpv6Leak, cancelled,
                )
                e.onStopped = { main.post { if (generation.get() == gen && engine === e) failed(gen, "OpenVPN متوقف شد (جزئیات در لاگ)", label) } }
                e.start(this, "")
                if (generation.get() != gen) { runCatching { e.stop() }; return }
                engine = e
                LogBuffer.add("[زمان] تونل OpenVPN ساخته شد: +${System.currentTimeMillis() - begun} ms")
            } else for ((i, profile) in dpi.withIndex()) {
                val config = when (engineName) {
                    "singbox" -> if (awg) {
                        val conf = kotlinx.serialization.json.Json.parseToJsonElement(entry!!.json).jsonObject["conf"]!!.jsonPrimitive.content
                        SingboxConfig.forLocalSocks(ProxyCores.startAwg(this, child, conf, cancelled), packageName, settings.blockIpv6Leak, split, routing)
                    } else SingboxConfig.forEntry(Dpi.apply(entry!!, profile), settings.blockIpv6Leak, split, routing)
                    // child core first; sing-box then only turns its SOCKS port into a VPN
                    "aether" -> SingboxConfig.forLocalSocks(ProxyCores.startAether(this, child, settings, cancelled), packageName, settings.blockIpv6Leak, split, routing)
                    "tor" -> SingboxConfig.forLocalSocks(ProxyCores.startTor(this, child, child2, settings, cancelled), packageName, settings.blockIpv6Leak, split, routing)
                    "mihomo" -> SingboxConfig.forLocalSocks(ProxyCores.startMihomo(this, child, settings, cancelled), packageName, settings.blockIpv6Leak, split, routing)
                    "psiphon" -> SingboxConfig.forLocalSocks(ProxyCores.startPsiphon(this, child, settings, cancelled), packageName, settings.blockIpv6Leak, split, routing)
                    else -> throw IllegalStateException("موتور ناشناخته: $engineName")
                }
                if (cancelled()) { child.stop(); return }
                // per-phase timing, so a slow connect can be read straight from a pasted log
                LogBuffer.add("[زمان] هسته آماده و ترافیک تأیید شد: +${System.currentTimeMillis() - begun} ms")
                if (dpi.size > 1) LogBuffer.add("ضد DPI هوشمند: امتحان «${Dpi.label(profile)}» (${i + 1} از ${dpi.size})")
                LogBuffer.add("پیکربندی sing-box: " + SingboxConfig.redacted(config))
                val e = CoreEngines.create()
                (e as? LibboxEngine)?.onStopped = { main.post { if (generation.get() == gen && engine === e) failed(gen, "تونل متوقف شد", label) } }
                e.start(this, config)
                if (generation.get() != gen) { runCatching { e.stop() }; return }
                engine = e
                LogBuffer.add("[زمان] تونل VPN ساخته شد: +${System.currentTimeMillis() - begun} ms")
                if (dpi.size == 1) break
                // a real request through the tunnel decides (two tries: the first can race startup)
                if (Tester.probeTunnel() != null || Tester.probeTunnel() != null) {
                    LogBuffer.add("ضد DPI هوشمند: «${Dpi.label(profile)}» کار کرد و برای این سرور ذخیره شد")
                    repo.setDpiLearned(entry!!.id, profile)
                    break
                }
                if (generation.get() != gen) return
                // none worked: keep the last variant running so the usual health warning applies
                if (i < dpi.lastIndex) { engine = null; runCatching { e.stop() } }
            }
            // keep "connecting" on screen briefly so the state change is visible
            val wait = 1200 - (System.currentTimeMillis() - begun)
            if (wait > 0) Thread.sleep(wait)
            if (generation.get() != gen) return
            val socksPort = if (awg) ProxyCores.AWG_SOCKS else ProxyCores.socksPortFor(engineName)
            setState(VpnUiState(VpnStatus.Connected, since = System.currentTimeMillis(), socksPort = socksPort), label)
            releaseBlock() // the engine's own TUN has replaced it by now
            LogBuffer.add("[زمان] متصل: +${System.currentTimeMillis() - begun} ms")
            if (engineName != "singbox" || awg) watchChild(gen, retriesLeft ?: settings.reconnectAttempts)
            watchHealth(gen, engineName, settings.v2rayAuto, label, socksPort)
            if (settings.autoPauseApps) startAppWatcher()
        } catch (t: Throwable) {
            if (generation.get() != gen) return
            LogBuffer.add("خطا: ${t.message}")
            failed(gen, t.message ?: "خطا", label)
        }
    }

    /** Servers Auto gave up on during this session (cleared by a user-started connect). */
    private val autoExclude = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    /**
     * Auto mode: the fastest server by saved test results (not ones that just failed).
     * With no usable results it quick-tests up to 30 servers first, favorites first.
     */
    private fun pickAuto(repo: Repo): app.gozarvpn.android.data.ConfigEntry? {
        fun best(): app.gozarvpn.android.data.ConfigEntry? {
            val s = repo.state.value
            return s.configs.filter { it.id !in autoExclude && s.results[it.id]?.ok == true }
                .minByOrNull { s.results[it.id]?.latencyMs ?: Long.MAX_VALUE }
        }
        best()?.let { LogBuffer.add("انتخاب خودکار: «${it.name}» (${repo.state.value.results[it.id]?.latencyMs} ms)"); repo.setActive(it.id); return it }
        val candidates = repo.state.value.configs.filter { it.id !in autoExclude }
            .sortedByDescending { it.favorite }.take(30)
        if (candidates.isEmpty()) return repo.activeConfig()
        LogBuffer.add("انتخاب خودکار: تست سریع ${candidates.size} سرور…")
        val pool = Executors.newFixedThreadPool(10)
        try {
            candidates.map { c -> pool.submit { app.gozarvpn.android.data.Tester.test(this, c)?.let { repo.saveResult(c.id, it) } } }
                .forEach { runCatching { it.get(15, java.util.concurrent.TimeUnit.SECONDS) } }
        } finally { pool.shutdownNow() }
        return best()?.also { LogBuffer.add("انتخاب خودکار: «${it.name}»"); repo.setActive(it.id) }
            ?: repo.activeConfig()
    }

    /**
     * Periodic real request through the tunnel (or the engine's SOCKS port, since our own app
     * is outside the TUN in engine modes). After 10 misses in a row: Auto switches server,
     * a manual pick only gets a warning (the user's choice always wins).
     */
    private fun watchHealth(gen: Int, engineName: String, auto: Boolean, label: String, port: Int?) {
        Thread {
            var misses = 0
            while (generation.get() == gen) {
                Thread.sleep(6000)
                if (generation.get() != gen) return@Thread
                val ok = (if (port != null) ProxyCores.probeSocks(port, timeoutMs = 8000) else app.gozarvpn.android.data.Tester.probeTunnel()) != null
                if (ok) {
                    if (misses >= 10) setState(_state.value.copy(warning = null), label)
                    misses = 0; continue
                }
                misses++
                if (misses == 10) {
                    val repo = Repo.get(applicationContext)
                    if (engineName == "singbox" && auto) {
                        repo.state.value.activeId?.let { autoExclude.add(it) }
                        LogBuffer.add("سرور فعلی ۱۰ بار پشت سر هم جواب نداد؛ سرور عوض شد")
                        val next = generation.incrementAndGet()
                        runCatching { worker.execute { connect(next, retriesLeft = null) } }
                        return@Thread
                    }
                    val w = "سرور فعلی جواب نمی‌دهد؛ سرور دیگری انتخاب کنید" + if (engineName == "singbox") " یا «انتخاب خودکار» را روشن کنید" else ""
                    LogBuffer.add(w)
                    setState(_state.value.copy(warning = w), label)
                }
            }
        }.apply { isDaemon = true }.start()
    }

    /** A child engine that dies while connected is restarted (up to [retriesLeft] times). */
    private fun watchChild(gen: Int, retriesLeft: Int) {
        Thread {
            while (generation.get() == gen) {
                Thread.sleep(3000)
                if (generation.get() != gen) return@Thread
                if (!child.isRunning()) {
                    LogBuffer.add("هسته‌ی موتور متوقف شد" + if (retriesLeft > 0) "؛ اتصال دوباره ($retriesLeft تلاش باقی مانده)…" else "")
                    if (retriesLeft > 0) {
                        val next = generation.incrementAndGet()
                        runCatching { worker.execute { connect(next, retriesLeft - 1) } }
                    } else {
                        failed(gen, "هسته‌ی موتور متوقف شد (جزئیات در لاگ)", "")
                    }
                    return@Thread
                }
            }
        }.apply { isDaemon = true }.start()
    }

    private fun stopEngine() {
        val e = engine
        engine = null
        try { e?.stop() } catch (_: Throwable) { }
        child.stop()
        child2.stop()
    }

    private fun shutdown(keepError: Boolean = false) {
        generation.incrementAndGet()
        watcherOn = false; recorderOn = false; pausedUntil = 0; pausedFor = null; main.removeCallbacks(resumeTask)
        runCatching { worker.execute { stopEngine() } }.onFailure { stopEngine() } // executor gone after onDestroy
        releaseBlock()
        if (!keepError) _state.value = VpnUiState(VpnStatus.Stopped)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onRevoke() = shutdown()
    override fun onDestroy() {
        recorderOn = false // the recorder saves once more on its way out
        generation.incrementAndGet()
        runCatching { worker.execute { stopEngine() } }.onFailure { stopEngine() }
        releaseBlock()
        worker.shutdown()
        super.onDestroy()
    }

    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "GozarVpn", NotificationManager.IMPORTANCE_LOW))
        // tapping the notification brings the existing app screen forward (no new instance)
        val open = android.app.PendingIntent.getActivity(
            this, 0,
            Intent(this, app.gozarvpn.android.MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun action(label: String, act: String, code: Int, minutes: Int = 0) = Notification.Action.Builder(
            null, label,
            android.app.PendingIntent.getService(this, code, Intent(this, GozarVpnService::class.java).setAction(act).putExtra(EXTRA_MINUTES, minutes),
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT),
        ).build()
        val b = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("GozarVpn")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(open)
            .setOngoing(true)
        // quick controls right in the notification
        if (_state.value.status == VpnStatus.Paused) b.addAction(action("ادامه‌ی اتصال", ACTION_RESUME, 11))
        else b.addAction(action("توقف ۵ دقیقه", ACTION_PAUSE, 12, 5)).addAction(action("توقف ۱۵ دقیقه", ACTION_PAUSE, 13, 15))
        b.addAction(action("قطع", ACTION_STOP, 14))
        return b.build()
    }

    companion object {
        const val ACTION_STOP = "app.gozarvpn.android.STOP"
        const val ACTION_PAUSE = "app.gozarvpn.android.PAUSE"
        const val ACTION_RESUME = "app.gozarvpn.android.RESUME"
        const val EXTRA_MINUTES = "minutes"
        private val ENGINE_LABELS = mapOf("singbox" to "V2ray", "aether" to "Aether", "tor" to "Tor", "mihomo" to "Clash", "psiphon" to "سایفون")
        private const val CHANNEL_ID = "vpn"
        private const val NOTIFICATION_ID = 1
        private val _state = MutableStateFlow(VpnUiState())
        val state: StateFlow<VpnUiState> = _state
    }
}
