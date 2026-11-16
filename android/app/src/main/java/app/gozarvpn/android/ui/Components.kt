package app.gozarvpn.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Translucent "glass" card over the backdrop; a light top edge gives it depth. */
@Composable
fun GCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        // a translucent container has no matching content colour, so set it (else text turns black)
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.78f), contentColor = MaterialTheme.colorScheme.onSurface),
        border = BorderStroke(1.dp, Brush.verticalGradient(listOf(Color(0x33FFFFFF), Color(0x0DFFFFFF)))),
        shape = RoundedCornerShape(20.dp),
        modifier = modifier.fillMaxWidth(),
    ) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content) }
}

/** Section title with a small accent bar, so cards read as groups at a glance. */
@Composable
fun H(text: String) = Row(verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(width = 3.dp, height = 14.dp).clip(RoundedCornerShape(2.dp)).background(Brush.verticalGradient(listOf(Orange, Rose))))
    Spacer(Modifier.width(8.dp))
    Text(text, fontWeight = FontWeight.Bold, fontSize = 15.sp)
}

/**
 * Pill tabs in one rounded track that scrolls sideways when the options don't fit.
 * [colorsOf] gives the selected pill's gradient (e.g. per engine).
 */
@Composable
fun PillTabs(
    options: List<Pair<String, String>>,
    selected: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colorsOf: (String) -> Pair<Color, Color> = { Orange to Rose },
    onSelect: (String) -> Unit,
) {
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0x66000000))
            .border(1.dp, Color(0x14FFFFFF), RoundedCornerShape(16.dp))
            .horizontalScroll(rememberScrollState()).padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for ((value, label) in options) {
            val on = value == selected
            val (c1, c2) = colorsOf(value)
            Box(
                Modifier.clip(RoundedCornerShape(12.dp))
                    .then(if (on) Modifier.background(Brush.horizontalGradient(listOf(c1.copy(alpha = 0.85f), c2.copy(alpha = 0.85f)))) else Modifier)
                    .clickable(enabled = enabled) { onSelect(value) }
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, fontSize = 13.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium,
                    color = if (on) Color.White else Muted, maxLines = 1)
            }
        }
    }
}

/** Icon in a softly tinted rounded square (stats, settings rows, empty states). */
@Composable
fun IconTile(icon: ImageVector, tint: Color, size: Int = 40) {
    Box(
        Modifier.size(size.dp).clip(RoundedCornerShape((size * 0.32f).dp)).background(tint.copy(alpha = 0.14f))
            .border(1.dp, tint.copy(alpha = 0.25f), RoundedCornerShape((size * 0.32f).dp)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = tint, modifier = Modifier.size((size * 0.5f).dp)) }
}

/** Shown instead of an empty list: icon, title and what to do next. */
@Composable
fun EmptyState(icon: ImageVector, title: String, text: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        IconTile(icon, Muted, 56)
        Text(title, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        Text(text, color = Muted, fontSize = 12.5.sp, textAlign = TextAlign.Center, lineHeight = 20.sp)
    }
}

@Composable
fun Hint(text: String) = Text(text, color = Muted, fontSize = 12.5.sp, lineHeight = 20.sp)

/** Single-choice chips in a wrapping row. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChoiceChips(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((value, label) in options) {
            FilterChip(selected == value, { onSelect(value) }, label = { Text(label) })
        }
    }
}

/** Labelled single-line setting; keeps its own text while typing and saves every change. */
@Composable
fun SettingField(label: String, value: String, number: Boolean = false, onChange: (String) -> Unit) {
    var text by androidx.compose.runtime.remember(value) { androidx.compose.runtime.mutableStateOf(value) }
    OutlinedTextField(
        text, { v -> val clean = if (number) v.filter { it.isDigit() } else v; text = clean; onChange(clean) },
        label = { Text(label, fontSize = 12.5.sp) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        keyboardOptions = if (number) androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number)
        else androidx.compose.foundation.text.KeyboardOptions.Default,
    )
}

@Composable
fun SettingSwitch(title: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp)
            Text(hint, color = Muted, fontSize = 12.sp, lineHeight = 18.sp)
        }
        Spacer(Modifier.width(8.dp))
        Switch(checked, onChange)
    }
}

@Composable
fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Muted, fontSize = 13.sp)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 13.sp)
    }
}
