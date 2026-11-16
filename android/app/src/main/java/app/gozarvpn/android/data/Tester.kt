package app.gozarvpn.android.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.serialization.json.*
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.SocketFactory
import javax.net.ssl.*

/**
 * Quick reachability test for a saved config, done without the VPN core:
 * TCP connect -> TLS handshake -> (WebSocket upgrade when the transport is ws).
 * It runs on the phone's real network even while the VPN is up.
 * WireGuard (UDP) cannot be probed this way, so those are skipped.
 */
object Tester {
    private const val TIMEOUT = 6000

    private val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    @Suppress("DEPRECATION")
    private fun physicalNetwork(ctx: Context): Network? {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        return cm.allNetworks.firstOrNull {
            val c = cm.getNetworkCapabilities(it)
            c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        }
    }

    /**
     * AmneziaWG has no TCP handshake to probe, so the engine itself runs briefly on a spare port and
     * one real request goes through it. Its UDP goes out like any app's (through a running VPN too).
     */
    private fun testAwg(ctx: Context, e: ConfigEntry): TestResult {
        val conf = Json.parseToJsonElement(e.json).jsonObject["conf"]?.jsonPrimitive?.contentOrNull ?: return TestResult(false, error = "کانفیگ خالی است")
        val bin = java.io.File(ctx.applicationInfo.nativeLibraryDir, "libawg.so")
        if (!bin.exists()) return TestResult(false, error = "هسته‌ی AmneziaWG در برنامه نیست")
        val port = java.net.ServerSocket(0).use { it.localPort }
        val file = java.io.File(ctx.cacheDir, "awg-test-$port.conf")
        var p: Process? = null
        try {
            file.writeText(AwgConf.forProxy(conf, port) { h -> runCatching { java.net.InetAddress.getByName(h).hostAddress }.getOrNull() ?: h })
            p = ProcessBuilder(bin.absolutePath, "-s", "-c", file.absolutePath).redirectErrorStream(true).start()
            Thread { runCatching { p.inputStream.copyTo(java.io.OutputStream.nullOutputStream()) } }.apply { isDaemon = true }.start()
            val deadline = System.currentTimeMillis() + 8000
            while (System.currentTimeMillis() < deadline && runCatching { Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 300) } }.isFailure) Thread.sleep(200)
            val ms = app.gozarvpn.android.core.ProxyCores.probeSocks(port, timeoutMs = 10_000)
            return if (ms != null) TestResult(true, latencyMs = ms) else TestResult(false, error = "دست‌دادن AmneziaWG انجام نشد")
        } catch (t: Throwable) {
            return TestResult(false, error = t.message ?: "خطا")
        } finally {
            runCatching { p?.destroyForcibly() }
            file.delete()
        }
    }

    /** null = this protocol cannot be tested this way. */
    fun test(ctx: Context, e: ConfigEntry): TestResult? {
        if (e.kind == "awg") return testAwg(ctx, e)
        if (e.kind == "openvpn") {
            val text = Json.parseToJsonElement(e.json).jsonObject["ovpn"]?.jsonPrimitive?.contentOrNull ?: return TestResult(false, error = "کانفیگ خالی است")
            return app.gozarvpn.android.core.OpenVpnEngine.test(ctx, text, OvpnCreds.load(ctx, e.id))
        }
        if (e.kind == "endpoint") return null
        val o = Json.parseToJsonElement(e.json).jsonObject
        val server = o["server"]?.jsonPrimitive?.contentOrNull ?: return TestResult(false, error = "آدرس سرور ندارد")
        val port = o["server_port"]?.jsonPrimitive?.intOrNull ?: 443
        val tls = o["tls"]?.jsonObject
        val useTls = tls?.get("enabled")?.jsonPrimitive?.booleanOrNull == true
        val transport = o["transport"]?.jsonObject
        val ws = transport?.get("type")?.jsonPrimitive?.contentOrNull == "ws"
        val wsHost = transport?.get("headers")?.jsonObject?.get("Host")?.jsonPrimitive?.contentOrNull
        val sni = tls?.get("server_name")?.jsonPrimitive?.contentOrNull ?: wsHost ?: server
        val path = transport?.get("path")?.jsonPrimitive?.contentOrNull ?: "/"

        val net = physicalNetwork(ctx)
        val started = System.nanoTime()
        var raw: Socket? = null
        try {
            val addr = if (net != null) net.getByName(server) else java.net.InetAddress.getByName(server)
            raw = (net?.socketFactory ?: SocketFactory.getDefault()).createSocket()
            raw.connect(InetSocketAddress(addr, port), TIMEOUT)
            raw.soTimeout = TIMEOUT
            // These configs exist because an unfragmented ClientHello gets reset by DPI;
            // our plain handshake would fail for the same reason, so stop at TCP connect.
            if (tls?.get("fragment")?.jsonPrimitive?.booleanOrNull == true) {
                return TestResult(true, latencyMs = (System.nanoTime() - started) / 1_000_000)
            }
            var sock: Socket = raw
            if (useTls) {
                val sc = SSLContext.getInstance("TLS").also { it.init(null, arrayOf<TrustManager>(trustAll), SecureRandom()) }
                val ssl = sc.socketFactory.createSocket(raw, sni, port, true) as SSLSocket
                ssl.sslParameters = ssl.sslParameters.also { p ->
                    p.serverNames = listOf(SNIHostName(sni))
                    if (ws) p.applicationProtocols = arrayOf("http/1.1")
                }
                ssl.soTimeout = TIMEOUT
                ssl.startHandshake()
                sock = ssl
            }
            if (ws) {
                val key = java.util.Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })
                val req = "GET $path HTTP/1.1\r\nHost: ${wsHost ?: sni}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\nUser-Agent: Mozilla/5.0\r\n\r\n"
                sock.getOutputStream().write(req.toByteArray())
                sock.getOutputStream().flush()
                val first = sock.getInputStream().bufferedReader().readLine() ?: return TestResult(false, error = "پاسخی نیامد")
                if (!first.contains(" 101")) return TestResult(false, error = "پاسخ سرور: ${first.take(40)}")
            }
            return TestResult(true, latencyMs = (System.nanoTime() - started) / 1_000_000)
        } catch (t: Throwable) {
            return TestResult(false, error = t.message ?: t::class.java.simpleName)
        } finally {
            runCatching { raw?.close() }
        }
    }

    /**
     * Exit IP and country code as the internet sees them (Cloudflare's trace page), through
     * the engine's SOCKS port when given (our app is outside the TUN then), else through the TUN.
     */
    data class ExitInfo(val ip: String, val cc: String, val warp: Boolean) {
        // Cloudflare places WARP exits in the user's own country (it reports loc=IR from Iran),
        // so for WARP the country says nothing about where traffic leaves: no flag then.
        fun flagCode(): String? = cc.takeIf { !warp && it.length == 2 }
        fun place(): String = if (warp) "Cloudflare WARP" else cc.ifEmpty { "?" }
    }

    fun exitInfo(socksPort: Int?): ExitInfo? = try {
        val url = URL("https://cloudflare.com/cdn-cgi/trace")
        val c = (if (socksPort != null) url.openConnection(java.net.Proxy(java.net.Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
            else url.openConnection()) as HttpURLConnection
        c.connectTimeout = 10000; c.readTimeout = 10000
        val body = try { c.inputStream.bufferedReader().readText() } finally { c.disconnect() }
        val kv = body.lines().mapNotNull { l -> l.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
        kv["ip"]?.let { ExitInfo(it, kv["loc"] ?: "", kv["warp"] == "on" || kv["warp"] == "plus") }
    } catch (_: Throwable) { null }

    /** Is the internet reachable through the running VPN? Returns the delay in ms or null. */
    fun probeTunnel(): Long? = try {
        val t0 = System.nanoTime()
        val c = URL("https://cp.cloudflare.com/generate_204").openConnection() as HttpURLConnection
        c.connectTimeout = 7000; c.readTimeout = 7000; c.instanceFollowRedirects = false
        val code = try { c.responseCode } finally { c.disconnect() }
        if (code in 200..399) (System.nanoTime() - t0) / 1_000_000 else null
    } catch (_: Throwable) { null }
}
