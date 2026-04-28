package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

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

interface DeviceAuthTokenStore {
  fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry?

  fun loadToken(
    deviceId: String,
    role: String,
  ): String? = loadEntry(deviceId, role)?.token

  fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String> = emptyList(),
  )

  fun clearToken(
    deviceId: String,
    role: String,
  )
}

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

  private fun normalizeDeviceId(deviceId: String): String = deviceId.trim().lowercase()

  private fun normalizeRole(role: String): String = role.trim().lowercase()

  private fun normalizeScopes(scopes: List<String>): List<String> =
    scopes
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .distinct()
      .sorted()
}
