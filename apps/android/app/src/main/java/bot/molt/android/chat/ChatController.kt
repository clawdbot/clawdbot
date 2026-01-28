package bot.molt.android.chat

import bot.molt.android.gateway.GatewaySession
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
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

class ChatController(
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val json: Json,
  private val supportsChatSubscribe: Boolean,
) {
  private val _sessionKey = MutableStateFlow("main")
  val sessionKey: StateFlow<String> = _sessionKey.asStateFlow()

  private val _sessionId = MutableStateFlow<String?>(null)
  val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

  private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
  val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

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
  private val pendingRunTimeoutMs = 120_000L

  private var lastHealthPollAtMs: Long? = null

  fun onDisconnected(message: String) {
    _healthOk.value = false
    // Not an error; keep connection status in the UI pill.
    _errorText.value = null
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null
  }

  fun load(sessionKey: String) {
    val key = sessionKey.trim().ifEmpty { "main" }
    _sessionKey.value = key
    scope.launch { bootstrap(forceHealth = true) }
  }

  fun applyMainSessionKey(mainSessionKey: String) {
    val trimmed = mainSessionKey.trim()
    if (trimmed.isEmpty()) return
    if (_sessionKey.value == trimmed) return
    if (_sessionKey.value != "main") return
    _sessionKey.value = trimmed
    scope.launch { bootstrap(forceHealth = true) }
  }

  fun refresh() {
    scope.launch { bootstrap(forceHealth = true) }
  }

  fun refreshSessions(limit: Int? = null) {
    scope.launch { fetchSessions(limit = limit) }
  }

  fun setThinkingLevel(thinkingLevel: String) {
    val normalized = normalizeThinking(thinkingLevel)
    if (normalized == _thinkingLevel.value) return
    _thinkingLevel.value = normalized
  }

  fun switchSession(sessionKey: String) {
    val key = sessionKey.trim()
    if (key.isEmpty()) return
    if (key == _sessionKey.value) return
    _sessionKey.value = key
    scope.launch { bootstrap(forceHealth = true) }
  }

  fun sendMessage(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ) {
    val trimmed = message.trim()
    if (trimmed.isEmpty() && attachments.isEmpty()) return
    if (!_healthOk.value) {
      _errorText.value = "Gateway health not OK; cannot send"
      return
    }

    val runId = UUID.randomUUID().toString()
    val text = if (trimmed.isEmpty() && attachments.isNotEmpty()) "See attached." else trimmed
    val sessionKey = _sessionKey.value
    val thinking = normalizeThinking(thinkingLevel)

    // Optimistic user message.
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
    _messages.value =
      _messages.value +
        ChatMessage(
          id = UUID.randomUUID().toString(),
          role = "user",
          content = userContent,
          timestampMs = System.currentTimeMillis(),
        )

    armPendingRunTimeout(runId)
    synchronized(pendingRuns) {
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }

    _errorText.value = null
    _streamingAssistantText.value = null
    pendingToolCallsById.clear()
    publishPendingToolCalls()

    scope.launch {
      try {
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
          clearPendingRun(runId)
          armPendingRunTimeout(actualRunId)
          synchronized(pendingRuns) {
            pendingRuns.add(actualRunId)
            _pendingRunCount.value = pendingRuns.size
          }
        }
      } catch (err: Throwable) {
        clearPendingRun(runId)
        _errorText.value = err.message
      }
    }
  }

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

  fun handleGatewayEvent(event: String, payloadJson: String?) {
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

  private suspend fun bootstrap(forceHealth: Boolean) {
    _errorText.value = null
    _healthOk.value = false
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null

    val key = _sessionKey.value
    try {
      if (supportsChatSubscribe) {
        try {
          session.sendNodeEvent("chat.subscribe", """{"sessionKey":"$key"}""")
        } catch (_: Throwable) {
          // best-effort
        }
      }

      val historyJson = session.request("chat.history", """{"sessionKey":"$key"}""")
      val history = parseHistory(historyJson, sessionKey = key)
      _messages.value = history.messages
      _sessionId.value = history.sessionId
      history.thinkingLevel?.trim()?.takeIf { it.isNotEmpty() }?.let { _thinkingLevel.value = it }

      pollHealthIfNeeded(force = forceHealth)
      fetchSessions(limit = 50)
    } catch (err: Throwable) {
      _errorText.value = err.message
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
    if (runId != null) {
      val isPending =
        synchronized(pendingRuns) {
          pendingRuns.contains(runId)
        }
      if (!isPending) return
    }

    val state = payload["state"].asStringOrNull()
    when (state) {
      "final", "aborted", "error" -> {
        if (state == "error") {
          _errorText.value = payload["errorMessage"].asStringOrNull() ?: "Chat failed"
        }
        if (runId != null) clearPendingRun(runId) else clearPendingRuns()
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        scope.launch {
          try {
            val historyJson =
              session.request("chat.history", """{"sessionKey":"${_sessionKey.value}"}""")
            val history = parseHistory(historyJson, sessionKey = _sessionKey.value)
            _messages.value = history.messages
            _sessionId.value = history.sessionId
            history.thinkingLevel?.trim()?.takeIf { it.isNotEmpty() }?.let { _thinkingLevel.value = it }
          } catch (_: Throwable) {
            // best-effort
          }
        }
      }
    }
  }

  private fun handleAgentEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val runId = payload["runId"].asStringOrNull()
    val sessionId = _sessionId.value
    if (sessionId != null && runId != sessionId) return

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
          val args = data?.get("args").asObjectOrNull()
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
    synchronized(pendingRuns) {
      pendingRuns.clear()
      _pendingRunCount.value = 0
    }
  }

  private fun parseHistory(historyJson: String, sessionKey: String): ChatHistory {
    val root = json.parseToJsonElement(historyJson).asObjectOrNull() ?: return ChatHistory(sessionKey, null, null, emptyList())
    val sid = root["sessionId"].asStringOrNull()
    val thinkingLevel = root["thinkingLevel"].asStringOrNull()
    val array = root["messages"].asArrayOrNull() ?: JsonArray(emptyList())

    val messages =
      array.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val role = obj["role"].asStringOrNull() ?: return@mapNotNull null
        val content = obj["content"].asArrayOrNull()?.mapNotNull(::parseMessageContent) ?: emptyList()
        val ts = obj["timestamp"].asLongOrNull()
        ChatMessage(
          id = UUID.randomUUID().toString(),
          role = role,
          content = content,
          timestampMs = ts,
        )
      }

    return ChatHistory(sessionKey = sessionKey, sessionId = sid, thinkingLevel = thinkingLevel, messages = messages)
  }

  private fun parseMessageContent(el: JsonElement): ChatMessageContent? {
    val obj = el.asObjectOrNull() ?: return null
    val type = obj["type"].asStringOrNull() ?: "text"
    return if (type == "text") {
      ChatMessageContent(type = "text", text = obj["text"].asStringOrNull())
    } else {
      ChatMessageContent(
        type = type,
        mimeType = obj["mimeType"].asStringOrNull(),
        fileName = obj["fileName"].asStringOrNull(),
        base64 = obj["content"].asStringOrNull(),
      )
    }
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

  private fun parseRunId(resJson: String): String? {
    return try {
      json.parseToJsonElement(resJson).asObjectOrNull()?.get("runId").asStringOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  private fun normalizeThinking(raw: String): String {
    return when (raw.trim().lowercase()) {
      "low" -> "low"
      "medium" -> "medium"
      "high" -> "high"
      else -> "off"
    }
  }
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
