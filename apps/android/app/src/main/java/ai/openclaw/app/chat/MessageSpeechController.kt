package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.voice.TalkAudioPlaying
import ai.openclaw.app.voice.TalkSpeakAudio
import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "MessageSpeech"

internal enum class MessageSpeechPhase {
  Preparing,
  Speaking,
}

/** Playback state for the chat Listen action; null when idle. */
internal data class MessageSpeechState(
  val messageId: String,
  val phase: MessageSpeechPhase,
)

/** Renders message text to an audio clip; null means fall back to local TTS. */
internal fun interface MessageSpeechSynthesizing {
  suspend fun synthesize(text: String): TalkSpeakAudio?
}

/** Speaks text with the on-device engine when the gateway cannot render audio. */
internal interface LocalSpeechSpeaking {
  suspend fun speak(text: String)

  fun stop()
}

/** Gateway tts.speak client using the general configured TTS provider chain. */
internal class MessageSpeechClient(
  private val session: GatewaySession? = null,
  private val json: Json = Json { ignoreUnknownKeys = true },
  private val requestDetailed: (suspend (String, String, Long) -> GatewaySession.RpcResult)? = null,
) : MessageSpeechSynthesizing {
  override suspend fun synthesize(text: String): TalkSpeakAudio? {
    val response =
      try {
        performRequest(
          method = "tts.speak",
          paramsJson = json.encodeToString(TtsSpeakRequest(text = text)),
          timeoutMs = 60_000,
        )
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak request failed: ${err.message ?: err::class.simpleName}")
        return null
      }
    if (!response.ok) {
      // Provider/config absence and older gateways both degrade to the on-device voice.
      Log.d(TAG, "tts.speak unavailable: ${response.error?.message ?: "unknown error"}")
      return null
    }
    val payload =
      try {
        json.decodeFromString<TtsSpeakResponse>(response.payloadJson ?: "")
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak payload invalid: ${err.message ?: err::class.simpleName}")
        return null
      }
    val bytes =
      try {
        android.util.Base64.decode(payload.audioBase64, android.util.Base64.DEFAULT)
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak audio decode failed: ${err.message ?: err::class.simpleName}")
        return null
      }
    if (bytes.isEmpty()) return null
    return TalkSpeakAudio(
      bytes = bytes,
      provider = payload.provider,
      outputFormat = payload.outputFormat,
      voiceCompatible = null,
      mimeType = payload.mimeType,
      fileExtension = payload.fileExtension,
    )
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
internal data class TtsSpeakRequest(
  val text: String,
)

@Serializable
private data class TtsSpeakResponse(
  val audioBase64: String,
  val provider: String,
  val outputFormat: String? = null,
  val mimeType: String? = null,
  val fileExtension: String? = null,
)

/** Drives one active chat Listen request, preferring gateway audio over local TTS. */
internal class MessageSpeechController(
  private val scope: CoroutineScope,
  private val synthesizer: MessageSpeechSynthesizing,
  private val player: TalkAudioPlaying,
  private val localSpeech: LocalSpeechSpeaking,
) {
  private val _state = MutableStateFlow<MessageSpeechState?>(null)
  val state: StateFlow<MessageSpeechState?> = _state.asStateFlow()

  // A superseded playback's completion must not clear state owned by the next request.
  private val generation = AtomicLong(0)
  private var job: Job? = null

  fun toggle(
    messageId: String,
    text: String,
  ) {
    if (_state.value?.messageId == messageId) {
      stop()
      return
    }
    start(messageId = messageId, text = text)
  }

  fun stop() {
    generation.incrementAndGet()
    job?.cancel()
    job = null
    player.stop()
    localSpeech.stop()
    _state.value = null
  }

  private fun start(
    messageId: String,
    text: String,
  ) {
    stop()
    val spoken = text.trim()
    if (spoken.isEmpty()) return
    val token = generation.incrementAndGet()
    _state.value = MessageSpeechState(messageId = messageId, phase = MessageSpeechPhase.Preparing)
    job =
      scope.launch {
        try {
          val clip = synthesizer.synthesize(spoken)
          if (generation.get() != token) return@launch
          _state.value = MessageSpeechState(messageId = messageId, phase = MessageSpeechPhase.Speaking)
          if (!playClip(clip) && generation.get() == token) {
            localSpeech.speak(spoken)
          }
        } finally {
          if (generation.get() == token) _state.value = null
        }
      }
  }

  private suspend fun playClip(clip: TalkSpeakAudio?): Boolean {
    if (clip == null) return false
    return try {
      player.play(clip)
      true
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      Log.w(TAG, "clip playback failed: ${err.message ?: err::class.simpleName}")
      false
    }
  }
}

/** Minimal on-device TTS wrapper for the chat Listen fallback voice. */
internal class SystemSpeechSpeaker(
  private val context: Context,
) : LocalSpeechSpeaking {
  private val lock = Any()
  private var engine: TextToSpeech? = null
  private var ready: CompletableDeferred<Boolean>? = null
  private var active: CompletableDeferred<Unit>? = null

  override suspend fun speak(text: String) {
    val engine = ensureEngine() ?: return
    val utteranceId = "chat-listen-${System.nanoTime()}"
    val done = CompletableDeferred<Unit>()
    synchronized(lock) {
      active?.cancel()
      active = done
    }
    withContext(Dispatchers.Main.immediate) {
      engine.setOnUtteranceProgressListener(
        object : UtteranceProgressListener() {
          override fun onStart(id: String?) {}

          override fun onDone(id: String?) {
            if (id == utteranceId) done.complete(Unit)
          }

          @Deprecated("Deprecated in Java")
          override fun onError(id: String?) {
            if (id == utteranceId) done.complete(Unit)
          }

          override fun onError(
            id: String?,
            errorCode: Int,
          ) {
            if (id == utteranceId) done.complete(Unit)
          }
        },
      )
      if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId) != TextToSpeech.SUCCESS) {
        done.complete(Unit)
      }
    }
    try {
      done.await()
    } finally {
      synchronized(lock) {
        if (active === done) active = null
      }
    }
  }

  override fun stop() {
    synchronized(lock) {
      active?.cancel()
      active = null
    }
    engine?.stop()
  }

  private suspend fun ensureEngine(): TextToSpeech? {
    val current = synchronized(lock) { ready }
    val pending = current ?: createEngine()
    if (pending.await()) return synchronized(lock) { engine }

    // A failed Android TTS service can recover later; do not cache its failed initialization.
    val failedEngine =
      synchronized(lock) {
        if (ready !== pending) return null
        ready = null
        engine.also { engine = null }
      }
    withContext(Dispatchers.Main.immediate) { failedEngine?.shutdown() }
    return null
  }

  private suspend fun createEngine(): CompletableDeferred<Boolean> {
    val pending = CompletableDeferred<Boolean>()
    val ownsInitialization =
      synchronized(lock) {
        if (ready != null) {
          false
        } else {
          ready = pending
          true
        }
      }
    if (!ownsInitialization) return synchronized(lock) { checkNotNull(ready) }

    val created =
      try {
        // Finish publishing the constructed engine even if the Listen job is stopped mid-init.
        withContext(NonCancellable + Dispatchers.Main.immediate) {
          TextToSpeech(context) { status -> pending.complete(status == TextToSpeech.SUCCESS) }
        }
      } catch (err: Throwable) {
        Log.d(TAG, "system TTS initialization failed: ${err.message ?: err::class.simpleName}")
        pending.complete(false)
        null
      }
    synchronized(lock) {
      if (ready === pending) engine = created else created?.shutdown()
    }
    return pending
  }
}
