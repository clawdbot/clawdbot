package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID

internal data class WearProxyStatus(
  val connected: Boolean,
  val activeAgentId: String?,
  val activeSessionKey: String?,
  val selectedModelRef: String?,
  val capabilities: Set<WearProxyCapability>,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearAgent(
  val id: String,
  val name: String,
  val emoji: String?,
  val selected: Boolean,
)

internal data class WearAgentList(
  val agents: List<WearAgent>,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearSession(
  val key: String,
  val title: String?,
  val updatedAt: Long?,
  val hasActiveRun: Boolean,
  val phoneNodeId: String,
  val agentId: String? = null,
  val modelRef: String? = null,
)

internal data class WearSessionList(
  val sessions: List<WearSession>,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
  val activeAgentId: String? = null,
  val selectedSessionValid: Boolean = false,
)

internal data class WearModel(
  val ref: String,
  val name: String,
)

internal data class WearModelList(
  val models: List<WearModel>,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearModelSelection(
  val selectedModelRef: String,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearChatMessage(
  val id: String?,
  val role: String,
  val text: String,
  val timestamp: Long?,
)

internal data class WearTranscript(
  val sessionKey: String,
  val messages: List<WearChatMessage>,
  val activeRunId: String?,
  val activeText: String?,
  val selectedModelRef: String?,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearChatEvent(
  val sessionKey: String?,
  val runId: String?,
  val state: String?,
  val deltaText: String?,
  val replace: Boolean,
  val streamText: String?,
  val streamTextComplete: Boolean,
  val message: WearChatMessage?,
)

internal data class WearSendAttempt(
  val sessionKey: String,
  val message: String,
  val idempotencyKey: String,
  val phoneNodeId: String,
)

internal class WearSendAttemptTracker(
  private val newId: () -> String = { UUID.randomUUID().toString() },
) {
  private var ambiguousAttempt: WearSendAttempt? = null

  fun begin(
    sessionKey: String,
    message: String,
    phoneNodeId: String,
  ): WearSendAttempt {
    ambiguousAttempt
      ?.takeIf { it.sessionKey == sessionKey && it.message == message && it.phoneNodeId == phoneNodeId }
      ?.let { return it }
    ambiguousAttempt = null
    return WearSendAttempt(sessionKey, message, "wear-${newId()}", phoneNodeId)
  }

  fun markAmbiguous(attempt: WearSendAttempt) {
    ambiguousAttempt = attempt
  }

  fun markSucceeded(attempt: WearSendAttempt) {
    if (ambiguousAttempt == attempt) ambiguousAttempt = null
  }
}

internal class WearGatewayRepository(
  private val requester: WearRpcRequester,
) {
  suspend fun status(expectedNodeId: String? = null): WearProxyStatus {
    val response = requester.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId)
    val result = response.payload.asObject("proxy.status")
    return WearProxyStatus(
      connected = result.boolean("connected") ?: false,
      activeAgentId = result.string("activeAgentId"),
      activeSessionKey = result.string("activeSessionKey"),
      selectedModelRef = result.string("selectedModelRef"),
      capabilities = result.proxyCapabilities(),
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun agents(
    expectedNodeId: String,
    capabilities: Set<WearProxyCapability>,
  ): WearAgentList {
    capabilities.require(WearProxyCapability.AgentControls)
    val response =
      requester.request(
        WearRpcMethod.AgentsList,
        buildJsonObject {},
        expectedNodeId,
        requirePreferredNode = true,
      )
    val result = response.payload.asObject("agents.list")
    return WearAgentList(
      agents =
        (result["agents"] as? JsonArray)
          .orEmpty()
          .mapNotNull(::parseAgent),
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun selectAgent(
    agentId: String,
    phoneNodeId: String,
    capabilities: Set<WearProxyCapability>,
  ) {
    capabilities.require(WearProxyCapability.AgentControls)
    requester.request(
      WearRpcMethod.AgentsSelect,
      buildJsonObject { put("agentId", agentId) },
      phoneNodeId,
      requirePreferredNode = true,
    )
  }

  suspend fun models(
    expectedNodeId: String,
    capabilities: Set<WearProxyCapability>,
    selectedModelRef: String? = null,
  ): WearModelList {
    capabilities.require(WearProxyCapability.ModelControls)
    val response =
      requester.request(
        WearRpcMethod.ModelsList,
        buildJsonObject {
          selectedModelRef?.let { put("selectedModelRef", it) }
        },
        expectedNodeId,
        requirePreferredNode = true,
      )
    val result = response.payload.asObject("models.list")
    return WearModelList(
      models =
        (result["models"] as? JsonArray)
          .orEmpty()
          .mapNotNull(::parseModel),
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun selectModel(
    sessionKey: String,
    modelRef: String,
    phoneNodeId: String,
    capabilities: Set<WearProxyCapability>,
  ): WearModelSelection {
    capabilities.require(WearProxyCapability.ModelControls)
    val response =
      requester.request(
        WearRpcMethod.ModelsSelect,
        buildJsonObject {
          put("sessionKey", sessionKey)
          put("modelRef", modelRef)
        },
        phoneNodeId,
        requirePreferredNode = true,
      )
    val selectedModelRef =
      response.payload
        .asObject("models.select")
        .string("selectedModelRef")
        ?: throw WearProxyException("invalid_response", "models.select returned invalid data")
    return WearModelSelection(
      selectedModelRef = selectedModelRef,
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun setGatewayEnabled(
    enabled: Boolean,
    phoneNodeId: String,
    capabilities: Set<WearProxyCapability>,
  ): WearProxyStatus {
    capabilities.require(WearProxyCapability.GatewayControls)
    val method = if (enabled) WearRpcMethod.GatewayConnect else WearRpcMethod.GatewayDisconnect
    val response =
      requester.request(
        method,
        buildJsonObject {},
        phoneNodeId,
        requirePreferredNode = true,
      )
    val result = response.payload.asObject(if (enabled) "gateway.connect" else "gateway.disconnect")
    return WearProxyStatus(
      connected = result.boolean("connected") ?: false,
      activeAgentId = result.string("activeAgentId"),
      activeSessionKey = result.string("activeSessionKey"),
      selectedModelRef = result.string("selectedModelRef"),
      capabilities = result.proxyCapabilities(),
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun sessions(
    expectedNodeId: String? = null,
    selectedSessionKey: String? = null,
    capabilities: Set<WearProxyCapability> = emptySet(),
  ): WearSessionList {
    val response =
      requester
        .request(
          WearRpcMethod.SessionsList,
          buildJsonObject {
            put("limit", 30)
            if (WearProxyCapability.SessionSelectionLookup in capabilities) {
              selectedSessionKey?.takeIf(String::isNotBlank)?.let { put("selectedSessionKey", it) }
            }
          },
          expectedNodeId,
        )
    val result = response.payload.asObject("sessions.list")
    return WearSessionList(
      sessions =
        (result["sessions"] as? JsonArray)
          .orEmpty()
          .mapNotNull { parseSession(it, response.sourceNodeId) },
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
      activeAgentId = result.string("activeAgentId"),
      selectedSessionValid = result.boolean("selectedSessionValid") ?: false,
    )
  }

  suspend fun history(
    sessionKey: String,
    expectedNodeId: String,
  ): WearTranscript {
    val response =
      requester
        .request(
          WearRpcMethod.ChatHistory,
          buildJsonObject {
            put("sessionKey", sessionKey)
            put("limit", 20)
            put("maxChars", 2_000)
          },
          expectedNodeId,
        )
    val result = response.payload.asObject("chat.history")
    val inFlight = result["inFlightRun"] as? JsonObject
    return WearTranscript(
      sessionKey = result.string("sessionKey") ?: sessionKey,
      messages = (result["messages"] as? JsonArray).orEmpty().mapNotNull(::parseChatMessage),
      activeRunId = inFlight?.string("runId"),
      activeText = inFlight?.string("text"),
      selectedModelRef = result.string("selectedModelRef"),
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun send(
    attempt: WearSendAttempt,
    requirePreferredPhone: Boolean = false,
  ) {
    requester.request(
      WearRpcMethod.ChatSend,
      buildJsonObject {
        put("sessionKey", attempt.sessionKey)
        put("message", attempt.message)
        put("idempotencyKey", attempt.idempotencyKey)
      },
      attempt.phoneNodeId,
      requirePreferredNode = requirePreferredPhone,
    )
  }

  suspend fun abort(
    sessionKey: String,
    runId: String?,
    phoneNodeId: String,
  ) {
    requester.request(
      WearRpcMethod.ChatAbort,
      buildJsonObject {
        put("sessionKey", sessionKey)
        runId?.let { put("runId", it) }
      },
      phoneNodeId,
      requirePreferredNode = true,
    )
  }

  suspend fun startRealtimeTalk(
    sessionKey: String,
    attemptId: String,
    language: String?,
    phoneNodeId: String,
  ): WearRealtimeTalkSnapshot {
    val response =
      requester.request(
        WearRpcMethod.TalkStart,
        buildJsonObject {
          put("sessionKey", sessionKey)
          put("attemptId", attemptId)
          language?.let { put("language", it) }
        },
        phoneNodeId,
        requirePreferredNode = true,
      )
    return WearRealtimeTalkCodec.decode(response.payload)
  }

  suspend fun stopRealtimeTalk(
    phoneNodeId: String,
    attemptId: String,
  ): WearRealtimeTalkSnapshot {
    val response =
      requester.request(
        WearRpcMethod.TalkStop,
        buildJsonObject { put("attemptId", attemptId) },
        phoneNodeId,
        requirePreferredNode = true,
      )
    return WearRealtimeTalkCodec.decode(response.payload)
  }
}

internal fun parseWearChatEvent(payload: JsonElement?): WearChatEvent? {
  val source = payload as? JsonObject ?: return null
  return WearChatEvent(
    sessionKey = source.string("sessionKey"),
    runId = source.string("runId"),
    state = source.string("state"),
    deltaText = source.string("deltaText"),
    replace = source.boolean("replace") ?: false,
    streamText = source.string("streamText"),
    streamTextComplete = source.boolean("streamTextComplete") ?: false,
    message = parseChatMessage(source["message"]),
  )
}

private fun parseSession(
  element: JsonElement,
  phoneNodeId: String,
): WearSession? {
  val source = element as? JsonObject ?: return null
  val key = source.string("key") ?: return null
  val title =
    source.string("displayName")
      ?: source.string("label")
      ?: key.substringAfterLast(':').ifBlank { "Session" }
  return WearSession(
    key = key,
    title = title,
    updatedAt = source.long("updatedAt") ?: source.long("lastActivityAt"),
    hasActiveRun = source.boolean("hasActiveRun") ?: false,
    phoneNodeId = phoneNodeId,
    agentId = source.string("agentId"),
    modelRef = source.string("modelRef"),
  )
}

private fun parseModel(element: JsonElement): WearModel? {
  val source = element as? JsonObject ?: return null
  val ref = source.string("ref") ?: return null
  return WearModel(
    ref = ref,
    name = source.string("name") ?: ref,
  )
}

private fun parseAgent(element: JsonElement): WearAgent? {
  val source = element as? JsonObject ?: return null
  val id = source.string("id") ?: return null
  return WearAgent(
    id = id,
    name = source.string("name") ?: id,
    emoji = source.string("emoji"),
    selected = source.boolean("selected") ?: false,
  )
}

internal fun parseChatMessage(element: JsonElement?): WearChatMessage? {
  val source = element as? JsonObject ?: return null
  val role = source.string("role") ?: return null
  val text = contentText(source["content"])
  if (text.isBlank()) return null
  return WearChatMessage(
    id = source.string("id"),
    role = role,
    text = text,
    timestamp = source.long("timestamp"),
  )
}

private fun contentText(element: JsonElement?): String =
  when (element) {
    is JsonPrimitive -> element.contentOrNull.orEmpty()
    is JsonArray ->
      element
        .mapNotNull { part ->
          when (part) {
            is JsonPrimitive -> part.contentOrNull
            is JsonObject -> part.string("text")
            else -> null
          }
        }.filter { it.isNotBlank() }
        .joinToString("\n")
    else -> ""
  }

private fun JsonElement.asObject(method: String): JsonObject = this as? JsonObject ?: throw WearProxyException("invalid_response", "$method returned invalid data")

private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.boolean(name: String): Boolean? = (this[name] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private fun JsonObject.long(name: String): Long? = (this[name] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull

private fun JsonObject.proxyCapabilities(): Set<WearProxyCapability> =
  (this["capabilities"] as? JsonArray)
    .orEmpty()
    .mapNotNull { element ->
      (element as? JsonPrimitive)
        ?.takeIf(JsonPrimitive::isString)
        ?.contentOrNull
        ?.let(WearProxyCapability::fromWireValue)
    }.toSet()

private fun Set<WearProxyCapability>.require(capability: WearProxyCapability) {
  if (capability !in this) {
    // Old phones omit capability negotiation. Fail before sending an RPC they
    // cannot decode so the paired app remains usable during staggered updates.
    throw WearProxyException("unsupported_peer", "Update OpenClaw on the paired phone")
  }
}
