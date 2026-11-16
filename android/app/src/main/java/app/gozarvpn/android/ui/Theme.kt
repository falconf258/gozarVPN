package app.gozarvpn.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

val Amber = Color(0xFFF59E0B)
val Orange = Color(0xFFFF8A3D)
val Ink = Color(0xFF090B11)
val Card = Color(0xFF141822)
val Muted = Color(0xFF8B93A1)
val Good = Color(0xFF34D399)
val Warn = Color(0xFFFBBF24)
val Bad = Color(0xFFF87171)
val Rose = Color(0xFFF2557A)

/** Each engine has its own colour pair, used by the connect button and the engine picker. */
fun engineColors(engine: String): Pair<Color, Color> = when (engine) {
    "aether" -> Color(0xFFFF8A3D) to Color(0xFFF2557A)
    "singbox" -> Color(0xFF38BDF8) to Color(0xFF6366F1)
    "mihomo" -> Color(0xFFA78BFA) to Color(0xFFEC4899)
    "tor" -> Color(0xFF8B5CF6) to Color(0xFF6D28D9)
    "psiphon" -> Color(0xFF2DD4BF) to Color(0xFF0EA5E9)
    else -> Orange to Rose
}

private val Scheme = darkColorScheme(
    primary = Orange,
    onPrimary = Color(0xFF1A1000),
    secondary = Rose,
    background = Ink,
    surface = Card,
    onBackground = Color(0xFFE8EAEE),
    onSurface = Color(0xFFE8EAEE),
    surfaceVariant = Color(0xFF1C202B),
    surfaceContainer = Color(0xFF10131B),
    secondaryContainer = Orange.copy(alpha = 0.18f),
    onSecondaryContainer = Color(0xFFFFD4AD),
    error = Bad,
)

@Composable
fun GozarTheme(content: @Composable () -> Unit) {
    // The app is dark-only on purpose, like the desktop version.
    MaterialTheme(colorScheme = Scheme, content = content)
}

/** Dark backdrop with two soft colour glows, drawn once behind every screen. */
@Composable
fun Backdrop(accent: Color, content: @Composable BoxScope.() -> Unit) {
    Box(
        Modifier.fillMaxSize().background(Ink).drawBehind {
            drawCircle(Brush.radialGradient(listOf(accent.copy(alpha = 0.20f), Color.Transparent), Offset(size.width * 0.85f, size.height * 0.08f), size.width * 0.9f))
            drawCircle(Brush.radialGradient(listOf(Color(0xFF6366F1).copy(alpha = 0.13f), Color.Transparent), Offset(size.width * 0.1f, size.height * 0.75f), size.width))
        },
        content = content,
    )
}
