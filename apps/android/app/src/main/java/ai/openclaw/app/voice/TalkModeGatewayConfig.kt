package ai.openclaw.app.voice

import ai.openclaw.app.normalizeMainKey
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import java.util.Locale

internal data class TalkModeGatewayConfigState(
  val mainSessionKey: String,
  val speechLocale: String?,
  val interruptOnSpeech: Boolean?,
  val silenceTimeoutMs: Long,
)

internal object TalkModeGatewayConfigParser {
  /** Reads gateway talk/session config into the runtime state TalkMode needs. */
  fun parse(config: JsonObject?): TalkModeGatewayConfigState {
    val talk = config?.get("talk").asObjectOrNull()
    val sessionCfg = config?.get("session").asObjectOrNull()
    return TalkModeGatewayConfigState(
      mainSessionKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull()),
      speechLocale = normalizeSpeechLocaleTag(talk?.get("speechLocale").asStringOrNull()),
      interruptOnSpeech = talk?.get("interruptOnSpeech").asBooleanOrNull(),
      silenceTimeoutMs = resolvedSilenceTimeoutMs(talk),
    )
  }

  /** Accepts only numeric whole-millisecond silence timeouts; malformed config uses defaults. */
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

internal fun normalizeSpeechLocaleTag(value: String?): String? {
  val candidate =
    value
      ?.trim()
      ?.replace('_', '-')
      ?.takeIf(String::isNotEmpty)
      ?: return null
  val locale = Locale.forLanguageTag(candidate)
  return locale
    .toLanguageTag()
    .takeIf { tag -> locale.language.isNotBlank() && tag != "und" }
}

internal fun realtimeTranscriptionLanguage(localeTag: String?): String? =
  localeTag
    ?.let(Locale::forLanguageTag)
    ?.language
    ?.lowercase(Locale.ROOT)
    ?.takeIf { language ->
      language.length == ISO_639_1_LANGUAGE_LENGTH &&
        language.all { character -> character in 'a'..'z' }
    }

internal fun resolveRealtimeTranscriptionLanguageHint(
  configuredLocaleTag: String?,
  requestedLanguage: String?,
  deviceLocaleTag: String?,
): String? =
  realtimeTranscriptionLanguage(
    configuredLocaleTag
      ?: requestedLanguage
      ?: deviceLocaleTag,
  )

private const val ISO_639_1_LANGUAGE_LENGTH = 2
