package app.gozarvpn.android.data

import java.io.File
import java.util.Calendar

/**
 * Local data-usage history: hourly buckets in files/traffic.txt, never sent anywhere.
 * Per hour and engine: [netDown, netUp, tunDown, tunUp] in bytes, where
 *   net = this app's own traffic as Android counts it (all engines, tests and checks included),
 *   tun = what went through the VPN tunnel (sing-box's counters; not available for OpenVPN).
 * File format: one line per bucket, "hourStartMillis engine nd nu td tu".
 */
class TrafficLog(private val file: File) {
    private val buckets = HashMap<String, LongArray>()
    private var dirty = false

    init {
        runCatching {
            if (file.exists()) file.readLines().forEach { line ->
                val p = line.trim().split(' ')
                if (p.size == 6) buckets["${p[0]}|${p[1]}"] = LongArray(4) { p[it + 2].toLong() }
            }
        }
    }

    @Synchronized
    fun add(engine: String, netDown: Long, netUp: Long, tunDown: Long, tunUp: Long, now: Long = System.currentTimeMillis()) {
        val v = longArrayOf(netDown, netUp, tunDown, tunUp).map { it.coerceAtLeast(0) }
        if (v.all { it == 0L }) return
        val b = buckets.getOrPut("${unitStart(now, Span.HOUR)}|$engine") { LongArray(4) }
        for (i in 0..3) b[i] += v[i]
        dirty = true
    }

    /** Saves if something changed (temp file + rename, so a crash never leaves half a file). Drops data older than 400 days. */
    @Synchronized
    fun flush(now: Long = System.currentTimeMillis()) {
        if (!dirty) return
        val oldest = now - 400L * 86_400_000
        buckets.keys.removeAll { it.substringBefore('|').toLong() < oldest }
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(buckets.entries.joinToString("\n") { (k, v) -> "${k.replace('|', ' ')} ${v.joinToString(" ")}" })
        // replace the old file in one step (renameTo does not overwrite on every filesystem)
        try {
            java.nio.file.Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            java.nio.file.Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        }
        dirty = false
    }

    @Synchronized
    fun reset() { buckets.clear(); dirty = true; flush() }

    data class Row(val start: Long, val v: LongArray)
    data class Result(val unit: Span, val rows: List<Row>, val total: LongArray, val engines: Map<String, LongArray>, val paired: LongArray)

    /** Rows for [from, to) per unit (empty units included), totals, per-engine totals, and [net, tunnel] over hours that have both. */
    @Synchronized
    fun query(from: Long, to: Long, unit: Span): Result {
        val rows = ArrayList<Row>()
        val index = HashMap<Long, Int>()
        var s = unitStart(from, unit)
        while (s < to) { index[s] = rows.size; rows += Row(s, LongArray(4)); s = nextUnit(s, unit) }
        val total = LongArray(4)
        val engines = HashMap<String, LongArray>()
        val paired = LongArray(2)
        for ((k, v) in buckets) {
            val t = k.substringBefore('|').toLong()
            if (t < from || t >= to) continue
            index[unitStart(t, unit)]?.let { i -> for (j in 0..3) rows[i].v[j] += v[j] }
            val e = engines.getOrPut(k.substringAfter('|')) { LongArray(4) }
            for (j in 0..3) { total[j] += v[j]; e[j] += v[j] }
            if (v[2] + v[3] > 0) { paired[0] += v[0] + v[1]; paired[1] += v[2] + v[3] }
        }
        return Result(unit, rows, total, engines, paired)
    }

    @Synchronized
    fun csv(from: Long, to: Long): String {
        val c = Calendar.getInstance()
        val sb = StringBuilder("hour_start_local,engine,net_download_bytes,net_upload_bytes,tunnel_download_bytes,tunnel_upload_bytes\n")
        buckets.entries.sortedBy { it.key }.forEach { (k, v) ->
            val t = k.substringBefore('|').toLong()
            if (t < from || t >= to) return@forEach
            c.timeInMillis = t
            sb.append("%04d-%02d-%02d %02d:00,%s,%d,%d,%d,%d\n".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH), c.get(Calendar.HOUR_OF_DAY), k.substringAfter('|'), v[0], v[1], v[2], v[3]))
        }
        return sb.toString()
    }

    enum class Span { HOUR, DAY, WEEK, MONTH }

    companion object {
        /** Local-time start of the unit containing [ts]; weeks start on Saturday (as in Iran). */
        fun unitStart(ts: Long, unit: Span): Long {
            val c = Calendar.getInstance().apply { timeInMillis = ts; set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }
            if (unit == Span.HOUR) return c.timeInMillis
            c.set(Calendar.HOUR_OF_DAY, 0)
            when (unit) {
                Span.WEEK -> c.add(Calendar.DAY_OF_MONTH, -((c.get(Calendar.DAY_OF_WEEK) - Calendar.SATURDAY + 7) % 7))
                Span.MONTH -> c.set(Calendar.DAY_OF_MONTH, 1)
                else -> {}
            }
            return c.timeInMillis
        }

        fun nextUnit(start: Long, unit: Span): Long {
            val c = Calendar.getInstance().apply { timeInMillis = start }
            when (unit) {
                Span.HOUR -> c.add(Calendar.HOUR_OF_DAY, 1)
                Span.DAY -> c.add(Calendar.DAY_OF_MONTH, 1)
                Span.WEEK -> c.add(Calendar.DAY_OF_MONTH, 7)
                Span.MONTH -> c.add(Calendar.MONTH, 1)
            }
            return c.timeInMillis
        }

        /** The standard views as (from, to, unit): last 24 h by hour, 30 days, 12 weeks, 12 months. */
        fun view(name: String, now: Long = System.currentTimeMillis()): Triple<Long, Long, Span> {
            val unit = when (name) { "day" -> Span.DAY; "week" -> Span.WEEK; "month" -> Span.MONTH; else -> Span.HOUR }
            val end = nextUnit(unitStart(now, unit), unit)
            val c = Calendar.getInstance().apply { timeInMillis = end }
            when (unit) {
                Span.HOUR -> c.add(Calendar.HOUR_OF_DAY, -24)
                Span.DAY -> c.add(Calendar.DAY_OF_MONTH, -30)
                Span.WEEK -> c.add(Calendar.DAY_OF_MONTH, -84)
                Span.MONTH -> c.add(Calendar.MONTH, -12)
            }
            return Triple(c.timeInMillis, end, unit)
        }

        /** Whole days [fromDay, toDay] inclusive: by hour up to two days, by month past three months, else by day. */
        fun range(fromDay: Long, toDay: Long): Triple<Long, Long, Span> {
            val f = unitStart(minOf(fromDay, toDay), Span.DAY)
            val t = nextUnit(unitStart(maxOf(fromDay, toDay), Span.DAY), Span.DAY)
            val days = (t - f) / 86_400_000.0
            return Triple(f, t, if (days <= 2.05) Span.HOUR else if (days > 92) Span.MONTH else Span.DAY)
        }

        @Volatile private var shared: TrafficLog? = null
        fun get(ctx: android.content.Context): TrafficLog = shared ?: synchronized(this) { shared ?: TrafficLog(File(ctx.filesDir, "traffic.txt")).also { shared = it } }
    }
}
