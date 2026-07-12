package ai.openclaw.app.chat
import java.util.Locale

private val visibleChatMessageRoles = setOf("user", "assistant", "system", "custom")
internal const val CHAT_IMAGE_MAX_BASE64_CHARS = 300 * 1024

/** Keeps transcript rows limited to roles Android renders as user-visible chat. */
internal fun normalizeVisibleChatMessageRole(role: String?): String? =
  role
    ?.trim()
    ?.lowercase(Locale.US)
    ?.takeIf(visibleChatMessageRoles::contains)

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
  val durationMs: Long? = null,
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

/** Gateway-advertised thinking choice for the active provider/model pair. */
data class ChatThinkingLevelOption(
  val id: String,
  val label: String,
)

/** Thinking choices currently shown by chat, including whether the Gateway supplied them. */
data class ChatThinkingLevelSelection(
  val options: List<ChatThinkingLevelOption>,
  val isGatewayProvided: Boolean,
)

internal val defaultChatThinkingLevelSelection =
  ChatThinkingLevelSelection(
    options =
      listOf(
        ChatThinkingLevelOption(id = "off", label = "Off"),
        ChatThinkingLevelOption(id = "low", label = "Low"),
        ChatThinkingLevelOption(id = "medium", label = "Medium"),
        ChatThinkingLevelOption(id = "high", label = "High"),
      ),
    isGatewayProvided = false,
  )

/**
 * Stable session selector row; [key] is the gateway session key used in chat requests.
 */
data class ChatSessionEntry(
  val key: String,
  val updatedAtMs: Long?,
  val displayName: String? = null,
  val label: String? = null,
  val category: String? = null,
  val pinned: Boolean? = null,
  val archived: Boolean? = null,
  val unread: Boolean? = null,
  val lastReadAt: Long? = null,
  val lastActivityAt: Long? = null,
  val totalTokens: Long? = null,
  val totalTokensFresh: Boolean? = null,
  val modelProvider: String? = null,
  val model: String? = null,
  val thinkingLevel: String? = null,
  val thinkingLevels: List<ChatThinkingLevelOption>? = null,
  val thinkingDefault: String? = null,
  val contextTokens: Long? = null,
  val hasContextUsageMetadata: Boolean = totalTokens != null || totalTokensFresh != null || contextTokens != null,
)

/** Local fallback for server-side `sessions.list` search over cached entries. */
fun filterSessionEntries(
  sessions: List<ChatSessionEntry>,
  search: String,
): List<ChatSessionEntry> {
  val query = search.trim().lowercase()
  if (query.isEmpty()) return sessions
  return sessions.filter { session ->
    listOfNotNull(session.displayName, session.label, session.key)
      .any { it.lowercase().contains(query) }
  }
}

/**
 * Slash command metadata exposed by the gateway for text-surface chat clients.
 */
data class ChatCommandEntry(
  val name: String,
  val description: String,
  val category: String? = null,
  val textAliases: List<String> = emptyList(),
  val acceptsArgs: Boolean = false,
)

/**
 * Run still streaming on the gateway when a chat.history snapshot was captured;
 * [text] is the assistant text buffered so far (may be empty for runs without deltas).
 */
data class ChatInFlightRun(
  val runId: String,
  val text: String,
)

/**
 * Snapshot of one chat session, including optional thinking level selected on the gateway.
 */
data class ChatHistory(
  val sessionKey: String,
  val sessionId: String?,
  val thinkingLevel: String?,
  val messages: List<ChatMessage>,
  val sessionInfo: ChatSessionEntry? = null,
  val inFlightRun: ChatInFlightRun? = null,
)

/**
 * User-selected attachment payload sent to the gateway as inline base64.
 */
data class OutgoingAttachment(
  val type: String,
  val mimeType: String,
  val fileName: String,
  val base64: String,
  val durationMs: Long? = null,
)
