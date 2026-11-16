package app.gozarvpn.android.core

import android.content.Context
import android.net.IpPrefix
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.Os
import app.gozarvpn.android.data.LogBuffer
import app.gozarvpn.android.data.Ovpn
import app.gozarvpn.android.data.TestResult
import java.io.File
import java.io.FileDescriptor
import java.net.InetAddress

/**
 * One OpenVPN 2 process (jniLibs/<abi>/libovpnexec.so + libopenvpn.so, built from ics-openvpn,
 * GPLv2) driven through its management socket. It is a separate program: we only talk to it over
 * a local socket. The Android build of OpenVPN asks the app for everything the system must do:
 * protect its own sockets (PROTECTFD), the tunnel settings (IFCONFIG, ROUTE, DNSSERVER…) and the
 * tunnel itself (OPENTUN: our VpnService builds it and passes the fd back over the socket).
 */
class OvpnProcess(private val ctx: Context, private val tag: String) {
    interface Handler {
        fun protect(fd: Int): Boolean
        /** Reply for a NEED-OK request ("ok" when null). */
        fun need(what: String, arg: String): String? = null
        /** The tunnel for OPENTUN, or null to refuse. */
        fun openTun(): ParcelFileDescriptor? = null
        fun state(name: String, detail: String) {}
        fun line(text: String) {}
        fun exit(code: Int) {}
    }

    @Volatile private var proc: Process? = null
    @Volatile private var sock: LocalSocket? = null
    private var bound: LocalSocket? = null
    private var server: LocalServerSocket? = null
    private val fds = ArrayDeque<FileDescriptor>()
    private var cfgFile: File? = null
    private var sockPath = ""
    @Volatile private var sentAuth = false

    fun isRunning() = proc?.isAlive == true

