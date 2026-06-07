package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
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
    assertEquals(1, timeline.scrollTargetIndex)
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
    assertEquals(3, timeline.scrollTargetIndex)
  }

  @Test
  fun finishedRunAnchorsNewestPersistedMessage() {
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
    assertEquals(0, timeline.scrollTargetIndex)
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
    assertEquals(null, timeline.scrollTargetIndex)
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
