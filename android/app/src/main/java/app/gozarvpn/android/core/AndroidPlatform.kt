// Platform glue adapted from sing-box-for-android (GPL-3.0), trimmed to what a plain VPN needs.
package app.gozarvpn.android.core

import android.net.IpPrefix
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.OsConstants
import io.nekohasekai.libbox.BridgeOptions
import io.nekohasekai.libbox.BridgeSession
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LocalDNSTransport
import io.nekohasekai.libbox.NeighborUpdateListener
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.Notification
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.PlatformUser
import io.nekohasekai.libbox.RoutePrefix
import io.nekohasekai.libbox.ShellSession
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InterfaceAddress
import java.net.NetworkInterface
import io.nekohasekai.libbox.NetworkInterface as LibboxNetworkInterface

class AndroidPlatform(private val service: VpnService) : PlatformInterface {
    val monitor = DefaultNetworkMonitor(service)
    private val resolver = LocalResolver(monitor)
    private val cm = service.getSystemService(android.net.ConnectivityManager::class.java)
    @Volatile var tunFd: ParcelFileDescriptor? = null

    fun closeTun() {
        runCatching { tunFd?.close() }
        tunFd = null
    }

    override fun usePlatformAutoDetectInterfaceControl(): Boolean = true
    override fun autoDetectInterfaceControl(fd: Int) { service.protect(fd) }

