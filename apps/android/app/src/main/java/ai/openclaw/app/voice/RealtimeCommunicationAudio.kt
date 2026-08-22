package ai.openclaw.app.voice

import android.media.AudioFocusRequest
import android.media.AudioManager
import android.util.Log

/**
 * Owns the device-wide communication audio state for one realtime Talk session: the audio mode
 * and the audio focus that goes with it.
 *
 * Session-level, not response-level. The mode is entered once when the relay session opens and
 * restored once when it closes, so a response boundary, a barge-in, or a push-to-talk excursion
 * never toggles the device in and out of communication mode mid-conversation.
 *
 * Focus is acquired with it rather than separately: without it another app keeps playing into the
 * same loudspeaker the platform echo canceller is using as its reference signal, which is exactly
 * the audio the canceller cannot subtract.
 *
 * Ownership is a token. A teardown that lost the race to a newer session declines to restore,
 * because restoring would put the device back into the mode the *previous* session found -- over
 * a session that is still running.
 */
internal class RealtimeCommunicationAudioOwner {
  private var nextOwner = 0L
  private var activeOwner: Long? = null
  private var previousMode: Int = AudioManager.MODE_NORMAL
  private var focusRequest: AudioFocusRequest? = null

  /**
   * Enters communication mode and returns the token that may later restore it, or [NO_OWNER] when
   * the platform refused the mode -- a session that never changed the mode must not later claim
   * the authority to change it back.
   */
  @Synchronized
  fun enter(audioManager: AudioManager): Long {
    val owner = ++nextOwner
    // Only the first acquisition records what to restore. A stop racing a restart would otherwise
    // record the mode it had just set, and hand the device back still in communication mode.
    val restoreTo = if (activeOwner == null) runCatching { audioManager.mode }.getOrDefault(AudioManager.MODE_NORMAL) else previousMode
    val applied =
      runCatching { audioManager.mode = AudioManager.MODE_IN_COMMUNICATION }
        .onFailure { Log.w(tag, "communication mode not applied: ${it.message ?: it::class.simpleName}") }
        .isSuccess
    if (!applied) return NO_OWNER
    previousMode = restoreTo
    activeOwner = owner
    requestFocus(audioManager)
    return owner
  }

  /** Restores the pre-session mode and releases focus, but only for the token that still owns it. */
  @Synchronized
  fun restore(
    audioManager: AudioManager,
    owner: Long,
  ) {
    if (owner == NO_OWNER || owner != activeOwner) return
    activeOwner = null
    focusRequest?.let { request ->
      runCatching { audioManager.abandonAudioFocusRequest(request) }
      focusRequest = null
    }
    runCatching { audioManager.mode = previousMode }
      .onFailure { Log.w(tag, "communication mode not restored: ${it.message ?: it::class.simpleName}") }
  }

  private fun requestFocus(audioManager: AudioManager) {
    if (focusRequest != null) return
    val request =
      AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(realtimeCommunicationPlaybackAttributes())
        .build()
    val granted = runCatching { audioManager.requestAudioFocus(request) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      // Not fatal: Talk still works, but another app may keep feeding the speaker the canceller
      // is referencing, so it is worth seeing in a log when echo control underperforms.
      Log.w(tag, "communication audio focus not granted (code $granted)")
      return
    }
    focusRequest = request
  }

  internal companion object {
    /** The token value a session that never acquired the mode carries. */
    const val NO_OWNER = 0L
    private const val tag = "RealtimeAudio"
  }
}
