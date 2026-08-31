package ai.openclaw.wear

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
class WearSettingsStoreTest {
  @Test
  fun defaultsAreStableWithoutWritingPreferenceRows() {
    val preferences = freshPreferences()

    val settings = WearSettingsStore(preferences).read()

    assertEquals(WearThemeMode.Dark, settings.themeMode)
    assertFalse(settings.autoSpeak)
    assertTrue(preferences.all.isEmpty())
  }

  @Test
  fun oneStoreOwnsThemeAndAutoSpeakAcrossProcessRestart() {
    val preferences = freshPreferences()
    WearSettingsStore(preferences).apply {
      writeThemeMode(WearThemeMode.Light)
      writeAutoSpeak(true)
    }

    val restored = WearSettingsStore(preferences).read()

    assertEquals(WearThemeMode.Light, restored.themeMode)
    assertTrue(restored.autoSpeak)
    assertEquals(setOf("appearance.themeMode", "conversation.autoSpeak"), preferences.all.keys)
  }

  @Test
  fun unknownThemeFallsBackWithoutResettingOtherSettings() {
    val preferences = freshPreferences()
    preferences
      .edit()
      .putString("appearance.themeMode", "future-theme")
      .putBoolean("conversation.autoSpeak", true)
      .commit()

    val restored = WearSettingsStore(preferences).read()

    assertEquals(WearThemeMode.Dark, restored.themeMode)
    assertTrue(restored.autoSpeak)
  }

  private fun freshPreferences() =
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("wear-settings-${UUID.randomUUID()}", Context.MODE_PRIVATE)
}
