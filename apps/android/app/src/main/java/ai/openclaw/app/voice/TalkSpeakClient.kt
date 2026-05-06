package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

internal data class TalkSpeakAudio(
  val bytes: ByteArray,
  val provider: String,
  val outputFormat: String?,
  val voiceCompatible: Boolean?,
  val mimeType: String?,
  val fileExtension: String?,
)

internal sealed interface TalkSpeakResult {
  data class Success(
    val audio: TalkSpeakAudio,
  ) : TalkSpeakResult

  data class FallbackToLocal(
    val message: String,
  ) : TalkSpeakResult

  data class Failure(
    val message: String,
  ) : TalkSpeakResult
}

internal interface TalkSpeechSynthesizing {
  suspend fun synthesize(
    text: String,
    directive: TalkDirective?,
  ): TalkSpeakResult
}

internal class TalkSpeakClient(
  private val session: GatewaySession? = null,
  private val json: Json = Json { ignoreUnknownKeys = true },
  private val requestDetailed: (suspend (String, String, Long) -> GatewaySession.RpcResult)? = null,
) : TalkSpeechSynthesizing {
  override suspend fun synthesize(
    text: String,
    directive: TalkDirective?,
  ): TalkSpeakResult {
    val response =
      try {
        performRequest(
          method = "talk.speak",
          paramsJson = json.encodeToString(TalkSpeakRequest.from(text = text, directive = directive)),
          timeoutMs = 45_000,
        )
      } catch (err: Throwable) {
        return TalkSpeakResult.Failure(err.message ?: "talk.speak request failed")
      }
    if (!response.ok) {
      val error = response.error
      val message = error?.message ?: "talk.speak request failed"
      return if (isFallbackEligible(error)) {
        TalkSpeakResult.FallbackToLocal(message)
      } else {
        TalkSpeakResult.Failure(message)
      }
    }
    val payload =
      try {
        json.decodeFromString<TalkSpeakResponse>(response.payloadJson ?: "")
      } catch (err: Throwable) {
        return TalkSpeakResult.Failure(err.message ?: "talk.speak payload invalid")
      }
    val bytes =
      try {
        android.util.Base64.decode(payload.audioBase64, android.util.Base64.DEFAULT)
      } catch (err: Throwable) {
        return TalkSpeakResult.Failure(err.message ?: "talk.speak audio decode failed")
      }
    if (bytes.isEmpty()) {
      return TalkSpeakResult.Failure("talk.speak returned empty audio")
    }
    return TalkSpeakResult.Success(
      TalkSpeakAudio(
        bytes = bytes,
        provider = payload.provider,
        outputFormat = payload.outputFormat,
        voiceCompatible = payload.voiceCompatible,
        mimeType = payload.mimeType,
        fileExtension = payload.fileExtension,
      ),
    )
  }

  private fun isFallbackEligible(error: GatewaySession.ErrorShape?): Boolean {
    val reason = error?.details?.reason
    if (reason == null) return true
    return reason == "talk_unconfigured" ||
      reason == "talk_provider_unsupported" ||
      reason == "method_unavailable"
  }

  private suspend fun performRequest(
    method: String,
    paramsJson: String,
    timeoutMs: Long,
  ): GatewaySession.RpcResult {
    requestDetailed?.let { return it(method, paramsJson, timeoutMs) }
    val activeSession = session ?: throw IllegalStateException("session missing")
    return activeSession.requestDetailed(method = method, paramsJson = paramsJson, timeoutMs = timeoutMs)
  }
}

@Serializable
internal data class TalkSpeakRequest(
  val text: String,
  val voiceId: String? = null,
  val modelId: String? = null,
  val outputFormat: String? = null,
  val speed: Double? = null,
  val rateWpm: Int? = null,
  val stability: Double? = null,
  val similarity: Double? = null,
  val style: Double? = null,
  val speakerBoost: Boolean? = null,
  val seed: Long? = null,
  val normalize: String? = null,
  val language: String? = null,
  val latencyTier: Int? = null,
) {
  companion object {
    fun from(
      text: String,
      directive: TalkDirective?,
    ): TalkSpeakRequest =
      TalkSpeakRequest(
        text = text,
        voiceId = directive?.voiceId,
        modelId = directive?.modelId,
        outputFormat = directive?.outputFormat,
        speed = directive?.speed,
        rateWpm = directive?.rateWpm,
        stability = directive?.stability,
        similarity = directive?.similarity,
        style = directive?.style,
        speakerBoost = directive?.speakerBoost,
        seed = directive?.seed,
        normalize = directive?.normalize,
        language = directive?.language,
        latencyTier = directive?.latencyTier,
      )
  }
}

@Serializable
private data class TalkSpeakResponse(
  val audioBase64: String,
  val provider: String,
  val outputFormat: String? = null,
  val voiceCompatible: Boolean? = null,
  val mimeType: String? = null,
  val fileExtension: String? = null,
)
