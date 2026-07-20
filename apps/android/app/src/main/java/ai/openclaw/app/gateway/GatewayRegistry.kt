package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
enum class GatewayRegistryEntryKind {
  @SerialName("manual")
  MANUAL,

  @SerialName("discovered")
  DISCOVERED,
}

@Serializable
data class GatewayRegistryEntry(
  val stableId: String,
  val kind: GatewayRegistryEntryKind,
  val name: String,
  val host: String? = null,
  val port: Int? = null,
  val tls: Boolean = true,
  val lastConnectedAtMs: Long = 0L,
)

@Serializable
internal data class PersistedGatewayRegistry(
  val version: Int = 1,
  val activeStableId: String? = null,
  val entries: List<GatewayRegistryEntry> = emptyList(),
)

class GatewayRegistryStore(
  private val prefs: SecurePrefs,
  private val onActiveChanged: ((String?) -> Unit)? = null,
) {
  companion object {
    internal const val STORAGE_KEY = "gateway.registry"
  }

  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
  private val mutationLock = Any()
  private val initial = decode(prefs.getString(STORAGE_KEY))
  private val _entries = MutableStateFlow(initial.entries.sortedForStorage())
  val entries: StateFlow<List<GatewayRegistryEntry>> = _entries.asStateFlow()
  private val _activeStableId = MutableStateFlow(initial.activeStableId)
  val activeStableId: StateFlow<String?> = _activeStableId.asStateFlow()

  fun upsert(entry: GatewayRegistryEntry): Unit =
    synchronized(mutationLock) {
      val stableId = entry.stableId.trim()
      require(stableId.isNotEmpty()) { "Gateway stable id cannot be empty" }
      val existing = _entries.value.firstOrNull { it.stableId == stableId }
      val normalized =
        entry.copy(
          stableId = stableId,
          name = entry.name.trim().ifEmpty { stableId },
          host = entry.host?.trim()?.takeIf { it.isNotEmpty() },
          lastConnectedAtMs =
            if (entry.lastConnectedAtMs == 0L) {
              existing?.lastConnectedAtMs ?: 0L
            } else {
              entry.lastConnectedAtMs
            },
        )
      _entries.value = (_entries.value.filterNot { it.stableId == stableId } + normalized).sortedForStorage()
      persist()
    }

  fun setActive(stableId: String?): Unit =
    synchronized(mutationLock) {
      val normalized = stableId?.trim()?.takeIf { it.isNotEmpty() }
      require(normalized == null || _entries.value.any { it.stableId == normalized }) {
        "Active gateway must exist in the registry"
      }
      _activeStableId.value = normalized
      persist()
      onActiveChanged?.invoke(normalized)
    }

  fun markConnected(
    stableId: String,
    atMs: Long,
  ): Unit =
    synchronized(mutationLock) {
      val existing = _entries.value.firstOrNull { it.stableId == stableId } ?: return
      upsert(existing.copy(lastConnectedAtMs = atMs))
    }

  fun remove(stableId: String): Boolean =
    synchronized(mutationLock) {
      val normalized = stableId.trim()
      val nextEntries = _entries.value.filterNot { it.stableId == normalized }
      val previousActiveStableId = _activeStableId.value
      val nextActiveStableId = previousActiveStableId?.takeUnless { it == normalized }
      if (!persistSynchronously(nextEntries, nextActiveStableId)) return@synchronized false

      // Publish only after the durable commit. Notification is post-commit and cannot turn a
      // successful removal into a failure that would cancel the database recovery marker.
      _entries.value = nextEntries
      _activeStableId.value = nextActiveStableId
      if (previousActiveStableId != nextActiveStableId) {
        runCatching { onActiveChanged?.invoke(nextActiveStableId) }
          .onFailure { Log.e("GatewayRegistry", "Active-gateway observer failed after durable removal", it) }
      }
      true
    }

  fun activeEntry(): GatewayRegistryEntry? =
    synchronized(mutationLock) {
      val activeId = _activeStableId.value ?: return@synchronized null
      _entries.value.firstOrNull { it.stableId == activeId }
    }

  internal fun storedActiveStableId(): String? = decode(prefs.getString(STORAGE_KEY)).activeStableId

  private fun persist() {
    prefs.putString(STORAGE_KEY, encodedRegistry())
  }

  private fun persistSynchronously(
    entries: List<GatewayRegistryEntry>,
    activeStableId: String?,
  ): Boolean = prefs.putStringSynchronously(STORAGE_KEY, encodedRegistry(entries, activeStableId))

  private fun encodedRegistry(
    entries: List<GatewayRegistryEntry> = _entries.value,
    activeStableId: String? = _activeStableId.value,
  ): String =
    json.encodeToString(
      PersistedGatewayRegistry(
        activeStableId = activeStableId,
        entries = entries.sortedForStorage(),
      ),
    )

  private fun decode(raw: String?): PersistedGatewayRegistry =
    raw
      ?.let { runCatching { json.decodeFromString<PersistedGatewayRegistry>(it) }.getOrNull() }
      ?.takeIf { it.version == 1 }
      ?: PersistedGatewayRegistry()
}

internal fun List<GatewayRegistryEntry>.sortedForStorage(): List<GatewayRegistryEntry> = sortedWith(compareBy<GatewayRegistryEntry>({ it.name.lowercase() }, { it.stableId }))
