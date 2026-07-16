package ai.openclaw.app

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
class SecurePrefsTest {
  private fun testPrefs(context: android.app.Application): SecurePrefs =
    SecurePrefs(
      context,
      context.getSharedPreferences("secure-prefs-test-${UUID.randomUUID()}", Context.MODE_PRIVATE),
    )

  @Test
  fun backgroundSettingsResolutionRequiresBothPermissionLevels() {
    assertEquals(
      LocationMode.Always,
      locationModeAfterBackgroundSettings(LocationMode.Off, foregroundGranted = true, backgroundGranted = true),
    )
    assertEquals(
      LocationMode.Off,
      locationModeAfterBackgroundSettings(LocationMode.Off, foregroundGranted = true, backgroundGranted = false),
    )
    assertEquals(
      LocationMode.WhileUsing,
      locationModeAfterBackgroundSettings(LocationMode.Always, foregroundGranted = true, backgroundGranted = false),
    )
  }

  @Test
  fun loadLocationMode_enforcesFlavorAvailabilityForAlwaysValue() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putString("location.enabledMode", "always")
      .commit()

    val prefs = testPrefs(context)

    val expected =
      if (SensitiveFeatureConfig.backgroundLocationEnabled) LocationMode.Always else LocationMode.WhileUsing
    assertEquals(expected, prefs.locationMode.value)
    assertEquals(expected.rawValue, plainPrefs.getString("location.enabledMode", null))
  }

  @Test
  fun voiceMicEnabled_ignoresOldTalkEnabledKey() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putBoolean("talk.enabled", true)
      .commit()

    val prefs = testPrefs(context)

    assertFalse(prefs.voiceMicEnabled.value)
    assertFalse(plainPrefs.contains("voice.micEnabled"))
  }

  @Test
  fun setVoiceMicEnabled_persistsNewKeyOnly() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putBoolean("talk.enabled", false)
      .commit()
    val prefs = testPrefs(context)

    prefs.setVoiceMicEnabled(true)

    assertTrue(prefs.voiceMicEnabled.value)
    assertTrue(plainPrefs.getBoolean("voice.micEnabled", false))
    assertFalse(plainPrefs.getBoolean("talk.enabled", false))
  }

  @Test
  fun voiceWakeSettingsDefaultAndPersist() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    assertFalse(prefs.voiceWakeEnabled.value)
    assertEquals(listOf("openclaw", "claude", "computer"), prefs.voiceWakeWords.value)

    prefs.setVoiceWakeEnabled(true)
    prefs.setVoiceWakeWords(listOf(" hey claw ", "computer"))

    val restored = testPrefs(context)
    assertTrue(restored.voiceWakeEnabled.value)
    assertEquals(listOf("hey claw", "computer"), restored.voiceWakeWords.value)
  }

  @Test
  fun installedAppsSharing_defaultsOffAndPersistsDisclosureConsent() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    assertFalse(prefs.installedAppsSharingEnabled.value)

    prefs.grantInstalledAppsDisclosureConsent()

    assertTrue(prefs.installedAppsSharingEnabled.value)
    assertTrue(plainPrefs.getBoolean("device.apps.sharing.enabled", false))
    assertEquals(1, plainPrefs.getInt("device.apps.prominentDisclosure.consentVersion", 0))
    assertTrue(testPrefs(context).installedAppsSharingEnabled.value)
  }

  @Test
  fun installedAppsSharing_legacyOptInWithoutDisclosureRequiresReconsent() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putBoolean("device.apps.sharing.enabled", true)
      .commit()

    val prefs = testPrefs(context)

    assertFalse(prefs.installedAppsSharingEnabled.value)
    assertFalse(plainPrefs.getBoolean("device.apps.sharing.enabled", true))
    assertFalse(plainPrefs.contains("device.apps.prominentDisclosure.consentVersion"))
  }

  @Test
  fun installedAppsSharing_staleDisclosureVersionRequiresReconsent() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putBoolean("device.apps.sharing.enabled", true)
      .putInt("device.apps.prominentDisclosure.consentVersion", 0)
      .commit()

    val prefs = testPrefs(context)

    assertFalse(prefs.installedAppsSharingEnabled.value)
    assertFalse(plainPrefs.getBoolean("device.apps.sharing.enabled", true))
    assertFalse(plainPrefs.contains("device.apps.prominentDisclosure.consentVersion"))
  }

  @Test
  fun installedAppsSharing_futureDisclosureVersionRequiresReconsent() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putBoolean("device.apps.sharing.enabled", true)
      .putInt("device.apps.prominentDisclosure.consentVersion", 2)
      .commit()

    val prefs = testPrefs(context)

    assertFalse(prefs.installedAppsSharingEnabled.value)
    assertFalse(plainPrefs.getBoolean("device.apps.sharing.enabled", true))
    assertFalse(plainPrefs.contains("device.apps.prominentDisclosure.consentVersion"))
  }

  @Test
  fun installedAppsSharing_disablingRevokesConsent() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    prefs.grantInstalledAppsDisclosureConsent()
    prefs.revokeInstalledAppsDisclosureConsent()

    assertFalse(prefs.installedAppsSharingEnabled.value)
    assertFalse(plainPrefs.getBoolean("device.apps.sharing.enabled", true))
    assertFalse(plainPrefs.contains("device.apps.prominentDisclosure.consentVersion"))
  }

  @Test
  fun cameraSharing_defaultsOffAndPersistsOptIn() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    assertFalse(prefs.cameraEnabled.value)
    assertFalse(plainPrefs.getBoolean("camera.enabled", true))

    prefs.setCameraEnabled(true)

    assertTrue(prefs.cameraEnabled.value)
    assertTrue(plainPrefs.getBoolean("camera.enabled", false))
  }

  @Test
  fun cameraSharing_migratesExistingInstallsToPreviousDefault() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putString("node.instanceId", "existing-node")
      .commit()
    val prefs = testPrefs(context)

    assertTrue(prefs.cameraEnabled.value)
    assertTrue(plainPrefs.getBoolean("camera.enabled", false))
  }

  @Test
  fun appearanceThemeMode_defaultsDarkForExistingInstalls() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    assertEquals(AppearanceThemeMode.Dark, prefs.appearanceThemeMode.value)
    assertFalse(plainPrefs.contains("appearance.themeMode"))
  }

  @Test
  fun setAppearanceThemeMode_persistsSelectedMode() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val securePrefs = context.getSharedPreferences("secure-prefs-test-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(context, securePrefs)

    prefs.setAppearanceThemeMode(AppearanceThemeMode.Light)

    assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
    assertEquals("light", plainPrefs.getString("appearance.themeMode", null))
    assertEquals(AppearanceThemeMode.Light, SecurePrefs(context, securePrefs).appearanceThemeMode.value)
  }

  @Test
  fun gatewayCredentials_areIndependentAcrossGateways() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.saveGatewayCredentials("gateway-a", token = " shared-token ", bootstrapToken = "bootstrap-token")
    prefs.saveGatewayCredentials("gateway-b", password = "password-token")

    assertEquals(GatewayCredentials(token = "shared-token", bootstrapToken = "bootstrap-token"), prefs.loadGatewayCredentials("gateway-a"))
    assertEquals(GatewayCredentials(password = "password-token"), prefs.loadGatewayCredentials("gateway-b"))
  }

  @Test
  fun clearGatewayCredentials_removesOnlyTargetGateway() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test.clear", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.saveGatewayCredentials("gateway-a", token = "shared-token", bootstrapToken = "bootstrap-token")
    prefs.saveGatewayCredentials("gateway-b", password = "password-token")

    prefs.clearGatewayCredentials("gateway-a")

    assertEquals(GatewayCredentials(), prefs.loadGatewayCredentials("gateway-a"))
    assertEquals(GatewayCredentials(password = "password-token"), prefs.loadGatewayCredentials("gateway-b"))
  }

  @Test
  fun modelFavorites_togglePersistsPinOrder() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = SecurePrefs(context)

    prefs.toggleModelFavorite(" anthropic/claude-opus-4 ")
    prefs.toggleModelFavorite("openai/gpt-5")
    prefs.toggleModelFavorite("anthropic/claude-opus-4")
    prefs.toggleModelFavorite("anthropic/claude-opus-4")
    prefs.toggleModelFavorite("  ")

    assertEquals(
      listOf("openai/gpt-5", "anthropic/claude-opus-4"),
      prefs.modelFavorites.value,
    )
    assertEquals(prefs.modelFavorites.value, SecurePrefs(context).modelFavorites.value)
  }

  @Test
  fun modelRecents_dedupesToFrontAndCapsAtFive() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = SecurePrefs(context)

    (1..6).forEach { index -> prefs.recordModelRecent("provider/model-$index") }
    prefs.recordModelRecent(" provider/model-3 ")
    prefs.recordModelRecent(" ")

    assertEquals(
      listOf(
        "provider/model-3",
        "provider/model-6",
        "provider/model-5",
        "provider/model-4",
        "provider/model-2",
      ),
      prefs.modelRecents.value,
    )
    assertEquals(prefs.modelRecents.value, SecurePrefs(context).modelRecents.value)
  }

  @Test
  fun gatewayCustomHeaders_roundTripStaysScopedPerGateway() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test.headers", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    val stableId = "manual|gw.example.com|443"

    assertTrue(prefs.loadGatewayCustomHeaders(stableId).isEmpty())
    prefs.saveGatewayCustomHeaders(
      stableId,
      mapOf("CF-Access-Client-Id" to "client-id", "CF-Access-Client-Secret" to "client-secret"),
    )
    assertEquals(
      mapOf("CF-Access-Client-Id" to "client-id", "CF-Access-Client-Secret" to "client-secret"),
      prefs.loadGatewayCustomHeaders(stableId),
    )
    // Headers are per-gateway credentials; another endpoint never observes them.
    assertTrue(prefs.loadGatewayCustomHeaders("manual|other.example.com|443").isEmpty())

    prefs.saveGatewayCustomHeaders(stableId, emptyMap())
    assertTrue(prefs.loadGatewayCustomHeaders(stableId).isEmpty())
    assertFalse(securePrefs.contains("gateway.customHeaders.$stableId"))
  }

  @Test
  fun gatewayCustomHeaders_dropsReservedAndUnsafeEntries() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test.headers2", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    val stableId = "manual|gw.example.com|443"

    prefs.saveGatewayCustomHeaders(
      stableId,
      mapOf(
        "Host" to "smuggled.example",
        "Sec-WebSocket-Protocol" to "override",
        "X Bad" to "space",
        "X:Bad" to "colon",
        "X-Bad-é" to "unicode",
        "X-Split" to "a\r\nEvil: b",
        "X-Allowed" to "yes",
      ),
    )
    assertEquals(mapOf("X-Allowed" to "yes"), prefs.loadGatewayCustomHeaders(stableId))
  }

  @Test
  fun gatewayCustomHeaders_explicitClearRemovesOnlyCustomHeaderCredentials() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test.headers3", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    prefs.saveGatewayCustomHeaders("manual|one.example|443", mapOf("X-One" to "secret-one"))
    prefs.saveGatewayCustomHeaders("manual|two.example|443", mapOf("X-Two" to "secret-two"))
    prefs.putString("unrelated.secret", "keep")

    prefs.clearGatewayCustomHeaders("manual|one.example|443")

    assertTrue(prefs.loadGatewayCustomHeaders("manual|one.example|443").isEmpty())
    assertEquals(mapOf("X-Two" to "secret-two"), prefs.loadGatewayCustomHeaders("manual|two.example|443"))
    assertEquals("keep", prefs.getString("unrelated.secret"))
  }
}
