package app.gozarvpn.android.data

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

object Subscription {
    /** Downloads a subscription URL (blocking: call from Dispatchers.IO). */
    fun fetch(url: String): String {
        // Some panels answer differently by User-Agent: retry once with a browser UA on a server error.
        return try { fetchOnce(url, "v2rayNG/1.10.2") } catch (e: ServerError) {
            try { fetchOnce(url, "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36") } catch (_: ServerError) { throw e }
        }
    }

    private class ServerError(message: String) : IllegalStateException(message)

    private fun fetchOnce(url: String, ua: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 20000
        c.setRequestProperty("User-Agent", ua)
        c.setRequestProperty("Accept", "*/*")
        try {
            val code = c.responseCode
            if (code != 200) {
                val body = runCatching { (c.errorStream ?: c.inputStream).bufferedReader().readText().trim().take(200) }.getOrDefault("")
                val msg = "سرور پاسخ $code داد (مشکل از خود سرور/پنل ساب است)" + if (body.isNotEmpty()) ". متن پاسخ: $body" else ""
                if (code >= 500) throw ServerError(msg) else error(msg)
            }
            return c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }

    fun nameFor(url: String): String = runCatching { URI(url).host }.getOrNull() ?: "ساب جدید"
}

/** A readable Persian reason for a failed download. */
fun describeNetworkError(t: Throwable): String = when (t) {
    is java.net.UnknownHostException -> "آدرس پیدا نشد (اینترنت یا DNS مشکل دارد). اگر این سایت فیلتر است، اول با یک فیلترشکن وصل شوید و دوباره امتحان کنید."
    is java.net.SocketTimeoutException -> "مهلت اتصال تمام شد. اگر سایت فیلتر است، اول با یک فیلترشکن وصل شوید."
    is javax.net.ssl.SSLException -> "اتصال امن (TLS) برقرار نشد: ${t.message}"
    is java.net.ConnectException -> "اتصال به سرور برقرار نشد. اگر سایت فیلتر است، اول با یک فیلترشکن وصل شوید."
    is java.net.MalformedURLException -> "لینک درست نیست."
    else -> "${t::class.java.simpleName}: ${t.message}"
}
