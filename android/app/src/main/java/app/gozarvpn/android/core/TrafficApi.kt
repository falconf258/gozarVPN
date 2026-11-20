package app.gozarvpn.android.core

import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.security.SecureRandom

/**
 * sing-box's own byte counters (its clash_api, bound to 127.0.0.1 with a random secret): the total
 * that went through the tunnel since sing-box started, all connections included.
 */
object TrafficApi {
    const val PORT = 9094
    val secret: String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    /** (download, upload) bytes since sing-box started, or null when it does not answer. */
    fun totals(): Pair<Long, Long>? = runCatching {
        val c = URL("http://127.0.0.1:$PORT/connections").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        c.connectTimeout = 1500; c.readTimeout = 3000
        c.setRequestProperty("Authorization", "Bearer $secret")
        try {
            if (c.responseCode != 200) return null
            val body = c.inputStream.bufferedReader().readText()
            val d = Regex("\"downloadTotal\"\\s*:\\s*(\\d+)").find(body)?.groupValues?.get(1)?.toLong() ?: return null
            val u = Regex("\"uploadTotal\"\\s*:\\s*(\\d+)").find(body)?.groupValues?.get(1)?.toLong() ?: return null
            d to u
        } finally { c.disconnect() }
    }.getOrNull()
}
