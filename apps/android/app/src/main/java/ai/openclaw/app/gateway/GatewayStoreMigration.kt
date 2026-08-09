package ai.openclaw.app.gateway

import ai.openclaw.app.GatewayCredentials
import ai.openclaw.app.SecurePrefs
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

internal class GatewayStoreMigration(
  private val prefs: SecurePrefs,
) {
  private val json = Json { encodeDefaults = true }

  fun run() {
    if (prefs.containsSecureKey(GatewayRegistryStore.STORAGE_KEY)) return

    val activeEntry = legacyActiveEntry()
    migrateCredentials(activeEntry?.stableId)
    migrateDeviceTokens(activeEntry?.stableId)
    migrateNotificationSessionKey(activeEntry?.stableId)
    prefs.putString(
      GatewayRegistryStore.STORAGE_KEY,
      json.encodeToString(
        PersistedGatewayRegistry(
          activeStableId = activeEntry?.stableId,
          connectedStableIds = listOfNotNull(activeEntry?.stableId),
          entries = listOfNotNull(activeEntry),
        ),
      ),
    )
  }

  private fun legacyActiveEntry(): GatewayRegistryEntry? {
    if (prefs.getPlainBoolean("gateway.manual.enabled", false)) {
      val host = prefs.getPlainString("gateway.manual.host").orEmpty().trim()
      val port = prefs.getPlainInt("gateway.manual.port", 18789)
      if (host.isNotEmpty() && port in 1..65535) {
        val endpoint = GatewayEndpoint.manual(host, port)
        return GatewayRegistryEntry(
          stableId = endpoint.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = "$host:$port",
          host = host,
          port = port,
          tls = prefs.getPlainBoolean("gateway.manual.tls", true),
        )
      }
    }

    val stableId = prefs.getPlainString("gateway.lastDiscoveredStableID").orEmpty().trim()
    return stableId
      .takeIf { it.isNotEmpty() }
      ?.let {
        GatewayRegistryEntry(
          stableId = it,
          kind = GatewayRegistryEntryKind.DISCOVERED,
          name = it,
        )
      }
  }

  private fun migrateCredentials(activeStableId: String?) {
    val instanceId = prefs.instanceId.value
    val legacyKeys =
      listOf(
        "gateway.manual.token",
        "gateway.token.$instanceId",
        "gateway.bootstrapToken.$instanceId",
        "gateway.password.$instanceId",
      )
    if (activeStableId != null) {
      val legacyToken =
        sequenceOf(prefs.getString(legacyKeys[0]), prefs.getString(legacyKeys[1]))
          .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
          .firstOrNull()
      val credentials =
        GatewayCredentials(
          token = legacyToken,
          bootstrapToken = prefs.getString(legacyKeys[2]),
          password = prefs.getString(legacyKeys[3]),
        ).normalized()
      if (credentials != GatewayCredentials()) {
        prefs.saveGatewayCredentials(activeStableId, credentials)
      }
    }
    prefs.removeSecureKeys(legacyKeys)
  }

  private fun migrateDeviceTokens(activeStableId: String?) {
    val legacyPrefixes = listOf("gateway.deviceToken.", "gateway.deviceTokenMeta.")
    val keys = prefs.secureKeys()
    for (key in keys) {
      val prefix = legacyPrefixes.firstOrNull(key::startsWith) ?: continue
      val suffix = key.removePrefix(prefix)
      if (suffix.split('.').size != 2) continue
      prefs.moveSecureString(key, activeStableId?.let { "$prefix$it.$suffix" })
    }
  }

  private fun migrateNotificationSessionKey(activeStableId: String?) {
    val legacyKey = "notifications.forwarding.sessionKey"
    prefs.movePlainString(legacyKey, activeStableId?.let { "$legacyKey.$it" })
  }
}
