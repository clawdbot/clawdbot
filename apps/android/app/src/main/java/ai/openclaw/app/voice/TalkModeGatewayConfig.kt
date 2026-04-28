package ai.openclaw.app.voice

import ai.openclaw.app.normalizeMainKey
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

internal data class TalkModeGatewayConfigState(
  val mainSessionKey: String,
  val interruptOnSpeech: Boolean?,
  val silenceTimeoutMs: Long,
)

internal object TalkModeGatewayConfigParser {
  fun parse(config: JsonObject?): TalkModeGatewayConfigState {
    val talk = config?.get("talk").asObjectOrNull()
    val sessionCfg = config?.get("session").asObjectOrNull()
    return TalkModeGatewayConfigState(
      mainSessionKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull()),
      interruptOnSpeech = talk?.get("interruptOnSpeech").asBooleanOrNull(),
      silenceTimeoutMs = resolvedSilenceTimeoutMs(talk),
    )
  }

  fun resolvedSilenceTimeoutMs(talk: JsonObject?): Long {
    val fallback = TalkDefaults.defaultSilenceTimeoutMs
    val primitive = talk?.get("silenceTimeoutMs") as? JsonPrimitive ?: return fallback
    if (primitive.isString) return fallback
    val timeout = primitive.content.toDoubleOrNull() ?: return fallback
    if (timeout <= 0 || timeout % 1.0 != 0.0 || timeout > Long.MAX_VALUE.toDouble()) {
      return fallback
    }
    return timeout.toLong()
  }
}

private fun JsonElement?.asStringOrNull(): String? =
  this
    ?.let { element ->
      element as? JsonPrimitive
    }?.contentOrNull

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.booleanOrNull
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject
