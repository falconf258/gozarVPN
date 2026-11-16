package app.gozarvpn.android.core

import android.content.Context
import app.gozarvpn.android.data.LogBuffer
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * A proxy core (Aether, Tor, mihomo) run as a child process that exposes a local
 * SOCKS port; sing-box's TUN then forwards everything to that port.
 *
 * Android 10+ only lets apps exec files from the native library dir, so each core
 * ships as jniLibs/arm64-v8a/lib<name>.so and needs useLegacyPackaging = true.
 */
class ChildCore(private val label: String) {
    @Volatile private var proc: Process? = null

    /** Last line that looked like progress (e.g. Tor's "Bootstrapped 45%"). */
    @Volatile var progress: String? = null
        private set

    /** Last error-looking line the core printed, shown to the user instead of a bare exit code. */
    @Volatile var lastError: String? = null
        private set

    fun nativeBin(ctx: Context, lib: String): File {
        val f = File(ctx.applicationInfo.nativeLibraryDir, lib)
        if (!f.exists()) error("فایل هسته‌ی $label ($lib) در برنامه پیدا نشد.")
        return f
    }

    /**
     * Starts the process and blocks until [ready] matches a log line and the SOCKS
     * port accepts connections, or throws after [timeoutMs].
     */
    fun start(
        ctx: Context,
        cmd: List<String>,
        workDir: File,
        env: Map<String, String>,
        socksPort: Int,
        timeoutMs: Long,
        ready: (String) -> Boolean,
        isProgress: (String) -> Boolean = { false },
        isCancelled: () -> Boolean,
    ) {
        stop()
        workDir.mkdirs()
        val pb = ProcessBuilder(cmd).directory(workDir).redirectErrorStream(true)
        pb.environment().apply {
            put("HOME", workDir.absolutePath)
            put("TMPDIR", workDir.absolutePath)
            put("LD_LIBRARY_PATH", ctx.applicationInfo.nativeLibraryDir)
            putAll(env)
        }
        LogBuffer.add("[$label] اجرا: ${File(cmd[0]).name}")
        lastError = null
        val p = pb.start()
        proc = p
        val sawReady = java.util.concurrent.atomic.AtomicBoolean(false)
        var failures = 0
        var lastSummary = System.currentTimeMillis()
        var lastStuck: String? = null
        val reader = Thread {
            runCatching {
                p.inputStream.bufferedReader().forEachLine { line ->
                    // colour codes out; key material masked in case a core ever prints its config
                    val clean = line.replace(Regex("\u001B\\[[0-9;]*m"), "").trim()
                        .replace(Regex("(?i)(private_?key\\s*[=:]\\s*)\\S+"), "$1***")
                    if (clean.isEmpty()) return@forEachLine
                    // Tor reports every bridge it touches; keep progress, warnings and errors
                    if (NOISE.any { it in clean }) {
                        if (isProgress(clean)) progress = clean
                        return@forEachLine
                    }
                    // per-bridge failure lines repeat hundreds of times: count, summarize every 15 s
                    if (REPEATED.any { it in clean }) {
                        failures++
                        if (clean.contains("Problem bootstrapping")) lastStuck = clean.substringAfter("Problem bootstrapping.").substringBefore("(").trim()
                        val now = System.currentTimeMillis()
                        if (now - lastSummary > 15_000) {
                            LogBuffer.add("[$label] $failures تلاش ناموفق برای اتصال به پل/رله در ۱۵ ثانیه‌ی اخیر" + (lastStuck?.let { " · $it" } ?: ""))
                            failures = 0; lastSummary = now
                        }
                        return@forEachLine
                    }
                    LogBuffer.add("[$label] $clean")
                    if (Regex("(?i)\\berror\\b|\\[err\\]|fatal|panic").containsMatchIn(clean)) lastError = clean
                    if (isProgress(clean)) progress = clean
                    if (ready(clean)) sawReady.set(true)
                }
            }
            // output closed = process gone; say how it ended
            runCatching { LogBuffer.add("[$label] پروسه تمام شد (کد خروج ${p.waitFor()})") }
        }.also { it.isDaemon = true; it.start() }

        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            if (isCancelled()) { stop(); error("لغو شد") }
            if (!p.isAlive) {
                reader.join(500)
                proc = null
                error("هسته متوقف شد (کد ${p.exitValue()})" + (lastError?.let { ": ${it.take(200)}" } ?: ". جزئیات در تب لاگ."))
            }
            if (sawReady.get() && portOpen(socksPort)) break
            if (System.currentTimeMillis() > deadline) {
                stop()
                error("هسته‌ی $label در ${timeoutMs / 1000} ثانیه آماده نشد. جزئیات در تب لاگ.")
            }
            Thread.sleep(300)
        }
        LogBuffer.add("[$label] آماده روی 127.0.0.1:$socksPort")
    }

    fun isRunning() = proc?.isAlive == true

    fun stop() {
        val p = proc ?: return
        proc = null
        runCatching { p.destroy() }
        runCatching { if (!p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly() }
    }

    private companion object {
        val NOISE = listOf("Using TLS SNI", "new bridge descriptor", "has both an IPv4 and an IPv6 address")
        val REPEATED = listOf(
            "Proxy Client: unable to connect", "connections have failed", "connections died in state",
            "Problem bootstrapping", "Managed proxy", "Error dialing",
        )
    }

    private fun portOpen(port: Int) = runCatching {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 400) }
        true
    }.getOrDefault(false)
}