    override fun openTun(options: TunOptions): Int {
        if (VpnService.prepare(service) != null) error("مجوز VPN داده نشده است")
        val b = service.Builder().setSession("GozarVpn").setMtu(options.mtu)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setMetered(false)

        val v4 = options.inet4Address
        var hasV4 = false
        while (v4.hasNext()) { val a = v4.next(); b.addAddress(a.address(), a.prefix()); hasV4 = true }
        val v6 = options.inet6Address
        var hasV6 = false
        while (v6.hasNext()) { val a = v6.next(); b.addAddress(a.address(), a.prefix()); hasV6 = true }

        if (options.autoRoute) {
            if (options.dnsMode.value != Libbox.DNSModeDisabled) {
                val dns = options.dnsServerAddress
                while (dns.hasNext()) b.addDnsServer(dns.next())
            }
            var added4 = false
            var added6 = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val r4 = options.inet4RouteAddress
                while (r4.hasNext()) { b.addRoute(r4.next().toIpPrefix()); added4 = true }
                val r6 = options.inet6RouteAddress
                while (r6.hasNext()) { b.addRoute(r6.next().toIpPrefix()); added6 = true }
                val x4 = options.inet4RouteExcludeAddress
                while (x4.hasNext()) b.excludeRoute(x4.next().toIpPrefix())
                val x6 = options.inet6RouteExcludeAddress
                while (x6.hasNext()) b.excludeRoute(x6.next().toIpPrefix())
            } else {
                val r4 = options.inet4RouteRange
                while (r4.hasNext()) { val a = r4.next(); b.addRoute(a.address(), a.prefix()); added4 = true }
                val r6 = options.inet6RouteRange
                while (r6.hasNext()) { val a = r6.next(); b.addRoute(a.address(), a.prefix()); added6 = true }
            }
            if (!added4 && hasV4) b.addRoute("0.0.0.0", 0)
            if (!added6 && hasV6) b.addRoute("::", 0)

            val include = options.includePackage
            while (include.hasNext()) runCatching { b.addAllowedApplication(include.next()) }
            val exclude = options.excludePackage
            while (exclude.hasNext()) runCatching { b.addDisallowedApplication(exclude.next()) }
        }
        val pfd = b.establish() ?: error("تونل VPN ساخته نشد (مجوز لغو شده است)")
        tunFd = pfd
        return pfd.fd
    }

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener?) { monitor.setListener(listener) }
    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener?) { monitor.setListener(null) }

    override fun getInterfaces(): NetworkInterfaceIterator {
        val javaIfaces = java.util.Collections.list(NetworkInterface.getNetworkInterfaces())
        val out = mutableListOf<LibboxNetworkInterface>()
        for (network in cm.allNetworks) {
            val lp = cm.getLinkProperties(network) ?: continue
            val caps = cm.getNetworkCapabilities(network) ?: continue
            val ni = javaIfaces.find { it.name == lp.interfaceName } ?: continue
            val box = LibboxNetworkInterface()
            box.name = lp.interfaceName
            box.index = ni.index
            runCatching { box.mtu = ni.mtu }
            box.dnsServer = Strings(lp.dnsServers.mapNotNull { it.hostAddress }.iterator())
            box.gateway = Strings(
                lp.routes.filter { it.destination.prefixLength == 0 }
                    .mapNotNull { it.gateway }.filterNot { it.isAnyLocalAddress }
                    .mapNotNull { it.hostAddress }.iterator()
            )
            box.type = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> Libbox.InterfaceTypeWIFI
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Libbox.InterfaceTypeCellular
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Libbox.InterfaceTypeEthernet
                else -> Libbox.InterfaceTypeOther
            }
            box.addresses = Strings(ni.interfaceAddresses.map { it.toPrefix() }.iterator())
            var flags = 0
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) flags = OsConstants.IFF_UP or OsConstants.IFF_RUNNING
            if (ni.isLoopback) flags = flags or OsConstants.IFF_LOOPBACK
            if (ni.isPointToPoint) flags = flags or OsConstants.IFF_POINTOPOINT
            if (ni.supportsMulticast()) flags = flags or OsConstants.IFF_MULTICAST
            box.flags = flags
            box.metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            out.add(box)
        }
        return Ifaces(out.iterator())
    }

    override fun localDNSTransport(): LocalDNSTransport = resolver
    override fun underNetworkExtension(): Boolean = false
    override fun includeAllNetworks(): Boolean = false
    override fun clearDNSCache() {}
    override fun readWIFIState(): WIFIState? = null
    override fun registerMyInterface(name: String?) {}
    override fun sendNotification(notification: Notification?) {}
    override fun cancelNotification(identifier: String?, typeID: Int) {}
    override fun startNeighborMonitor(listener: NeighborUpdateListener?) {}
    override fun closeNeighborMonitor(listener: NeighborUpdateListener?) {}
    override fun tailscaleHostname(): String = ""

    override fun findConnectionOwner(
        ipProtocol: Int, sourceAddress: String?, sourcePort: Int, destinationAddress: String?, destinationPort: Int
    ): ConnectionOwner = error("not supported")

    override fun usePlatformShell(): Boolean = false
    override fun checkPlatformShell() { error("not supported") }
    override fun openShellSession(
        user: PlatformUser?, command: String?, environ: StringIterator?, term: String?, rows: Int, cols: Int
    ): ShellSession = error("not supported")
    override fun lookupUser(username: String?): PlatformUser = error("not supported")
    override fun lookupSFTPServer(): String = error("not supported")
    override fun readSystemSSHHostKey(): String = error("not supported")
    override fun usePlatformBridge(): Boolean = false
    override fun createBridge(options: BridgeOptions?): BridgeSession = error("not supported")

    private fun RoutePrefix.toIpPrefix() = IpPrefix(InetAddress.getByName(address()), prefix())

    private fun InterfaceAddress.toPrefix(): String =
        if (address is Inet6Address) "${Inet6Address.getByAddress(address.address).hostAddress}/$networkPrefixLength"
        else "${address.hostAddress}/$networkPrefixLength"

    class Strings(private val it: Iterator<String>) : StringIterator {
        override fun len(): Int = 0
        override fun hasNext(): Boolean = it.hasNext()
        override fun next(): String = it.next()
    }

    private class Ifaces(private val it: Iterator<LibboxNetworkInterface>) : NetworkInterfaceIterator {
        override fun hasNext(): Boolean = it.hasNext()
        override fun next(): LibboxNetworkInterface = it.next()
    }
}
