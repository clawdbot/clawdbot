package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.CopyOnWriteArrayList

internal val chatControllerTestJson = Json { ignoreUnknownKeys = true }

internal fun CoroutineScope.createChatController(
  requestGatewayForGateway: (suspend (gatewayId: String, method: String, paramsJson: String?) -> String)? = null,
  captureRequestLease: ((gatewayScope: ChatCacheScope?) -> GatewaySession.RequestLease?)? = null,
  transcriptCache: ChatTranscriptCache? = null,
  cacheScope: () -> ChatCacheScope? = { null },
  currentDefaultAgentId: () -> String? = { "main" },
  currentDefaultAgentRevision: () -> Long = { 0L },
  gatewayAdvertisesMethod: (method: String) -> Boolean? = { null },
  gatewayAdvertisesCapability: (capability: String) -> Boolean? = { null },
  recordModelRecent: (String) -> Unit = {},
  onSessionDeleted: (ChatSessionDeletion) -> Unit = {},
  onOfflineDefaultAgentRestored: (String) -> Unit = {},
  onAssistantReplyFinalized: (owner: ChatComposerOwner, runId: String, text: String) -> Unit = { _, _, _ -> },
  requestGateway: suspend (method: String, paramsJson: String?) -> String = { _, _ -> "{}" },
): ChatController {
  val scopedRequest =
    requestGatewayForGateway ?: { _, method, paramsJson -> requestGateway(method, paramsJson) }
  val settingsLease =
    captureRequestLease ?: { gatewayScope ->
      GatewaySession.RequestLease(endpointStableId = gatewayScope?.gatewayId.orEmpty()) { method, paramsJson, _, withEnqueue ->
        withEnqueue {}
        if (gatewayScope == null) {
          requestGateway(method, paramsJson)
        } else {
          scopedRequest(gatewayScope.gatewayId, method, paramsJson)
        }
      }
    }
  return ChatController(
    scope = this,
    json = chatControllerTestJson,
    requestGateway = requestGateway,
    requestGatewayForGateway = scopedRequest,
    captureRequestLease = settingsLease,
    transcriptCache = transcriptCache,
    cacheScope = cacheScope,
    currentDefaultAgentId = currentDefaultAgentId,
    currentDefaultAgentRevision = currentDefaultAgentRevision,
    gatewayAdvertisesMethod = gatewayAdvertisesMethod,
    gatewayAdvertisesCapability = gatewayAdvertisesCapability,
    recordModelRecent = recordModelRecent,
    onSessionDeleted = onSessionDeleted,
    onOfflineDefaultAgentRestored = onOfflineDefaultAgentRestored,
    onAssistantReplyFinalized = onAssistantReplyFinalized,
  )
}

internal class ChatControllerTestSetup(
  private val scope: CoroutineScope,
) {
  val requests = mutableListOf<Pair<String, String?>>()
  var cacheScope: () -> ChatCacheScope? = { null }
  var gatewayAdvertisesMethod: (method: String) -> Boolean? = { null }
  var gatewayAdvertisesCapability: (capability: String) -> Boolean? = { null }
  var recordModelRecent: (String) -> Unit = {}

  private val handlers = mutableMapOf<String, suspend (String?) -> String>()

  fun respond(
    method: String,
    responseJson: String,
  ) {
    handlers[method] = { responseJson }
  }

  fun respond(
    method: String,
    handler: suspend (paramsJson: String?) -> String,
  ) {
    handlers[method] = handler
  }

  val controller: ChatController by lazy {
    scope.createChatController(
      cacheScope = cacheScope,
      gatewayAdvertisesMethod = gatewayAdvertisesMethod,
      gatewayAdvertisesCapability = gatewayAdvertisesCapability,
      recordModelRecent = recordModelRecent,
      requestGateway = { method, paramsJson ->
        requests += method to paramsJson
        // Unscripted methods preserve the original controller-test empty-object fallback.
        handlers[method]?.invoke(paramsJson) ?: "{}"
      },
    )
  }

  operator fun component1(): ChatController = controller

  operator fun component2(): MutableList<Pair<String, String?>> = requests
}

