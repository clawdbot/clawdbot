package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
  /** Canonical transcript-tree identity supplied by chat.history. */
  val entryId: String? = null,
)

/** One selectable transcript branch returned by sessions.branches.list. */
data class SessionBranch(
  val leafEntryId: String,
  val headline: String,
  val messageCount: Int,
  val updatedAt: String?,
  val active: Boolean,
)

data class SessionRewindResult(
  val editorText: String?,
)

data class ChatTranscriptAnchorState(
  val sessionKey: String,
  val newestItemId: String?,
  val completedEndedAt: Long?,
  val completedNewestItemId: String?,
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
  val widget: ChatWidgetPreview? = null,
)

data class ChatWidgetPreview(
  val title: String?,
  val path: String,
  val preferredHeight: Int?,
  val sandbox: String,
) {
  val height: Int
    get() = (preferredHeight ?: 320).coerceIn(160, 1200)
}

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

enum class ChatPlanStepStatus {
  Pending,
  InProgress,
  Completed,
}

data class ChatPlanStep(
  val step: String,
  val status: ChatPlanStepStatus,
)

/** Parses a complete gateway plan snapshot, including legacy string-only steps. */
internal fun parseChatPlanSteps(element: JsonElement?): List<ChatPlanStep> {
  val entries = element as? JsonArray ?: return emptyList()
  var hasInProgressStep = false
  return entries.mapNotNull { entry ->
    val parsed =
      when (entry) {
        is JsonObject -> {
          val step =
            (entry["step"] as? JsonPrimitive)
              ?.takeIf { it.isString }
              ?.content
              ?.trim()
              ?.takeIf { it.isNotEmpty() }
              ?: return@mapNotNull null
          val status =
            when ((entry["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
              "pending" -> ChatPlanStepStatus.Pending
              "in_progress" -> ChatPlanStepStatus.InProgress
              "completed" -> ChatPlanStepStatus.Completed
              else -> return@mapNotNull null
            }
          ChatPlanStep(step = step, status = status)
        }
        is JsonPrimitive -> {
          val step =
            entry
              .takeIf { it.isString }
              ?.content
              ?.trim()
              ?.takeIf { it.isNotEmpty() }
              ?: return@mapNotNull null
          ChatPlanStep(step = step, status = ChatPlanStepStatus.Pending)
        }
        else -> return@mapNotNull null
      }
    if (parsed.status == ChatPlanStepStatus.InProgress) {
      if (hasInProgressStep) return@mapNotNull null
      hasInProgressStep = true
    }
    parsed
  }
}

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
  val ownerAgentId: String? = null,
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
  val hasActiveRun: Boolean? = null,
  val activeRunIds: List<String>? = null,
  val status: String? = null,
  val startedAt: Long? = null,
  val endedAt: Long? = null,
  val runtimeMs: Long? = null,
  val outputTokens: Long? = null,
  val hasRunMetadata: Boolean =
    status != null || startedAt != null || endedAt != null || runtimeMs != null || outputTokens != null,
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
  val plan: ChatPlanSnapshot? = null,
)

data class ChatPlanSnapshot(
  val steps: List<ChatPlanStep>,
  val explanation: String? = null,
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
