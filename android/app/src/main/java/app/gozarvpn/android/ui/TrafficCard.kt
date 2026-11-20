package app.gozarvpn.android.ui

import android.app.DatePickerDialog
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.gozarvpn.android.data.TrafficLog
import kotlinx.coroutines.delay
import java.util.Calendar

private val ENGINE_NAMES = mapOf("aether" to "Aether", "singbox" to "V2ray", "mihomo" to "Clash", "tor" to "Tor", "psiphon" to "سایفون", "openvpn" to "OpenVPN", "awg" to "AmneziaWG")
private val DOWN = Color(0xFF38BDF8)
private val UP = Color(0xFFFB7185)

/** Data usage history: hourly / daily / weekly / monthly / a chosen range, kept only on the phone. */
@Composable
fun TrafficCard() {
    val ctx = LocalContext.current
    val log = remember { TrafficLog.get(ctx) }
    var view by remember { mutableStateOf("hour") }
    val today = remember { TrafficLog.unitStart(System.currentTimeMillis(), TrafficLog.Span.DAY) }
    var from by remember { mutableLongStateOf(today - 6 * 86_400_000L) }
    var to by remember { mutableLongStateOf(today) }
    var tick by remember { mutableIntStateOf(0) }
    var confirmReset by remember { mutableStateOf(false) }
    // numbers stay fresh while the card is on screen
    LaunchedEffect(Unit) { while (true) { delay(30_000); tick++ } }
    val (qFrom, qTo, unit) = if (view == "range") TrafficLog.range(from, to) else TrafficLog.view(view)
    val r = remember(view, from, to, tick) { log.query(qFrom, qTo, unit) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        if (uri != null) runCatching { ctx.contentResolver.openOutputStream(uri)!!.use { it.write(("﻿" + log.csv(qFrom, qTo)).toByteArray()) } }
            .onSuccess { Toast.makeText(ctx, "ذخیره شد", Toast.LENGTH_SHORT).show() }
            .onFailure { Toast.makeText(ctx, "ذخیره نشد", Toast.LENGTH_SHORT).show() }
    }

    GCard {
        H("مصرف داده")
        ChoiceChips(listOf("hour" to "۲۴ ساعت", "day" to "۳۰ روز", "week" to "هفتگی", "month" to "ماهانه", "range" to "بازه"), view) { view = it }
        if (view == "range") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            fun pick(current: Long, set: (Long) -> Unit) {
                val c = Calendar.getInstance().apply { timeInMillis = current }
                DatePickerDialog(ctx, { _, y, m, d -> set(Calendar.getInstance().apply { set(y, m, d, 0, 0, 0); set(Calendar.MILLISECOND, 0) }.timeInMillis) },
                    c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH)).show()
            }
            OutlinedButton({ pick(from) { from = it } }) { Text("از ${ltr(dayLabel(from))}", fontSize = 12.5.sp) }
            OutlinedButton({ pick(to) { to = it } }) { Text("تا ${ltr(dayLabel(to))}", fontSize = 12.5.sp) }
        }
        Total("اینترنت مصرفی خود برنامه", r.total[0], r.total[1])
        Total("داخل تونل (برنامه‌ها از VPN)", r.total[2], r.total[3])
        if (r.paired[0] > 0 && r.paired[1] > 0) {
            val extra = ((r.paired[0].toDouble() / r.paired[1] - 1) * 100).toInt()
            Hint("سربار: اینترنت مصرفی ${ltr((if (extra >= 0) "+" else "") + extra + "%")} نسبت به ترافیک داخل تونل (فقط زمان‌هایی که هر دو اندازه گرفته شده).")
        }
        Bars(r)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Legend(DOWN, "دانلود"); Legend(UP, "آپلود")
        }
        if (r.engines.isEmpty()) Hint("در این بازه هنوز چیزی ثبت نشده. آمار از نسخه‌ی 0.14.0 به بعد و فقط وقتی VPN روشن است ثبت می‌شود.")
        r.engines.entries.sortedByDescending { it.value[0] + it.value[1] }.forEach { (k, v) ->
            Row(Modifier.fillMaxWidth()) {
                Text(ENGINE_NAMES[k] ?: k, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Text(ltr("↓ ${fmtBytes(v[0])}  ↑ ${fmtBytes(v[1])}"), fontSize = 12.5.sp, color = Muted)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ save.launch("gozarvpn-traffic.csv") }) { Text("ذخیره به‌صورت CSV") }
            TextButton({ confirmReset = true }) { Text("پاک کردن آمار", color = Bad) }
        }
        Hint("«اینترنت مصرفی خود برنامه» همان شمارنده‌ی اندروید برای GozarVpn است: ترافیک واقعی موتورها با سربارشان، به‌علاوه‌ی تست‌های اتصال و پینگ. «داخل تونل» چیزی است که برنامه‌های دیگر از VPN رد کرده‌اند؛ برای OpenVPN اندازه گرفته نمی‌شود. این آمار فقط روی همین گوشی نگه داشته می‌شود.")
    }
    if (confirmReset) AlertDialog(
        onDismissRequest = { confirmReset = false },
        text = { Text("همه‌ی آمار مصرف داده پاک شود؟ این کار برگشت ندارد.") },
        confirmButton = { TextButton({ log.reset(); tick++; confirmReset = false }) { Text("پاک شود", color = Bad) } },
        dismissButton = { TextButton({ confirmReset = false }) { Text("انصراف") } },
    )
}

