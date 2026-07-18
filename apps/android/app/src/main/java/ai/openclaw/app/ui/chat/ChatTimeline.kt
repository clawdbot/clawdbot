package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.OUTBOX_OWNER_CHANGED_ERROR
import ai.openclaw.app.resolveAgentIdFromMainSessionKey

internal sealed class ChatTimelineItem {
  data class Message(
    val message: ChatMessage,
  ) : ChatTimelineItem()

  /** Durable queued/failed offline command shown below the transcript until acked or deleted. */
  data class OutboxCommand(
    val item: ChatOutboxItem,
  ) : ChatTimelineItem()

  /** Gateway-level recovery row that cannot be placed in the visible owner/session. */
  data class RecoveryOutboxCommand(
    val item: ChatOutboxItem,
  ) : ChatTimelineItem()

  data class OutboxRecoveryHeader(
    val count: Int,
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
  val readAnchorIndex: Int?,
  val latestContentIndex: Int?,
  val latestUserMessageId: String?,
  val latestUserMessageVersion: String?,
  val latestContentVersion: String,
)

internal fun buildChatTimeline(
  messages: List<ChatMessage>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
  outboxItems: List<ChatOutboxItem> = emptyList(),
  recoveryOutboxItems: List<ChatOutboxItem> = emptyList(),
): ChatTimeline {
  val stream = streamingAssistantText?.trim()?.takeIf { it.isNotEmpty() }
  val items =
    buildList {
      // reverseLayout: index 0 renders bottom-most; queued commands are the newest user input.
      outboxItems.asReversed().forEach { item -> add(ChatTimelineItem.OutboxCommand(item)) }
      recoveryOutboxItems.asReversed().forEach { item -> add(ChatTimelineItem.RecoveryOutboxCommand(item)) }
      if (recoveryOutboxItems.isNotEmpty()) add(ChatTimelineItem.OutboxRecoveryHeader(recoveryOutboxItems.size))
      if (stream != null) add(ChatTimelineItem.StreamingAssistant(stream))
      if (pendingToolCalls.isNotEmpty()) add(ChatTimelineItem.PendingTools(pendingToolCalls))
      if (pendingRunCount > 0) add(ChatTimelineItem.Thinking)
      messages.asReversed().forEach { message -> add(ChatTimelineItem.Message(message)) }
    }
  if (items.isEmpty()) {
    return ChatTimeline(
      items = items,
      readAnchorIndex = null,
      latestContentIndex = null,
      latestUserMessageId = null,
      latestUserMessageVersion = null,
      latestContentVersion = "",
    )
  }

  val latestUserMessage =
    items.firstNotNullOfOrNull { item ->
      val message = (item as? ChatTimelineItem.Message)?.message ?: return@firstNotNullOfOrNull null
      message.takeIf { it.role.trim().equals("user", ignoreCase = true) }
    }
  val latestUserIndex =
    items.indexOfFirst { item ->
      item is ChatTimelineItem.Message &&
        item.message.id == latestUserMessage?.id
    }
  val latestContentIndex = 0
  // In reverseLayout, index 0 is bottom-most. Keep the latest prompt as a stable
  // reader anchor even after streaming rows collapse into a finished reply.
  val readAnchorIndex = latestUserIndex.takeIf { it >= 0 } ?: latestContentIndex

  return ChatTimeline(
    items = items,
    readAnchorIndex = readAnchorIndex,
    latestContentIndex = latestContentIndex,
    latestUserMessageId = latestUserMessage?.id,
    latestUserMessageVersion = latestUserMessage?.let(::stableMessageVersion),
    latestContentVersion =
      latestContentVersion(messages, pendingRunCount, pendingToolCalls, stream, outboxItems + recoveryOutboxItems),
  )
}

/**
 * Outbox rows for the visible session owner. Rows enqueued under the "main" alias still belong to the
 * canonical main session once the gateway hello rewrites the current key. Rows whose user turn
 * is already visible as a message (optimistic while a live run owns it, or the canonical history
 * copy right before the row retires) are hidden so one send never renders as two bubbles. Migrated
 * ownerless and unreachable legacy-main rows are excluded here and rendered only in the
 * gateway-level recovery section.
 */
internal fun outboxItemsForSession(
  items: List<ChatOutboxItem>,
  sessionKey: String,
  mainSessionKey: String,
  ownerAgentId: String,
  messages: List<ChatMessage> = emptyList(),
): List<ChatOutboxItem> {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  val current = sessionKey.trim().let { if (it == "main") mainKey else it }
  val visibleUserKeys =
    messages
      .mapNotNull { message -> message.idempotencyKey?.trim()?.takeIf { it.isNotEmpty() } }
      .toSet()
  return items.filter { item ->
    val itemKey = item.sessionKey.let { if (it == "main") mainKey else it }
    val ownerMatches = item.ownerAgentId == ownerAgentId
    ownerMatches &&
      itemKey == current &&
      "${item.id}:user" !in visibleUserKeys &&
      !isRecoveryOutboxItem(item)
  }
}

/** Rows with missing or internally contradictory ownership still need neutral controls. */
internal fun outboxItemsForRecovery(items: List<ChatOutboxItem>): List<ChatOutboxItem> = items.filter(::isRecoveryOutboxItem)

private fun isRecoveryOutboxItem(item: ChatOutboxItem): Boolean {
  val keyOwner = resolveAgentIdFromMainSessionKey(item.sessionKey)
  val parkedMainAlias =
    item.sessionKey.trim() == "main" &&
      item.status == ChatOutboxStatus.Failed &&
      item.lastError == OUTBOX_OWNER_CHANGED_ERROR
  return item.ownerAgentId == null ||
    (keyOwner != null && keyOwner != item.ownerAgentId) ||
    parkedMainAlias
}

private fun stableMessageVersion(message: ChatMessage): String {
  val role = message.role.trim().lowercase()
  val idempotencyKey = message.idempotencyKey?.trim().orEmpty()
  if (idempotencyKey.isNotEmpty()) return "$role:idempotency:$idempotencyKey"

  return buildString {
    append(role)
    append(':')
    append(message.timestampMs ?: "")
    message.content.forEach { content ->
      append(':')
      append(content.type)
      append('=')
      append(content.text?.hashCode() ?: 0)
      append(',')
      append(content.mimeType.orEmpty())
      append(',')
      append(content.fileName.orEmpty())
      append(',')
      append(content.base64?.length ?: 0)
      append(',')
      append(content.durationMs ?: "")
    }
  }
}

internal fun ChatTimeline.containsUserMessageVersion(version: String): Boolean =
  items.any { item ->
    val message = (item as? ChatTimelineItem.Message)?.message ?: return@any false
    message.role.trim().equals("user", ignoreCase = true) && stableMessageVersion(message) == version
  }

// Reader restoration only needs to detect changes at the live edge. Avoid hashing
// the full transcript whenever a streamed response updates.
private fun latestContentVersion(
  messages: List<ChatMessage>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  stream: String?,
  outboxItems: List<ChatOutboxItem> = emptyList(),
): String {
  val latest = messages.lastOrNull()
  return buildString {
    append(messages.size)
    append(':')
    append(latest?.id.orEmpty())
    append(':')
    append(latest?.role.orEmpty())
    append(':')
    append(latest?.timestampMs ?: "")
    latest?.content?.forEach { content ->
      append(':')
      append(content.type)
      append('=')
      append(content.text?.hashCode() ?: 0)
      append(',')
      append(content.mimeType.orEmpty())
      append(',')
      append(content.fileName.orEmpty())
      append(',')
      append(content.base64?.length ?: 0)
      append(',')
      append(content.durationMs ?: "")
    }
    append(":runs=")
    append(pendingRunCount)
    append(":tools=")
    pendingToolCalls.forEach { call ->
      append(call.toolCallId)
      append(',')
      append(call.name)
      append(',')
      append(call.isError)
      append(';')
    }
    append(":stream=")
    append(stream?.hashCode() ?: 0)
    append(":outbox=")
    outboxItems.forEach { item ->
      append(item.id)
      append(',')
      append(item.status)
      append(';')
    }
  }
}

internal fun chatTimelineItemKey(item: ChatTimelineItem): String =
  when (item) {
    is ChatTimelineItem.Message -> "message:${item.message.id}"
    is ChatTimelineItem.OutboxCommand -> "outbox:${item.item.id}"
    is ChatTimelineItem.RecoveryOutboxCommand -> "outbox-recovery:${item.item.id}"
    is ChatTimelineItem.OutboxRecoveryHeader -> "outbox-recovery-header"
    is ChatTimelineItem.PendingTools -> "tools"
    is ChatTimelineItem.StreamingAssistant -> "stream"
    ChatTimelineItem.Thinking -> "thinking"
  }
