package ai.openclaw.app.chat

/**
 * Chat transcript item as delivered by gateway chat history and live chat events.
 */
data class ChatMessage(
  val id: String,
  val role: String,
  val content: List<ChatMessageContent>,
  val timestampMs: Long?,
  val idempotencyKey: String? = null,
)

/**
 * One content part in a chat message; binary parts carry base64 plus their MIME metadata.
 */
data class ChatMessageContent(
  val type: String = "text",
  val text: String? = null,
  val mimeType: String? = null,
  val fileName: String? = null,
  val base64: String? = null,
)

/**
 * Tool call placeholder shown while a gateway run is still streaming.
 */
data class ChatPendingToolCall(
  val toolCallId: String,
  val name: String,
  val args: kotlinx.serialization.json.JsonObject? = null,
  val startedAtMs: Long,
  val isError: Boolean? = null,
)

/**
 * Stable session selector row; [key] is the gateway session key used in chat requests.
 */
data class ChatSessionEntry(
  val key: String,
  val updatedAtMs: Long?,
  val displayName: String? = null,
)

/**
 * Snapshot of one chat session, including optional thinking level selected on the gateway.
 */
data class ChatHistory(
  val sessionKey: String,
  val sessionId: String?,
  val thinkingLevel: String?,
  val messages: List<ChatMessage>,
)

/**
 * User-selected attachment payload sent to the gateway as inline base64.
 */
data class OutgoingAttachment(
  val type: String,
  val mimeType: String,
  val fileName: String,
  val base64: String,
)
