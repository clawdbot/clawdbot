package ai.openclaw.app

import ai.openclaw.app.ui.SettingsRoute
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidScreenshotModeTest {
  @Test
  fun ignoresNormalLaunches() {
    assertNull(parseAndroidScreenshotModeIntent(Intent(Intent.ACTION_MAIN)))
  }

  @Test
  fun parsesRequestedScene() {
    val parsed =
      parseAndroidScreenshotModeIntent(
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "voice"),
      )

    assertEquals(AndroidScreenshotScene.Voice, parsed)
  }

  @Test
  fun defaultsUnknownScenesToHome() {
    val parsed =
      parseAndroidScreenshotModeIntent(
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "unknown"),
      )

    assertEquals(AndroidScreenshotScene.Home, parsed)
  }

  @Test
  fun mapsScenesToProductionShellDestinations() {
    assertEquals(HomeDestination.Connect, AndroidScreenshotScene.Home.homeDestination)
    assertEquals(HomeDestination.Chat, AndroidScreenshotScene.Chat.homeDestination)
    assertEquals(HomeDestination.Voice, AndroidScreenshotScene.Voice.homeDestination)
    assertEquals(HomeDestination.Settings, AndroidScreenshotScene.Settings.homeDestination)
    assertEquals(HomeDestination.Settings, AndroidScreenshotScene.VoiceWake.homeDestination)
  }

  @Test
  fun gatewaySceneTargetsSettingsGatewayRoute() {
    val parsed =
      parseAndroidScreenshotModeIntent(
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "gateway"),
      )

    assertEquals(AndroidScreenshotScene.Gateway, parsed)
    assertEquals(HomeDestination.Settings, parsed?.homeDestination)
    assertEquals(SettingsRoute.Gateway, parsed?.settingsRoute)
    assertNull(AndroidScreenshotScene.Settings.settingsRoute)
  }

  @Test
  fun voiceWakeSceneTargetsVoiceSettings() {
    val scene = AndroidScreenshotScene.fromRawValue("voice-wake")

    assertEquals(AndroidScreenshotScene.VoiceWake, scene)
    assertEquals(SettingsRoute.Voice, scene.settingsRoute)
  }
}
