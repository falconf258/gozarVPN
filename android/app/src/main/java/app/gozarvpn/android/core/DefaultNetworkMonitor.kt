// Network-monitor approach adapted from sing-box-for-android (GPL-3.0).
package app.gozarvpn.android.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import io.nekohasekai.libbox.InterfaceUpdateListener
import java.net.NetworkInterface

/** Tracks the physical (non-VPN) default network and tells the core when it changes. */
class DefaultNetworkMonitor(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val thread = HandlerThread("gozar-network").also { it.start() }
    private val handler = Handler(thread.looper)

    @Volatile var current: Network? = null
        private set
    @Volatile private var listener: InterfaceUpdateListener? = null
    private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { current = network; notifyListener(network) }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            if (network == current) notifyListener(network)
        }
        override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
            if (network == current) notifyListener(network)
        }
        override fun onLost(network: Network) {
            if (network == current) { current = null; notifyListener(null) }
        }
    }

    fun start() {
        current = cm.activeNetwork
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        try {
            when {
                Build.VERSION.SDK_INT >= 31 -> cm.registerBestMatchingNetworkCallback(request, callback, handler)
                Build.VERSION.SDK_INT >= 28 -> cm.requestNetwork(request, callback, handler)
                else -> cm.registerDefaultNetworkCallback(callback, handler)
            }
            registered = true
        } catch (_: Throwable) {
            registered = false
        }
    }

    fun stop() {
        listener = null
        if (registered) runCatching { cm.unregisterNetworkCallback(callback) }
        registered = false
        thread.quitSafely()
    }

    fun setListener(l: InterfaceUpdateListener?) {
        listener = l
        handler.post { notifyListener(current) }
    }

    private fun notifyListener(network: Network?) {
        val l = listener ?: return
        if (network == null) { l.updateDefaultInterface("", -1, false, false); return }
        repeat(10) {
            val lp = cm.getLinkProperties(network)
            val name = lp?.interfaceName
            val index = try { NetworkInterface.getByName(name).index } catch (_: Throwable) { -1 }
            if (name != null && index >= 0) {
                l.updateDefaultInterface(name, index, false, false)
                return
            }
            Thread.sleep(100)
        }
    }
}
