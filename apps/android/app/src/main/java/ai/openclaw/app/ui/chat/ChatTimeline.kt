package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatPendingToolCall

internal sealed class ChatTimelineItem {
  data class Message(
    val message: ChatMessage,
  ) : ChatTimelineItem()

  data class StreamingAssistant(
    val text: String,
  ) : ChatTimelineItem()

  data class PendingTools(
    val toolCalls: List<ChatPendingToolCall>,
  ) : ChatTimelineItem()

  object Thinking : ChatTimelineItem()
}

internal data class ChatTimeline(
  val items: List<ChatTimelineItem>,
  val scrollTargetIndex: Int?,
)

internal fun buildChatTimeline(
  messages: List<ChatMessage>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
): ChatTimeline {
  val stream = streamingAssistantText?.trim()?.takeIf { it.isNotEmpty() }
  val hasActiveRun = pendingRunCount > 0 || pendingToolCalls.isNotEmpty() || stream != null
  val items =
    buildList {
      if (stream != null) add(ChatTimelineItem.StreamingAssistant(stream))
      if (pendingToolCalls.isNotEmpty()) add(ChatTimelineItem.PendingTools(pendingToolCalls))
      if (pendingRunCount > 0) add(ChatTimelineItem.Thinking)
      messages.asReversed().forEach { message -> add(ChatTimelineItem.Message(message)) }
    }
  if (items.isEmpty()) return ChatTimeline(items = items, scrollTargetIndex = null)

  // In reverseLayout, index 0 is bottom-most. During an active run, keep the prompt
  // anchored so streaming/tool rows do not immediately push the just-sent message away.
  val activePromptIndex =
    if (hasActiveRun) {
      items.indexOfFirst { item ->
        item is ChatTimelineItem.Message &&
          item.message.role
            .trim()
            .equals("user", ignoreCase = true)
      }
    } else {
      -1
    }
  return ChatTimeline(
    items = items,
    scrollTargetIndex = activePromptIndex.takeIf { it >= 0 } ?: 0,
  )
}

internal fun chatTimelineItemKey(item: ChatTimelineItem): String =
  when (item) {
    is ChatTimelineItem.Message -> "message:${item.message.id}"
    is ChatTimelineItem.PendingTools -> "tools"
    is ChatTimelineItem.StreamingAssistant -> "stream"
    ChatTimelineItem.Thinking -> "thinking"
  }
