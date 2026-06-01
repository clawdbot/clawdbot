package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class ChatController(
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val json: Json,
) {
  private var appliedMainSessionKey = "main"
  private val _sessionKey = MutableStateFlow("main")
  val sessionKey: StateFlow<String> = _sessionKey.asStateFlow()

  private val _sessionId = MutableStateFlow<String?>(null)
  val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

  private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
  val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

  private val _historyLoading = MutableStateFlow(false)
  val historyLoading: StateFlow<Boolean> = _historyLoading.asStateFlow()

  private val _errorText = MutableStateFlow<String?>(null)
  val errorText: StateFlow<String?> = _errorText.asStateFlow()

  private val _healthOk = MutableStateFlow(false)
  val healthOk: StateFlow<Boolean> = _healthOk.asStateFlow()

  private val _thinkingLevel = MutableStateFlow("off")
  val thinkingLevel: StateFlow<String> = _thinkingLevel.asStateFlow()

  private val _pendingRunCount = MutableStateFlow(0)
  val pendingRunCount: StateFlow<Int> = _pendingRunCount.asStateFlow()

  private val _streamingAssistantText = MutableStateFlow<String?>(null)
  val streamingAssistantText: StateFlow<String?> = _streamingAssistantText.asStateFlow()

  private val pendingToolCallsById = ConcurrentHashMap<String, ChatPendingToolCall>()
  private val _pendingToolCalls = MutableStateFlow<List<ChatPendingToolCall>>(emptyList())
  val pendingToolCalls: StateFlow<List<ChatPendingToolCall>> = _pendingToolCalls.asStateFlow()

  private val _sessions = MutableStateFlow<List<ChatSessionEntry>>(emptyList())
  val sessions: StateFlow<List<ChatSessionEntry>> = _sessions.asStateFlow()

  private val pendingRuns = mutableSetOf<String>()
  private val pendingRunTimeoutJobs = ConcurrentHashMap<String, Job>()
  // Preserve sent messages locally until chat.history includes the gateway-confirmed copy.
  private val optimisticMessagesByRunId = LinkedHashMap<String, ChatMessage>()
  private val pendingRunTimeoutMs = 120_000L
  // Drops stale history responses after session switches or refresh races.
  private val historyLoadGeneration = AtomicLong(0)

  private var lastHealthPollAtMs: Long? = null

  /** Clears transient chat state when the operator gateway session disconnects. */
  fun onDisconnected(message: String) {
    _healthOk.value = false
    _errorText.value = null
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _historyLoading.value = false
    _sessionId.value = null
  }

  /** Loads a chat session, normalizing "main" to the current gateway-provided main session key. */
  fun load(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    val generation = beginHistoryLoad(key, clearMessages = key != _sessionKey.value)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = true)
    }
  }

  /** Rebinds chat to a new canonical main session key after gateway hello/agent changes. */
  fun applyMainSessionKey(mainSessionKey: String) {
    val trimmed = mainSessionKey.trim()
    if (trimmed.isEmpty()) return
    val nextState =
      applyMainSessionKey(
        currentSessionKey = normalizeRequestedSessionKey(_sessionKey.value),
        appliedMainSessionKey = appliedMainSessionKey,
        nextMainSessionKey = trimmed,
      )
    appliedMainSessionKey = nextState.appliedMainSessionKey
    if (_sessionKey.value == nextState.currentSessionKey) return
    val generation = beginHistoryLoad(nextState.currentSessionKey, clearMessages = true)
    scope.launch {
      bootstrap(
        sessionKey = nextState.currentSessionKey,
        generation = generation,
        forceHealth = true,
        refreshSessions = true,
      )
    }
  }

  /** Refreshes current chat history and session list without clearing optimistic messages first. */
  fun refresh() {
    val key = normalizeRequestedSessionKey(_sessionKey.value)
    val generation = beginHistoryLoad(key, clearMessages = false)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = true)
    }
  }

  fun refreshSessions(limit: Int? = null) {
    scope.launch { fetchSessions(limit = limit) }
  }

  /** Persists the normalized thinking level used for subsequent chat sends. */
  fun setThinkingLevel(thinkingLevel: String) {
    val normalized = normalizeThinking(thinkingLevel)
    if (normalized == _thinkingLevel.value) return
    _thinkingLevel.value = normalized
  }

  /** Switches to another gateway chat session and starts a fresh history load. */
  fun switchSession(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key.isEmpty()) return
    if (key == _sessionKey.value) return
    val generation = beginHistoryLoad(key, clearMessages = true)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = false)
    }
  }

  private fun beginHistoryLoad(
    key: String,
    clearMessages: Boolean,
  ): Long {
    val generation = historyLoadGeneration.incrementAndGet()
    _sessionKey.value = key
    _errorText.value = null
    _healthOk.value = false
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null
    _historyLoading.value = true
    if (clearMessages) {
      _messages.value = emptyList()
    }
    return generation
  }

  private fun normalizeRequestedSessionKey(sessionKey: String): String {
    val key = sessionKey.trim()
    if (key.isEmpty()) return appliedMainSessionKey
    if (key == "main" && appliedMainSessionKey != "main") return appliedMainSessionKey
    return key
  }

  /** Queues a chat send without waiting for gateway acceptance. */
  fun sendMessage(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ) {
    scope.launch {
      sendMessageAwaitAcceptance(
        message = message,
        thinkingLevel = thinkingLevel,
        attachments = attachments,
      )
    }
  }

  /** Sends a chat message and returns once the gateway accepts or rejects the request. */
  suspend fun sendMessageAwaitAcceptance(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean {
    val trimmed = message.trim()
    if (trimmed.isEmpty() && attachments.isEmpty()) return false
    if (!_healthOk.value) {
      _errorText.value = "Gateway health not OK; cannot send"
      return false
    }

    val runId = UUID.randomUUID().toString()
    val text = if (trimmed.isEmpty() && attachments.isNotEmpty()) "See attached." else trimmed
    val sessionKey = _sessionKey.value
    val thinking = normalizeThinking(thinkingLevel)

    // Optimistic user message keeps the composer responsive while chat.send and history refresh complete.
    val userContent =
      buildList {
        add(ChatMessageContent(type = "text", text = text))
        for (att in attachments) {
          add(
            ChatMessageContent(
              type = att.type,
              mimeType = att.mimeType,
              fileName = att.fileName,
              base64 = att.base64,
            ),
          )
        }
      }
    val optimisticMessage =
      ChatMessage(
        id = UUID.randomUUID().toString(),
        role = "user",
        content = userContent,
        timestampMs = System.currentTimeMillis(),
      )
    optimisticMessagesByRunId[runId] = optimisticMessage
    _messages.value = _messages.value + optimisticMessage

    armPendingRunTimeout(runId)
    synchronized(pendingRuns) {
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }

    _errorText.value = null
    _streamingAssistantText.value = null
    pendingToolCallsById.clear()
    publishPendingToolCalls()

    return try {
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(sessionKey))
          put("message", JsonPrimitive(text))
          put("thinking", JsonPrimitive(thinking))
          put("timeoutMs", JsonPrimitive(30_000))
          put("idempotencyKey", JsonPrimitive(runId))
          if (attachments.isNotEmpty()) {
            put(
              "attachments",
              JsonArray(
                attachments.map { att ->
                  buildJsonObject {
                    put("type", JsonPrimitive(att.type))
                    put("mimeType", JsonPrimitive(att.mimeType))
                    put("fileName", JsonPrimitive(att.fileName))
                    put("content", JsonPrimitive(att.base64))
                  }
                },
              ),
            )
          }
        }
      val res = session.request("chat.send", params.toString())
      val actualRunId = parseRunId(res) ?: runId
      if (actualRunId != runId) {
        // Gateway may return a canonical run id; move all pending bookkeeping to that id.
        optimisticMessagesByRunId[actualRunId] = optimisticMessagesByRunId.remove(runId) ?: optimisticMessage
        clearPendingRun(runId)
        armPendingRunTimeout(actualRunId)
        synchronized(pendingRuns) {
          pendingRuns.add(actualRunId)
          _pendingRunCount.value = pendingRuns.size
        }
      }
      true
    } catch (err: Throwable) {
      clearPendingRun(runId)
      removeOptimisticMessage(runId)
      _errorText.value = err.message
      false
    }
  }

  /** Sends best-effort abort requests for every currently pending gateway run. */
  fun abort() {
    val runIds =
      synchronized(pendingRuns) {
        pendingRuns.toList()
      }
    if (runIds.isEmpty()) return
    scope.launch {
      for (runId in runIds) {
        try {
          val params =
            buildJsonObject {
              put("sessionKey", JsonPrimitive(_sessionKey.value))
              put("runId", JsonPrimitive(runId))
            }
          session.request("chat.abort", params.toString())
        } catch (_: Throwable) {
          // best-effort
        }
      }
    }
  }

  /** Applies gateway chat/agent stream events to local transcript and pending-run state. */
  fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    when (event) {
      "tick" -> {
        scope.launch { pollHealthIfNeeded(force = false) }
      }
      "health" -> {
        // If we receive a health snapshot, the gateway is reachable.
        _healthOk.value = true
      }
      "seqGap" -> {
        _errorText.value = "Event stream interrupted; try refreshing."
        clearPendingRuns()
      }
      "chat" -> {
        if (payloadJson.isNullOrBlank()) return
        handleChatEvent(payloadJson)
      }
      "agent" -> {
        if (payloadJson.isNullOrBlank()) return
        handleAgentEvent(payloadJson)
      }
    }
  }

  private suspend fun bootstrap(
    sessionKey: String,
    generation: Long,
    forceHealth: Boolean,
    refreshSessions: Boolean,
  ) {
    try {
      val historyJson =
        session.request(
          "chat.history",
          buildJsonObject { put("sessionKey", JsonPrimitive(sessionKey)) }.toString(),
        )
      if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return
      val history = parseHistory(historyJson, sessionKey = sessionKey, previousMessages = _messages.value)
      _messages.value = mergeOptimisticMessages(incoming = history.messages, optimistic = optimisticMessagesByRunId.values)
      _sessionId.value = history.sessionId
      _historyLoading.value = false
      history.thinkingLevel
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?.let { _thinkingLevel.value = it }

      pollHealthIfNeeded(force = forceHealth)
      if (refreshSessions) {
        fetchSessions(limit = 50)
      }
    } catch (err: Throwable) {
      if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return
      _errorText.value = err.message
      _historyLoading.value = false
    }
  }

  private suspend fun fetchSessions(limit: Int?) {
    try {
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          if (limit != null && limit > 0) put("limit", JsonPrimitive(limit))
        }
      val res = session.request("sessions.list", params.toString())
      _sessions.value = parseSessions(res)
    } catch (_: Throwable) {
      // best-effort
    }
  }

  private suspend fun pollHealthIfNeeded(force: Boolean) {
    val now = System.currentTimeMillis()
    val last = lastHealthPollAtMs
    if (!force && last != null && now - last < 10_000) return
    lastHealthPollAtMs = now
    try {
      session.request("health", null)
      _healthOk.value = true
    } catch (_: Throwable) {
      _healthOk.value = false
    }
  }

  private fun handleChatEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return

    val runId = payload["runId"].asStringOrNull()
    val isPending =
      if (runId != null) synchronized(pendingRuns) { pendingRuns.contains(runId) } else true

    val state = payload["state"].asStringOrNull()
    when (state) {
      "delta" -> {
        // Only show streaming text for runs we initiated in this controller.
        if (!isPending) return
        val text = parseAssistantDeltaText(payload)
        if (!text.isNullOrEmpty()) {
          _streamingAssistantText.value = text
        }
      }
      "final", "aborted", "error" -> {
        if (state == "error") {
          _errorText.value = payload["errorMessage"].asStringOrNull() ?: "Chat failed"
        }
        if (runId != null) {
          clearPendingRun(runId)
          optimisticMessagesByRunId.remove(runId)
        } else {
          clearPendingRuns()
          optimisticMessagesByRunId.clear()
        }
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        scope.launch {
          try {
            val currentSessionKey = _sessionKey.value
            val currentGeneration = historyLoadGeneration.get()
            val historyJson =
              session.request(
                "chat.history",
                buildJsonObject { put("sessionKey", JsonPrimitive(currentSessionKey)) }.toString(),
              )
            if (
              !isCurrentHistoryLoad(
                currentSessionKey,
                _sessionKey.value,
                currentGeneration,
                historyLoadGeneration.get(),
              )
            ) {
              return@launch
            }
            val history =
              parseHistory(
                historyJson,
                sessionKey = currentSessionKey,
                previousMessages = _messages.value,
              )
            _messages.value = mergeOptimisticMessages(incoming = history.messages, optimistic = optimisticMessagesByRunId.values)
            _sessionId.value = history.sessionId
            history.thinkingLevel
              ?.trim()
              ?.takeIf { it.isNotEmpty() }
              ?.let { _thinkingLevel.value = it }
          } catch (_: Throwable) {
            // best-effort
          }
        }
      }
    }
  }

  private fun handleAgentEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return

    val stream = payload["stream"].asStringOrNull()
    val data = payload["data"].asObjectOrNull()

    when (stream) {
      "assistant" -> {
        val text = data?.get("text")?.asStringOrNull()
        if (!text.isNullOrEmpty()) {
          _streamingAssistantText.value = text
        }
      }
      "tool" -> {
        val phase = data?.get("phase")?.asStringOrNull()
        val name = data?.get("name")?.asStringOrNull()
        val toolCallId = data?.get("toolCallId")?.asStringOrNull()
        if (phase.isNullOrEmpty() || name.isNullOrEmpty() || toolCallId.isNullOrEmpty()) return

        val ts = payload["ts"].asLongOrNull() ?: System.currentTimeMillis()
        if (phase == "start") {
          val args = data.get("args").asObjectOrNull()
          pendingToolCallsById[toolCallId] =
            ChatPendingToolCall(
              toolCallId = toolCallId,
              name = name,
              args = args,
              startedAtMs = ts,
              isError = null,
            )
          publishPendingToolCalls()
        } else if (phase == "result") {
          pendingToolCallsById.remove(toolCallId)
          publishPendingToolCalls()
        }
      }
      "error" -> {
        _errorText.value = "Event stream interrupted; try refreshing."
        clearPendingRuns()
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
      }
    }
  }

  private fun parseAssistantDeltaText(payload: JsonObject): String? {
    val message = payload["message"].asObjectOrNull() ?: return null
    if (message["role"].asStringOrNull() != "assistant") return null
    val content = message["content"].asArrayOrNull() ?: return null
    for (item in content) {
      val obj = item.asObjectOrNull() ?: continue
      if (obj["type"].asStringOrNull() != "text") continue
      val text = obj["text"].asStringOrNull()
      if (!text.isNullOrEmpty()) {
        return text
      }
    }
    return null
  }

  private fun publishPendingToolCalls() {
    _pendingToolCalls.value =
      pendingToolCallsById.values.sortedBy { it.startedAtMs }
  }

  private fun armPendingRunTimeout(runId: String) {
    pendingRunTimeoutJobs[runId]?.cancel()
    pendingRunTimeoutJobs[runId] =
      scope.launch {
        delay(pendingRunTimeoutMs)
        val stillPending =
          synchronized(pendingRuns) {
            pendingRuns.contains(runId)
          }
        if (!stillPending) return@launch
        clearPendingRun(runId)
        removeOptimisticMessage(runId)
        _errorText.value = "Timed out waiting for a reply; try again or refresh."
      }
  }

  private fun clearPendingRun(runId: String) {
    pendingRunTimeoutJobs.remove(runId)?.cancel()
    synchronized(pendingRuns) {
      pendingRuns.remove(runId)
      _pendingRunCount.value = pendingRuns.size
    }
  }

  private fun clearPendingRuns() {
    for ((_, job) in pendingRunTimeoutJobs) {
      job.cancel()
    }
    pendingRunTimeoutJobs.clear()
    optimisticMessagesByRunId.clear()
    synchronized(pendingRuns) {
      pendingRuns.clear()
      _pendingRunCount.value = 0
    }
  }

  private fun removeOptimisticMessage(runId: String) {
    val message = optimisticMessagesByRunId.remove(runId) ?: return
    _messages.value = _messages.value.filterNot { it.id == message.id }
  }

  private fun parseHistory(
    historyJson: String,
    sessionKey: String,
    previousMessages: List<ChatMessage>,
  ): ChatHistory {
    val root = json.parseToJsonElement(historyJson).asObjectOrNull() ?: return ChatHistory(sessionKey, null, null, emptyList())
    val sid = root["sessionId"].asStringOrNull()
    val thinkingLevel = root["thinkingLevel"].asStringOrNull()
    val array = root["messages"].asArrayOrNull() ?: JsonArray(emptyList())

    val messages =
      array.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val role = obj["role"].asStringOrNull() ?: return@mapNotNull null
        val content = obj["content"].asArrayOrNull()?.mapNotNull(::parseChatMessageContent) ?: emptyList()
        val ts = obj["timestamp"].asLongOrNull()
        ChatMessage(
          id = UUID.randomUUID().toString(),
          role = role,
          content = content,
          timestampMs = ts,
        )
      }

    return ChatHistory(
      sessionKey = sessionKey,
      sessionId = sid,
      thinkingLevel = thinkingLevel,
      messages = reconcileMessageIds(previous = previousMessages, incoming = messages),
    )
  }

  private fun parseSessions(jsonString: String): List<ChatSessionEntry> {
    val root = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return emptyList()
    val sessions = root["sessions"].asArrayOrNull() ?: return emptyList()
    return sessions.mapNotNull { item ->
      val obj = item.asObjectOrNull() ?: return@mapNotNull null
      val key = obj["key"].asStringOrNull()?.trim().orEmpty()
      if (key.isEmpty()) return@mapNotNull null
      val updatedAt = obj["updatedAt"].asLongOrNull()
      val displayName = obj["displayName"].asStringOrNull()?.trim()
      ChatSessionEntry(key = key, updatedAtMs = updatedAt, displayName = displayName)
    }
  }

  private fun parseRunId(resJson: String): String? =
    try {
      json
        .parseToJsonElement(resJson)
        .asObjectOrNull()
        ?.get("runId")
        .asStringOrNull()
    } catch (_: Throwable) {
      null
    }

  private fun normalizeThinking(raw: String): String =
    when (raw.trim().lowercase()) {
      "low" -> "low"
      "medium" -> "medium"
      "high" -> "high"
      else -> "off"
    }
}

