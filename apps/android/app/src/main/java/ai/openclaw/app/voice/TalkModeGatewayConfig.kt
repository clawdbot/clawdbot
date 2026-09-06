package ai.openclaw.app.voice

import ai.openclaw.app.normalizeMainKey
import kotlinx.serialization.json.JsonArray
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
  val realtimeTransport: String?,
  val realtimeMode: String?,
  val strictAuthProviders: Set<String>,
)

internal object TalkModeGatewayConfigParser {
  /** Resolves runtime routing; only the Gateway relay enforces forced transcript consultations. */
  fun parse(config: JsonObject?): TalkModeGatewayConfigState {
    val talk = config?.get("talk").asObjectOrNull()
    val realtime = talk?.get("realtime").asObjectOrNull()
    val requiresGatewayRelay = realtime?.get("consultRouting").asStringOrNull() == "force-agent-consult"
    val sessionCfg = config?.get("session").asObjectOrNull()
    return TalkModeGatewayConfigState(
      mainSessionKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull()),
      speechLocale = normalizeSpeechLocaleTag(talk?.get("speechLocale").asStringOrNull()),
      interruptOnSpeech = talk?.get("interruptOnSpeech").asBooleanOrNull(),
      silenceTimeoutMs = resolvedSilenceTimeoutMs(talk),
      realtimeTransport = if (requiresGatewayRelay) "gateway-relay" else realtime?.get("transport").asStringOrNull(),
      realtimeMode = realtime?.get("mode").asStringOrNull(),
      strictAuthProviders =
        (realtime?.get("providers") as? JsonObject)
          .orEmpty()
          .mapNotNull { (id, provider) -> id.lowercase(Locale.ROOT).takeIf { provider.asObjectOrNull()?.containsKey("authMethod") == true } }
          .toSet(),
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

internal enum class AndroidRealtimeRoute {
  WebRtc,
  WebRtcWithRelayRecovery,
  GatewayRelay,
}

/** Select transport and recovery together from the same authoritative provider row. */
internal fun resolveAndroidRealtimeRoute(
  configured: String?,
  catalog: JsonObject?,
  strictAuthProviders: Set<String>,
): AndroidRealtimeRoute {
  when (configured) {
    "webrtc" -> return AndroidRealtimeRoute.WebRtc
    "gateway-relay", "provider-websocket" -> return AndroidRealtimeRoute.GatewayRelay
    null -> Unit
    else -> error("Configured Talk transport is not supported on Android")
  }
  val group = catalog?.get("realtime").asObjectOrNull() ?: error("Gateway did not return realtime Talk capabilities")
  val active = group["activeProvider"].asStringOrNull() ?: error("No realtime Talk provider is selected")
  val providers = (group["providers"] as? JsonArray)?.mapNotNull { it.asObjectOrNull() }.orEmpty()
  val selected =
    providers.firstOrNull { it["id"].asStringOrNull() == active }
      ?: providers.firstOrNull { provider -> (provider["aliases"] as? JsonArray)?.any { it.asStringOrNull() == active } == true }
      ?: error("Gateway selected an unavailable Talk provider")
  val providerId = selected["id"].asStringOrNull() ?: error("Gateway selected a Talk provider without identity")
  // talk.config canonicalizes provider keys but retains inactive legacy rows.
  val strictAuthSelected = providerId.lowercase(Locale.ROOT) in strictAuthProviders
  val transports = (selected["transports"] as? JsonArray)?.mapNotNull { it.asStringOrNull() }.orEmpty()
  return when {
    "webrtc" in transports -> if (strictAuthSelected) AndroidRealtimeRoute.WebRtc else AndroidRealtimeRoute.WebRtcWithRelayRecovery
    "gateway-relay" in transports -> AndroidRealtimeRoute.GatewayRelay
    else -> error("Selected Talk provider has no supported Android transport")
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
