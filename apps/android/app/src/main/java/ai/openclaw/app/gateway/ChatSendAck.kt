package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal data class ChatSendAck(
  val runId: String?,
  val status: String?,
) {
  val normalizedStatus: String
    get() = status?.trim()?.lowercase().orEmpty()

  val isTerminalSuccess: Boolean
    get() = normalizedStatus == "ok"

  val isTerminalFailure: Boolean
    get() = normalizedStatus == "timeout" || normalizedStatus == "error"

  val isTerminal: Boolean
    get() = isTerminalSuccess || isTerminalFailure
}

internal fun chatSendAckHistorySinceSeconds(
  ack: ChatSendAck,
  startedAtSeconds: Double,
): Double? = if (ack.isTerminalSuccess) null else startedAtSeconds

internal fun parseChatSendAck(
  json: Json,
  responseJson: String,
): ChatSendAck =
  try {
    val obj = json.parseToJsonElement(responseJson).asObjectOrNull()
    ChatSendAck(
      runId = obj?.get("runId").asStringOrNull(),
      status = obj?.get("status").asStringOrNull(),
    )
  } catch (_: Throwable) {
    ChatSendAck(runId = null, status = null)
  }

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
