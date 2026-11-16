package app.gozarvpn.android.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

/**
 * Small JSON-file store; the whole app state is tiny (hundreds of configs).
 * One instance per process ([get]): separate copies would overwrite each other's saves.
 */
class Repo private constructor(context: Context) {
    private val file = File(context.filesDir, "state.json")
    private val backup = File(context.filesDir, "state.json.bak")
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }

    private val _state = MutableStateFlow(load())
    val state: StateFlow<AppState> = _state

    /** Falls back to the last good copy instead of silently starting empty (that lost profiles). */
    private fun load(): AppState {
        for (f in listOf(file, backup)) {
            if (!f.exists()) continue
            try {
                return json.decodeFromString(AppState.serializer(), f.readText())
            } catch (e: Exception) {
                LogBuffer.add("خواندن ${f.name} ناموفق بود: ${e.message?.take(160)}")
            }
        }
        return AppState()
    }

    @Synchronized
    private fun update(block: (AppState) -> AppState) {
        val next = block(_state.value)
        _state.value = next
        // write-then-rename: a kill mid-write (app swiped away) can't leave a truncated state.json
        val tmp = File(file.parentFile, "state.json.tmp")
        tmp.writeText(json.encodeToString(AppState.serializer(), next))
        if (file.exists()) file.copyTo(backup, overwrite = true)
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    companion object {
        @Volatile private var instance: Repo? = null
        fun get(context: Context): Repo = instance ?: synchronized(this) {
            instance ?: Repo(context.applicationContext).also { instance = it }
        }
    }

    fun addParsed(parsed: List<LinkParser.Parsed>, groupName: String, sourceUrl: String?): Int {
        if (parsed.isEmpty()) return 0
        val group = Group(id = UUID.randomUUID().toString(), name = groupName, sourceUrl = sourceUrl)
        val entries = parsed.map {
            ConfigEntry(
                id = UUID.randomUUID().toString(),
                name = it.remark,
                protocol = it.protocol,
                groupId = group.id,
                kind = it.kind,
                json = it.json,
            )
        }
        update { s ->
            s.copy(
                groups = listOf(group) + s.groups,
                configs = s.configs + entries,
                activeId = s.activeId ?: entries.first().id,
            )
        }
        return entries.size
    }

    /** Re-import a subscription group: new list replaces the old one, keeping favorites and the active pick by name. */
    fun replaceGroup(groupId: String, parsed: List<LinkParser.Parsed>): Int {
        if (parsed.isEmpty()) return 0
        update { s ->
            val old = s.configs.filter { it.groupId == groupId }
            val favNames = old.filter { it.favorite }.map { it.name }.toSet()
            val activeName = old.firstOrNull { it.id == s.activeId }?.name
            val fresh = parsed.map {
                ConfigEntry(id = UUID.randomUUID().toString(), name = it.remark, protocol = it.protocol,
                    groupId = groupId, kind = it.kind, json = it.json, favorite = it.remark in favNames)
            }
            val gone = old.map { it.id }.toSet()
            s.copy(
                configs = s.configs.filterNot { it.groupId == groupId } + fresh,
                results = s.results - gone,
                activeId = if (s.activeId in gone) fresh.firstOrNull { it.name == activeName }?.id else s.activeId,
            )
        }
        return parsed.size
    }

    fun toggleFavorite(id: String) = update { s ->
        s.copy(configs = s.configs.map { if (it.id == id) it.copy(favorite = !it.favorite) else it })
    }

    fun setActive(id: String) = update { it.copy(activeId = id) }

    fun deleteConfig(id: String) = update { s ->
        s.copy(
            configs = s.configs.filterNot { it.id == id },
            results = s.results - id,
            activeId = if (s.activeId == id) null else s.activeId,
        )
    }

    fun deleteGroup(groupId: String) = update { s ->
        val gone = s.configs.filter { it.groupId == groupId }.map { it.id }.toSet()
        s.copy(
            groups = s.groups.filterNot { it.id == groupId },
            configs = s.configs.filterNot { it.id in gone },
            results = s.results - gone,
            activeId = if (s.activeId in gone) null else s.activeId,
        )
    }

    fun renameGroup(groupId: String, name: String) = update { s ->
        s.copy(groups = s.groups.map { if (it.id == groupId) it.copy(name = name) else it })
    }

    fun saveResult(id: String, result: TestResult) = update { it.copy(results = it.results + (id to result)) }

    /** null = back to automatic. */
    fun setDpiManual(id: String, profile: String?) = update {
        it.copy(dpiManual = if (profile == null) it.dpiManual - id else it.dpiManual + (id to profile))
    }

    fun setDpiLearned(id: String, profile: String) = update { it.copy(dpiLearned = it.dpiLearned + (id to profile)) }

    fun updateSettings(block: (Settings) -> Settings) = update { it.copy(settings = block(it.settings)) }

    fun activeConfig(): ConfigEntry? = _state.value.let { s -> s.configs.firstOrNull { it.id == s.activeId } }
}
