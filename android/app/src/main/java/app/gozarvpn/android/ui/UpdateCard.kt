package app.gozarvpn.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.gozarvpn.android.data.AppState
import app.gozarvpn.android.data.AppUpdate
import app.gozarvpn.android.vpn.GozarVpnService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** "Update the app" card: check GitHub Releases, download with progress (cancellable), verify, install. */
@Composable
fun UpdateCard(vm: AppViewModel, app: AppState) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val s = app.settings
    val version = remember { runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "-" }
    var status by remember { mutableStateOf<String?>(null) }
    // what the launch check already found shows up here without asking GitHub again
    val shared by AppUpdate.found.collectAsState()
    var found by remember { mutableStateOf(shared) }
    androidx.compose.runtime.LaunchedEffect(shared) { if (shared != null) found = shared }
    var progress by remember { mutableStateOf<Float?>(null) }
    var cancel by remember { mutableStateOf(false) }
    var apk by remember { mutableStateOf<File?>(null) }
    val socks = { GozarVpnService.state.value.socksPort }

    suspend fun check(): AppUpdate.Found? {
        status = "در حال بررسی…"; found = null; apk = null
        val r = runCatching { withContext(Dispatchers.IO) { AppUpdate.check(ctx, socks(), s.updateBeta) } }
        status = r.fold(
            { f -> found = f; if (f == null) "شما از آخرین نسخه استفاده می‌کنید." else "نسخه‌ی جدید: ${f.version}${if (f.prerelease) " (آزمایشی)" else ""} · ${"%.1f".format(f.size / 1048576.0)} MB" },
            { "خطا: ${AppUpdate.friendly(it)}" },
        )
        // the badge on More follows every successful check
        r.onSuccess { f -> AppUpdate.found.value = f; vm.repo.updateSettings { it.copy(updateLatest = f?.version ?: "", updateLastCheck = System.currentTimeMillis()) } }
        return r.getOrNull()
    }

    suspend fun download(f: AppUpdate.Found) {
        cancel = false; progress = 0f; status = "در حال دانلود ${f.file}…"
        runCatching { withContext(Dispatchers.IO) { AppUpdate.download(ctx, f, socks(), { progress = it }, { cancel }) } }
            .onSuccess { apk = it; status = "دانلود و بررسی هش انجام شد. «نصب» را بزنید." }
            .onFailure { status = "خطا: ${AppUpdate.friendly(it)}" }
        progress = null
    }

    // "update" in the launch dialog or the row at the top of More: straight to the download
    val start by AppUpdate.startDownload.collectAsState()
    androidx.compose.runtime.LaunchedEffect(start) {
        if (!start) return@LaunchedEffect
        AppUpdate.startDownload.value = false
        (found ?: check())?.let { download(it) }
    }

    GCard {
        H("به‌روزرسانی برنامه")
        Hint("نسخه‌ی فعلی: $version · از GitHub (اگر مستقیم باز نشد، از طریق اتصال فعلی VPN). فایل با SHA256SUMS.txt همان نسخه بررسی می‌شود.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button({ scope.launch { check() } }, enabled = progress == null) { Text("بررسی به‌روزرسانی") }
            OutlinedButton({ ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(AppUpdate.RELEASES_PAGE)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }) { Text("صفحه‌ی انتشارها") }
        }
        status?.let { Text(it, fontSize = 13.sp) }
        found?.let { f ->
            if (f.notes.isNotBlank()) Text(
                f.notes.replace(Regex("[*#`>]+"), "").trim(), color = Muted, fontSize = 12.sp, lineHeight = 18.sp,
                modifier = Modifier.heightIn(max = 160.dp).verticalScroll(rememberScrollState()),
            )
            val p = progress
            when {
                p != null -> {
                    LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth())
                    TextButton({ cancel = true }) { Text("لغو دانلود") }
                }
                apk == null -> Button({ scope.launch { download(f) } }) { Text("دانلود ${f.version}") }
                else -> Button({
                    if (!AppUpdate.canInstall(ctx)) {
                        status = "اجازه‌ی «نصب برنامه‌های ناشناس» را برای GozarVpn بدهید و برگردید، بعد دوباره «نصب» را بزنید."
                        ctx.startActivity(AppUpdate.allowInstallSettings(ctx).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } else ctx.startActivity(AppUpdate.installIntent(ctx, apk!!))
                }) { Text("نصب") }
            }
        }
        SettingSwitch("بررسی خودکار هنگام باز شدن برنامه", "هر بار که برنامه باز می‌شود آخرین نسخه را از GitHub می‌پرسد و اگر نسخه‌ی جدیدی باشد خبر می‌دهد", s.autoUpdateCheck) { v -> vm.repo.updateSettings { it.copy(autoUpdateCheck = v) } }
        SettingSwitch("نسخه‌های آزمایشی", "نسخه‌های pre-release هم پیشنهاد شوند", s.updateBeta) { v -> vm.repo.updateSettings { it.copy(updateBeta = v) } }
    }
}
