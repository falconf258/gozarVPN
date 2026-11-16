package app.gozarvpn.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * OpenVPN .ovpn files (same rules as the Windows app's openvpn.js). Configs come from public
 * groups, so directives that run programs, load plugins or write files are dropped.
 */
object Ovpn {
    data class Remote(val host: String, val port: String, val proto: String)
    data class Parsed(
        val ok: Boolean,
        val lines: List<String>,
        val remotes: List<Remote>,
        val needsAuth: Boolean,
        val cipher: String?,
        val dataCiphers: Boolean,
        val compression: Boolean,
        val removed: List<String>,
        val problems: List<String>,
    )

    private val BLOCKED = setOf(
        "up", "down", "route-up", "route-pre-down", "ipchange", "tls-verify", "auth-user-pass-verify",
        "client-connect", "client-disconnect", "learn-address", "plugin", "script-security", "setenv-safe",
        "management", "management-client", "management-hold", "management-query-passwords", "management-signal",
        "management-forget-disconnect", "management-external-key", "management-external-cert", "management-client-auth",
        "management-up-down", "management-log-cache", "management-query-proxy", "management-query-remote",
        "log", "log-append", "config", "cd", "chroot", "writepid", "status", "status-version", "daemon", "service",
        "tmp-dir", "askpass", "tls-export-cert", "dns-updown", "auth-gen-token-secret", "replay-persist",
        "ifconfig-pool-persist", "syslog", "user", "group", "mlock", "cryptoapicert", "win-sys",
        // the tunnel device is ours on Android
        "dev-node", "windows-driver", "machine-readable-output",
    )
    private val SERVER_ONLY = setOf("server", "server-bridge", "mode", "tls-server", "client-config-dir", "dh", "push")
    private val INLINE = setOf("ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2", "pkcs12", "secret", "extra-certs", "crl-verify", "auth-user-pass", "http-proxy-user-pass", "peer-fingerprint")
    private val LEGACY_CIPHER = Regex("^(BF|DES|DESX|RC2|RC4|CAST|CAST5|SEED|IDEA)\\b|^DES-", RegexOption.IGNORE_CASE)

    /** Quick check used by the importer. */
    fun looksLike(text: String): Boolean {
        val t = text.replace("\r", "")
        return Regex("^\\s*remote\\s+\\S+", RegexOption.MULTILINE).containsMatchIn(t) &&
            (Regex("^\\s*(client|dev\\s+tun|dev\\s+tap|tls-client|proto\\s+(udp|tcp))", RegexOption.MULTILINE).containsMatchIn(t) || "<ca>" in t)
    }

    /** OpenVPN word splitting: "..." and '...' quoting, backslash escapes, # and ; comments. */
    fun words(line: String): List<String> {
        val out = mutableListOf<String>()
        val cur = StringBuilder()
        var quote: Char? = null
        var any = false
        var i = 0
        while (i < line.length) {
            val c = line[i]
            if (quote != null) {
                if (c == quote) quote = null
                else if (c == '\\' && quote == '"' && i + 1 < line.length) cur.append(line[++i])
                else cur.append(c)
            } else if (c == '"' || c == '\'') { quote = c; any = true }
            else if (c == '\\' && i + 1 < line.length) { cur.append(line[++i]); any = true }
            else if (c.isWhitespace()) { if (any) { out += cur.toString(); cur.clear(); any = false } }
            else if ((c == '#' || c == ';') && !any) break
            else { cur.append(c); any = true }
            i++
        }
        if (any) out += cur.toString()
        return out
    }

    fun parse(text: String): Parsed {
        val src = text.removePrefix("﻿").replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val lines = mutableListOf<String>()
        val remotes = mutableListOf<Triple<String, String?, String?>>()
        val removed = linkedSetOf<String>()
        val problems = mutableListOf<String>()
        val inline = mutableSetOf<String>()
        val fileRefs = mutableListOf<String>()
        var defPort = "1194"
        var defProto = "udp"
        var needsAuth = false
        var cipher: String? = null
        var dataCiphers = false
        var compression = false
        var isServer = false
        var i = 0
        while (i < src.size) {
            val raw = src[i]
            val t = raw.trim()
            val open = Regex("^<([a-z0-9-]+)>$", RegexOption.IGNORE_CASE).find(t)
            if (open != null) {
                val tag = open.groupValues[1].lowercase()
                val end = (i + 1 until src.size).firstOrNull { src[it].trim().lowercase() == "</$tag>" }
                if (end == null) { problems += "بلوک <$tag> بسته نشده است"; break }
                when {
                    tag == "connection" -> for (l in src.subList(i, end + 1)) {
                        val w = words(l.trim())
                        val d = w.firstOrNull()?.lowercase()
                        if (d != null && d in BLOCKED) { removed += d; continue }
                        if (d == "remote" && w.size > 1) remotes += Triple(w[1], w.getOrNull(2), w.getOrNull(3)?.lowercase())
                        lines += l.trimEnd()
                    }
                    tag in INLINE -> { src.subList(i, end + 1).forEach { lines += it.trimEnd() }; inline += tag }
                    else -> removed += "<$tag>"
                }
                i = end + 1
                continue
            }
            val w = words(t)
            if (w.isEmpty()) { i++; continue }
            val d = w[0].lowercase().removePrefix("--")
            if (d in BLOCKED) { removed += d; i++; continue }
            if (d in SERVER_ONLY && !(d == "mode" && w.getOrNull(1)?.lowercase() == "p2p")) { isServer = true; i++; continue }
            var keep = raw.trimEnd()
            when (d) {
                "remote" -> if (w.size > 1) remotes += Triple(w[1], w.getOrNull(2), w.getOrNull(3)?.lowercase())
                "port", "rport" -> w.getOrNull(1)?.let { defPort = it }
                "proto" -> w.getOrNull(1)?.let { defProto = it.lowercase() }
                "auth-user-pass" -> { needsAuth = true; keep = "auth-user-pass" } // a file name would point at the phone's storage
                "cipher" -> cipher = w.getOrNull(1)
                "ncp-ciphers", "data-ciphers" -> dataCiphers = true
                "comp-lzo", "compress" -> compression = true
                else -> if (d in INLINE && w.size > 1 && w[1] != "[inline]") fileRefs += d
            }
            lines += keep
            i++
        }
        if ("auth-user-pass" in inline) needsAuth = false
        val rs = remotes.map { (h, p, pr) ->
            val proto = pr ?: defProto
            Remote(h, p ?: defPort, if (proto.startsWith("tcp")) "tcp" else "udp")
        }
        val refs = fileRefs.filter { it !in inline }.distinct()
        if (isServer) problems += "این فایل کانفیگ سرور است، نه کلاینت"
        if (rs.isEmpty()) problems += "هیچ آدرس سروری (remote) در فایل نیست"
        if (listOf("ca", "pkcs12", "secret", "peer-fingerprint").none { it in inline } && "ca" !in refs) problems += "گواهی CA در فایل نیست"
        if (refs.isNotEmpty()) problems += "این فایل به فایل‌های جداگانه اشاره می‌کند (${refs.joinToString("، ")})؛ فقط کانفیگ‌هایی که گواهی‌ها داخلشان است پشتیبانی می‌شوند"
        return Parsed(!isServer && rs.isNotEmpty() && refs.isEmpty(), lines, rs, needsAuth, cipher, dataCiphers, compression, removed.toList(), problems)
    }

    /** The config handed to the OpenVPN process: cleaned lines + compatibility + [extra] (management etc.). */
    fun build(p: Parsed, extra: List<String> = emptyList()): String {
        val out = p.lines.toMutableList()
        out += listOf("", "# --- added by GozarVpn ---", "client", "nobind", "auth-nocache", "verb 3")
        if (p.cipher != null && !p.dataCiphers) {
            // OpenVPN 2.6+ negotiates only AEAD ciphers unless told otherwise; old servers need their own one
            out += "data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:${p.cipher}"
            out += "data-ciphers-fallback ${p.cipher}"
        }
        if (p.cipher != null && LEGACY_CIPHER.containsMatchIn(p.cipher)) out += "providers legacy default"
        if (p.compression) out += "allow-compression asym"
        out += extra
        return out.joinToString("\n") + "\n"
    }

    /** "a.b.c.d/n" -> (address, prefix) for IPv4, else null. */
    fun cidr4(s: String): Pair<String, Int>? {
        val m = Regex("^(\\d{1,3}(?:\\.\\d{1,3}){3})(?:/(\\d{1,2}))?$").find(s.trim()) ?: return null
        val bits = m.groupValues[2].ifEmpty { "32" }.toInt()
        if (bits !in 1..32 || m.groupValues[1].split('.').any { it.toInt() > 255 }) return null
        return m.groupValues[1] to bits
    }

    /** Dotted netmask -> prefix length (255.255.255.0 -> 24). */
    fun maskToPrefix(mask: String): Int = mask.split('.').sumOf { Integer.bitCount(it.toIntOrNull() ?: 0) }
}

/**
 * Username/password per OpenVPN config, encrypted with an AES key that never leaves the Android
 * Keystore (the app's prefs file alone is not enough to read them).
 */
object OvpnCreds {
    private const val ALIAS = "gozarvpn-ovpn-creds"
    private const val PREFS = "ovpn_creds"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return gen.generateKey()
    }

    fun save(ctx: Context, id: String, user: String, pass: String) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (user.isBlank()) { prefs.edit().remove(id).apply(); return }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val enc = c.doFinal((user + "\u0000" + pass).toByteArray())
        prefs.edit().putString(id, Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP)).apply()
    }

    fun has(ctx: Context, id: String) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(id)

    fun load(ctx: Context, id: String): Pair<String, String>? = runCatching {
        val s = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(id, null) ?: return null
        val (iv, data) = s.split(':').map { Base64.decode(it, Base64.NO_WRAP) }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
        val plain = String(c.doFinal(data))
        plain.substringBefore('\u0000') to plain.substringAfter('\u0000')
    }.getOrNull()
}
