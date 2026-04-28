package ai.openclaw.app

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SecurePrefsTest {
  @Test
  fun loadLocationMode_migratesLegacyAlwaysValue() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putString("location.enabledMode", "always")
      .commit()

    val prefs = SecurePrefs(context)

    assertEquals(LocationMode.WhileUsing, prefs.locationMode.value)
    assertEquals("whileUsing", plainPrefs.getString("location.enabledMode", null))
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

    val prefs = SecurePrefs(context)

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
    val prefs = SecurePrefs(context)

    prefs.setVoiceMicEnabled(true)

    assertTrue(prefs.voiceMicEnabled.value)
    assertTrue(plainPrefs.getBoolean("voice.micEnabled", false))
    assertFalse(plainPrefs.getBoolean("talk.enabled", false))
  }

  @Test
  fun saveGatewayBootstrapToken_persistsSeparatelyFromSharedToken() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.setGatewayToken("shared-token")
    prefs.setGatewayBootstrapToken("bootstrap-token")

    assertEquals("shared-token", prefs.loadGatewayToken())
    assertEquals("bootstrap-token", prefs.loadGatewayBootstrapToken())
    assertEquals("bootstrap-token", prefs.gatewayBootstrapToken.value)
  }

  @Test
  fun clearGatewaySetupAuth_removesStoredGatewayAuth() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test.clear", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.setGatewayToken("shared-token")
    prefs.setGatewayBootstrapToken("bootstrap-token")
    prefs.setGatewayPassword("password-token")

    prefs.clearGatewaySetupAuth()

    assertEquals("", prefs.gatewayToken.value)
    assertEquals("", prefs.gatewayBootstrapToken.value)
    assertNull(prefs.loadGatewayToken())
    assertNull(prefs.loadGatewayBootstrapToken())
    assertNull(prefs.loadGatewayPassword())
  }
}
