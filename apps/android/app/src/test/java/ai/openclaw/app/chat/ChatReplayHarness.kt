package ai.openclaw.app.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

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

  val calls = mutableListOf<Call>()
  private val handlers = mutableMapOf<String, suspend (paramsJson: String?) -> String>()

  /** Client-generated run id captured from the latest chat.send params. */
  var lastRunId: String? = null
    private set

  init {
    // Benign defaults so bootstrap/health/commands side requests never fail a scenario.
    respondWith("health", "{}")
    respondWith("chat.metadata", """{"commands":[],"models":[]}""")
    respondWith("sessions.list", """{"sessions":[]}""")
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
)

internal fun historyResponse(
  sessionId: String,
  messages: List<ReplayHistoryMessage>,
  inFlightRun: Pair<String, String>? = null,
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
      put("sessionInfo", buildJsonObject { put("hasActiveRun", JsonPrimitive(true)) })
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