internal fun CoroutineScope.chatControllerTestSetup(
  configure: ChatControllerTestSetup.() -> Unit,
): ChatControllerTestSetup = ChatControllerTestSetup(this).apply(configure)

internal fun CoroutineScope.createScriptedChatController(
  configure: ChatControllerTestSetup.() -> Unit,
): ChatController = chatControllerTestSetup(configure).controller

/**
 * Scripted gateway responder for deterministic chat replay tests.
 *
 * Plugs into the same internal ChatController(requestGateway) seam the other
 * controller tests use; scenarios script per-method responses and replay
 * chat/agent events through ChatController.handleGatewayEvent under
 * kotlinx-coroutines-test virtual time.
 */
internal class ScriptedGateway(
  private val json: Json,
) {
  data class Call(
    val method: String,
    val paramsJson: String?,
  )

  // Controllers can retry from a background dispatcher while tests inspect calls.
  // Snapshot iteration keeps assertions from racing concurrent request recording.
  val calls = CopyOnWriteArrayList<Call>()
  private val handlers = mutableMapOf<String, suspend (paramsJson: String?) -> String>()

  /** Client-generated run id captured from the latest chat.send params. */
  var lastRunId: String? = null
    private set

  init {
    // Benign defaults so bootstrap/health/commands side requests never fail a scenario.
    respondWith("health", "{}")
    respondWith("chat.metadata", """{"commands":[],"models":[]}""")
    respondWith("sessions.list", """{"sessions":[]}""")
    respondWith("progressCard.get", """{"card":null}""")
  }

  fun respond(
    method: String,
    handler: suspend (paramsJson: String?) -> String,
  ) {
    handlers[method] = handler
  }

  fun respondWith(
    method: String,
    responseJson: String,
  ) {
    respond(method) { responseJson }
  }

  /** Acks chat.send echoing the client idempotency key as run id, like the live gateway. */
  fun respondChatSend(status: String) {
    respond("chat.send") { paramsJson ->
      val runId =
        paramsJson
          ?.let { value ->
            json
              .parseToJsonElement(value)
              .jsonObject["idempotencyKey"]
              ?.jsonPrimitive
              ?.content
          }
      lastRunId = runId
      buildJsonObject {
        if (runId != null) put("runId", JsonPrimitive(runId))
        put("status", JsonPrimitive(status))
      }.toString()
    }
  }

  suspend fun request(
    method: String,
    paramsJson: String?,
  ): String {
    calls += Call(method, paramsJson)
    val handler = handlers[method] ?: error("ScriptedGateway: no scripted response for $method")
    return handler(paramsJson)
  }

  fun sessionKeyOf(paramsJson: String?): String? =
    paramsJson?.let { value ->
      json
        .parseToJsonElement(value)
        .jsonObject["sessionKey"]
        ?.jsonPrimitive
        ?.content
    }

  fun callCount(method: String): Int = calls.count { it.method == method }
}

/** One transcript row for a scripted chat.history response. */
internal data class ReplayHistoryMessage(
  val role: String,
  val text: String,
  val timestampMs: Long,
  val idempotencyKey: String? = null,
  val entryId: String? = null,
)

