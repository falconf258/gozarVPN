package app.gozarvpn.android.ui

import android.content.pm.ApplicationInfo
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.graphics.drawable.toBitmap
import app.gozarvpn.android.data.AppState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Settings card: which apps go through the VPN. */
@Composable
fun SplitTunnelCard(vm: AppViewModel, app: AppState, connected: Boolean, onReconnect: () -> Unit) {
    val s = app.settings
    var picking by remember { mutableStateOf(false) }
    // the running tunnel keeps its app list until it is rebuilt
    var changedWhileConnected by remember { mutableStateOf(false) }
    GCard {
        H("تونل‌سازی انتخابی (برنامه‌ها)")
        ChoiceChips(listOf("all" to "همه‌ی برنامه‌ها", "only" to "فقط انتخاب‌شده‌ها", "except" to "همه به‌جز انتخاب‌شده‌ها"), s.perAppMode) { v ->
            vm.repo.updateSettings { it.copy(perAppMode = v) }
            if (connected) changedWhileConnected = true
        }
        Hint(when (s.perAppMode) {
            "only" -> if (s.perAppPackages.isEmpty()) "هنوز برنامه‌ای انتخاب نکرده‌اید. تا وقتی انتخاب نکنید، همه‌ی برنامه‌ها از VPN می‌روند." else "فقط ${s.perAppPackages.size} برنامه‌ی انتخاب‌شده از VPN رد می‌شوند؛ بقیه مستقیم وصل می‌شوند."
            "except" -> "همه‌ی برنامه‌ها از VPN رد می‌شوند، به‌جز ${s.perAppPackages.size} برنامه‌ی انتخاب‌شده (مثلاً برنامه‌های بانکی)."
            else -> "همه‌ی برنامه‌ها از VPN رد می‌شوند."
        })
        if (s.perAppMode != "all") OutlinedButton({ picking = true }) { Text("انتخاب برنامه‌ها (${s.perAppPackages.size})") }
        // one tap to keep Iranian banking / payment apps out of the VPN
        var suggesting by remember { mutableStateOf<List<Pair<String, String>>?>(null) }
        val ctx = androidx.compose.ui.platform.LocalContext.current
        TextButton({ suggesting = iranianAppSuggestions(ctx) }) { Text("پیشنهاد: برنامه‌های بانکی و ایرانی بیرون از VPN") }
        suggesting?.let { list ->
            val chosen = remember(list) { mutableStateListOf<String>().apply { addAll(list.map { it.first }) } }
            AlertDialog(
                onDismissRequest = { suggesting = null },
                title = { Text("بیرون گذاشتن از VPN") },
                text = {
                    if (list.isEmpty()) Text("برنامه‌ی بانکی یا ایرانی شناخته‌شده‌ای روی گوشی پیدا نشد؛ از «انتخاب برنامه‌ها» دستی اضافه کنید.")
                    else Column(Modifier.heightIn(max = 360.dp).verticalScroll(androidx.compose.foundation.rememberScrollState())) {
                        Text("این برنامه‌ها مستقیم (بدون VPN) وصل می‌شوند. هرکدام را نمی‌خواهید بردارید:", fontSize = 13.sp)
                        for ((p, l) in list) Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(p in chosen, { if (it) chosen.add(p) else chosen.remove(p) })
                            Column { Text(l, fontSize = 13.5.sp); Text(p, color = Muted, fontSize = 11.sp) }
                        }
                    }
                },
                confirmButton = {
                    TextButton({
                        vm.repo.updateSettings { st ->
                            // adding to the bypass list only makes sense in "all except" mode
                            val base = if (st.perAppMode == "except") st.perAppPackages else emptyList()
                            st.copy(perAppMode = "except", perAppPackages = base + chosen.filter { it !in base })
                        }
                        if (connected) changedWhileConnected = true
                        suggesting = null
                    }, enabled = list.isNotEmpty()) { Text("بیرون بگذار (${chosen.size})") }
                },
                dismissButton = { TextButton({ suggesting = null }) { Text("انصراف") } },
            )
        }
        if (connected && changedWhileConnected) Row(verticalAlignment = Alignment.CenterVertically) {
            Text("تغییر از اتصال بعدی اعمال می‌شود.", color = Warn, fontSize = 12.5.sp, modifier = Modifier.weight(1f))
            TextButton({ changedWhileConnected = false; onReconnect() }) { Text("اتصال دوباره") }
        }
    }
    if (picking) AppPicker(app.settings.perAppPackages, onDismiss = { picking = false }) { picked ->
        vm.repo.updateSettings { it.copy(perAppPackages = picked) }
        if (connected) changedWhileConnected = true
        picking = false
    }
}

