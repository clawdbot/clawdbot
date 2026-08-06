package ai.openclaw.app.gateway

import ai.openclaw.app.GatewayCredentials
import ai.openclaw.app.SecurePrefs
import android.content.Context
import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class GatewayStoreMigrationTest {
  @Test
  fun manualStateMigratesCredentialsDeviceTokensAndNotificationKey() {
    val fixture = fixture()
    fixture.plain
      .edit()
      .putString("node.instanceId", "install-1")
      .putBoolean("gateway.manual.enabled", true)
      .putString("gateway.manual.host", "Example.COM")
      .putInt("gateway.manual.port", 18789)
      .putBoolean("gateway.manual.tls", false)
      .putString("notifications.forwarding.sessionKey", " notify-main ")
      .commit()
    fixture.secure
      .edit()
      .putString("gateway.manual.token", "manual-token")
      .putString("gateway.token.install-1", "fallback-token")
      .putString("gateway.bootstrapToken.install-1", "bootstrap-token")
      .putString("gateway.password.install-1", "password")
      .putString("gateway.deviceToken.device-1.operator", "device-token")
      .putString("gateway.deviceTokenMeta.device-1.operator", "{\"scopes\":[\"operator.read\"]}")
      .commit()

    val prefs = SecurePrefs(fixture.context, fixture.secure)
    val stableId = GatewayEndpoint.manual("Example.COM", 18789).stableId

    assertEquals(stableId, prefs.gatewayRegistry.activeStableId.value)
    assertEquals(GatewayRegistryEntryKind.MANUAL, prefs.gatewayRegistry.activeEntry()?.kind)
    assertEquals("Example.COM:18789", prefs.gatewayRegistry.activeEntry()?.name)
    assertEquals(false, prefs.gatewayRegistry.activeEntry()?.tls)
    assertEquals(
      GatewayCredentials("manual-token", "bootstrap-token", "password"),
      prefs.loadGatewayCredentials(stableId),
    )
    assertEquals("device-token", fixture.secure.getString("gateway.deviceToken.$stableId.device-1.operator", null))
    assertTrue(fixture.secure.contains("gateway.deviceTokenMeta.$stableId.device-1.operator"))
    assertFalse(fixture.secure.contains("gateway.manual.token"))
    assertFalse(fixture.secure.contains("gateway.token.install-1"))
    assertFalse(fixture.secure.contains("gateway.bootstrapToken.install-1"))
    assertFalse(fixture.secure.contains("gateway.password.install-1"))
    assertFalse(fixture.plain.contains("notifications.forwarding.sessionKey"))
    assertEquals("notify-main", fixture.plain.getString("notifications.forwarding.sessionKey.$stableId", null))
    assertTrue(fixture.plain.getBoolean("gateway.manual.enabled", false))
  }

  @Test
  fun discoveredOnlyStateBecomesActivePlaceholderEntry() {
    val fixture = fixture()
    fixture.plain
      .edit()
      .putString("gateway.lastDiscoveredStableID", "bonjour-gateway")
      .commit()

    val prefs = SecurePrefs(fixture.context, fixture.secure)

    assertEquals("bonjour-gateway", prefs.gatewayRegistry.activeStableId.value)
    assertEquals(
      GatewayRegistryEntry(
        stableId = "bonjour-gateway",
        kind = GatewayRegistryEntryKind.DISCOVERED,
        name = "bonjour-gateway",
      ),
      prefs.gatewayRegistry.activeEntry(),
    )
  }

  @Test
  fun blankManualTokenFallsBackToInstanceScopedToken() {
    val fixture = fixture()
    fixture.plain
      .edit()
      .putString("node.instanceId", "install-1")
      .putBoolean("gateway.manual.enabled", true)
      .putString("gateway.manual.host", "gateway.example")
      .putInt("gateway.manual.port", 18789)
      .commit()
    fixture.secure
      .edit()
      .putString("gateway.manual.token", "  ")
      .putString("gateway.token.install-1", "fallback-token")
      .commit()

    val prefs = SecurePrefs(fixture.context, fixture.secure)
    val stableId = GatewayEndpoint.manual("gateway.example", 18789).stableId

    assertEquals("fallback-token", prefs.loadGatewayCredentials(stableId).token)
    assertFalse(fixture.secure.contains("gateway.manual.token"))
    assertFalse(fixture.secure.contains("gateway.token.install-1"))
  }

  @Test
  fun emptyLegacyStateWritesEmptyRegistryAndDeletesOwnerlessDeviceTokens() {
    val fixture = fixture()
    fixture.secure
      .edit()
      .putString("gateway.deviceToken.device-1.node", "orphan")
      .putString("gateway.deviceTokenMeta.device-1.node", "{}")
      .commit()

    val prefs = SecurePrefs(fixture.context, fixture.secure)

    // Migration runs on first gateway-state access, not at construction.
    assertTrue(
      prefs.gatewayRegistry.entries.value
        .isEmpty(),
    )
    assertTrue(fixture.secure.contains(GatewayRegistryStore.STORAGE_KEY))
    assertNull(prefs.gatewayRegistry.activeStableId.value)
    assertFalse(fixture.secure.contains("gateway.deviceToken.device-1.node"))
    assertFalse(fixture.secure.contains("gateway.deviceTokenMeta.device-1.node"))
  }

  @Test
  fun secondMigrationRunIsNoOp() {
    val fixture = fixture()
    fixture.plain
      .edit()
      .putBoolean("gateway.manual.enabled", true)
      .putString("gateway.manual.host", "first.example")
      .putInt("gateway.manual.port", 18789)
      .commit()
    val prefs = SecurePrefs(fixture.context, fixture.secure)
    // First gateway-state access performs the one-time migration.
    prefs.gatewayRegistry.activeStableId.value
    val registryBefore = fixture.secure.getString(GatewayRegistryStore.STORAGE_KEY, null)
    fixture.plain
      .edit()
      .putString("gateway.manual.host", "changed.example")
      .commit()
    fixture.secure
      .edit()
      .putString("gateway.manual.token", "late-legacy-token")
      .commit()

    GatewayStoreMigration(prefs).run()

    assertEquals(registryBefore, fixture.secure.getString(GatewayRegistryStore.STORAGE_KEY, null))
    assertEquals("late-legacy-token", fixture.secure.getString("gateway.manual.token", null))
  }

  private fun fixture(): Fixture {
    val context = RuntimeEnvironment.getApplication()
    val plain = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plain.edit().clear().commit()
    val secure = context.getSharedPreferences("gateway-migration-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    secure.edit().clear().commit()
    return Fixture(context, plain, secure)
  }

  private data class Fixture(
    val context: android.app.Application,
    val plain: SharedPreferences,
    val secure: SharedPreferences,
  )
}
