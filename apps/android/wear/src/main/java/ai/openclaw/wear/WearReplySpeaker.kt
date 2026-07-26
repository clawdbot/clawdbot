package ai.openclaw.wear

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import java.util.UUID

internal class WearReplySpeaker(
  context: Context,
) {
  private val _isSpeaking = MutableStateFlow(false)
  val isSpeaking: StateFlow<Boolean> = _isSpeaking.asStateFlow()
  private val audioFocus = WearAudioFocusController(context, ::stop)

  private var engine: TextToSpeech? = null
  private var ready = false
  private var pendingText: String? = null

  init {
    val created =
      TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
          engine?.language = Locale.getDefault()
          engine?.setAudioAttributes(wearSpeechAudioAttributes)
          pendingText?.let(::speak)
        } else {
          pendingText = null
          _isSpeaking.value = false
          audioFocus.abandon()
        }
      }
    engine = created
    created.setOnUtteranceProgressListener(
      object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {
          _isSpeaking.value = true
        }

        override fun onDone(utteranceId: String) {
          _isSpeaking.value = false
          audioFocus.abandon()
        }

        @Suppress("OVERRIDE_DEPRECATION")
        override fun onError(utteranceId: String) {
          _isSpeaking.value = false
          audioFocus.abandon()
        }

        override fun onError(
          utteranceId: String,
          errorCode: Int,
        ) {
          _isSpeaking.value = false
          audioFocus.abandon()
        }

        override fun onStop(
          utteranceId: String,
          interrupted: Boolean,
        ) {
          _isSpeaking.value = false
          audioFocus.abandon()
        }
      },
    )
    if (ready) {
      created.language = Locale.getDefault()
      created.setAudioAttributes(wearSpeechAudioAttributes)
      pendingText?.let(::speak)
    }
  }

  fun speak(text: String) {
    val normalized = text.trim().takeIf(String::isNotEmpty) ?: return
    if (!ready) {
      pendingText = normalized
      return
    }
    pendingText = null
    audioFocus.request()
    val result =
      engine?.speak(
        normalized,
        TextToSpeech.QUEUE_FLUSH,
        Bundle(),
        UUID.randomUUID().toString(),
      )
    if (result == TextToSpeech.ERROR) {
      _isSpeaking.value = false
      audioFocus.abandon()
    }
  }

  fun stop() {
    pendingText = null
    engine?.stop()
    _isSpeaking.value = false
    audioFocus.abandon()
  }

  fun shutdown() {
    pendingText = null
    engine?.stop()
    engine?.shutdown()
    engine = null
    ready = false
    _isSpeaking.value = false
    audioFocus.abandon()
  }
}
