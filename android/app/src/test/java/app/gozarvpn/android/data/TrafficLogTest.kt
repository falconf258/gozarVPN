package app.gozarvpn.android.data

import app.gozarvpn.android.data.TrafficLog.Span
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.Calendar
import java.util.TimeZone

class TrafficLogTest {
    private lateinit var saved: TimeZone

    @Before fun tz() { saved = TimeZone.getDefault(); TimeZone.setDefault(TimeZone.getTimeZone("Asia/Tehran")) }
    @After fun restore() { TimeZone.setDefault(saved) }

    private fun at(y: Int, m: Int, d: Int, h: Int = 0, mi: Int = 0) =
        Calendar.getInstance().apply { clear(); set(y, m - 1, d, h, mi) }.timeInMillis

    @Test fun boundaries() {
        assertEquals(at(2026, 11, 20, 15), TrafficLog.unitStart(at(2026, 11, 20, 15, 42), Span.HOUR))
        assertEquals(at(2026, 11, 20), TrafficLog.unitStart(at(2026, 11, 20, 23, 59), Span.DAY))
        // Friday 20 Nov belongs to the week that started on Saturday 14 Nov; Saturday 21 starts a new one
        assertEquals(at(2026, 11, 14), TrafficLog.unitStart(at(2026, 11, 20, 12), Span.WEEK))
        assertEquals(at(2026, 11, 21), TrafficLog.unitStart(at(2026, 11, 21, 1), Span.WEEK))
        assertEquals(at(2026, 11, 1), TrafficLog.unitStart(at(2026, 11, 30, 9), Span.MONTH))
        assertEquals(at(2027, 1, 1), TrafficLog.nextUnit(at(2026, 12, 1), Span.MONTH))
        val (f, t, u) = TrafficLog.view("hour", at(2026, 11, 20, 15, 30))
        assertEquals(Span.HOUR, u); assertEquals(at(2026, 11, 20, 16), t); assertEquals(24 * 3_600_000L, t - f)
        assertEquals(Span.HOUR, TrafficLog.range(at(2026, 11, 18), at(2026, 11, 18)).third)
        assertEquals(Span.DAY, TrafficLog.range(at(2026, 11, 1), at(2026, 11, 20)).third)
    }

    @Test fun recordsAggregatesAndPersists() {
        val file = File.createTempFile("traffic", ".txt").apply { delete() }
        val log = TrafficLog(file)
        log.add("aether", 1000, 100, 0, 0, at(2026, 11, 20, 15, 1))
        log.add("aether", 500, 50, 400, 40, at(2026, 11, 20, 15, 59))
        log.add("tor", 2000, 200, 0, 0, at(2026, 11, 20, 23, 30))
        log.add("tor", 7, 7, 0, 0, at(2026, 11, 21, 0, 10))
        log.add("tor", 0, 0, 0, 0, at(2026, 11, 21, 0, 10))
        log.add("aether", -5, 0, 0, 0, at(2026, 11, 21, 0, 10))
        log.flush(at(2026, 11, 21, 1))

        val again = TrafficLog(file) // as after a restart
        val day = again.query(at(2026, 11, 20), at(2026, 11, 21), Span.HOUR)
        assertEquals(24, day.rows.size)
        assertArrayEquals(longArrayOf(1500, 150, 400, 40), day.rows[15].v)
        assertArrayEquals(longArrayOf(3500, 350, 400, 40), day.total)
        assertArrayEquals(longArrayOf(1650, 440), day.paired)
        assertArrayEquals(longArrayOf(2000, 200, 0, 0), day.engines["tor"])
        assertEquals(listOf(3500L, 7L), again.query(at(2026, 11, 20), at(2026, 11, 22), Span.DAY).rows.map { it.v[0] })
        assertEquals(listOf(3500L, 7L), again.query(at(2026, 11, 14), at(2026, 11, 28), Span.WEEK).rows.map { it.v[0] })
        assertEquals(listOf(3507L, 0L), again.query(at(2026, 11, 1), at(2027, 1, 1), Span.MONTH).rows.map { it.v[0] })
        assert(again.csv(at(2026, 11, 20), at(2026, 11, 22)).contains("2026-11-20 15:00,aether,1500,150,400,40"))

        again.reset()
        assertArrayEquals(longArrayOf(0, 0, 0, 0), TrafficLog(file).query(at(2026, 1, 1), at(2027, 1, 1), Span.MONTH).total)
        file.delete()
    }

    @Test fun damagedFileStartsEmpty() {
        val file = File.createTempFile("traffic", ".txt").apply { writeText("garbage\nnot numbers here at all\n") }
        assertArrayEquals(longArrayOf(0, 0, 0, 0), TrafficLog(file).query(at(2026, 1, 1), at(2027, 1, 1), Span.MONTH).total)
        file.delete()
    }

    @Test fun oldDataIsPruned() {
        val file = File.createTempFile("traffic", ".txt").apply { delete() }
        val log = TrafficLog(file)
        log.add("tor", 1, 0, 0, 0, at(2025, 1, 1))
        log.add("tor", 2, 0, 0, 0, at(2026, 11, 1))
        log.flush(at(2026, 11, 21))
        assertEquals(2L, TrafficLog(file).query(at(2024, 1, 1), at(2027, 1, 1), Span.MONTH).total[0])
        file.delete()
    }
}