internal fun isCurrentHistoryLoad(
  requestedSessionKey: String,
  currentSessionKey: String,
  requestGeneration: Long,
  activeGeneration: Long,
): Boolean = requestedSessionKey == currentSessionKey && requestGeneration == activeGeneration

/**
 * Convert gateway chat content parts into Android UI content parts.
 */
internal fun parseChatMessageContent(el: JsonElement): ChatMessageContent? {
  val obj = el.asObjectOrNull() ?: return null
  return when (obj["type"].asStringOrNull() ?: "text") {
    "text", "input_text", "output_text" ->
      ChatMessageContent(
        type = "text",
        text = obj["text"].asStringOrNull() ?: obj["content"].asStringOrNull(),
      )

    "image" ->
      ChatMessageContent(
        type = "image",
        mimeType = obj["mimeType"].asStringOrNull(),
        fileName = obj["fileName"].asStringOrNull(),
        base64 = obj["content"].asStringOrNull()?.takeIf { it.isNotBlank() },
      )

    else -> null
  }
}

internal data class MainSessionState(
  val currentSessionKey: String,
  val appliedMainSessionKey: String,
)

/**
 * Rewrite only the active "main" alias when the gateway publishes a new canonical main session key.
 */
internal fun applyMainSessionKey(
  currentSessionKey: String,
  appliedMainSessionKey: String,
  nextMainSessionKey: String,
): MainSessionState {
  if (currentSessionKey == appliedMainSessionKey) {
    return MainSessionState(
      currentSessionKey = nextMainSessionKey,
      appliedMainSessionKey = nextMainSessionKey,
    )
  }
  return MainSessionState(
    currentSessionKey = currentSessionKey,
    appliedMainSessionKey = nextMainSessionKey,
  )
}