private class AppRow(val pkg: String, val label: String, val system: Boolean, val info: ApplicationInfo)

/** Full-screen searchable list of installed apps with checkboxes; user apps first. */
@Composable
internal fun AppPicker(initial: List<String>, onDismiss: () -> Unit, onSave: (List<String>) -> Unit) {
    val ctx = LocalContext.current
    val pm = ctx.packageManager
    var apps by remember { mutableStateOf<List<AppRow>?>(null) }
    LaunchedEffect(Unit) {
        apps = withContext(Dispatchers.IO) {
            pm.getInstalledApplications(0).filter { it.packageName != ctx.packageName }.map {
                AppRow(it.packageName, pm.getApplicationLabel(it).toString(), it.flags and ApplicationInfo.FLAG_SYSTEM != 0, it)
            }.sortedWith(compareBy<AppRow>({ it.system }, { it.label.lowercase() }))
        }
    }
    val selected = remember { mutableStateListOf<String>().apply { addAll(initial) } }
    var query by remember { mutableStateOf("") }
    var showSystem by remember { mutableStateOf(false) }
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Ink, contentColor = MaterialTheme.colorScheme.onBackground) {
            Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                H("انتخاب برنامه‌ها")
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true,
                    leadingIcon = { Icon(Icons.Filled.Search, null) }, placeholder = { Text("جستجوی نام یا بسته") })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("نمایش برنامه‌های سیستمی", fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Switch(showSystem, { showSystem = it })
                }
                val list = apps
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    if (list == null) CircularProgressIndicator(Modifier.align(Alignment.Center))
                    else {
                        val q = query.trim().lowercase()
                        val shown = list.filter { (showSystem || !it.system || it.pkg in selected) && (q.isEmpty() || q in it.label.lowercase() || q in it.pkg) }
                        if (shown.isEmpty()) EmptyState(Icons.Filled.Apps, "برنامه‌ای پیدا نشد", "نام دیگری را جستجو کنید یا برنامه‌های سیستمی را هم نشان دهید.")
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(shown, key = { it.pkg }) { a ->
                                val on = a.pkg in selected
                                Row(
                                    Modifier.fillMaxWidth().clickable { if (on) selected.remove(a.pkg) else selected.add(a.pkg) }.padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    AppIcon(a)
                                    Spacer(Modifier.width(10.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(a.label, fontSize = 14.sp, maxLines = 1)
                                        Text(a.pkg, color = Muted, fontSize = 11.sp, maxLines = 1)
                                    }
                                    Checkbox(on, { if (it) selected.add(a.pkg) else selected.remove(a.pkg) })
                                }
                            }
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button({ onSave(selected.toList()) }) { Text("ذخیره (${selected.size})") }
                    OutlinedButton(onDismiss) { Text("انصراف") }
                    Spacer(Modifier.weight(1f))
                    TextButton({ selected.clear() }) { Text("پاک کردن همه") }
                }
            }
        }
    }
}

@Composable
private fun AppIcon(a: AppRow) {
    val pm = LocalContext.current.packageManager
    // icons load off the main thread, one per visible row
    val icon by produceState<ImageBitmap?>(null, a.pkg) {
        value = withContext(Dispatchers.IO) { runCatching { pm.getApplicationIcon(a.info).toBitmap(96, 96).asImageBitmap() }.getOrNull() }
    }
    val img = icon
    if (img != null) Image(img, null, Modifier.size(36.dp))
    else Box(Modifier.size(36.dp).background(Muted.copy(alpha = 0.15f)))
}
