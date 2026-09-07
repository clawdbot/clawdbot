package ai.openclaw.app.gateway

import ai.openclaw.app.GatewayCredentials
import ai.openclaw.app.SecurePrefs
import android.content.Context
import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceAuthStoreTest {
  @Test
  fun saveTokenPersistsNormalizedScopesMetadata() {
    val (prefs) = createPrefs()
    val store = DeviceAuthStore(prefs)

    assertTrue(
      store.saveToken(
        gatewayId = "gateway-a",
        deviceId = " Device-1 ",
        role = " Operator ",
        token = " operator-token ",
        scopes = listOf("operator.write", "operator.read", "operator.write", " "),
      ),
    )

    val entry = store.loadEntry("gateway-a", "device-1", "operator")
    assertNotNull(entry)
    assertEquals("operator-token", entry?.token)
    assertEquals("operator", entry?.role)
    assertEquals(listOf("operator.read", "operator.write"), entry?.scopes)
    assertTrue((entry?.updatedAtMs ?: 0L) > 0L)
  }

  @Test
  fun tokenDerivedMutationsRequireTheCurrentStoredToken() {
    val (prefs) = createPrefs()
    val store = DeviceAuthStore(prefs)

    for (expectedToken in listOf("old", " ")) {
      assertFalse(store.saveToken("gateway-a", "device-1", "operator", "stale", replacesStoredToken = expectedToken))
      assertNull(store.loadEntry("gateway-a", "device-1", "operator"))
    }

    assertTrue(store.saveToken("gateway-a", "device-1", "operator", " old ", listOf("operator.read")))
    assertTrue(
      store.saveToken("gateway-a", "device-1", "operator", "new", listOf("operator.write"), replacesStoredToken = " old "),
    )
    val freshEntry = store.loadEntry("gateway-a", "device-1", "operator")
    assertEquals("new", freshEntry?.token)
    assertEquals("operator", freshEntry?.role)
    assertEquals(listOf("operator.write"), freshEntry?.scopes)
    assertTrue((freshEntry?.updatedAtMs ?: 0L) > 0L)

    assertFalse(
      store.saveToken("gateway-a", "device-1", "operator", "stale", listOf("operator.admin"), replacesStoredToken = "old"),
    )
    assertEquals(freshEntry, store.loadEntry("gateway-a", "device-1", "operator"))
    store.clearToken("gateway-a", "device-1", "operator", onlyIfToken = "old")
    assertEquals(freshEntry, store.loadEntry("gateway-a", "device-1", "operator"))
    store.clearToken("gateway-a", "device-1", "operator", onlyIfToken = " new ")
    assertNull(store.loadEntry("gateway-a", "device-1", "operator"))
  }

  @Test
  fun gatewayIdsIsolateSameDeviceAndRole() {
    val (prefs) = createPrefs()
    val store = DeviceAuthStore(prefs)
    store.saveToken("gateway-a", "device-1", "operator", "token-a")
    store.saveToken("gateway-b", "device-1", "operator", "token-b")

    assertEquals("token-a", store.loadToken("gateway-a", "device-1", "operator"))
    assertEquals("token-b", store.loadToken("gateway-b", "device-1", "operator"))

    store.clearToken("gateway-a", "device-1", "operator")

    assertEquals(null, store.loadToken("gateway-a", "device-1", "operator"))
    assertEquals("token-b", store.loadToken("gateway-b", "device-1", "operator"))
  }

  @Test
  fun failedTokenCommitRestoresBothTokenAndMetadata() {
    for (hasPreviousToken in listOf(false, true)) {
      val (prefs, securePrefs) = createPrefs()
      val store = DeviceAuthStore(prefs)
      if (hasPreviousToken) {
        assertTrue(store.saveToken("gateway-a", "device-1", "operator", "old-token", listOf("operator.read")))
      }
      val previousEntry = store.loadEntry("gateway-a", "device-1", "operator")
      val previousValues = securePrefs.all.toMap()

      securePrefs.failNextCommit = true
      assertFalse(store.saveToken("gateway-a", "device-1", "operator", "replacement-token", listOf("operator.write")))

      assertEquals(previousEntry, store.loadEntry("gateway-a", "device-1", "operator"))
      assertEquals(previousValues, securePrefs.all)
      assertEquals(
        previousEntry,
        DeviceAuthStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs)).loadEntry("gateway-a", "device-1", "operator"),
      )
    }
  }

  @Test
  fun failedBootstrapRetirementRetainsCredentialsUntilDurableRetry() {
    val (prefs, securePrefs) = createPrefs()
    val credentials = GatewayCredentials(token = "shared-token", bootstrapToken = "bootstrap-token", password = "password")
    prefs.saveGatewayCredentials("gateway-a", credentials)
    val handoff = prefs.prepareGatewayBootstrapHandoff("gateway-a", "bootstrap-token", allowStoredTokenRecovery = false)

    securePrefs.failNextCommit = true
    assertFalse(handoff.complete())
    assertFalse(handoff.completed)
    assertEquals(credentials, prefs.loadGatewayCredentials("gateway-a"))
    assertEquals(
      credentials,
      SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs).loadGatewayCredentials("gateway-a"),
    )

    assertTrue(handoff.complete())
    assertTrue(handoff.completed)
    assertEquals(credentials.copy(bootstrapToken = null), prefs.loadGatewayCredentials("gateway-a"))
  }

  @Test
  fun newerCredentialIntentFencesBootstrapRetirement() {
    val credentials = GatewayCredentials(token = "shared-token", bootstrapToken = "bootstrap-token", password = "password")
    for (replacement in listOf("same-value save", "reset", "reset and same-value save", "intent invalidation")) {
      val (prefs) = createPrefs()
      prefs.saveGatewayCredentials("gateway-a", credentials)
      val handoff = prefs.prepareGatewayBootstrapHandoff("gateway-a", "bootstrap-token", allowStoredTokenRecovery = false)
      when (replacement) {
        "same-value save" -> {
          prefs.saveGatewayCredentials("gateway-a", credentials)
        }

        "reset" -> {
          prefs.clearGatewayCredentials("gateway-a")
        }

        "reset and same-value save" -> {
          prefs.clearGatewayCredentials("gateway-a")
          prefs.saveGatewayCredentials("gateway-a", credentials)
        }

        "intent invalidation" -> {
          handoff.invalidate()
        }
      }

      assertFalse(replacement, handoff.complete())
      assertFalse(replacement, handoff.completed)
      assertEquals(
        replacement,
        if (replacement == "reset") GatewayCredentials() else credentials,
        prefs.loadGatewayCredentials("gateway-a"),
      )
    }
  }

  @Test
  fun handoffCannotRetireDifferentSavedBootstrap() {
    val (prefs) = createPrefs()
    val credentials = GatewayCredentials(bootstrapToken = "saved-bootstrap")
    prefs.saveGatewayCredentials("gateway-a", credentials)
    val handoff = prefs.prepareGatewayBootstrapHandoff("gateway-a", "different-bootstrap", allowStoredTokenRecovery = false)

    assertFalse(handoff.complete())
    assertEquals(credentials, prefs.loadGatewayCredentials("gateway-a"))
  }

  private fun createPrefs(): Pair<SecurePrefs, CommitControlledSharedPreferences> {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      CommitControlledSharedPreferences(
        app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", Context.MODE_PRIVATE),
      )
    return SecurePrefs(app, securePrefsOverride = securePrefs) to securePrefs
  }

  private class CommitControlledSharedPreferences(
    private val delegate: SharedPreferences,
  ) : SharedPreferences by delegate {
    var failNextCommit = false

    override fun edit(): SharedPreferences.Editor {
      val editor = delegate.edit()
      return object : SharedPreferences.Editor by editor {
        override fun commit(): Boolean {
          if (!failNextCommit) return editor.commit()
          failNextCommit = false
          // Android publishes memory before attempting the disk write, even when commit fails.
          editor.apply()
          return false
        }
      }
    }
  }
}
