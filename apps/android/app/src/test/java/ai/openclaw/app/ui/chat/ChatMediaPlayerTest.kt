package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatMediaPlayerTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun claimHandoffReleasesPreviousPlaybackInstance() {
    class FakePlayer {
      var released = false

      fun release() {
        released = true
      }
    }
    val first = FakePlayer()
    val second = FakePlayer()
    val claims = ChatMediaPlaybackClaims<FakePlayer>(FakePlayer::release)

    claims.claim(first)
    claims.claim(second)

    assertTrue(first.released)
    assertFalse(second.released)
    assertSame(second, claims.active)
  }

  @Test
  fun legacyMediaPartsRenderLabelsWithoutPlayControlsOrClaims() {
    val audio =
      ChatMessageContent(
        type = "audio",
        mimeType = "audio/mpeg",
        fileName = "legacy.mp3",
        durationMs = 4_000,
      )
    val video =
      ChatMessageContent(
        type = "video",
        mimeType = "video/mp4",
        fileName = "legacy.mp4",
        durationMs = 9_000,
      )
    var loadCount = 0

    composeRule.setContent {
      ChatMessageBubble(
        message =
          ChatMessage(
            id = "legacy-media",
            role = "assistant",
            content = listOf(audio, video),
            timestampMs = 1,
          ),
        loadMediaArtifact = { _, _ ->
          loadCount += 1
          null
        },
      )
    }

    composeRule.onNodeWithText("legacy.mp3").assertIsDisplayed()
    composeRule.onNodeWithText("legacy.mp4").assertIsDisplayed()
    composeRule.onNodeWithText("0:04").assertIsDisplayed()
    composeRule.onNodeWithText("0:09").assertIsDisplayed()
    composeRule.onAllNodesWithContentDescription("Play audio").assertCountEquals(0)
    composeRule.onAllNodesWithContentDescription("Play video").assertCountEquals(0)
    composeRule.runOnIdle {
      assertEquals(0, loadCount)
      assertFalse(audio.hasPlayableMediaArtifact())
      assertFalse(video.hasPlayableMediaArtifact())
    }
  }
}
