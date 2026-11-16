package app.gozarvpn.android.vpn

import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick Settings tile: connected -> pause 5 minutes, paused -> resume, off -> connect
 * (or open the app when VPN permission still has to be granted).
 */
class GozarTileService : TileService() {
    override fun onStartListening() = refresh()

    override fun onClick() {
        val status = GozarVpnService.state.value.status
        val i = Intent(this, GozarVpnService::class.java)
        when (status) {
            VpnStatus.Connected, VpnStatus.Starting -> startService(i.setAction(GozarVpnService.ACTION_PAUSE).putExtra(GozarVpnService.EXTRA_MINUTES, 5))
            VpnStatus.Paused -> startService(i.setAction(GozarVpnService.ACTION_RESUME))
            else -> if (VpnService.prepare(this) == null) startForegroundService(i) else openApp()
        }
        refresh()
    }

    private fun openApp() {
        val open = Intent(this, app.gozarvpn.android.MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(android.app.PendingIntent.getActivity(this, 0, open, android.app.PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(open)
        }
    }

    // subtitles exist from Android 10
    private fun sub(tile: Tile, text: String) { if (Build.VERSION.SDK_INT >= 29) tile.subtitle = text }

    private fun refresh() {
        val tile = qsTile ?: return
        when (GozarVpnService.state.value.status) {
            VpnStatus.Connected -> { tile.state = Tile.STATE_ACTIVE; tile.label = "GozarVpn"; sub(tile, "توقف ۵ دقیقه") }
            VpnStatus.Starting -> { tile.state = Tile.STATE_ACTIVE; tile.label = "GozarVpn"; sub(tile, "در حال اتصال") }
            VpnStatus.Paused -> { tile.state = Tile.STATE_INACTIVE; tile.label = "GozarVpn"; sub(tile, "متوقف · ادامه") }
            else -> { tile.state = Tile.STATE_INACTIVE; tile.label = "GozarVpn"; sub(tile, "اتصال") }
        }
        tile.updateTile()
    }
}