/**
 * Keep Compose item identity stable across history refreshes by matching existing messages to incoming copies.
 */
internal fun reconcileMessageIds(
  previous: List<ChatMessage>,
  incoming: List<ChatMessage>,
): List<ChatMessage> {
  if (previous.isEmpty() || incoming.isEmpty()) return incoming

  val idsByKey = LinkedHashMap<String, ArrayDeque<String>>()
  for (message in previous) {
    val key = messageIdentityKey(message) ?: continue
    idsByKey.getOrPut(key) { ArrayDeque() }.addLast(message.id)
  }

  return incoming.map { message ->
    val key = messageIdentityKey(message) ?: return@map message
    val ids = idsByKey[key] ?: return@map message
    val reusedId = ids.removeFirstOrNull() ?: return@map message
    if (ids.isEmpty()) {
      idsByKey.remove(key)
    }
    if (reusedId == message.id) return@map message
    message.copy(id = reusedId)
  }
}

internal fun mergeOptimisticMessages(
  incoming: List<ChatMessage>,
  optimistic: Collection<ChatMessage>,
): List<ChatMessage> {
  if (optimistic.isEmpty()) return incoming

  val unmatchedIncoming = incoming.toMutableList()
  val missingOptimistic =
    optimistic.filter { message ->
      val matchIndex =
        unmatchedIncoming.indexOfFirst { incomingMessage ->
          incomingMessageConsumesOptimistic(incomingMessage, message)
        }
      if (matchIndex >= 0) {
        unmatchedIncoming.removeAt(matchIndex)
        false
      } else {
        true
      }
    }
  if (missingOptimistic.isEmpty()) return incoming

  return (incoming + missingOptimistic).sortedWith(compareBy<ChatMessage> { it.timestampMs ?: Long.MAX_VALUE }.thenBy { it.id })
}

