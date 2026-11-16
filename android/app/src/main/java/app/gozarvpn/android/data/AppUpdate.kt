package app.gozarvpn.android.data

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.security.MessageDigest

/**
 * Updates of the app itself from the project's GitHub Releases (public API, no token: it works
 * once the repository or its releases are public; a private repo answers 404). The APK is picked by
 * this phone's CPU type, its version is read from the file name (release tags follow the Windows
 * version), and it must match SHA256SUMS.txt from the same release before it is offered to install.
 */
object AppUpdate {
    const val OWNER = "falconf258"
    const val REPO = "gozarVPN"
    const val RELEASES_PAGE = "https://github.com/$OWNER/$REPO/releases"
    private const val API = "https://api.github.com/repos/$OWNER/$REPO/releases?per_page=15"

    data class Found(
        val version: String, val tag: String, val title: String, val notes: String, val prerelease: Boolean,
        val file: String, val url: String, val size: Long, val sumsUrl: String?,
    )

    fun cmp(a: String, b: String): Int {
        val pa = a.split('.').map { it.toIntOrNull() ?: 0 }
        val pb = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val d = pa.getOrElse(i) { 0 } - pb.getOrElse(i) { 0 }
            if (d != 0) return d.coerceIn(-1, 1)
        }
        return 0
    }

    /** Newest APK above [current] for the first matching ABI in [abis] (universal as the fallback). */
    fun pick(releasesJson: String, current: String, abis: List<String>, beta: Boolean): Found? {
        val wanted = abis.filter { it == "arm64-v8a" || it == "armeabi-v7a" } + "universal"
        val re = Regex("^GozarVpn-(\\d+\\.\\d+\\.\\d+)-([a-z0-9-]+?)-release\\.apk$")
        var best: Pair<Found, Int>? = null
        for (r in Json.parseToJsonElement(releasesJson).jsonArray.map { it.jsonObject }) {
            if (r["draft"]?.jsonPrimitive?.booleanOrNull == true) continue
            val pre = r["prerelease"]?.jsonPrimitive?.booleanOrNull == true
            if (pre && !beta) continue
            val assets = (r["assets"] as? JsonArray)?.map { it.jsonObject } ?: continue
            val sums = assets.firstOrNull { it["name"]?.jsonPrimitive?.contentOrNull == "SHA256SUMS.txt" }?.get("browser_download_url")?.jsonPrimitive?.contentOrNull
            for (a in assets) {
                val name = a["name"]?.jsonPrimitive?.contentOrNull ?: continue
                val m = re.find(name) ?: continue
                val (ver, abi) = m.destructured
                val rank = wanted.indexOf(abi)
                if (rank < 0 || cmp(ver, current) <= 0) continue
                val f = Found(
                    ver, r["tag_name"]?.jsonPrimitive?.contentOrNull ?: "", r["name"]?.jsonPrimitive?.contentOrNull ?: "",
                    r["body"]?.jsonPrimitive?.contentOrNull ?: "", pre, name,
                    a["browser_download_url"]?.jsonPrimitive?.contentOrNull ?: continue, a["size"]?.jsonPrimitive?.longOrNull ?: 0, sums,
                )
                val b = best
                if (b == null || cmp(ver, b.first.version) > 0 || (cmp(ver, b.first.version) == 0 && rank < b.second)) best = f to rank
            }
        }
        return best?.first
    }

    fun hashFromSums(text: String, file: String): String? = text.lines().firstNotNullOfOrNull { line ->
        Regex("^([0-9a-fA-F]{64})\\s+\\*?(.+)$").find(line.trim())?.takeIf { it.groupValues[2].trim() == file }?.groupValues?.get(1)?.lowercase()
    }

    /** User-facing text for a failed request. */
    fun friendly(t: Throwable): String {
        val m = t.message ?: t.javaClass.simpleName
        return when {
            "HTTP 404" in m -> "نسخه‌ای روی GitHub پیدا نشد: مخزن هنوز خصوصی است یا منتشر نشده."
            "HTTP 403" in m -> "GitHub موقتاً اجازه نداد (محدودیت تعداد درخواست)؛ کمی بعد دوباره امتحان کنید."
            else -> m
        }
    }

    /** Direct first; if that fails and an engine's SOCKS port is up (our app is outside the TUN then), through it. */
    private fun <T> anyPath(socksPort: Int?, fn: (Proxy) -> T): T = try {
        fn(Proxy.NO_PROXY)
    } catch (t: Throwable) {
        if (socksPort == null) throw t
        fn(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
    }

    private fun open(url: String, proxy: Proxy): HttpURLConnection {
        val c = URL(url).openConnection(proxy) as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 30000
        c.setRequestProperty("User-Agent", "gozarvpn-updater")
        c.setRequestProperty("Accept", "application/vnd.github+json")
        if (c.responseCode != 200) { c.disconnect(); error("HTTP ${c.responseCode}") }
        return c
    }

    private fun text(url: String, proxy: Proxy) = open(url, proxy).let { c -> try { c.inputStream.bufferedReader().readText() } finally { c.disconnect() } }

    fun check(ctx: Context, socksPort: Int?, beta: Boolean): Found? {
        val current = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "0"
        val json = anyPath(socksPort) { text(API, it) }
        return pick(json, current, Build.SUPPORTED_ABIS.toList(), beta)
    }

    /**
     * Downloads [f] into the cache, checks SHA-256 and that it is signed with the same key as the
     * installed app. [progress] gets 0..1; [cancelled] stops it. Returns the verified file.
     */
    fun download(ctx: Context, f: Found, socksPort: Int?, progress: (Float) -> Unit, cancelled: () -> Boolean): File {
        val sumsUrl = f.sumsUrl ?: error("این نسخه فایل SHA256SUMS.txt ندارد؛ برای امنیت دانلود نمی‌شود. از صفحه‌ی انتشارها دستی بگیرید.")
        val want = hashFromSums(anyPath(socksPort) { text(sumsUrl, it) }, f.file) ?: error("هش ${f.file} در SHA256SUMS.txt نیست")
        val dir = File(ctx.cacheDir, "update").apply { deleteRecursively(); mkdirs() }
        val out = File(dir, f.file)
        val md = MessageDigest.getInstance("SHA-256")
        anyPath(socksPort) { proxy ->
            md.reset()
            val c = open(f.url, proxy)
            try {
                val total = c.contentLengthLong.takeIf { it > 0 } ?: f.size
                var done = 0L
                c.inputStream.use { input ->
                    out.outputStream().use { o ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            if (cancelled()) error("لغو شد")
                            val n = input.read(buf)
                            if (n < 0) break
                            o.write(buf, 0, n); md.update(buf, 0, n)
                            done += n
                            if (total > 0) progress(done.toFloat() / total)
                        }
                    }
                }
            } finally { c.disconnect() }
        }
        val got = md.digest().joinToString("") { "%02x".format(it) }
        if (got != want) { out.delete(); error("هش فایل دانلودشده درست نیست؛ فایل حذف شد.") }
        if (!sameSigner(ctx, out)) { out.delete(); error("این فایل با کلید دیگری امضا شده و روی این نسخه نصب نمی‌شود. اگر نسخه‌ی فعلی را از جای دیگری (نسخه‌ی آزمایشی/دیباگ) نصب کرده‌اید، اول آن را حذف کنید و نسخه‌ی جدید را دستی نصب کنید.") }
        return out
    }

    @Suppress("DEPRECATION")
    private fun signers(pm: PackageManager, info: android.content.pm.PackageInfo?): Set<String> {
        val sigs = if (Build.VERSION.SDK_INT >= 28) info?.signingInfo?.apkContentsSigners else info?.signatures
        return sigs.orEmpty().map { s -> MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
    }

    @Suppress("DEPRECATION")
    private fun sameSigner(ctx: Context, apk: File): Boolean {
        val pm = ctx.packageManager
        val flag = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val mine = signers(pm, pm.getPackageInfo(ctx.packageName, flag))
        val theirs = signers(pm, pm.getPackageArchiveInfo(apk.absolutePath, flag))
        // if Android cannot read the archive's signers here, leave the decision to the installer
        return theirs.isEmpty() || mine.intersect(theirs).isNotEmpty()
    }

    /** True when this app may open the installer; otherwise the caller sends the user to [allowInstallSettings]. */
    fun canInstall(ctx: Context) = ctx.packageManager.canRequestPackageInstalls()

    fun allowInstallSettings(ctx: Context) = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))

    fun installIntent(ctx: Context, apk: File): Intent {
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.update", apk)
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
