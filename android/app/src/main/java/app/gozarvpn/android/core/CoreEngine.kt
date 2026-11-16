package app.gozarvpn.android.core

import android.net.VpnService

/**
 * The network core behind the VPN. The real implementation wraps sing-box's
 * `libbox` (built with gomobile into app/libs/libbox.aar); until that file is
 * added the app uses [MissingCoreEngine] and says so, instead of pretending to connect.
 */
interface CoreEngine {
    /** Starts the core with [configJson]. Throws with a user-readable (Persian) message on failure. */
    fun start(service: VpnService, configJson: String)
    fun stop()
}

object CoreEngines {
    fun create(): CoreEngine = try {
        Class.forName("io.nekohasekai.libbox.Libbox")
        LibboxEngine()
    } catch (_: ClassNotFoundException) {
        MissingCoreEngine()
    }
}

class MissingCoreEngine : CoreEngine {
    override fun start(service: VpnService, configJson: String) {
        throw IllegalStateException("هسته‌ی sing-box (libbox.aar) هنوز در برنامه نیست. نسخه‌ی کامل را از مرحله‌ی بعد بگیرید.")
    }
    override fun stop() = Unit
}
