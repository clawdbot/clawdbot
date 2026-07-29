package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class SecurePrefsNotificationForwardingTest {
  private fun testPrefs(context: android.app.Application): SecurePrefs =
    SecurePrefs(
      context,
      context.getSharedPreferences("notification-prefs-${UUID.randomUUID()}", Context.MODE_PRIVATE),
    )

  @Test
  fun setNotificationForwardingQuietHours_rejectsInvalidDraftsWithoutMutatingStoredValues() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = testPrefs(context)

    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = false,
        start = "22:00",
        end = "07:00",
      ),
    )

    val originalStart = prefs.notificationForwardingQuietStart.value
    val originalEnd = prefs.notificationForwardingQuietEnd.value
    val originalEnabled = prefs.notificationForwardingQuietHoursEnabled.value

    assertFalse(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "7:00",
        end = "07:00",
      ),
    )

    assertEquals(originalStart, prefs.notificationForwardingQuietStart.value)
    assertEquals(originalEnd, prefs.notificationForwardingQuietEnd.value)
    assertEquals(originalEnabled, prefs.notificationForwardingQuietHoursEnabled.value)
  }

  @Test
  fun setNotificationForwardingQuietHours_persistsValidDraftsAndEnabledState() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = testPrefs(context)

    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "22:30",
        end = "06:45",
      ),
    )

    assertTrue(prefs.notificationForwardingQuietHoursEnabled.value)
    assertEquals("22:30", prefs.notificationForwardingQuietStart.value)
    assertEquals("06:45", prefs.notificationForwardingQuietEnd.value)
  }

  @Test
  fun setNotificationForwardingQuietHours_disablesWithoutRevalidatingDrafts() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = testPrefs(context)
    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "22:30",
        end = "06:45",
      ),
    )

    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = false,
        start = "7:00",
        end = "06:45",
      ),
    )

    assertFalse(prefs.notificationForwardingQuietHoursEnabled.value)
    assertEquals("22:30", prefs.notificationForwardingQuietStart.value)
    assertEquals("06:45", prefs.notificationForwardingQuietEnd.value)
  }

  @Test
  fun getNotificationForwardingPolicy_readsLatestQuietHoursImmediately() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = testPrefs(context)
    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "21:15",
        end = "06:10",
      ),
    )

    val policy = prefs.getNotificationForwardingPolicy(appPackageName = "ai.openclaw.app")

    assertTrue(policy.quietHoursEnabled)
    assertEquals("21:15", policy.quietStart)
    assertEquals("06:10", policy.quietEnd)
  }

  @Test
  fun notificationForwarding_defaultsDisabledForSaferPosture() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = testPrefs(context)
    val policy = prefs.getNotificationForwardingPolicy(appPackageName = "ai.openclaw.app")

    assertFalse(prefs.notificationForwardingEnabled.value)
    assertFalse(policy.enabled)
    assertEquals(NotificationPackageFilterMode.Blocklist, policy.mode)
  }

  @Test
  fun getNotificationForwardingPolicy_blocksOwnedPackagesInAllowlistMode() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = testPrefs(context)
    prefs.setNotificationForwardingMode(NotificationPackageFilterMode.Allowlist)
    prefs.setNotificationForwardingPackages(listOf("ai.openclaw.app", "com.whatsapp", "com.other.app"))

    val policy = prefs.getNotificationForwardingPolicy(appPackageName = "ai.openclaw.app")

    assertFalse(policy.allowsPackage("ai.openclaw.app"))
    assertFalse(policy.allowsPackage("com.whatsapp"))
    assertTrue(policy.allowsPackage("com.other.app"))
  }

  @Test
  fun notificationSessionKeyFollowsActiveGateway() {
    val context = RuntimeEnvironment.getApplication()
    context
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    val secure = context.getSharedPreferences("notification-gateways-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(context, secure)
    val gatewayA = GatewayEndpoint.manual("a.example", 18789)
    val gatewayB = GatewayEndpoint.manual("b.example", 18789)
    listOf(gatewayA, gatewayB).forEach { endpoint ->
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(
          stableId = endpoint.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = endpoint.name,
          host = endpoint.host,
          port = endpoint.port,
        ),
      )
    }

    prefs.gatewayRegistry.setActive(gatewayA.stableId)
    prefs.setNotificationForwardingSessionKey("session-a")
    prefs.gatewayRegistry.setActive(gatewayB.stableId)
    prefs.setNotificationForwardingSessionKey("session-b")

    prefs.gatewayRegistry.setActive(gatewayA.stableId)
    assertEquals("session-a", prefs.getNotificationForwardingPolicy("ai.openclaw.app").sessionKey)
    prefs.gatewayRegistry.setActive(gatewayB.stableId)
    assertEquals("session-b", prefs.getNotificationForwardingPolicy("ai.openclaw.app").sessionKey)
  }
}
