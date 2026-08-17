package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatMessageViewsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun transcriptBubblesExposeSpeakerWithoutReplacingMessageText() {
    val messages =
      listOf(
        Triple("user", "user body", false),
        Triple("assistant", "assistant body", false),
        Triple("system", "system body", false),
        Triple("assistant", "live body", true),
      )

    composeRule.setContent {
      Column {
        messages.forEachIndexed { index, (role, body, live) ->
          ChatBubble(
            messageId = "message-$index",
            entryId = null,
            role = role,
            live = live,
            content = listOf(ChatMessageContent(type = "text", text = body)),
            timestampMs = null,
            onReplyMessage = {},
            sessionActionsEnabled = false,
            onRewindMessage = {},
            onForkMessage = {},
            speechState = null,
            onToggleListen = { _, _ -> },
            inlineMediaPlaybackBlocked = false,
            inlineWidgetResolverReady = false,
            resolveInlineWidgetResource = { _, _ -> null },
            loadImageArtifact = { null },
            loadMediaArtifact = { _, _, _ -> null },
          )
        }
      }
    }

    composeRule.onNode(hasContentDescription("You") and hasText("user body")).assertExists()
    composeRule.onNode(hasContentDescription("OpenClaw") and hasText("assistant body")).assertExists()
    composeRule.onNode(hasContentDescription("System") and hasText("system body")).assertExists()
    composeRule.onNode(hasContentDescription("OpenClaw") and hasText("live body")).assertExists()
    composeRule.onAllNodesWithText("You", useUnmergedTree = true).assertCountEquals(0)
    composeRule.onAllNodesWithText("OpenClaw", useUnmergedTree = true).assertCountEquals(0)
    composeRule.onAllNodesWithText("System", useUnmergedTree = true).assertCountEquals(1)
    composeRule.onAllNodesWithText("OpenClaw · Live", useUnmergedTree = true).assertCountEquals(1)
  }

  @Test
  fun outboxBubbleExposesSpeakerWithoutReplacingStatusOrActions() {
    composeRule.setContent {
      ChatOutboxBubble(
        item =
          ChatOutboxItem(
            id = "outbox-1",
            sessionKey = "main",
            text = "queued body",
            thinkingLevel = "low",
            createdAtMs = 0L,
            status = ChatOutboxStatus.Queued,
            retryCount = 0,
            lastError = null,
            ownerAgentId = "main",
          ),
        onRetry = {},
        onDelete = {},
      )
    }

    composeRule
      .onNode(
        hasContentDescription("You") and
          hasText("queued body") and
          hasAnyDescendant(hasText("Delete") and hasClickAction()),
      ).assertExists()
  }

  @Test
  fun managedImageCompositionRequestsItsArtifact() {
    val artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111"
    val requested = mutableListOf<String>()

    composeRule.setContent {
      ChatBubble(
        messageId = "managed-image",
        entryId = null,
        role = "assistant",
        live = false,
        content =
          listOf(
            ChatMessageContent(
              type = "image",
              mimeType = "image/png",
              artifactId = artifactId,
              alt = "Managed image",
            ),
          ),
        timestampMs = null,
        onReplyMessage = {},
        sessionActionsEnabled = false,
        onRewindMessage = {},
        onForkMessage = {},
        speechState = null,
        onToggleListen = { _, _ -> },
        inlineMediaPlaybackBlocked = false,
        inlineWidgetResolverReady = true,
        resolveInlineWidgetResource = { _, _ -> null },
        loadImageArtifact = { requestedArtifactId ->
          requested += requestedArtifactId
          null
        },
        loadMediaArtifact = { _, _, _ -> null },
      )
    }
    composeRule.waitUntil(timeoutMillis = 5_000) { requested.isNotEmpty() }

    assertEquals(listOf(artifactId), requested)
  }

  @Test
  fun systemRowsRenderNoticeLabelAndDividerMetric() {
    composeRule.setContent {
      Column {
        ChatSystemNoticeRow(
          ChatTimelineItem.SystemNotice(
            key = "system-notice:1:0",
            label = "System · restart recovery",
            body = "Turn interrupted by a gateway restart — asked the agent to resume and finish the response.",
          ),
        )
        ChatSystemDividerRow(
          ChatTimelineItem.SystemDivider(
            key = "divider:compaction:checkpoint-1",
            kind = SystemDividerKind.Compaction,
            label = "Compacted history",
            metric = "saved 875.3k tokens",
          ),
        )
      }
    }

    composeRule.onNodeWithText("System · restart recovery").assertIsDisplayed()
    composeRule
      .onNodeWithText("Turn interrupted by a gateway restart — asked the agent to resume and finish the response.")
      .assertIsDisplayed()
    composeRule.onNodeWithText("Compacted history").assertIsDisplayed()
    composeRule.onNodeWithText("saved 875.3k tokens").assertIsDisplayed()
  }
}
