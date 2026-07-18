package ai.openclaw.wear.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import java.nio.charset.CharacterCodingException

object WearProtocol {
  const val VERSION = 1
  const val REQUEST_PATH = "/openclaw/wear/v1/request"
  const val RESPONSE_PATH = "/openclaw/wear/v1/response"
  const val EVENT_PATH = "/openclaw/wear/v1/event"
  const val REALTIME_AUDIO_CHANNEL_PATH = "/openclaw/wear/v1/realtime/audio"
  const val PHONE_CAPABILITY = "openclaw_phone_proxy_v1"
  const val WATCH_CAPABILITY = "openclaw_wear_companion_v1"

  // MessageClient has a 100 KiB ceiling. Keep headroom for transport metadata and
  // force transcript pagination instead of depending on an edge-sized message.
  const val MAX_MESSAGE_BYTES = 64 * 1024
  const val MAX_REALTIME_AUDIO_FRAME_BYTES = 8 * 1024
  const val REALTIME_AUDIO_SAMPLE_RATE_HZ = 24_000
  const val REALTIME_AUDIO_FRAME_MILLIS = 20

  // Bound recursive JSON parsing at the untrusted Data Layer boundary.
  const val MAX_JSON_DEPTH = 32
}

enum class WearProxyCapability(
  val wireValue: String,
) {
  AgentControls(wireValue = "agent-controls"),
  GatewayControls(wireValue = "gateway-controls"),
  SessionSelectionLookup(wireValue = "session-selection-lookup"),
  ;

  companion object {
    fun fromWireValue(value: String): WearProxyCapability? = entries.firstOrNull { capability -> capability.wireValue == value }
  }
}

@Serializable
enum class WearRpcMethod {
  @SerialName("proxy.status")
  ProxyStatus,

  @SerialName("sessions.list")
  SessionsList,

  @SerialName("agents.list")
  AgentsList,

  @SerialName("agents.select")
  AgentsSelect,

  @SerialName("gateway.connect")
  GatewayConnect,

  @SerialName("gateway.disconnect")
  GatewayDisconnect,

  @SerialName("chat.history")
  ChatHistory,

  @SerialName("chat.send")
  ChatSend,

  @SerialName("chat.abort")
  ChatAbort,

  @SerialName("talk.start")
  TalkStart,

  @SerialName("talk.stop")
  TalkStop,
}

@Serializable
enum class WearEventType {
  @SerialName("chat")
  Chat,

  @SerialName("connection")
  Connection,

  @SerialName("resync")
  Resync,

  @SerialName("talk")
  Talk,
}

@Serializable
sealed interface WearMessage {
  val version: Int

  @Serializable
  @SerialName("request")
  data class Request(
    override val version: Int = WearProtocol.VERSION,
    val requestId: String,
    val method: WearRpcMethod,
    val params: JsonObject = buildJsonObject {},
  ) : WearMessage

  @Serializable
  @SerialName("response")
  data class Response(
    override val version: Int = WearProtocol.VERSION,
    val requestId: String,
    val ok: Boolean,
    val result: JsonElement? = null,
    val error: WearRpcError? = null,
    val eventStreamId: String? = null,
    val eventSequence: Long? = null,
  ) : WearMessage

  @Serializable
  @SerialName("event")
  data class Event(
    override val version: Int = WearProtocol.VERSION,
    val streamId: String? = null,
    val sequence: Long,
    val event: WearEventType,
    val payload: JsonElement? = null,
  ) : WearMessage
}

@Serializable
data class WearRpcError(
  val code: String,
  val message: String,
)

enum class WearDecodeFailureReason {
  Empty,
  TooLarge,
  TooDeep,
  Malformed,
  UnsupportedVersion,
  InvalidEnvelope,
}

sealed interface WearDecodeResult {
  data class Success(
    val message: WearMessage,
  ) : WearDecodeResult

  data class Failure(
    val reason: WearDecodeFailureReason,
  ) : WearDecodeResult
}

