package app.gozarvpn.android.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.gozarvpn.android.core.ProxyCores
import app.gozarvpn.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val repo = Repo.get(app)
    val state: StateFlow<AppState> = repo.state

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    data class TestRun(val done: Int, val total: Int)

    private val _testRun = MutableStateFlow<TestRun?>(null)
    val testRun: StateFlow<TestRun?> = _testRun
    private var testJob: Job? = null

    /** Tests [list] in parallel, saving each result as it arrives (new results replace old ones). */
    fun testConfigs(list: List<ConfigEntry>) {
        if (testJob?.isActive == true || list.isEmpty()) return
        val ctx = getApplication<Application>()
        testJob = viewModelScope.launch(Dispatchers.IO) {
            val total = list.size
            var done = 0
            _testRun.value = TestRun(0, total)
            val gate = Semaphore(16)
            try {
                coroutineScope {
                    list.map { c ->
                        async {
                            gate.withPermit {
                                ensureActive()
                                val r = runCatching { Tester.test(ctx, c) }.getOrElse { TestResult(false, error = it.message) }
                                if (r != null) repo.saveResult(c.id, r)
                                _testRun.value = TestRun(synchronized(this@AppViewModel) { ++done }, total)
                            }
                        }
                    }.awaitAll()
                }
                _message.value = "تست تمام شد."
            } catch (_: CancellationException) {
                _message.value = "تست لغو شد."
            } finally {
                _testRun.value = null
            }
        }
    }

    fun cancelTest() { testJob?.cancel() }

    fun consumeMessage() { _message.value = null }

    fun importText(text: String, groupName: String) {
        viewModelScope.launch {
            val (ok, failed) = LinkParser.parseSubscription(text)
            val n = repo.addParsed(ok, groupName.ifBlank { "دستی" }, null)
            _message.value = if (n == 0) "هیچ لینک معتبری پیدا نشد." else "$n کانفیگ اضافه شد" + if (failed > 0) " ($failed مورد خوانده نشد)." else "."
        }
    }

    private val _subStatus = MutableStateFlow<Pair<Boolean, String>?>(null)
    /** Result of the last subscription import, kept on screen (true = success). */
    val subStatus: StateFlow<Pair<Boolean, String>?> = _subStatus

    private fun report(ok: Boolean, text: String) {
        _subStatus.value = ok to text
        _message.value = text
        LogBuffer.add("ساب: $text")
    }

    /** DNS lookups have no timeout of their own, so give the whole download a hard limit. */
    private suspend fun fetchWithTimeout(url: String): String {
        // Unstructured on purpose: a stuck DNS lookup can't be cancelled, and must not block the timeout.
        val job = CoroutineScope(Dispatchers.IO).async { Subscription.fetch(url) }
        return try {
            withTimeout(30_000) { job.await() }
        } catch (_: TimeoutCancellationException) {
            throw java.net.SocketTimeoutException("زمان دریافت تمام شد")
        }
    }

    fun importSubscription(url: String, groupName: String) {
        viewModelScope.launch {
            _busy.value = true
            _subStatus.value = true to "در حال دریافت…"
            LogBuffer.add("دریافت ساب: ${url.trim().substringBefore('?')}")
            try {
                val text = fetchWithTimeout(url.trim())
                LogBuffer.add("ساب دریافت شد: ${text.length} بایت، شروع: " + text.trim().take(60).replace('\n', ' '))
                val (ok, failed) = LinkParser.parseSubscription(text)
                val n = repo.addParsed(ok, groupName.ifBlank { Subscription.nameFor(url) }, url.trim())
                if (n == 0) report(false, "پاسخ دریافت شد (${text.length} بایت) ولی کانفیگ قابل‌خواندنی نداشت. شروع پاسخ: " + text.trim().take(80).replace('\n', ' '))
                else report(true, "$n کانفیگ اضافه شد" + if (failed > 0) " ($failed مورد خوانده نشد)." else ".")
            } catch (t: Throwable) {
                report(false, "افزودن ساب ناموفق بود: " + describeNetworkError(t))
            } finally {
                _busy.value = false
            }
        }
    }

    fun refreshGroup(g: Group) {
        val url = g.sourceUrl ?: return
        viewModelScope.launch {
            _busy.value = true
            try {
                val text = fetchWithTimeout(url)
                val (ok, failed) = LinkParser.parseSubscription(text)
                val n = repo.replaceGroup(g.id, ok)
                _message.value = if (n == 0) "از این لینک کانفیگی خوانده نشد." else "گروه به‌روز شد: $n کانفیگ" + if (failed > 0) " ($failed مورد خوانده نشد)." else "."
            } catch (t: Throwable) {
                _message.value = "به‌روزرسانی ناموفق بود: " + describeNetworkError(t)
            } finally {
                _busy.value = false
            }
        }
    }

    private val _clashStatus = MutableStateFlow<Pair<Boolean, String>?>(null)
    /** Result of the last Clash profile save, kept on screen (true = success). */
    val clashStatus: StateFlow<Pair<Boolean, String>?> = _clashStatus

    init {
        // older versions kept one profile in mihomo/profile.txt; turn it into a named profile once
        val ctx = getApplication<Application>()
        val legacy = java.io.File(ctx.filesDir, "mihomo/profile.txt")
        if (repo.state.value.settings.clashProfiles.isEmpty() && legacy.exists() && legacy.length() > 0) {
            val id = java.util.UUID.randomUUID().toString()
            ProxyCores.clashProfileFile(ctx, id).apply { parentFile?.mkdirs(); writeText(legacy.readText()) }
            repo.updateSettings { it.copy(clashProfiles = listOf(ClashProfile(id, "پروفایل قبلی", it.clashUrl.ifBlank { null })), clashActive = id) }
        }
    }

    /**
     * What mihomo's file provider can read: Clash YAML with `proxies:`, share links, or a
     * base64 blob of links. Returns an error text, or null when the content looks usable.
     */
    private fun clashProblem(body: String): String? {
        if (body.isEmpty()) return "متن خالی است."
        if (body.startsWith("<")) return "این یک صفحه‌ی وب است، نه اشتراک Clash."
        if (Regex("(?m)^proxies:").containsMatchIn(body) || "://" in body) return null
        val decoded = runCatching { String(android.util.Base64.decode(body, android.util.Base64.DEFAULT)) }.getOrNull()
        if (decoded != null && "://" in decoded) return null
        if (Regex("(?m)^proxy-providers:").containsMatchIn(body))
            return "این فایل فقط proxy-providers (اشتراک‌های راه دور) دارد و سرور مستقیم (proxies:) ندارد؛ لینک همان provider را در «لینک اشتراک» بدهید."
        return "سرور قابل‌خواندنی پیدا نشد (نه proxies: دارد، نه لینک vless/vmess/…)."
    }

    /** Copies [text] into a new named profile and makes it active. */
    private fun addClashProfile(text: String, name: String, url: String?): Boolean {
        val body = text.trim().removePrefix("﻿")
        clashProblem(body)?.let { _clashStatus.value = false to it; return false }
        val id = java.util.UUID.randomUUID().toString()
        ProxyCores.clashProfileFile(getApplication(), id).apply { parentFile?.mkdirs(); writeText(body) }
        repo.updateSettings { it.copy(clashProfiles = it.clashProfiles + ClashProfile(id, name.ifBlank { "پروفایل Clash" }, url), clashActive = id, clashSelected = "") }
        _clashStatus.value = true to "پروفایل «${name.ifBlank { "پروفایل Clash" }}» ذخیره و فعال شد (${body.length} بایت). موتور Clash را در خانه انتخاب و وصل کنید."
        return true
    }

    fun importClash(url: String) {
        viewModelScope.launch {
            _busy.value = true
            _clashStatus.value = true to "در حال دریافت…"
            try {
                val text = fetchWithTimeout(url.trim())
                if (addClashProfile(text, Subscription.nameFor(url.trim()), url.trim())) repo.updateSettings { it.copy(clashUrl = url.trim()) }
            } catch (t: Throwable) {
                _clashStatus.value = false to "دریافت ناموفق بود: " + describeNetworkError(t)
            } finally {
                _busy.value = false
                _clashStatus.value?.let { LogBuffer.add("Clash: ${it.second}") }
            }
        }
    }

    /** A .yaml/.yml/.txt picked with the system file picker (no storage permission needed). */
    fun importClashFile(uri: android.net.Uri) {
        viewModelScope.launch(Dispatchers.IO) {
            val ctx = getApplication<Application>()
            runCatching {
                val name = ctx.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
                    ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }?.substringBeforeLast('.') ?: "فایل Clash"
                val text = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() } ?: error("فایل خوانده نشد")
                if (text.length > 5_000_000) error("فایل بیش از ۵ مگابایت است")
                addClashProfile(text, name, null)
            }.onFailure { _clashStatus.value = false to "خواندن فایل ناموفق بود: ${it.message}" }
        }
    }

    fun setActiveClash(id: String) = repo.updateSettings { it.copy(clashActive = id, clashSelected = "") }

    fun renameClash(id: String, name: String) =
        repo.updateSettings { s -> s.copy(clashProfiles = s.clashProfiles.map { if (it.id == id) it.copy(name = name.trim().ifBlank { it.name }) else it }) }

    fun deleteClash(id: String) {
        ProxyCores.clashProfileFile(getApplication(), id).delete()
        repo.updateSettings { s ->
            val rest = s.clashProfiles.filter { it.id != id }
            s.copy(clashProfiles = rest, clashActive = if (s.clashActive == id) rest.firstOrNull()?.id ?: "" else s.clashActive)
        }
    }

    data class ClashItem(val name: String, val delay: Int? = null, val current: Boolean = false, val tested: Boolean = false)

    private val _clashNodes = MutableStateFlow<List<ClashItem>>(emptyList())
    /** Clash servers: live from mihomo while connected, else names read from the saved profile. */
    val clashNodes: StateFlow<List<ClashItem>> = _clashNodes

    fun loadClashNodes(connected: Boolean) {
        viewModelScope.launch(Dispatchers.IO) {
            val ctx = getApplication<Application>()
            val selected = repo.state.value.settings.clashSelected
            _clashNodes.value = if (connected) runCatching {
                val (now, nodes) = ProxyCores.mihomoNodes()
                nodes.map { ClashItem(it.name, it.delay, current = it.name == now, tested = it.delay != null) }
            }.getOrElse { LogBuffer.add("Clash: فهرست سرورها از mihomo گرفته نشد: ${it.message}"); emptyList() }
            else (listOf("AUTO") + ProxyCores.clashNamesFromProfile(ctx, repo.state.value.settings))
                .map { ClashItem(it, current = it == selected.ifEmpty { "AUTO" }) }
        }
    }

    /** Delay test of every listed server through mihomo (only while connected). */
    fun testClashDelays() {
        viewModelScope.launch(Dispatchers.IO) {
            val gate = Semaphore(8)
            coroutineScope {
                _clashNodes.value.filter { it.name != "AUTO" }.map { item ->
                    async {
                        gate.withPermit {
                            val d = ProxyCores.mihomoDelay(item.name)
                            _clashNodes.value = _clashNodes.value.map { if (it.name == item.name) it.copy(delay = d, tested = true) else it }
                        }
                    }
                }.awaitAll()
            }
        }
    }

    fun selectClash(name: String, connected: Boolean) {
        repo.updateSettings { it.copy(clashSelected = if (name == "AUTO") "" else name) }
        _clashNodes.value = _clashNodes.value.map { it.copy(current = it.name == name) }
        if (connected) viewModelScope.launch(Dispatchers.IO) {
            runCatching { ProxyCores.mihomoSelect(name) }
                .onSuccess { _message.value = "سرور «$name» انتخاب شد." }
                .onFailure { _message.value = "انتخاب سرور ناموفق بود: ${it.message}" }
        }
    }

    fun saveClashText(text: String, name: String = "") { addClashProfile(text, name.ifBlank { "متن چسبانده‌شده" }, null) }

    fun addWarp() {
        viewModelScope.launch {
            _busy.value = true
            try {
                val parsed = withContext(Dispatchers.IO) { Warp.register() }
                repo.addParsed(listOf(parsed), "Cloudflare WARP", null)
                _message.value = "WARP اضافه شد."
            } catch (t: Throwable) {
                _message.value = "خطا در ساخت WARP: ${t.message}"
            } finally {
                _busy.value = false
            }
        }
    }
}