/**
 * Message identity used only for refresh reconciliation; it avoids exposing gateway ids as UI keys.
 */
internal fun messageIdentityKey(message: ChatMessage): String? {
  val contentKey = messageContentIdentityKey(message) ?: return null
  val timestamp = message.timestampMs?.toString().orEmpty()
  if (timestamp.isEmpty() && contentKey.isEmpty()) return null
  return listOf(contentKey, timestamp).joinToString(separator = "|")
}

private fun optimisticMessageIdentityKey(message: ChatMessage): String? = messageContentIdentityKey(message)

private fun incomingMessageConsumesOptimistic(
  incoming: ChatMessage,
  optimistic: ChatMessage,
): Boolean {
  if (optimisticMessageIdentityKey(incoming) != optimisticMessageIdentityKey(optimistic)) return false
  val incomingTimestamp = incoming.timestampMs ?: return false
  val optimisticTimestamp = optimistic.timestampMs ?: return true
  return incomingTimestamp >= optimisticTimestamp
}

private fun messageContentIdentityKey(message: ChatMessage): String? {
  val role = message.role.trim().lowercase()
  if (role.isEmpty()) return null

  val contentFingerprint =
    message.content.joinToString(separator = "\u001E") { part ->
      listOf(
        part.type.trim().lowercase(),
        part.text?.trim().orEmpty(),
        part.mimeType
          ?.trim()
          ?.lowercase()
          .orEmpty(),
        part.fileName?.trim().orEmpty(),
        part.base64
          ?.hashCode()
          ?.toString()
          .orEmpty(),
      ).joinToString(separator = "\u001F")
    }

  return listOf(role, contentFingerprint).joinToString(separator = "|")
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

private fun JsonElement?.asLongOrNull(): Long? =
  when (this) {
    is JsonPrimitive -> content.toLongOrNull()
    else -> null
  }
