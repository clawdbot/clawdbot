package ai.openclaw.app.voice

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CancellationException
import java.util.concurrent.atomic.AtomicReference

/** One capture's request for Android's process-wide communication mode and audio focus. */
internal class RealtimeCommunicationAudio private constructor(
  private val audioManager: AudioManager,
  private val isCurrent: () -> Boolean,
  private val onFocusLost: () -> Unit,
) : AutoCloseable {
  companion object {
    private val ownershipLock = Any()
    private var current: RealtimeCommunicationAudio? = null

    fun open(
      audioManager: AudioManager,
      isCurrent: () -> Boolean = { true },
      onFocusLost: () -> Unit = {},
    ): RealtimeCommunicationAudio =
      synchronized(ownershipLock) {
        // A cancelled opener must not displace the replacement capture while acquiring SDK state.
        if (!isCurrent()) throw CancellationException("audio capture replaced")
        current?.close()
        RealtimeCommunicationAudio(audioManager, isCurrent, onFocusLost).also { session ->
          current = session
          try {
            session.start()
          } catch (error: RuntimeException) {
            session.close()
            throw error
          }
        }
      }

    fun playbackAttributes(): AudioAttributes =
      AudioAttributes
        .Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
  }

  @Volatile private var closed = false

  private enum class Focus { Requesting, Granted, Lost }

  private val focus = AtomicReference(Focus.Requesting)

  @Volatile private var mode = AudioManager.MODE_NORMAL
  private var modeListenerRegistered = false
  private var modeRequested = false
  private val handler = Handler(Looper.getMainLooper())
  private val modeListener =
    AudioManager.OnModeChangedListener { value ->
      if (!closed) {
        mode = value
        Log.d("TalkAudio", "communication mode=$value")
      }
    }
  private val focusRequest =
    AudioFocusRequest
      .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(playbackAttributes())
      .setWillPauseWhenDucked(true)
      .setOnAudioFocusChangeListener({ change ->
        if (!closed) {
          focus.set(if (change == AudioManager.AUDIOFOCUS_GAIN) Focus.Granted else Focus.Lost)
          Log.d("TalkAudio", "communication focus=$change")
          if (change != AudioManager.AUDIOFOCUS_GAIN) {
            handler.post {
              if (!closed && isCurrent()) onFocusLost()
            }
          }
        }
      }, handler)
      .build()

  // Mode is the effective platform value, not proof that this app owns every hardware route.
  val eligible: Boolean
    get() = !closed && focus.get() == Focus.Granted && mode == AudioManager.MODE_IN_COMMUNICATION

  private fun start() {
    audioManager.addOnModeChangedListener({ command -> handler.post(command) }, modeListener)
    modeListenerRegistered = true
    val granted = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    // A loss callback delivered during acquisition must not be overwritten by its return value.
    focus.compareAndSet(Focus.Requesting, if (granted) Focus.Granted else Focus.Lost)
    check(granted && focus.get() == Focus.Granted) { "audio focus unavailable" }
    modeRequested = true
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    mode = audioManager.mode
  }

  override fun close() {
    synchronized(ownershipLock) {
      if (closed) return
      closed = true
      focus.set(Focus.Lost)
      if (modeListenerRegistered) {
        runCatching { audioManager.removeOnModeChangedListener(modeListener) }
      }
      runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
      if (current === this) {
        current = null
        // AOSP tracks mode requests per PID. NORMAL withdraws ours; replaying a saved global
        // mode would assert another app's request as our own after Talk has stopped.
        if (modeRequested) runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
      }
    }
  }
}