internal fun historyResponse(
  sessionId: String,
  messages: List<ReplayHistoryMessage>,
  inFlightRun: Pair<String, String>? = null,
  hasActiveRun: Boolean? = inFlightRun?.let { true },
  activeRunIds: List<String>? = inFlightRun?.let { listOf(it.first) },
): String =
  buildJsonObject {
    put("sessionId", JsonPrimitive(sessionId))
    if (inFlightRun != null) {
      put(
        "inFlightRun",
        buildJsonObject {
          put("runId", JsonPrimitive(inFlightRun.first))
          put("text", JsonPrimitive(inFlightRun.second))
        },
      )
    }
    if (hasActiveRun != null || activeRunIds != null) {
      put(
        "sessionInfo",
        buildJsonObject {
          hasActiveRun?.let { put("hasActiveRun", JsonPrimitive(it)) }
          activeRunIds?.let { ids ->
            put("activeRunIds", JsonArray(ids.map(::JsonPrimitive)))
          }
        },
      )
    }
    put(
      "messages",
      JsonArray(
        messages.map { message ->
          buildJsonObject {
            put("role", JsonPrimitive(message.role))
            put("content", JsonPrimitive(message.text))
            put("timestamp", JsonPrimitive(message.timestampMs))
            if (message.idempotencyKey != null) {
              put("idempotencyKey", JsonPrimitive(message.idempotencyKey))
            }
            if (message.entryId != null) {
              put("__openclaw", buildJsonObject { put("id", JsonPrimitive(message.entryId)) })
            }
          }
        },
      ),
    )
  }.toString()

/** Gateway delta carrying the accumulated snapshot plus the v4 incremental chunk when present. */
internal fun chatDeltaPayload(
  sessionKey: String,
  runId: String,
  seq: Int,
  deltaText: String?,
  accumulatedText: String,
): String =
  buildJsonObject {
    put("sessionKey", JsonPrimitive(sessionKey))
    put("runId", JsonPrimitive(runId))
    put("seq", JsonPrimitive(seq))
    put("state", JsonPrimitive("delta"))
    if (deltaText != null) put("deltaText", JsonPrimitive(deltaText))
    put(
      "message",
      buildJsonObject {
        put("role", JsonPrimitive("assistant"))
        put(
          "content",
          JsonArray(
            listOf(
              buildJsonObject {
                put("type", JsonPrimitive("text"))
                put("text", JsonPrimitive(accumulatedText))
              },
            ),
          ),
        )
      },
    )
  }.toString()

internal fun chatTerminalPayload(
  sessionKey: String,
  runId: String,
  seq: Int,
  state: String = "final",
  assistantText: String? = null,
): String =
  buildJsonObject {
    put("sessionKey", JsonPrimitive(sessionKey))
    put("runId", JsonPrimitive(runId))
    put("seq", JsonPrimitive(seq))
    put("state", JsonPrimitive(state))
    if (assistantText != null) {
      put(
        "message",
        buildJsonObject {
          put("role", JsonPrimitive("assistant"))
          put(
            "content",
            JsonArray(
              listOf(
                buildJsonObject {
                  put("type", JsonPrimitive("text"))
                  put("text", JsonPrimitive(assistantText))
                },
              ),
            ),
          )
        },
      )
    }
  }.toString()

/**
 * Splits text into fixed-size chunks without splitting surrogate pairs; encoding half
 * a pair through the JSON event pipeline would corrupt the streamed byte sequence.
 */
internal fun chunkPreservingCodePoints(
  text: String,
  chunkSize: Int,
): List<String> {
  require(chunkSize > 1) { "chunkSize must leave room for surrogate pairs" }
  val chunks = mutableListOf<String>()
  var start = 0
  while (start < text.length) {
    var end = minOf(start + chunkSize, text.length)
    if (end < text.length && Character.isHighSurrogate(text[end - 1])) {
      end -= 1
    }
    chunks += text.substring(start, end)
    start = end
  }
  return chunks
}

internal suspend fun ChatCommandOutbox.recordTranscriptTip(
  gatewayId: String,
  scope: ChatOutboxScope,
  leafEntryId: String,
  previousState: ChatOutboxBranchState,
): Boolean =
  reconcileBranchScope(
    gatewayId,
    scope,
    ChatOutboxBranchEvidence.History(previousState),
    leafEntryId,
    setOf(leafEntryId),
    OUTBOX_BRANCH_CHANGED_ERROR,
  ) != null