private fun dayLabel(t: Long): String {
    val c = Calendar.getInstance().apply { timeInMillis = t }
    return "%d/%02d/%02d".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
}

@Composable
private fun Total(title: String, down: Long, up: Long) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = 0.04f)).padding(horizontal = 10.dp, vertical = 8.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 12.sp, color = Muted)
            Text(ltr("↓ ${fmtBytes(down)}   ↑ ${fmtBytes(up)}"), fontSize = 12.sp, color = Muted)
        }
        Text(ltr(fmtBytes(down + up)), fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Legend(color: Color, label: String) = Row {
    Text("■ ", color = color, fontSize = 12.sp); Text(label, color = Muted, fontSize = 12.sp)
}

/** Real network traffic per unit, oldest on the left: download stacked under upload. */
@Composable
private fun Bars(r: TrafficLog.Result) {
    val max = (r.rows.maxOfOrNull { it.v[0] + it.v[1] } ?: 0L).coerceAtLeast(1L).toFloat()
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Ltr) {
        Column {
            Canvas(Modifier.fillMaxWidth().height(110.dp)) {
                val n = r.rows.size.coerceAtLeast(1)
                val slot = size.width / n
                val w = (slot * 0.7f).coerceAtLeast(1f)
                r.rows.forEachIndexed { i, row ->
                    val x = i * slot + (slot - w) / 2
                    val hd = size.height * row.v[0] / max
                    val hu = size.height * row.v[1] / max
                    drawRect(DOWN, Offset(x, size.height - hd), Size(w, hd))
                    drawRect(UP, Offset(x, size.height - hd - hu), Size(w, hu))
                }
            }
            if (r.rows.isNotEmpty()) Row(Modifier.fillMaxWidth()) {
                Text(axisLabel(r.rows.first().start, r.unit), fontSize = 10.5.sp, color = Muted, modifier = Modifier.weight(1f))
                Text(axisLabel(r.rows.last().start, r.unit), fontSize = 10.5.sp, color = Muted)
            }
        }
    }
}

private fun axisLabel(t: Long, unit: TrafficLog.Span): String {
    val c = Calendar.getInstance().apply { timeInMillis = t }
    return when (unit) {
        TrafficLog.Span.HOUR -> "%02d:00".format(c.get(Calendar.HOUR_OF_DAY))
        TrafficLog.Span.MONTH -> "%d/%02d".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1)
        else -> "%02d/%02d".format(c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }
}
