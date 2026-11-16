package app.gozarvpn.android.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** In-memory log shown on the log tab (never written to disk). */
object LogBuffer {
    private const val MAX = 2000
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)
    private val _lines = MutableStateFlow<List<String>>(emptyList())
    val lines: StateFlow<List<String>> = _lines

    @Synchronized
    fun add(text: String) {
        val line = "${fmt.format(Date())}  $text"
        _lines.value = (_lines.value + line).takeLast(MAX)
    }

    @Synchronized
    fun clear() { _lines.value = emptyList() }
}