object WearProtocolCodec {
  private val json =
    Json {
      classDiscriminator = "type"
      encodeDefaults = true
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  fun encode(message: WearMessage): ByteArray {
    requireValid(message)
    require(hasValidPayloadDepth(message)) {
      "Wear message exceeds JSON depth ${WearProtocol.MAX_JSON_DEPTH}"
    }
    val encoded = json.encodeToString(WearMessage.serializer(), message)
    require(!exceedsJsonDepth(encoded)) {
      "Wear message exceeds JSON depth ${WearProtocol.MAX_JSON_DEPTH}"
    }
    val bytes =
      encoded.encodeToByteArray(throwOnInvalidSequence = true)
    require(bytes.size <= WearProtocol.MAX_MESSAGE_BYTES) {
      "Wear message exceeds ${WearProtocol.MAX_MESSAGE_BYTES} bytes"
    }
    return bytes
  }

  private fun hasValidPayloadDepth(message: WearMessage): Boolean {
    val payloads =
      when (message) {
        is WearMessage.Request -> listOf(message.params)
        is WearMessage.Response -> listOfNotNull(message.result)
        is WearMessage.Event -> listOfNotNull(message.payload)
      }
    return payloads.all { element -> hasValidElementDepth(element, parentDepth = 1) }
  }

  private fun hasValidElementDepth(
    element: JsonElement,
    parentDepth: Int,
  ): Boolean {
    val pending = ArrayDeque<Pair<JsonElement, Int>>()
    pending.addLast(element to parentDepth)
    while (pending.isNotEmpty()) {
      val (current, parent) = pending.removeLast()
      val children =
        when (current) {
          is JsonArray -> current
          is JsonObject -> current.values
          else -> continue
        }
      val depth = parent + 1
      if (depth > WearProtocol.MAX_JSON_DEPTH) return false
      children.forEach { child -> pending.addLast(child to depth) }
    }
    return true
  }

  fun decode(bytes: ByteArray): WearDecodeResult {
    if (bytes.isEmpty()) return WearDecodeResult.Failure(WearDecodeFailureReason.Empty)
    if (bytes.size > WearProtocol.MAX_MESSAGE_BYTES) {
      return WearDecodeResult.Failure(WearDecodeFailureReason.TooLarge)
    }

    val text =
      try {
        bytes.decodeToString(throwOnInvalidSequence = true)
      } catch (_: CharacterCodingException) {
        return WearDecodeResult.Failure(WearDecodeFailureReason.Malformed)
      }
    if (exceedsJsonDepth(text)) {
      return WearDecodeResult.Failure(WearDecodeFailureReason.TooDeep)
    }
    val root =
      try {
        json.parseToJsonElement(text).jsonObject
      } catch (_: SerializationException) {
        return WearDecodeResult.Failure(WearDecodeFailureReason.Malformed)
      } catch (_: IllegalArgumentException) {
        return WearDecodeResult.Failure(WearDecodeFailureReason.Malformed)
      }
    val version =
      (root["version"] as? JsonPrimitive)?.intOrNull
        ?: return WearDecodeResult.Failure(WearDecodeFailureReason.Malformed)
    if (version != WearProtocol.VERSION) {
      return WearDecodeResult.Failure(WearDecodeFailureReason.UnsupportedVersion)
    }
    val message =
      try {
        json.decodeFromJsonElement(WearMessage.serializer(), root)
      } catch (_: SerializationException) {
        return WearDecodeResult.Failure(WearDecodeFailureReason.Malformed)
      } catch (_: IllegalArgumentException) {
        return WearDecodeResult.Failure(WearDecodeFailureReason.Malformed)
      }
    if (!isValid(message)) {
      return WearDecodeResult.Failure(WearDecodeFailureReason.InvalidEnvelope)
    }
    return WearDecodeResult.Success(message)
  }

  private fun exceedsJsonDepth(text: String): Boolean {
    var depth = 0
    var inString = false
    var escaped = false
    for (character in text) {
      if (inString) {
        when {
          escaped -> escaped = false
          character == '\\' -> escaped = true
          character == '"' -> inString = false
        }
        continue
      }

      when (character) {
        '"' -> inString = true
        '{', '[' -> {
          depth += 1
          if (depth > WearProtocol.MAX_JSON_DEPTH) return true
        }
        '}', ']' -> depth -= 1
      }
    }
    return false
  }

  private fun requireValid(message: WearMessage) {
    require(message.version == WearProtocol.VERSION) { "Unsupported Wear protocol version: ${message.version}" }
    require(isValid(message)) { "Invalid Wear protocol envelope" }
  }

  private fun isValid(message: WearMessage): Boolean =
    when (message) {
      is WearMessage.Request -> message.requestId.isNotBlank()
      is WearMessage.Response ->
        message.requestId.isNotBlank() &&
          (message.eventStreamId == null || message.eventStreamId.isNotBlank()) &&
          (message.eventSequence == null || message.eventSequence >= 0) &&
          if (message.ok) {
            message.error == null
          } else {
            message.error != null && message.result == null && message.error.code.isNotBlank()
          }
      is WearMessage.Event ->
        (message.streamId == null || message.streamId.isNotBlank()) &&
          message.sequence >= 0
    }
}
