package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatPendingToolCall
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatTimelineTest {
  @Test
  fun activeRunAnchorsNewestUserPromptInsteadOfThinkingRow() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")

    val timeline =
      buildChatTimeline(
        messages = listOf(user),
        pendingRunCount = 1,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(listOf("thinking", "message:user-1"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(1, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun activeRunAnchorsNewestUserPromptWhileAssistantStreams() {
    val olderAssistant = textMessage(id = "assistant-1", role = "assistant", text = "previous")
    val user = textMessage(id = "user-1", role = "user", text = "next")
    val tool =
      ChatPendingToolCall(
        toolCallId = "tool-1",
        name = "memory.search",
        startedAtMs = 1000L,
      )

    val timeline =
      buildChatTimeline(
        messages = listOf(olderAssistant, user),
        pendingRunCount = 1,
        pendingToolCalls = listOf(tool),
        streamingAssistantText = "streaming",
      )

    assertEquals(
      listOf("stream", "tools", "thinking", "message:user-1", "message:assistant-1"),
      timeline.items.map(::chatTimelineItemKey),
    )
    assertEquals(3, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun finishedRunKeepsLatestUserPromptAsReaderAnchor() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")
    val assistant = textMessage(id = "assistant-1", role = "assistant", text = "done")

    val timeline =
      buildChatTimeline(
        messages = listOf(user, assistant),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(listOf("message:assistant-1", "message:user-1"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(1, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun emptyTimelineHasNoScrollTarget() {
    val timeline =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(emptyList<String>(), timeline.items.map(::chatTimelineItemKey))
    assertEquals(null, timeline.readAnchorIndex)
    assertEquals(null, timeline.latestContentIndex)
    assertEquals(null, timeline.latestUserMessageId)
  }

  @Test
  fun outboxRowsHideOnceTheirUserTurnIsVisibleAsAMessage() {
    val visible =
      ChatOutboxItem(
        id = "visible-row",
        sessionKey = "main",
        text = "still queued",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
      )
    val consumed =
      visible.copy(
        id = "consumed-row",
        status = ChatOutboxStatus.Accepted,
        createdAtMs = 2,
      )
    val optimisticCopy =
      textMessage(id = "m1", role = "user", text = "sent already")
        .copy(idempotencyKey = "consumed-row:user")

    val filtered =
      outboxItemsForSession(
        items = listOf(visible, consumed),
        sessionKey = "main",
        mainSessionKey = "agent:work:main",
        messages = listOf(optimisticCopy),
      )

    // A row whose turn already renders as a message never shows a second bubble.
    assertEquals(listOf("visible-row"), filtered.map { it.id })
  }

  private fun textMessage(
    id: String,
    role: String,
    text: String,
  ): ChatMessage =
    ChatMessage(
      id = id,
      role = role,
      content = listOf(ChatMessageContent(type = "text", text = text)),
      timestampMs = null,
    )
}
