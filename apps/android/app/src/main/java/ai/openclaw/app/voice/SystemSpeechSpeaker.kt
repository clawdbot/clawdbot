package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import java.util.Locale
import java.util.UUID

/** Speaks text with the on-device engine when the gateway cannot render audio. */
internal interface LocalSpeechSpeaking {
  suspend fun speak(text: String)

  fun stop()
}

/** Owns initialization and one cancellable, ordered local speech request for Chat or Talk. */
internal class SystemSpeechSpeaker(
  private val context: Context,
) : LocalSpeechSpeaking {
  private val lock = Any()
  private var engine: TextToSpeech? = null
  private var ready: CompletableDeferred<Int>? = null
  private var active: Job? = null

  override suspend fun speak(text: String) {
    speak(text, locale = null, speechRate = null, beforeSpeak = {})
  }

  suspend fun speak(
    text: String,
    locale: Locale?,
    speechRate: Float?,
    beforeSpeak: () -> Unit,
  ) = coroutineScope {
    val request = coroutineContext.job
    try {
      synchronized(lock) {
        request.ensureActive()
        val previous = active
        active = request
        previous?.cancel()
        engine?.stop()
      }
      val speechEngine = ensureEngine(request)
      var start = 0
      while (start < text.length) {
        // Android caps each utterance in UTF-16 units. Keep every character, including
        // boundary whitespace, and never split a surrogate pair or flush an unfinished chunk.
        var end = start + minOf(TextToSpeech.getMaxSpeechInputLength(), text.length - start)
        if (end < text.length) {
          if (text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) end -= 1
          (end - 1 downTo start).firstOrNull { text[it].isWhitespace() }?.let { end = it + 1 }
        }
        val utteranceId = UUID.randomUUID().toString()
        val finished = CompletableDeferred<Unit>()
        try {
          withContext(Dispatchers.Main.immediate) {
            synchronized(lock) {
              checkActive(request)
              if (start == 0) {
                // Chat retains the engine's defaults; Talk supplies its validated directive.
                locale?.let {
                  val result = speechEngine.setLanguage(it)
                  check(result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED) {
                    "Language unavailable on this device"
                  }
                }
                speechRate?.let { speechEngine.setSpeechRate(it) }
                speechEngine.setAudioAttributes(
                  AudioAttributes
                    .Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build(),
                )
                beforeSpeak()
                checkActive(request)
              }
              speechEngine.setOnUtteranceProgressListener(
                object : UtteranceProgressListener() {
                  override fun onStart(id: String?) = Unit

                  override fun onDone(id: String?) {
                    if (id == utteranceId) finished.complete(Unit)
                  }

                  @Suppress("OVERRIDE_DEPRECATION")
                  @Deprecated("Deprecated in Java")
                  override fun onError(id: String?) {
                    onError(id, TextToSpeech.ERROR_SYNTHESIS)
                  }

                  override fun onError(
                    id: String?,
                    errorCode: Int,
                  ) {
                    if (id == utteranceId) finished.completeExceptionally(IllegalStateException("TextToSpeech playback failed ($errorCode)"))
                  }

                  override fun onStop(
                    id: String?,
                    interrupted: Boolean,
                  ) {
                    if (id == utteranceId) finished.cancel()
                  }
                },
              )
              check(speechEngine.speak(text.substring(start, end), TextToSpeech.QUEUE_FLUSH, null, utteranceId) == TextToSpeech.SUCCESS) {
                "TextToSpeech start failed"
              }
            }
          }
          finished.await()
        } finally {
          finished.cancel()
        }
        start = end
      }
    } finally {
      synchronized(lock) {
        // A canceled request's callbacks/finally must not stop its replacement.
        if (active === request) {
          active = null
          engine?.stop()
        }
      }
    }
  }

  override fun stop() {
    synchronized(lock) {
      val request = active
      active = null
      request?.cancel()
      engine?.stop()
    }
  }

  fun shutdown() {
    synchronized(lock) {
      val request = active
      val pending = ready
      val retired = engine
      active = null
      ready = null
      engine = null
      request?.cancel()
      pending?.cancel()
      retired?.stop()
      retired?.shutdown()
    }
  }

  private fun checkActive(request: Job) {
    request.ensureActive()
    if (active !== request) throw CancellationException("Speech request superseded")
  }

  private suspend fun ensureEngine(request: Job): TextToSpeech =
    withContext(Dispatchers.Main.immediate) {
      val pending =
        synchronized(lock) {
          checkActive(request)
          ready ?: CompletableDeferred<Int>().also { initialization ->
            ready = initialization
            try {
              // Allocate and publish without suspension. A late callback only completes its
              // own initialization; it cannot republish an engine retired by shutdown.
              engine = TextToSpeech(context) { initialization.complete(it) }
            } catch (err: Throwable) {
              if (ready === initialization) ready = null
              initialization.completeExceptionally(err)
              throw err
            }
          }
        }
      val result = pending.await()
      synchronized(lock) {
        checkActive(request)
        if (result != TextToSpeech.SUCCESS) {
          val failed = engine
          engine = null
          ready = null
          failed?.shutdown()
          error("TextToSpeech init failed ($result)")
        }
        checkNotNull(engine)
      }
    }
}
