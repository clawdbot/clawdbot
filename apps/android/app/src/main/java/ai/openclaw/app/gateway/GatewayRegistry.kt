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
  val connectedStableIds: List<String>? = null,
  val entries: List<GatewayRegistryEntry> = emptyList(),
)

@Serializable
private data class PersistedGatewayRegistryVersion(
  val version: Int,
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
  private val initialRaw = prefs.getString(STORAGE_KEY)
  private val initialDecode = decode(initialRaw)
  private val initial = initialDecode.registry
  private val mutationsAllowed = initialRaw == null || initialDecode.canRewrite
  private val _entries = MutableStateFlow(initial.entries.sortedForStorage())
  val entries: StateFlow<List<GatewayRegistryEntry>> = _entries.asStateFlow()
  private val _activeStableId = MutableStateFlow(initial.activeStableId)
  val activeStableId: StateFlow<String?> = _activeStableId.asStateFlow()
  private val _connectedStableIds = MutableStateFlow(initial.connectedStableIds.orEmpty())
  val connectedStableIds: StateFlow<List<String>> = _connectedStableIds.asStateFlow()

  init {
    if (initialDecode.canRewrite && initialRaw != encodedRegistry()) persist()
  }

  fun upsert(entry: GatewayRegistryEntry): Unit =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized
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
      if (!mutationsAllowed) return@synchronized
      val normalized = stableId?.trim()?.takeIf { it.isNotEmpty() }
      require(normalized == null || _entries.value.any { it.stableId == normalized }) {
        "Active gateway must exist in the registry"
      }
      _activeStableId.value = normalized
      if (normalized != null && normalized !in _connectedStableIds.value) {
        _connectedStableIds.value = _connectedStableIds.value + normalized
      }
      persist()
      onActiveChanged?.invoke(normalized)
    }

  fun setConnectionEnabled(
    stableId: String,
    enabled: Boolean,
  ): Unit =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized
      val normalized = stableId.trim()
      require(_entries.value.any { it.stableId == normalized }) {
        "Connected gateway must exist in the registry"
      }
      _connectedStableIds.value =
        if (enabled) {
          (_connectedStableIds.value + normalized).distinct()
        } else {
          _connectedStableIds.value.filterNot { it == normalized }
        }
      persist()
    }

  fun connectedEntries(): List<GatewayRegistryEntry> =
    synchronized(mutationLock) {
      _connectedStableIds.value.mapNotNull { connectedId ->
        _entries.value.firstOrNull { it.stableId == connectedId }
      }
    }

  fun markConnected(
    stableId: String,
    atMs: Long,
  ): Unit =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized
      val existing = _entries.value.firstOrNull { it.stableId == stableId } ?: return
      upsert(existing.copy(lastConnectedAtMs = atMs))
    }

  fun remove(stableId: String): Boolean =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized false
      val normalized = stableId.trim()
      val nextEntries = _entries.value.filterNot { it.stableId == normalized }
      val previousActiveStableId = _activeStableId.value
      val nextActiveStableId = previousActiveStableId?.takeUnless { it == normalized }
      val nextConnectedStableIds = _connectedStableIds.value.filterNot { it == normalized }
      if (!persistSynchronously(nextEntries, nextActiveStableId, nextConnectedStableIds)) return@synchronized false

      // Publish only after the durable commit. Notification is post-commit and cannot turn a
      // successful removal into a failure that would cancel the database recovery marker.
      _entries.value = nextEntries
      _activeStableId.value = nextActiveStableId
      _connectedStableIds.value = nextConnectedStableIds
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

  internal fun storedActiveStableId(): String? = decode(prefs.getString(STORAGE_KEY)).registry.activeStableId

  private fun persist() {
    if (!mutationsAllowed) return
    prefs.putString(STORAGE_KEY, encodedRegistry())
  }

  private fun persistSynchronously(
    entries: List<GatewayRegistryEntry>,
    activeStableId: String?,
    connectedStableIds: List<String>,
  ): Boolean =
    mutationsAllowed &&
      prefs.putStringSynchronously(
        STORAGE_KEY,
        encodedRegistry(entries, activeStableId, connectedStableIds),
      )

  private fun encodedRegistry(
    entries: List<GatewayRegistryEntry> = _entries.value,
    activeStableId: String? = _activeStableId.value,
    connectedStableIds: List<String> = _connectedStableIds.value,
  ): String =
    json.encodeToString(
      PersistedGatewayRegistry(
        activeStableId = activeStableId,
        connectedStableIds =
          connectedStableIds
            .distinct()
            .filter { connectedId -> entries.any { it.stableId == connectedId } },
        entries = entries.sortedForStorage(),
      ),
    )

  private data class DecodedRegistry(
    val registry: PersistedGatewayRegistry,
    val canRewrite: Boolean,
  )

  private fun decode(rawValue: String?): DecodedRegistry {
    val raw = rawValue ?: return DecodedRegistry(PersistedGatewayRegistry(), canRewrite = false)
    val version =
      runCatching { json.decodeFromString<PersistedGatewayRegistryVersion>(raw) }
        .getOrNull()
        ?.version
        ?.takeIf { it in 1..2 }
        ?: return DecodedRegistry(PersistedGatewayRegistry(), canRewrite = false)
    val decoded =
      runCatching { json.decodeFromString<PersistedGatewayRegistry>(raw) }.getOrNull()
        ?: return DecodedRegistry(PersistedGatewayRegistry(), canRewrite = false)
    val entries = decoded.entries.sortedForStorage()
    val active = decoded.activeStableId?.takeIf { activeId -> entries.any { it.stableId == activeId } }
    val connected =
      (decoded.connectedStableIds ?: if (version == 1) listOfNotNull(active) else emptyList())
        .distinct()
        .filter { connectedId -> entries.any { it.stableId == connectedId } }
    return DecodedRegistry(
      registry =
        PersistedGatewayRegistry(
          version = 1,
          activeStableId = active,
          connectedStableIds = connected,
          entries = entries,
        ),
      canRewrite = true,
    )
  }
}

internal fun List<GatewayRegistryEntry>.sortedForStorage(): List<GatewayRegistryEntry> = sortedWith(compareBy<GatewayRegistryEntry>({ it.name.lowercase() }, { it.stableId }))
