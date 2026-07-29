package ai.openclaw.app.wear

import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRpcError
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.Locale

internal class WearProxyGatewayException(
  val code: String,
  override val message: String,
) : IllegalStateException(message)

internal data class WearProxyAgent(
  val id: String,
  val name: String?,
  val emoji: String?,
)

internal data class WearProxyModel(
  val ref: String,
  val name: String,
)

internal class WearProxyController(
  private val requestGateway: suspend (method: String, params: JsonObject) -> JsonElement,
  private val isGatewayConnected: () -> Boolean,
  private val gatewayStatusText: () -> String,
  private val activeAgentId: () -> String? = { null },
  private val activeSessionKey: () -> String? = { null },
  private val selectedModelRef: () -> String? = { null },
  private val agents: () -> List<WearProxyAgent> = { emptyList() },
  private val selectGatewayAgent: suspend (agentId: String) -> Boolean = { false },
  private val models: () -> List<WearProxyModel> = { emptyList() },
  private val selectSessionModel: suspend (sessionKey: String, modelRef: String) -> Boolean = { _, _ -> false },
  private val connectGateway: suspend () -> Unit = {},
  private val disconnectGateway: suspend () -> Unit = {},
  private val startRealtimeTalk:
    suspend (nodeId: String, sessionKey: String, attemptId: String, language: String?) -> WearRealtimeTalkSnapshot? = { _, _, _, _ -> null },
  private val stopRealtimeTalk: suspend (nodeId: String, attemptId: String) -> WearRealtimeTalkSnapshot? = { _, _ -> null },
) {
  suspend fun handle(
    request: WearMessage.Request,
    sourceNodeId: String = "",
  ): WearMessage.Response =
    try {
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> proxyStatus(request.params)
          WearRpcMethod.SessionsList -> listSessions(request.params)
          WearRpcMethod.AgentsList -> listAgents(request.params)
          WearRpcMethod.AgentsSelect -> selectAgent(request.params)
          WearRpcMethod.ModelsList -> listModels(request.params)
          WearRpcMethod.ModelsSelect -> selectModel(request.params)
          WearRpcMethod.GatewayConnect -> gatewayConnect(request.params)
          WearRpcMethod.GatewayDisconnect -> gatewayDisconnect(request.params)
          WearRpcMethod.ChatHistory -> chatHistory(request.params)
          WearRpcMethod.ChatSend -> sendChat(request.params)
          WearRpcMethod.ChatAbort -> abortChat(request.params)
          WearRpcMethod.TalkStart -> talkStart(sourceNodeId, request.params)
          WearRpcMethod.TalkStop -> talkStop(sourceNodeId, request.params)
        }
      WearMessage.Response(requestId = request.requestId, ok = true, result = result)
    } catch (err: WearProxyInvalidRequest) {
      failure(request.requestId, code = "invalid_request", message = err.message ?: "Invalid Wear request")
    } catch (err: WearProxyGatewayException) {
      failure(request.requestId, code = err.code, message = err.message)
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      failure(request.requestId, code = "unavailable", message = "Phone gateway request failed")
    }

  private suspend fun talkStart(
    sourceNodeId: String,
    params: JsonObject,
  ): JsonElement {
    if (sourceNodeId.isBlank()) throw WearProxyInvalidRequest("Missing Watch node")
    params.requireOnly("sessionKey", "attemptId", "language")
    val sessionKey = params.stringParam("sessionKey", MAX_SESSION_KEY_CHARS)
    val attemptId = params.stringParam("attemptId", MAX_ATTEMPT_ID_CHARS)
    val language =
      params
        .optionalStringParam("language", 2)
        ?.lowercase(Locale.ROOT)
        ?.takeIf { value -> value.length == 2 && value.all { it in 'a'..'z' } }
        ?: if ("language" in params) throw WearProxyInvalidRequest("Invalid language") else null
    val snapshot =
      startRealtimeTalk(sourceNodeId, sessionKey, attemptId, language)
        ?: throw WearProxyGatewayException("action_rejected", "Real-Time Talk is unavailable")
    return WearRealtimeTalkCodec.encode(snapshot)
  }

  private suspend fun talkStop(
    sourceNodeId: String,
    params: JsonObject,
  ): JsonElement {
    if (sourceNodeId.isBlank()) throw WearProxyInvalidRequest("Missing Watch node")
    params.requireOnly("attemptId")
    val attemptId = params.stringParam("attemptId", MAX_ATTEMPT_ID_CHARS)
    val snapshot =
      stopRealtimeTalk(sourceNodeId, attemptId)
        ?: throw WearProxyGatewayException("action_rejected", "Real-Time Talk belongs to another Watch")
    return WearRealtimeTalkCodec.encode(snapshot)
  }

  private fun proxyStatus(params: JsonObject): JsonObject {
    params.requireOnly()
    return buildJsonObject {
      put("connected", isGatewayConnected())
      put("status", gatewayStatusText().takeCodePoints(MAX_STATUS_CHARS))
      put(
        "capabilities",
        buildJsonArray {
          WearProxyCapability.entries.forEach { capability -> add(JsonPrimitive(capability.wireValue)) }
        },
      )
      activeAgentId()?.takeIf(String::isNotBlank)?.let { put("activeAgentId", it.takeCodePoints(MAX_AGENT_ID_CHARS)) }
      activeSessionKey()?.takeIf(String::isNotBlank)?.let { put("activeSessionKey", it.takeCodePoints(MAX_SESSION_KEY_CHARS)) }
      canonicalModelRef(selectedModelRef())?.let { put("selectedModelRef", it) }
    }
  }

  private fun listAgents(params: JsonObject): JsonObject {
    params.requireOnly()
    val selected = activeAgentId()
    val availableAgents =
      agents().mapNotNull { agent ->
        agent.id
          .trim()
          .takeIf(String::isNotEmpty)
          ?.let { id -> id to agent }
      }
    val boundedAgents = availableAgents.take(MAX_AGENT_COUNT).toMutableList()
    availableAgents
      .firstOrNull { (id) -> id == selected }
      ?.takeIf { selectedAgent -> boundedAgents.none { (id) -> id == selectedAgent.first } }
      ?.let { selectedAgent ->
        if (boundedAgents.size == MAX_AGENT_COUNT) {
          boundedAgents[boundedAgents.lastIndex] = selectedAgent
        } else {
          boundedAgents += selectedAgent
        }
      }
    return buildJsonObject {
      put(
        "agents",
        buildJsonArray {
          boundedAgents.forEach { (id, agent) ->
            add(
              buildJsonObject {
                put("id", id.takeCodePoints(MAX_AGENT_ID_CHARS))
                agent.name?.takeIf(String::isNotBlank)?.let { put("name", it.takeCodePoints(MAX_AGENT_NAME_CHARS)) }
                agent.emoji?.takeIf(String::isNotBlank)?.let { put("emoji", it.takeCodePoints(MAX_AGENT_EMOJI_CHARS)) }
                put("selected", id == selected)
              },
            )
          }
        },
      )
    }
  }

  private suspend fun selectAgent(params: JsonObject): JsonObject {
    params.requireOnly("agentId")
    val agentId = params.stringParam("agentId", MAX_AGENT_ID_CHARS)
    if (!selectGatewayAgent(agentId)) {
      throw WearProxyGatewayException("not_found", "Agent is no longer available")
    }
    return buildJsonObject { put("activeAgentId", agentId) }
  }

  private fun listModels(params: JsonObject): JsonObject {
    params.requireOnly("selectedModelRef")
    val selected =
      canonicalModelRef(params.optionalStringParam("selectedModelRef", MAX_MODEL_REF_CHARS))
        ?: canonicalModelRef(selectedModelRef())
    val availableModels = availableModels()
    // The Watch picker moves one adjacent model at a time and reloads after each choice.
    // Centering keeps both directions reachable without exceeding the message cap.
    val selectedIndex = availableModels.indexOfFirst { (ref) -> ref == selected }
    val boundedModels =
      if (availableModels.size <= MAX_MODEL_COUNT || selectedIndex < 0) {
        availableModels.take(MAX_MODEL_COUNT)
      } else {
        val start =
          (selectedIndex - MAX_MODEL_COUNT / 2)
            .coerceIn(0, availableModels.size - MAX_MODEL_COUNT)
        availableModels.subList(start, start + MAX_MODEL_COUNT)
      }
    return buildJsonObject {
      put(
        "models",
        buildJsonArray {
          boundedModels.forEach { (ref, model) ->
            add(
              buildJsonObject {
                put("ref", ref)
                put("name", model.name.takeCodePoints(MAX_MODEL_NAME_CHARS))
              },
            )
          }
        },
      )
    }
  }

  private suspend fun selectModel(params: JsonObject): JsonObject {
    params.requireOnly("sessionKey", "modelRef")
    val sessionKey = params.stringParam("sessionKey", MAX_SESSION_KEY_CHARS)
    val modelRef =
      canonicalModelRef(params.stringParam("modelRef", MAX_MODEL_REF_CHARS))
        ?: throw WearProxyInvalidRequest("Invalid modelRef")
    if (availableModels().none { (ref) -> ref == modelRef }) {
      throw WearProxyGatewayException("not_found", "Model is no longer available")
    }
    if (!selectSessionModel(sessionKey, modelRef)) {
      throw WearProxyGatewayException("action_rejected", "Model could not be changed")
    }
    return buildJsonObject {
      put("sessionKey", sessionKey)
      put("selectedModelRef", modelRef)
    }
  }

  private fun availableModels(): List<Pair<String, WearProxyModel>> =
    models()
      .mapNotNull { model -> canonicalModelRef(model.ref)?.let { ref -> ref to model } }
      .distinctBy { (ref) -> ref }

  private fun canonicalModelRef(value: String?): String? =
    value
      ?.trim()
      ?.takeIf { ref -> ref.isNotEmpty() && ref.codePointCount() <= MAX_MODEL_REF_CHARS }

  private suspend fun gatewayConnect(params: JsonObject): JsonObject {
    params.requireOnly()
    connectGateway()
    return proxyStatus(buildJsonObject {})
  }

  private suspend fun gatewayDisconnect(params: JsonObject): JsonObject {
    params.requireOnly()
    disconnectGateway()
    return proxyStatus(buildJsonObject {})
  }

  private suspend fun listSessions(params: JsonObject): JsonObject {
    params.requireOnly("limit", "selectedSessionKey")
    val limit = params.intParam("limit", default = DEFAULT_SESSION_LIMIT, range = 1..MAX_SESSION_LIMIT)
    val selectedSessionKey = params.optionalStringParam("selectedSessionKey", MAX_SESSION_KEY_CHARS)
    val agentId = activeAgentId()?.trim()?.takeIf(String::isNotEmpty)
    val gatewayResult =
      requestGateway(
        "sessions.list",
        buildJsonObject {
          put("limit", limit)
          put("includeGlobal", false)
          put("includeUnknown", false)
          agentId?.let { put("agentId", it.takeCodePoints(MAX_AGENT_ID_CHARS)) }
        },
      ).asObject("sessions.list")
    val sessions =
      gatewayResult["sessions"]
        .asArrayOrNull()
        ?.mapNotNull { projectSession(it, agentId) }
        .orEmpty()
        .toMutableList()
    val selectedSessionValid =
      selectedSessionKey
        ?.takeIf { selectedKey -> sessions.none { session -> session.stringOrNull("key") == selectedKey } }
        ?.let { selectedKey ->
          val lookupResult =
            requestGateway(
              "sessions.resolve",
              buildJsonObject {
                put("key", selectedKey)
                put("allowMissing", true)
                put("includeGlobal", false)
                put("includeUnknown", false)
                agentId?.let { put("agentId", it.takeCodePoints(MAX_AGENT_ID_CHARS)) }
              },
            ).asObject("sessions.resolve")
          val resolvedKey = lookupResult.stringOrNull("key")
          lookupResult["ok"].booleanPrimitiveOrNull() == true &&
            resolvedKey == selectedKey &&
            agentId != null &&
            resolveAgentIdFromMainSessionKey(resolvedKey) == agentId
        } ?: false
    return buildJsonObject {
      put("sessions", JsonArray(sessions))
      agentId?.let { put("activeAgentId", it.takeCodePoints(MAX_AGENT_ID_CHARS)) }
      if (selectedSessionKey != null) put("selectedSessionValid", selectedSessionValid)
      gatewayResult["hasMore"].booleanPrimitiveOrNull()?.let { put("hasMore", it) }
      gatewayResult["totalCount"].longPrimitiveOrNull()?.let { put("totalCount", it) }
    }
  }

  private suspend fun chatHistory(params: JsonObject): JsonObject {
    params.requireOnly("sessionKey", "limit", "maxChars", "offset")
    val sessionKey = params.stringParam("sessionKey", MAX_SESSION_KEY_CHARS)
    val limit = params.intParam("limit", default = DEFAULT_HISTORY_LIMIT, range = 1..MAX_HISTORY_LIMIT)
    val maxChars = params.intParam("maxChars", default = DEFAULT_HISTORY_CHARS, range = 1..MAX_HISTORY_CHARS)
    val offset = params.optionalIntParam("offset", range = 0..MAX_HISTORY_OFFSET)
    val result =
      requestGateway(
        "chat.history",
        buildJsonObject {
          put("sessionKey", sessionKey)
          put("limit", limit)
          put("maxChars", maxChars)
          offset?.let { put("offset", it) }
        },
      ).asObject("chat.history")
    return projectHistory(result)
  }

  private suspend fun sendChat(params: JsonObject): JsonObject {
    params.requireOnly("sessionKey", "message", "idempotencyKey")
    val result =
      requestGateway(
        "chat.send",
        buildJsonObject {
          put("sessionKey", params.stringParam("sessionKey", MAX_SESSION_KEY_CHARS))
          put("message", params.stringParam("message", MAX_MESSAGE_CHARS))
          put("idempotencyKey", params.stringParam("idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS))
          put("deliver", false)
        },
      ).asObject("chat.send")
    return projectAck(result)
  }

  private suspend fun abortChat(params: JsonObject): JsonObject {
    params.requireOnly("sessionKey", "runId")
    val result =
      requestGateway(
        "chat.abort",
        buildJsonObject {
          put("sessionKey", params.stringParam("sessionKey", MAX_SESSION_KEY_CHARS))
          params.optionalStringParam("runId", MAX_RUN_ID_CHARS)?.let { put("runId", it) }
        },
      ).asObject("chat.abort")
    return projectAck(result)
  }

  private fun failure(
    requestId: String,
    code: String,
    message: String,
  ): WearMessage.Response =
    WearMessage.Response(
      requestId = requestId,
      ok = false,
      error = WearRpcError(code = code.takeCodePoints(MAX_ERROR_CODE_CHARS), message = message.takeCodePoints(MAX_ERROR_MESSAGE_CHARS)),
    )

  private companion object {
    const val DEFAULT_SESSION_LIMIT = 20
    const val MAX_SESSION_LIMIT = 50
    const val DEFAULT_HISTORY_LIMIT = 20
    const val MAX_HISTORY_LIMIT = 20
    const val DEFAULT_HISTORY_CHARS = 2_000
    const val MAX_HISTORY_CHARS = 2_000
    const val MAX_HISTORY_OFFSET = 100_000
    const val MAX_SESSION_KEY_CHARS = 512
    const val MAX_ATTEMPT_ID_CHARS = 128
    const val MAX_MESSAGE_CHARS = 4_000
    const val MAX_IDEMPOTENCY_KEY_CHARS = 128
    const val MAX_RUN_ID_CHARS = 128
    const val MAX_STATUS_CHARS = 200
    const val MAX_AGENT_COUNT = 32
    const val MAX_AGENT_ID_CHARS = 200
    const val MAX_AGENT_NAME_CHARS = 200
    const val MAX_AGENT_EMOJI_CHARS = 32
    const val MAX_MODEL_COUNT = 50
    const val MAX_MODEL_REF_CHARS = 200
    const val MAX_MODEL_NAME_CHARS = 200
    const val MAX_SESSION_LABEL_CHARS = 200
    const val MAX_EVENT_TEXT_CHARS = 2_000
    const val MAX_ERROR_CODE_CHARS = 64
    const val MAX_ERROR_MESSAGE_CHARS = 300
  }
}

internal fun projectWearChatEvent(payload: JsonElement): JsonObject? {
  val source = payload as? JsonObject ?: return null
  return buildJsonObject {
    copyString(source, "runId", MAX_RUN_ID_CHARS)
    copyString(source, "sessionKey", MAX_SESSION_KEY_CHARS)
    copyString(source, "agentId", MAX_SESSION_KEY_CHARS)
    copyLong(source, "seq")
    copyString(source, "state", 32)
    copyString(source, "deltaText", MAX_EVENT_TEXT_CHARS)
    copyBoolean(source, "replace")
    copyString(source, "errorMessage", MAX_ERROR_MESSAGE_CHARS)
    copyString(source, "stopReason", 100)
    projectMessage(source["message"])?.let { put("message", it) }
  }
}

internal fun projectedWearMessageText(message: JsonElement?): String? {
  val content = (message as? JsonObject)?.get("content")
  val text =
    when (content) {
      is JsonPrimitive -> content.contentOrNull
      is JsonArray ->
        content.joinToString(separator = "") { part ->
          when (part) {
            is JsonPrimitive -> part.contentOrNull.orEmpty()
            is JsonObject -> part.stringOrNull("text").orEmpty()
            else -> ""
          }
        }
      else -> null
    }
  return text?.takeIf { it.isNotEmpty() }
}

private fun projectHistory(source: JsonObject): JsonObject =
  buildJsonObject {
    copyString(source, "sessionKey", MAX_SESSION_KEY_CHARS)
    copyString(source, "sessionId", MAX_SESSION_KEY_CHARS)
    val messages = source["messages"].asArrayOrNull()?.mapNotNull(::projectMessage).orEmpty()
    put("messages", JsonArray(messages))
    copyLong(source, "offset")
    copyLong(source, "nextOffset")
    copyLong(source, "totalMessages")
    copyBoolean(source, "hasMore")
    ((source["sessionInfo"] as? JsonObject)?.providerQualifiedModelRef() ?: source.providerQualifiedModelRef())
      ?.let { put("selectedModelRef", it) }
    val inFlight = source["inFlightRun"] as? JsonObject
    if (inFlight != null) {
      put(
        "inFlightRun",
        buildJsonObject {
          copyString(inFlight, "runId", MAX_RUN_ID_CHARS)
          copyString(inFlight, "text", MAX_EVENT_TEXT_CHARS)
        },
      )
    }
  }

private fun projectSession(
  element: JsonElement,
  agentId: String?,
): JsonObject? {
  val source = element as? JsonObject ?: return null
  val key = source.stringOrNull("key") ?: source.stringOrNull("sessionKey") ?: return null
  return buildJsonObject {
    put("key", key.takeCodePoints(MAX_SESSION_KEY_CHARS))
    agentId?.let { put("agentId", it.takeCodePoints(MAX_PROJECTED_AGENT_ID_CHARS)) }
    copyString(source, "displayName", MAX_SESSION_LABEL_CHARS)
    copyString(source, "label", MAX_SESSION_LABEL_CHARS)
    copyLong(source, "updatedAt")
    copyLong(source, "lastActivityAt")
    copyBoolean(source, "pinned")
    copyBoolean(source, "unread")
    copyBoolean(source, "hasActiveRun")
    source.providerQualifiedModelRef()?.let { put("modelRef", it) }
  }
}

private fun projectMessage(element: JsonElement?): JsonObject? {
  val source = element as? JsonObject ?: return null
  val role = source.stringOrNull("role") ?: return null
  return buildJsonObject {
    copyString(source, "id", MAX_RUN_ID_CHARS)
    put("role", role.takeCodePoints(32))
    copyLong(source, "timestamp")
    copyString(source, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS)
    projectContent(source["content"])?.let { put("content", it) }
  }
}

private fun projectContent(content: JsonElement?): JsonElement? =
  when (content) {
    is JsonPrimitive -> content.contentOrNull?.let { JsonPrimitive(it.takeUtf8Bytes(MAX_PROJECTED_CONTENT_BYTES)) }
    is JsonArray ->
      buildJsonArray {
        var remainingBytes = MAX_PROJECTED_CONTENT_BYTES
        var partCount = 0
        for (part in content) {
          if (remainingBytes == 0 || partCount == MAX_PROJECTED_CONTENT_PARTS) break
          val text =
            when (part) {
              is JsonPrimitive -> part.contentOrNull
              is JsonObject -> {
                val type = part.stringOrNull("type")
                if (type != null && type != "text") continue
                part.stringOrNull("text")
              }
              else -> null
            } ?: continue
          val projectedText = text.takeUtf8Bytes(remainingBytes)
          if (projectedText.isEmpty() && text.isNotEmpty()) break

          // The Wear transport has one byte ceiling for the complete event. Bound text across
          // all parts so a terminal event remains encodable and can still carry its final state.
          if (part is JsonObject) {
            add(
              buildJsonObject {
                put("type", "text")
                put("text", projectedText)
              },
            )
          } else {
            add(JsonPrimitive(projectedText))
          }
          remainingBytes -= projectedText.toByteArray(Charsets.UTF_8).size
          partCount += 1
        }
      }
    else -> null
  }

private fun projectAck(source: JsonObject): JsonObject =
  buildJsonObject {
    copyString(source, "runId", MAX_RUN_ID_CHARS)
    copyString(source, "status", 64)
    copyBoolean(source, "aborted")
  }

private class WearProxyInvalidRequest(
  message: String,
) : IllegalArgumentException(message)

private fun JsonObject.requireOnly(vararg allowed: String) {
  val allowedNames = allowed.toSet()
  if (keys.any { it !in allowedNames }) throw WearProxyInvalidRequest("Unsupported Wear request field")
}

private fun JsonObject.stringParam(
  name: String,
  maxChars: Int,
): String {
  val value = stringOrNull(name) ?: throw WearProxyInvalidRequest("Missing $name")
  if (value.isBlank() || value.codePointCount() > maxChars) {
    throw WearProxyInvalidRequest("Invalid $name")
  }
  return value
}

private fun JsonObject.optionalStringParam(
  name: String,
  maxChars: Int,
): String? {
  if (name !in this) return null
  return stringParam(name, maxChars)
}

private fun JsonObject.intParam(
  name: String,
  default: Int,
  range: IntRange,
): Int = optionalIntParam(name, range) ?: default

private fun JsonObject.optionalIntParam(
  name: String,
  range: IntRange,
): Int? {
  if (name !in this) return null
  val primitive = this[name] as? JsonPrimitive
  val value = primitive?.takeUnless { it.isString }?.intOrNull
  if (value == null || value !in range) throw WearProxyInvalidRequest("Invalid $name")
  return value
}

private fun JsonElement.asObject(method: String): JsonObject = this as? JsonObject ?: throw WearProxyGatewayException("invalid_response", "$method returned an invalid response")

private fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

private fun JsonObject.stringOrNull(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.providerQualifiedModelRef(): String? {
  val model = stringOrNull("model")?.trim()?.takeIf(String::isNotEmpty) ?: return null
  val provider = stringOrNull("modelProvider")?.trim()?.takeIf(String::isNotEmpty)
  val ref = if (provider == null || model.startsWith("$provider/")) model else "$provider/$model"
  return ref.takeIf { it.codePointCount() <= MAX_PROJECTED_MODEL_REF_CHARS }
}

private fun JsonElement?.booleanPrimitiveOrNull(): Boolean? = (this as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private fun JsonElement?.longPrimitiveOrNull(): Long? = (this as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull

private fun kotlinx.serialization.json.JsonObjectBuilder.copyString(
  source: JsonObject,
  name: String,
  maxChars: Int,
) {
  source.stringOrNull(name)?.let { put(name, it.takeCodePoints(maxChars)) }
}

private fun kotlinx.serialization.json.JsonObjectBuilder.copyLong(
  source: JsonObject,
  name: String,
) {
  source[name].longPrimitiveOrNull()?.let { put(name, it) }
}

private fun kotlinx.serialization.json.JsonObjectBuilder.copyBoolean(
  source: JsonObject,
  name: String,
) {
  source[name].booleanPrimitiveOrNull()?.let { put(name, it) }
}

private fun String.codePointCount(): Int = codePointCount(0, length)

private fun String.takeCodePoints(maxCodePoints: Int): String {
  if (codePointCount() <= maxCodePoints) return this
  return substring(0, offsetByCodePoints(0, maxCodePoints))
}

private fun String.takeUtf8Bytes(maxBytes: Int): String {
  var end = 0
  var usedBytes = 0
  while (end < length) {
    val codePoint = codePointAt(end)
    val charCount = Character.charCount(codePoint)
    val byteCount =
      when {
        codePoint <= 0x7f -> 1
        codePoint <= 0x7ff -> 2
        codePoint <= 0xffff -> 3
        else -> 4
      }
    if (usedBytes + byteCount > maxBytes) break
    usedBytes += byteCount
    end += charCount
  }
  if (end == length) return this
  return substring(0, end)
}

private const val MAX_SESSION_KEY_CHARS = 512
private const val MAX_PROJECTED_AGENT_ID_CHARS = 200
private const val MAX_PROJECTED_MODEL_REF_CHARS = 200
private const val MAX_RUN_ID_CHARS = 128
private const val MAX_IDEMPOTENCY_KEY_CHARS = 128
private const val MAX_SESSION_LABEL_CHARS = 200
private const val MAX_EVENT_TEXT_CHARS = 2_000
private const val MAX_PROJECTED_CONTENT_BYTES = 1_024
private const val MAX_PROJECTED_CONTENT_PARTS = 20
private const val MAX_ERROR_MESSAGE_CHARS = 300
