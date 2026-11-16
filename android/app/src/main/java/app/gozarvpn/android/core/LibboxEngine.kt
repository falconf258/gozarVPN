package app.gozarvpn.android.core

import android.net.VpnService
import android.os.Build
import app.gozarvpn.android.data.LogBuffer
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.SetupOptions
import io.nekohasekai.libbox.SystemProxyStatus
import java.io.File
import java.io.RandomAccessFile

/** Runs sing-box (libbox.aar, v1.14) inside the VpnService. */
class LibboxEngine : CoreEngine {
    /** Called when the core asks to be stopped on its own (error, reload failure…). */
    var onStopped: (() -> Unit)? = null

    private var server: CommandServer? = null
    private var platform: AndroidPlatform? = null
    private var tail: LogTail? = null
    @Volatile private var stopping = false

    override fun start(service: VpnService, configJson: String) {
        stopping = false
        setup(service)
        try {
            Libbox.checkConfig(configJson)
        } catch (t: Throwable) {
            throw IllegalStateException("کانفیگ نامعتبر است: ${t.message}")
        }
        val logFile = File(File(service.filesDir, "box"), SingboxConfig.LOG_FILE)
        runCatching { logFile.writeText("") }
        tail = LogTail(logFile).also { it.start() }

        val p = AndroidPlatform(service).also { platform = it }
        p.monitor.start()
        try {
            val s = CommandServer(handler, p)
            server = s
            s.start()
            s.startOrReloadService(configJson, OverrideOptions())
            LogBuffer.add("هسته‌ی sing-box ${Libbox.version()} راه افتاد")
        } catch (t: Throwable) {
            val msg = t.message ?: t.toString()
            stop()
            throw IllegalStateException(msg)
        }
    }

    override fun stop() {
        if (stopping) return
        stopping = true
        val s = server
        val p = platform
        server = null
        platform = null
        runCatching { p?.closeTun() }
        runCatching { s?.closeService() }
        runCatching { s?.close() }
        runCatching { p?.monitor?.stop() }
        Thread { Thread.sleep(800); tail?.stop(); tail = null }.start()
    }

    private val handler = object : CommandServerHandler {
        override fun connectSSHAgent(): Int = error("not supported")
        override fun getSystemProxyStatus(): SystemProxyStatus = SystemProxyStatus()
        override fun serviceReload() {}
        override fun serviceStop() { if (!stopping) onStopped?.invoke() }
        override fun setSystemProxyEnabled(enabled: Boolean) {}
        override fun triggerNativeCrash() {}
        override fun writeDebugMessage(message: String?) { if (message != null) LogBuffer.add(message) }
    }

    private class LogTail(private val file: File) {
        @Volatile private var running = true
        private val thread = Thread {
            var raf: RandomAccessFile? = null
            try {
                while (running) {
                    if (raf == null && file.exists()) raf = RandomAccessFile(file, "r")
                    val line = raf?.readLine()
                    if (line == null) { Thread.sleep(400); continue }
                    // Android can't look up a connection's process; that line repeats per connection
                    if ("failed to search process" in line || "pre-match" in line) continue
                    LogBuffer.add(String(line.toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8))
                }
            } catch (_: Throwable) {
            } finally { runCatching { raf?.close() } }
        }.also { it.isDaemon = true }
        fun start() = thread.start()
        fun stop() { running = false }
    }

    companion object {
        @Volatile private var ready = false

        @Synchronized
        private fun setup(service: VpnService) {
            if (ready) return
            val work = File(service.filesDir, "box").also { it.mkdirs() }
            val o = SetupOptions()
            o.basePath = service.filesDir.path
            o.workingPath = work.path
            o.tempPath = service.cacheDir.path
            o.fixAndroidStack = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            o.logMaxLines = 2000L
            o.debug = false
            o.crashReportSource = "GozarVpn"
            Libbox.setup(o)
            ready = true
        }
    }
}
