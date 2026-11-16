package app.gozarvpn.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppUpdateTest {
    // the shape of GitHub's /releases answer (only the fields we read)
    private val json = """
    [
      {"tag_name":"v1.21.0","name":"beta","body":"b","draft":false,"prerelease":true,"assets":[
        {"name":"GozarVpn-0.13.0-arm64-v8a-release.apk","size":5,"browser_download_url":"u/b"}]},
      {"tag_name":"v1.20.0","name":"1.20","body":"notes","draft":false,"prerelease":false,"assets":[
        {"name":"GozarVpn-0.12.0-arm64-v8a-release.apk","size":80,"browser_download_url":"u/arm64"},
        {"name":"GozarVpn-0.12.0-armeabi-v7a-release.apk","size":79,"browser_download_url":"u/v7"},
        {"name":"GozarVpn-0.12.0-universal-release.apk","size":148,"browser_download_url":"u/uni"},
        {"name":"GozarVpn-Setup-1.20.0.exe","size":88,"browser_download_url":"u/exe"},
        {"name":"SHA256SUMS.txt","size":1,"browser_download_url":"u/sums"}]},
      {"tag_name":"v9","draft":true,"prerelease":false,"assets":[
        {"name":"GozarVpn-9.0.0-arm64-v8a-release.apk","size":1,"browser_download_url":"u/draft"}]}
    ]
    """.trimIndent()

    @Test fun picksByAbiAndVersion() {
        val f = AppUpdate.pick(json, "0.11.0", listOf("arm64-v8a", "armeabi-v7a"), beta = false)!!
        assertEquals("0.12.0", f.version)
        assertEquals("u/arm64", f.url)
        assertEquals("u/sums", f.sumsUrl)
        assertEquals("u/v7", AppUpdate.pick(json, "0.11.0", listOf("armeabi-v7a"), false)!!.url)
        assertEquals("u/uni", AppUpdate.pick(json, "0.11.0", listOf("x86_64"), false)!!.url)
        assertEquals("0.13.0", AppUpdate.pick(json, "0.11.0", listOf("arm64-v8a"), beta = true)!!.version)
        assertNull(AppUpdate.pick(json, "0.12.0", listOf("arm64-v8a"), false))
    }

    @Test fun helpers() {
        assertEquals(1, AppUpdate.cmp("0.10.0", "0.9.9"))
        assertEquals("b".repeat(64), AppUpdate.hashFromSums("${"a".repeat(64)}  x.apk\n${"B".repeat(64)} *y.apk", "y.apk"))
        assertNull(AppUpdate.hashFromSums("zz  x.apk", "x.apk"))
        assertEquals(true, "خصوصی" in AppUpdate.friendly(IllegalStateException("HTTP 404")))
    }
}
