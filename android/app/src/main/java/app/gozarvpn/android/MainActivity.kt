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
import androidx.lifecycle.repeatOnLifecycle
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
        val installed = remember { runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "0" }
        // a system permission dialog is on screen: no update dialog on top of it
        var asking by remember { mutableStateOf(false) }
        var promptShown by remember { mutableStateOf(false) }
        var prompt by remember { mutableStateOf<String?>(null) }
        // On launch and whenever the app comes back to the front: GitHub is asked at most every
        // few hours (one small request, through the tunnel when GitHub is blocked); failures stay silent.
        val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(Unit) {
            lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
                val s0 = vm.repo.state.value.settings
                // the version once found is installed now: no badge any more
                if (s0.updateLatest.isNotEmpty() && !AppUpdate.hasNewer(s0.updateLatest, installed)) vm.repo.updateSettings { it.copy(updateLatest = "") }
                if (s0.autoUpdateCheck && AppUpdate.needsCheck(s0.updateLastCheck, System.currentTimeMillis())) {
                    kotlinx.coroutines.delay(5000)
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        runCatching { AppUpdate.check(this@MainActivity, GozarVpnService.state.value.socksPort, s0.updateBeta) }
                    }.onSuccess { f ->
                        promptShown = false // a fresh check may offer it again on this open
                        AppUpdate.found.value = f
                        vm.repo.updateSettings { it.copy(updateLatest = f?.version ?: "", updateLastCheck = System.currentTimeMillis()) }
                    }
                }
                val s = vm.repo.state.value.settings
                if (!promptShown && s.autoUpdateCheck && AppUpdate.shouldPrompt(s.updateLatest, installed, s.updateSkip)) prompt = s.updateLatest
            }
        }

        val startVpn: () -> Unit = { startService(Intent(this, GozarVpnService::class.java)) }
        val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            asking = false
            if (it.resultCode == Activity.RESULT_OK) startVpn()
        }
        val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { asking = false }

        val onToggle: () -> Unit = {
            if (vpn.status == VpnStatus.Paused) {
                startService(Intent(this, GozarVpnService::class.java).setAction(GozarVpnService.ACTION_RESUME))
            } else if (vpn.status == VpnStatus.Connected || vpn.status == VpnStatus.Starting) {
                startService(Intent(this, GozarVpnService::class.java).setAction(GozarVpnService.ACTION_STOP))
            } else {
                if (Build.VERSION.SDK_INT >= 33) { asking = true; notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
                val prepare = VpnService.prepare(this)
                if (prepare != null) { asking = true; permissionLauncher.launch(prepare) } else startVpn()
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
                        // a dot on More while a newer version is known (even after "later" or "don't show again")
                        val newer = AppUpdate.hasNewer(app.settings.updateLatest, installed)
                        for ((label, icon, i) in items) NavigationBarItem(
                            tab == i, { tab = i },
                            {
                                if (i == 3 && newer) androidx.compose.material3.BadgedBox(badge = { androidx.compose.material3.Badge() }) { Icon(icon, null) }
                                else Icon(icon, null)
                            },
                            label = { Text(label) },
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
                        0 -> HomeScreen(vm, app, vpn, onToggle, onReconnect, Modifier.padding(pad)) { tab = 3 } // data usage is the first card in More
                        1 -> ConfigsHost(vm, app, busy, Modifier.padding(pad))
                        2 -> LogScreen(Modifier.padding(pad))
                        else -> MoreScreen(vm, app, vpn.status == VpnStatus.Connected, onReconnect, Modifier.padding(pad))
                    }
                }
            }
        }
        // shown once per session, never over a permission dialog or while a connection is starting
        val p = prompt
        if (p != null && !asking && vpn.status != VpnStatus.Starting) UpdateDialog(
            version = p,
            notes = AppUpdate.found.collectAsStateWithLifecycle().value?.takeIf { it.version == p }?.notes.orEmpty(),
            onUpdate = { promptShown = true; prompt = null; AppUpdate.startDownload.value = true; tab = 3 },
            onLater = { skip -> promptShown = true; prompt = null; if (skip) vm.repo.updateSettings { it.copy(updateSkip = p) } },
        )
    }
}
