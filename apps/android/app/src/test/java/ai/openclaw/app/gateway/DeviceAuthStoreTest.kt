package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val store = DeviceAuthStore(prefs)

    store.saveToken(
      gatewayId = "gateway-a",
      deviceId = " Device-1 ",
      role = " Operator ",
      token = " operator-token ",
      scopes = listOf("operator.write", "operator.read", "operator.write", " "),
    )

    val entry = store.loadEntry("gateway-a", "device-1", "operator")
    assertNotNull(entry)
    assertEquals("operator-token", entry?.token)
    assertEquals("operator", entry?.role)
    assertEquals(listOf("operator.read", "operator.write"), entry?.scopes)
    assertTrue((entry?.updatedAtMs ?: 0L) > 0L)
  }

  @Test
  fun gatewayIdsIsolateSameDeviceAndRole() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val store = DeviceAuthStore(prefs)
    store.saveToken("gateway-a", "device-1", "operator", "token-a")
    store.saveToken("gateway-b", "device-1", "operator", "token-b")

    assertEquals("token-a", store.loadToken("gateway-a", "device-1", "operator"))
    assertEquals("token-b", store.loadToken("gateway-b", "device-1", "operator"))

    store.clearToken("gateway-a", "device-1", "operator")

    assertEquals(null, store.loadToken("gateway-a", "device-1", "operator"))
    assertEquals("token-b", store.loadToken("gateway-b", "device-1", "operator"))
  }
}
