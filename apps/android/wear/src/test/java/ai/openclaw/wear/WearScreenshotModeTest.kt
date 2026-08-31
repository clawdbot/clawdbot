package ai.openclaw.wear

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearScreenshotModeTest {
  @Test
  fun ignoresNormalLaunches() {
    assertNull(parseWearScreenshotModeIntent(Intent(Intent.ACTION_MAIN)))
  }

  @Test
  fun parsesRequestedScene() {
    val parsed =
      parseWearScreenshotModeIntent(
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraWearScreenshotMode, true)
          .putExtra(extraWearScreenshotScene, "voice"),
      )

    assertEquals(WearScreenshotScene.Voice, parsed)
  }

  @Test
  fun defaultsUnknownScenesToChat() {
    val parsed =
      parseWearScreenshotModeIntent(
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraWearScreenshotMode, true)
          .putExtra(extraWearScreenshotScene, "unknown"),
      )

    assertEquals(WearScreenshotScene.Chat, parsed)
  }

  @Test
  fun mapsScenesToProductionPages() {
    assertEquals(WearHomePage.Chat, WearScreenshotScene.Chat.initialPage)
    assertEquals(WearHomePage.Voice, WearScreenshotScene.Voice.initialPage)
    assertEquals(WearHomePage.Controls, WearScreenshotScene.Controls.initialPage)
  }

  @Test
  fun fixtureRepresentsAConnectedConversation() {
    val snapshot = WearScreenshotFixture.snapshot

    assertEquals(WearGatewayState.CONNECTED, snapshot.gatewayState)
    assertEquals("release-planning", snapshot.activeSessionId)
    assertTrue(snapshot.messages.any { message -> message.chatRole == WearChatRole.ASSISTANT })
  }
}