    fun start(configText: String, extraArgs: List<String>, creds: Pair<String, String>?, h: Handler) {
        val bin = File(ctx.applicationInfo.nativeLibraryDir, "libovpnexec.so")
        if (!bin.exists()) error("هسته‌ی OpenVPN در این نسخه‌ی برنامه نیست.")
        val dir = File(ctx.filesDir, "openvpn").apply { mkdirs() }
        // a unix socket path must stay under 108 bytes; filesDir is short enough
        sockPath = File(dir, "mgmt-$tag").absolutePath
        File(sockPath).delete()
        val ls = LocalSocket()
        ls.bind(LocalSocketAddress(sockPath, LocalSocketAddress.Namespace.FILESYSTEM))
        bound = ls
        server = LocalServerSocket(ls.fileDescriptor)
        val cfg = File(dir, "$tag.ovpn")
        cfg.writeText(configText + listOf(
            "management $sockPath unix", "management-client", "management-query-passwords", "management-hold",
            "tmp-dir ${dir.absolutePath}", "script-security 1",
        ).joinToString("\n", postfix = "\n"))
        cfgFile = cfg
        sentAuth = false
        val pb = ProcessBuilder(listOf(bin.absolutePath, "--config", cfg.absolutePath) + extraArgs).directory(dir).redirectErrorStream(true)
        pb.environment()["LD_LIBRARY_PATH"] = ctx.applicationInfo.nativeLibraryDir
        val p = pb.start()
        proc = p
        Thread {
            runCatching { p.inputStream.bufferedReader().forEachLine { l -> if (l.isNotBlank()) h.line(l.replace(Regex("^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d "), "")) } }
            val code = runCatching { p.waitFor() }.getOrDefault(-1)
            cleanup()
            h.exit(code)
        }.apply { isDaemon = true }.start()
        Thread {
            val s = runCatching { server!!.accept() }.getOrNull() ?: return@Thread
            sock = s
            val buf = ByteArray(8192)
            val text = StringBuilder()
            runCatching {
                while (true) {
                    val n = s.inputStream.read(buf)
                    if (n < 0) break
                    s.ancillaryFileDescriptors?.let { synchronized(fds) { fds.addAll(it) } }
                    text.append(String(buf, 0, n))
                    while (true) {
                        val i = text.indexOf("\n")
                        if (i < 0) break
                        val line = text.substring(0, i).trimEnd('\r')
                        text.delete(0, i + 1)
                        handle(line, creds, h)
                    }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    private fun send(cmd: String, fd: FileDescriptor? = null) {
        val s = sock ?: return
        synchronized(this) {
            runCatching {
                if (fd != null) s.setFileDescriptorsForSend(arrayOf(fd))
                s.outputStream.write("$cmd\n".toByteArray())
                s.outputStream.flush()
                if (fd != null) s.setFileDescriptorsForSend(null)
            }
        }
    }

    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun handle(msg: String, creds: Pair<String, String>?, h: Handler) {
        when {
            msg.startsWith(">HOLD:") -> { send("state on"); send("hold release") }
            msg.startsWith(">STATE:") -> {
                val p = msg.removePrefix(">STATE:").split(',')
                h.state(p.getOrElse(1) { "" }, p.drop(2).joinToString(","))
            }
            msg.startsWith(">PASSWORD:") -> {
                val body = msg.removePrefix(">PASSWORD:")
                if (body.startsWith("Verification Failed")) { h.state("AUTH_FAILED", body); return }
                val type = Regex("^Need '([^']+)'").find(body)?.groupValues?.get(1) ?: return
                if (type == "Auth" && creds != null && !sentAuth) {
                    sentAuth = true
                    send("username ${quote(type)} ${quote(creds.first)}")
                    send("password ${quote(type)} ${quote(creds.second)}")
                } else if (type == "Auth" && sentAuth) {
                    h.state("AUTH_FAILED", "credentials rejected"); send("signal SIGTERM")
                } else {
                    h.state("NEED_CREDS", type); send("signal SIGTERM")
                }
            }
            msg.startsWith(">NEED-OK:") -> {
                val body = msg.removePrefix(">NEED-OK:")
                val what = Regex("'([^']+)'").find(body)?.groupValues?.get(1) ?: return
                val arg = body.substringAfter("MSG:", "")
                when (what) {
                    "PROTECTFD" -> {
                        val fd = synchronized(fds) { fds.removeFirstOrNull() }
                        if (fd != null) {
                            runCatching { ParcelFileDescriptor.dup(fd).use { h.protect(it.fd) } }
                            runCatching { Os.close(fd) }
                        }
                        send("needok '$what' ok")
                    }
                    "OPENTUN" -> {
                        val pfd = runCatching { h.openTun() }.onFailure { LogBuffer.add("[openvpn] ساخت تونل نشد: ${it.message}") }.getOrNull()
                        if (pfd == null) send("needok '$what' cancel")
                        else { send("needok '$what' ok", pfd.fileDescriptor); runCatching { pfd.close() } }
                    }
                    else -> send("needok '$what' ${h.need(what, arg) ?: "ok"}")
                }
            }
        }
    }

    fun stop() {
        val p = proc ?: return
        send("signal SIGTERM")
        runCatching { if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly() }
        cleanup()
    }

    private fun cleanup() {
        proc = null
        runCatching { sock?.close() }
        runCatching { server?.close() }
        runCatching { bound?.close() }
        sock = null; server = null; bound = null
        synchronized(fds) { fds.forEach { runCatching { Os.close(it) } }; fds.clear() }
        cfgFile?.delete()
        File(sockPath).delete()
    }
}

/**
 * The OpenVPN engine: builds the TUN from what the server pushes, with Iranian (and the user's
 * direct) IPv4 ranges excluded (Android 13+) and the per-app split applied.
 * [start] blocks until the tunnel is up and throws a Persian message on failure.
 */
class OpenVpnEngine(
    private val ctx: Context,
    private val ovpnText: String,
    private val creds: Pair<String, String>?,
    private val split: SingboxConfig.Split,
    private val directV4: List<String>,
    private val blockIpv6: Boolean,
    private val isCancelled: () -> Boolean,
) : CoreEngine {
    /** Called when OpenVPN exits on its own after it was connected. */
    @Volatile var onStopped: (() -> Unit)? = null

    private val proc = OvpnProcess(ctx, "run")
    @Volatile private var userStop = false
    @Volatile private var connected = false
    @Volatile private var failure: String? = null
    @Volatile private var exited = false

    private var local4: Pair<String, Int>? = null
    private var local6: Pair<String, Int>? = null
    private var mtu = 1500
    private val routes4 = mutableListOf<Pair<String, Int>>()
    private val skip4 = mutableListOf<Pair<String, Int>>()
    private val routes6 = mutableListOf<Pair<String, Int>>()
    private val dns = mutableListOf<String>()
    private var domain: String? = null

    override fun start(service: VpnService, configJson: String) {
        val parsed = Ovpn.parse(ovpnText)
        if (!parsed.ok) error(parsed.problems.joinToString("؛ "))
        if (parsed.needsAuth && creds == null) error("این کانفیگ OpenVPN نام کاربری و رمز می‌خواهد؛ در لیست کانفیگ‌ها با دکمه‌ی 🔑 واردش کنید.")
        if (parsed.removed.isNotEmpty()) LogBuffer.add("[openvpn] این دستورها از کانفیگ حذف شدند (امنیت): ${parsed.removed.joinToString(", ")}")
        val r = parsed.remotes.first()
        LogBuffer.add("[openvpn] اتصال به ${r.host}:${r.port}/${r.proto}" + if (parsed.remotes.size > 1) " (و ${parsed.remotes.size - 1} سرور دیگر)" else "")
        if (directV4.isNotEmpty()) LogBuffer.add(
            if (Build.VERSION.SDK_INT >= 33) "[openvpn] ${directV4.size} محدوده‌ی IP ایران/لیست مستقیم بیرون از تونل می‌رود"
            else "[openvpn] «ایران مستقیم» برای OpenVPN به اندروید ۱۳ یا جدیدتر نیاز دارد؛ همه از تونل می‌رود",
        )
        proc.start(Ovpn.build(parsed), listOf("--connect-retry-max", "5"), creds, object : OvpnProcess.Handler {
            override fun protect(fd: Int) = service.protect(fd)
            override fun need(what: String, arg: String): String? = onNeed(what, arg)
            override fun openTun() = buildTun(service)
            override fun state(name: String, detail: String) {
                when (name) {
                    "CONNECTED" -> connected = true
                    "RECONNECTING" -> LogBuffer.add("[openvpn] اتصال دوباره… ($detail)")
                    "AUTH_FAILED" -> failure = "نام کاربری یا رمز را سرور قبول نکرد"
                    "NEED_CREDS" -> failure = if (detail == "Auth") "نام کاربری و رمز لازم است" else "«$detail» لازم است (پشتیبانی نمی‌شود)"
                }
            }
            override fun line(text: String) {
                LogBuffer.add("[openvpn] $text")
                friendly(text)?.let { if (failure == null) failure = it }
                if ("Initialization Sequence Completed" in text) connected = true
            }
            override fun exit(code: Int) {
                exited = true
                LogBuffer.add("[openvpn] پروسه تمام شد (کد خروج $code)")
                if (connected && !userStop) onStopped?.invoke()
            }
        })
        val deadline = System.currentTimeMillis() + 90_000
        while (!connected) {
            if (isCancelled()) { stop(); error("لغو شد") }
            if (exited) error(failure ?: "OpenVPN متوقف شد (جزئیات در لاگ)")
            if (failure != null && (failure!!.contains("رمز") || failure!!.contains("لازم"))) { stop(); error(failure!!) }
            if (System.currentTimeMillis() > deadline) { stop(); error(failure ?: "OpenVPN در ۹۰ ثانیه وصل نشد") }
            Thread.sleep(300)
        }
    }

    private fun onNeed(what: String, arg: String): String? {
        val p = arg.trim().split(Regex("\\s+"))
        when (what) {
            "IFCONFIG" -> {
                // "local netmask-or-peer mtu topology"
                val bits = when (p.getOrNull(3)) { "subnet" -> Ovpn.maskToPrefix(p.getOrElse(1) { "255.255.255.255" }); "net30" -> 30; else -> 32 }
                local4 = p[0] to bits
                p.getOrNull(2)?.toIntOrNull()?.let { mtu = it }
            }
            "IFCONFIG6" -> {
                local6 = p[0].substringBefore('/') to (p[0].substringAfter('/', "64").toIntOrNull() ?: 64)
                p.getOrNull(1)?.toIntOrNull()?.let { mtu = it }
            }
            "ROUTE" -> {
                // "network netmask gateway [dev iface]": a route via another interface (net_gateway) stays outside
                val r = p[0] to Ovpn.maskToPrefix(p.getOrElse(1) { "255.255.255.255" })
                if (p.size >= 5 && !p[4].startsWith("tun")) skip4 += r else routes4 += r
            }
            "ROUTE6" -> routes6 += p[0].substringBefore('/') to (p[0].substringAfter('/', "128").toIntOrNull() ?: 128)
            "DNSSERVER", "DNS6SERVER" -> dns += p[0]
            "DNSDOMAIN" -> domain = p[0]
            // a reconnect re-opens the tunnel; Android swaps it without a gap
            "PERSIST_TUN_ACTION" -> return "OPEN_BEFORE_CLOSE"
        }
        return null
    }

    private fun buildTun(service: VpnService): ParcelFileDescriptor? {
        val b = service.Builder().setSession("GozarVpn").setMtu(mtu)
        if (Build.VERSION.SDK_INT >= 29) b.setMetered(false)
        local4?.let { b.addAddress(it.first, it.second) }
        local6?.let { b.addAddress(it.first, it.second) }
        routes4.forEach { runCatching { b.addRoute(it.first, it.second) } }
        routes6.forEach { runCatching { b.addRoute(it.first, it.second) } }
        if (local6 == null && blockIpv6) {
            // IPv6 goes into the tunnel and is dropped there instead of leaking past it
            b.addAddress("fdfe:dcba:9877::1", 126)
            b.addRoute("::", 0)
        }
        dns.forEach { runCatching { b.addDnsServer(it) } }
        domain?.let { runCatching { b.addSearchDomain(it) } }
        if (Build.VERSION.SDK_INT >= 33) {
            val out = skip4 + directV4.mapNotNull { Ovpn.cidr4(it) }
            out.forEach { (a, bits) -> runCatching { b.excludeRoute(IpPrefix(InetAddress.getByName(a), bits)) } }
        }
        if (split.include.isNotEmpty()) split.include.forEach { runCatching { b.addAllowedApplication(it) } }
        else split.exclude.forEach { runCatching { b.addDisallowedApplication(it) } }
        // the next OPENTUN (after a reconnect) gets fresh settings from the server
        routes4.clear(); routes6.clear(); skip4.clear(); dns.clear()
        return b.establish()
    }

    override fun stop() {
        userStop = true
        proc.stop()
    }

    companion object {
        private val FRIENDLY = listOf(
            Regex("TLS key negotiation failed|TLS handshake failed") to "دست‌دادن TLS با سرور انجام نشد (سرور در دسترس نیست یا فیلتر شده)",
            Regex("Cannot resolve host address|RESOLVE: Cannot resolve") to "آدرس سرور پیدا نشد (DNS)",
            Regex("AUTH_FAILED") to "نام کاربری یا رمز را سرور قبول نکرد",
            Regex("Unrecognized option or missing or extra parameter") to "یکی از تنظیمات این کانفیگ را OpenVPN نمی‌شناسد (جزئیات در لاگ)",
            Regex("(?i)cipher .* not supported|Unsupported cipher") to "رمزنگاری این کانفیگ پشتیبانی نمی‌شود",
        )

        fun friendly(line: String) = FRIENDLY.firstOrNull { it.first.containsMatchIn(line) }?.second

        /**
         * A real handshake with the server and no tunnel (--dev null). OK once the server accepted us.
         * Its sockets are not protected, so with a VPN already running the test goes through it.
         */
        fun test(ctx: Context, ovpnText: String, creds: Pair<String, String>?): TestResult {
            val parsed = Ovpn.parse(ovpnText)
            if (!parsed.ok) return TestResult(false, error = parsed.problems.joinToString("؛ "))
            if (parsed.needsAuth && creds == null) return TestResult(false, error = "نام کاربری و رمز لازم است")
            val begun = System.currentTimeMillis()
            val p = OvpnProcess(ctx, "test-${System.nanoTime() % 100000}")
            val res = java.util.concurrent.atomic.AtomicReference<TestResult?>(null)
            var last = ""
            try {
                p.start(Ovpn.build(parsed), listOf("--dev", "null", "--route-noexec", "--ifconfig-noexec", "--connect-retry-max", "1"), creds, object : OvpnProcess.Handler {
                    override fun protect(fd: Int) = true
                    override fun line(text: String) {
                        last = text
                        if ("Peer Connection Initiated" in text) res.compareAndSet(null, TestResult(true, latencyMs = System.currentTimeMillis() - begun))
                        friendly(text)?.let { res.compareAndSet(null, TestResult(false, error = it)) }
                    }
                    override fun state(name: String, detail: String) {
                        if (name == "AUTH_FAILED") res.compareAndSet(null, TestResult(false, error = "نام کاربری یا رمز را سرور قبول نکرد"))
                    }
                    override fun exit(code: Int) { res.compareAndSet(null, TestResult(false, error = "OpenVPN بسته شد: ${last.take(100)}")) }
                })
                val deadline = System.currentTimeMillis() + 20_000
                while (res.get() == null && System.currentTimeMillis() < deadline) Thread.sleep(200)
                return res.get() ?: TestResult(false, error = "در ۲۰ ثانیه جوابی نیامد")
            } catch (t: Throwable) {
                return TestResult(false, error = t.message ?: "خطا")
            } finally {
                p.stop()
            }
        }
    }
}
