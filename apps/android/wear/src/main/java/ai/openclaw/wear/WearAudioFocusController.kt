package ai.openclaw.wear

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager

internal val wearSpeechAudioAttributes: AudioAttributes =
  AudioAttributes
    .Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

internal class WearAudioFocusController(
  context: Context,
  private val onFocusLost: () -> Unit,
) {
  private val audioManager =
    context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val focusRequest =
    AudioFocusRequest
      .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(wearSpeechAudioAttributes)
      .setOnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
          AudioManager.AUDIOFOCUS_LOSS,
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,
          -> {
            hasFocus = false
            onFocusLost()
          }
        }
      }.build()

  @Volatile private var hasFocus = false

  fun request(): Boolean {
    if (hasFocus) return true
    hasFocus =
      audioManager.requestAudioFocus(focusRequest) ==
      AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    return hasFocus
  }

  fun abandon() {
    if (!hasFocus) return
    audioManager.abandonAudioFocusRequest(focusRequest)
    hasFocus = false
  }
}
