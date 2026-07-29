package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceIdentityStoreTest {
  private val app get() = RuntimeEnvironment.getApplication()
  private val legacyFile get() = File(app.filesDir, "openclaw/identity/device.json")

  @Before
  fun setUp() {
    legacyFile.delete()
  }

  @After
  fun tearDown() {
    legacyFile.delete()
  }

  @Test
  fun migratesLegacyIdentityAndKeepsItStableAcrossReopen() {
    val backing = newBackingPrefs()
    val prefs = SecurePrefs(app, securePrefsOverride = backing)
    val seed = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate()
    backing.edit().clear().commit()
    legacyFile.parentFile?.mkdirs()
    legacyFile.writeText(Json.encodeToString(seed), Charsets.UTF_8)

    val migrated = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate()

    assertEquals(seed, migrated)
    assertFalse(legacyFile.exists())
    assertEquals(migrated, DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate())
  }

  @Test
  fun freshInstallPersistsIdentityOnlyInSecurePrefs() {
    val backing = newBackingPrefs()
    val prefs = SecurePrefs(app, securePrefsOverride = backing)

    val created = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate()

    assertFalse(legacyFile.exists())
    assertEquals(created, DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate())
  }

  @Test
  fun corruptedLegacyFileIsDeletedAndReplacedWithStableIdentity() {
    val backing = newBackingPrefs()
    val prefs = SecurePrefs(app, securePrefsOverride = backing)
    legacyFile.parentFile?.mkdirs()
    legacyFile.writeText("{not-json", Charsets.UTF_8)

    val regenerated = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate()

    assertFalse(legacyFile.exists())
    assertEquals(regenerated, DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate())
  }

  private fun newBackingPrefs() =
    app.getSharedPreferences(
      "device-identity-test-${UUID.randomUUID()}",
      Context.MODE_PRIVATE,
    )
}
