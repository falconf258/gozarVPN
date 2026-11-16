package app.gozarvpn.android.core

import io.nekohasekai.libbox.ExchangeContext
import io.nekohasekai.libbox.LocalDNSTransport
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.UnknownHostException

/** Resolves names on the physical network (never through the VPN itself). */
class LocalResolver(private val monitor: DefaultNetworkMonitor) : LocalDNSTransport {
    override fun raw(): Boolean = false

    override fun exchange(ctx: ExchangeContext, message: ByteArray) {
        error("raw DNS is not used")
    }

    override fun lookup(ctx: ExchangeContext, network: String, domain: String) {
        val net = monitor.current ?: error("شبکه‌ی اینترنت در دسترس نیست")
        try {
            val all = net.getAllByName(domain.trimEnd('.'))
            val picked = all.filter {
                when (network) {
                    "ip4" -> it is Inet4Address
                    "ip6" -> it is Inet6Address
                    else -> true
                }
            }
            ctx.success(picked.mapNotNull { it.hostAddress }.joinToString("\n"))
        } catch (_: UnknownHostException) {
            ctx.errorCode(3) // NXDOMAIN
        }
    }
}
