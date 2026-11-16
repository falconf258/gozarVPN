package app.gozarvpn.android.data

import android.util.Base64
import com.google.crypto.tink.subtle.X25519
import kotlinx.serialization.json.*
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.time.Instant

/** Free Cloudflare WARP: registers a device and returns a sing-box WireGuard endpoint. */
object Warp {
    private const val API = "https://api.cloudflareclient.com/v0a2158/reg"
    private const val EDGE_IP = "162.159.192.1"
    private const val EDGE_PORT = 2408

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)

    private fun call(method: String, url: String, body: JsonObject?, token: String? = null): JsonObject {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15000
        c.readTimeout = 20000
        c.setRequestProperty("User-Agent", "okhttp/3.12.1")
        c.setRequestProperty("CF-Client-Version", "a-6.3-1922")
        c.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
        if (token != null) c.setRequestProperty("Authorization", "Bearer $token")
        try {
            if (body != null) {
                c.doOutput = true
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            if (c.responseCode >= 400) error("Cloudflare API ${c.responseCode}")
            return Json.parseToJsonElement(c.inputStream.bufferedReader().readText()).jsonObject
        } finally {
            c.disconnect()
        }
    }

    /** Blocking: call from Dispatchers.IO. */
    fun register(): LinkParser.Parsed {
        val priv = X25519.generatePrivateKey()
        val pub = X25519.publicFromPrivate(priv)
        val reg = call("POST", API, buildJsonObject {
            put("key", b64(pub)); put("install_id", ""); put("fcm_token", "")
            put("tos", Instant.now().toString()); put("type", "Android"); put("model", "PC"); put("locale", "en_US")
        })
        val cfg = reg["config"]?.jsonObject ?: error("پاسخ Cloudflare ناقص بود")
        val peer = cfg["peers"]?.jsonArray?.firstOrNull()?.jsonObject ?: error("peer پیدا نشد")
        val peerKey = peer["public_key"]?.jsonPrimitive?.content ?: error("کلید peer پیدا نشد")
        val addrs = cfg["interface"]?.jsonObject?.get("addresses")?.jsonObject
        val addresses = listOfNotNull(
            addrs?.get("v4")?.jsonPrimitive?.contentOrNull?.let { "$it/32" },
            addrs?.get("v6")?.jsonPrimitive?.contentOrNull?.let { "$it/128" },
        ).ifEmpty { listOf("172.16.0.2/32") }
        val reserved = cfg["client_id"]?.jsonPrimitive?.contentOrNull
            ?.let { Base64.decode(it, Base64.DEFAULT).take(3).map { b -> b.toInt() and 0xff } }

        // Best effort: make sure the registration is switched on.
        runCatching {
            call("PATCH", "$API/${reg["id"]?.jsonPrimitive?.content}/account",
                buildJsonObject { put("warp_enabled", true) }, reg["token"]?.jsonPrimitive?.contentOrNull)
        }

        val o = buildJsonObject {
            put("type", "wireguard"); put("tag", "proxy"); put("system", false); put("mtu", 1280)
            put("address", buildJsonArray { addresses.forEach { add(it) } })
            put("private_key", b64(priv))
            put("peers", buildJsonArray {
                add(buildJsonObject {
                    put("address", EDGE_IP); put("port", EDGE_PORT); put("public_key", peerKey)
                    put("allowed_ips", buildJsonArray { add("0.0.0.0/0"); add("::/0") })
                    if (reserved != null && reserved.size == 3) put("reserved", buildJsonArray { reserved.forEach { add(it) } })
                })
            })
        }
        return LinkParser.Parsed("Cloudflare WARP (رایگان)", "wireguard", "endpoint", o.toString())
    }
}
