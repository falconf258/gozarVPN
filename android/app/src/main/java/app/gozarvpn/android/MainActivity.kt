package app.gozarvpn.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.gozarvpn.android.data.AppUpdate
import app.gozarvpn.android.ui.*
import app.gozarvpn.android.vpn.GozarVpnService
import app.gozarvpn.android.vpn.VpnStatus

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            GozarTheme {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    Root()
                }
            }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun Root() {
        val app by vm.state.collectAsStateWithLifecycle()
        val vpn by GozarVpnService.state.collectAsStateWithLifecycle()
        val busy by vm.busy.collectAsStateWithLifecycle()
        val message by vm.message.collectAsStateWithLifecycle()
        var tab by remember { mutableIntStateOf(0) }
        val snackbar = remember { SnackbarHostState() }

        LaunchedEffect(message) {
            message?.let { snackbar.showSnackbar(it); vm.consumeMessage() }
        }
        // a quiet look at GitHub Releases on start; a new version is announced once
        LaunchedEffect(Unit) {
            val s = vm.repo.state.value.settings
            if (!s.autoUpdateCheck) return@LaunchedEffect
            kotlinx.coroutines.delay(8000)
            val f = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { AppUpdate.check(this@MainActivity, GozarVpnService.state.value.socksPort, s.updateBeta) }.getOrNull()
            } ?: return@LaunchedEffect
            if (f.version == vm.repo.state.value.settings.updateSeen) return@LaunchedEffect
            vm.repo.updateSettings { it.copy(updateSeen = f.version) }
            snackbar.showSnackbar("نسخه‌ی جدید GozarVpn آماده است: ${f.version} (بیشتر › به‌روزرسانی برنامه)")
        }

        val startVpn: () -> Unit = { startService(Intent(this, GozarVpnService::class.java)) }
        val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (it.resultCode == Activity.RESULT_OK) startVpn()
        }
        val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

        val onToggle: () -> Unit = {
            if (vpn.status == VpnStatus.Paused) {
                startService(Intent(this, GozarVpnService::class.java).setAction(GozarVpnService.ACTION_RESUME))
            } else if (vpn.status == VpnStatus.Connected || vpn.status == VpnStatus.Starting) {
                startService(Intent(this, GozarVpnService::class.java).setAction(GozarVpnService.ACTION_STOP))
            } else {
                if (Build.VERSION.SDK_INT >= 33) notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                val prepare = VpnService.prepare(this)
                if (prepare != null) permissionLauncher.launch(prepare) else startVpn()
            }
        }

        // a running connect restarts with a fresh generation (same as a user-started connect)
        val onReconnect: () -> Unit = { if (vpn.status == VpnStatus.Connected) startVpn() }

        Backdrop(engineColors(app.settings.engine).first) {
            Scaffold(
                containerColor = androidx.compose.ui.graphics.Color.Transparent,
                // a transparent container gives no content colour, so text fell back to black
                contentColor = androidx.compose.material3.MaterialTheme.colorScheme.onBackground,
                snackbarHost = { SnackbarHost(snackbar) },
                bottomBar = {
                    NavigationBar(containerColor = androidx.compose.ui.graphics.Color(0xF20E1118), tonalElevation = 0.dp) {
                        val items = listOf(
                            Triple("خانه", Icons.Filled.Home, 0), Triple("کانفیگ‌ها", Icons.AutoMirrored.Filled.List, 1),
                            Triple("لاگ", Icons.Filled.Menu, 2), Triple("بیشتر", Icons.Filled.Info, 3),
                        )
                        for ((label, icon, i) in items) NavigationBarItem(
                            tab == i, { tab = i }, { Icon(icon, null) }, label = { Text(label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = Orange, selectedTextColor = Orange, indicatorColor = Orange.copy(alpha = 0.16f),
                                unselectedIconColor = Muted, unselectedTextColor = Muted,
                            ),
                        )
                    }
                },
            ) { pad ->
                androidx.compose.animation.Crossfade(tab, label = "tab") { t ->
                    when (t) {
                        0 -> HomeScreen(vm, app, vpn, onToggle, onReconnect, Modifier.padding(pad))
                        1 -> ConfigsHost(vm, app, busy, Modifier.padding(pad))
                        2 -> LogScreen(Modifier.padding(pad))
                        else -> MoreScreen(vm, app, vpn.status == VpnStatus.Connected, onReconnect, Modifier.padding(pad))
                    }
                }
            }
        }
    }
}
