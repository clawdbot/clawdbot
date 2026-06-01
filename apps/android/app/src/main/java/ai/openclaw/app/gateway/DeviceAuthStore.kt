package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Stored gateway device-token material scoped by device id and role. */
data class DeviceAuthEntry(
  val token: String,
  val role: String,
  val scopes: List<String>,
  val updatedAtMs: Long,
)

@Serializable
private data class PersistedDeviceAuthMetadata(
  val scopes: List<String> = emptyList(),
  val updatedAtMs: Long = 0L,
)

/** Persistence interface used by gateway pairing/session code for role tokens. */
interface DeviceAuthTokenStore {
  /** Loads the stored token plus metadata for one device/role pair. */
  fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry?

  /** Loads only the bearer token when callers do not need scope metadata. */
  fun loadToken(
    deviceId: String,
    role: String,
  ): String? = loadEntry(deviceId, role)?.token

  /** Persists a role token and deterministic scope metadata under normalized keys. */
  fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String> = emptyList(),
  )

  /** Removes both token and metadata for the normalized device/role pair. */
  fun clearToken(
    deviceId: String,
    role: String,
  )
}

/** SecurePrefs-backed implementation of Android gateway device-token storage. */
class DeviceAuthStore(
  private val prefs: SecurePrefs,
) : DeviceAuthTokenStore {
  private val json = Json { ignoreUnknownKeys = true }

  override fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? {
    val key = tokenKey(deviceId, role)
    val token = prefs.getString(key)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val normalizedRole = normalizeRole(role)
    val metadata =
      prefs
        .getString(metadataKey(deviceId, role))
        ?.let { raw ->
          runCatching { json.decodeFromString<PersistedDeviceAuthMetadata>(raw) }.getOrNull()
        }
    return DeviceAuthEntry(
      token = token,
      role = normalizedRole,
      scopes = metadata?.scopes ?: emptyList(),
      updatedAtMs = metadata?.updatedAtMs ?: 0L,
    )
  }

  override fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) {
    val normalizedScopes = normalizeScopes(scopes)
    val key = tokenKey(deviceId, role)
    prefs.putString(key, token.trim())
    prefs.putString(
      metadataKey(deviceId, role),
      json.encodeToString(
        PersistedDeviceAuthMetadata(
          scopes = normalizedScopes,
          updatedAtMs = System.currentTimeMillis(),
        ),
      ),
    )
  }

  override fun clearToken(
    deviceId: String,
    role: String,
  ) {
    val key = tokenKey(deviceId, role)
    prefs.remove(key)
    prefs.remove(metadataKey(deviceId, role))
  }

  private fun tokenKey(
    deviceId: String,
    role: String,
  ): String {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    // Keep key normalization shared with metadata keys so token and metadata
    // are added/removed as one logical auth entry.
    return "gateway.deviceToken.$normalizedDevice.$normalizedRole"
  }

  private fun metadataKey(
    deviceId: String,
    role: String,
  ): String {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    return "gateway.deviceTokenMeta.$normalizedDevice.$normalizedRole"
  }

  /** Normalizes device ids before they become encrypted preference key segments. */
  private fun normalizeDeviceId(deviceId: String): String = deviceId.trim().lowercase()

  /** Normalizes role names so node/operator token slots are stable across callers. */
  private fun normalizeRole(role: String): String = role.trim().lowercase()

  /** Stores scopes in deterministic order for display and restart comparisons. */
  private fun normalizeScopes(scopes: List<String>): List<String> =
    scopes
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      // Persist deterministic scope lists because they are displayed and may be
      // compared across process restarts.
      .distinct()
      .sorted()
}
