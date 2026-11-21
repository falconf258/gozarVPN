package app.gozarvpn.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** "A new version is out" after the launch check. [onLater] gets true when "don't show again for this version" is ticked. */
@Composable
fun UpdateDialog(version: String, notes: String, onUpdate: () -> Unit, onLater: (Boolean) -> Unit) {
    var skip by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { onLater(skip) },
        title = { Text("نسخه‌ی جدید GozarVpn آماده است") },
        text = {
            Column {
                Text("نسخه‌ی ${ltr(version)} منتشر شده. A new version is available.", fontSize = 13.5.sp)
                val short = notes.replace(Regex("[*#`>|]+"), "").lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("---") }.take(8).joinToString("\n")
                if (short.isNotBlank()) Text(short, color = Muted, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState()))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(skip, { skip = it })
                    Text("برای این نسخه دیگر نشان نده", fontSize = 13.sp)
                }
            }
        },
        confirmButton = { Button(onUpdate) { Text("به‌روزرسانی") } },
        dismissButton = { TextButton({ onLater(skip) }) { Text("بعداً") } },
    )
}
