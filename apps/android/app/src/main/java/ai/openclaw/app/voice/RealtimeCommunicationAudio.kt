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
 * Focus is acquired *before* the mode rather than after it: the mode request is a request, and it
 * is least likely to be honoured in the window where this app is not the focus owner. Focus also
 * stops another app from feeding the same loudspeaker the platform echo canceller uses as its
 * reference signal, which is exactly the audio the canceller cannot subtract.
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

  /** The mode was taken after acquisition. The token stays valid so teardown can still unwind. */
  private var modeLost = false
  private var lastFailure = LastFailure.None
  private var focusRetriesLeft = 0

  /**
   * Lock-free mirror of [communicationModeActive] for the capture read loop.
   *
   * The monitor this class uses is held across AudioService binder calls, so a per-frame read that
   * entered it would put an IPC round trip on the critical path of `AudioRecord.read` -- the exact
   * coupling the capture-side cache exists to remove.
   */
  @Volatile private var modeActiveSnapshot = false

  /** Why the last attempt failed, so the retry can act only on the kind that is transient. */
  private enum class LastFailure {
    None,

    /** Another app held focus. Worth retrying: focus holders are usually momentary. */
    FocusDenied,

    /**
     * Focus was available but the mode did not take. Never retried: on a device where the mode
     * will not stick, retrying re-acquires and re-abandons focus on every tick, which ducks and
     * unducks whatever else is playing for the whole session. Half duplex is the correct answer.
     */
    ModeRefused,
  }

  /** What one [enter] attempt did to the process-wide focus request, so failure can undo its own. */
  private enum class FocusOutcome {
    /** An earlier still-live owner holds it; this attempt neither acquired nor may release it. */
    AlreadyHeld,

    /** This attempt acquired it, so this attempt must release it if it then fails. */
    Acquired,

    /** The platform refused. */
    Denied,
  }

  /**
   * Claims communication audio and returns the token that may later restore it, or [NO_OWNER].
   *
   * The claim is only ever made on a *read-back*. `AudioManager.mode` is a void setter that
   * records a per-app request; it reports nothing about whether the request took effect, so "the
   * setter did not throw" is not evidence that the device is on the communication path. Treating
   * it as evidence is how a session ends up believing the echo canceller has a valid reference
   * signal while the device is not actually in communication mode.
   *
   * What the read-back proves is that the device is in communication mode -- Android exposes no
   * per-app mode-owner query -- which is the fact the canceller depends on. It does not prove this
   * app is the one that put it there, and nothing here should be read as claiming that.
   */
  @Synchronized
  fun enter(audioManager: AudioManager): Long {
    // One session, one retry budget. ~3 s of 500 ms ticks: long enough for a notification chime
    // to finish, short enough that a device which simply will not grant focus stops being asked.
    focusRetriesLeft = FOCUS_RETRY_BUDGET
    return enterLocked(audioManager)
  }

  private fun enterLocked(audioManager: AudioManager): Long {
    val owner = ++nextOwner
    val hadOwner = activeOwner != null
    // Only the first acquisition records what to restore. A stop racing a restart would otherwise
    // record the mode it had just set, and hand the device back still in communication mode.
    val restoreTo = if (hadOwner) previousMode else withdrawTarget()

    // Focus first, and fatal to ownership: without it this app is not the one the platform is
    // routing the call around, so a mode it appears to hold is not one full duplex may rely on.
    val focus = acquireFocus(audioManager)
    if (focus == FocusOutcome.Denied) {
      Log.w(tag, "communication audio not claimed: focus denied")
      lastFailure = LastFailure.FocusDenied
      return NO_OWNER
    }

    val setter = runCatching { audioManager.mode = AudioManager.MODE_IN_COMMUNICATION }
    setter.exceptionOrNull()?.let { err ->
      Log.w(tag, "communication mode not applied: ${err.message ?: err::class.simpleName}")
    }
    val readBack = readMode(audioManager, AudioManager.MODE_INVALID)
    if (setter.isFailure || readBack != AudioManager.MODE_IN_COMMUNICATION) {
      Log.w(tag, "communication mode not active: requested=${AudioManager.MODE_IN_COMMUNICATION} readBack=$readBack")
      abandonFailedAttempt(audioManager, focus, hadOwner, setter.isSuccess, restoreTo)
      lastFailure = LastFailure.ModeRefused
      // This attempt just read the device back as not in communication mode. That is evidence, and
      // a live older owner must not keep being told otherwise until the next watcher tick.
      // Keyed on the read-back, not on the setter: a setter that threw says nothing about what
      // mode the device is in, and a live owner that genuinely still holds it must not be closed
      // down on that basis.
      if (hadOwner && readBack != AudioManager.MODE_IN_COMMUNICATION) {
        modeLost = true
        publishSnapshot()
      }
      return NO_OWNER
    }
    previousMode = restoreTo
    activeOwner = owner
    modeLost = false
    lastFailure = LastFailure.None
    publishSnapshot()
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
    modeLost = false
    lastFailure = LastFailure.None
    focusRetriesLeft = 0
    publishSnapshot()
    releaseFocus(audioManager)
    runCatching { audioManager.mode = previousMode }
      .onFailure { Log.w(tag, "communication mode not restored: ${it.message ?: it::class.simpleName}") }
  }

  /**
   * Whether a live session holds the mode and the device is still in communication mode.
   *
   * Deliberately not called "owns": `AudioManager.getMode()` returns the device's effective mode,
   * and Android exposes no per-app mode-owner query, so what is observable is "the device is in
   * communication mode", not "this app is the one that put it there". That is the fact the
   * canceller's reference signal actually depends on, so it is the fact this reports -- but the
   * distinction matters and must not be overstated anywhere it is quoted.
   */
  @get:Synchronized
  val communicationModeActive: Boolean
    get() = activeOwner != null && !modeLost

  /** The same fact, readable without entering the monitor. For the capture read loop only. */
  val communicationModeActiveUnsynchronized: Boolean
    get() = modeActiveSnapshot

  /**
   * Re-reads the device mode and marks it lost when the device is no longer in communication mode.
   *
   * Acquisition proves the mode at one instant; another app can move it afterwards. Without this
   * the capability would stay granted for a session whose downlink the canceller is no longer
   * referencing -- the same failure the acquisition read-back prevents, arriving late.
   *
   * It marks rather than releases. Nulling the owner token here would orphan it: [restore] is
   * token-guarded, so teardown would then abandon no focus and withdraw no mode request, other
   * apps would stay ducked for the process lifetime, and the next [enter] would read this
   * process's own stale request back as the mode to restore -- pinning the device in
   * communication mode permanently.
   */
  @Synchronized
  fun verifyCommunicationModeActive(audioManager: AudioManager): Boolean {
    if (activeOwner == null) return false
    if (readMode(audioManager, AudioManager.MODE_INVALID) == AudioManager.MODE_IN_COMMUNICATION) {
      modeLost = false
      publishSnapshot()
      return true
    }
    if (!modeLost) Log.w(tag, "communication mode no longer active; dropping to half duplex")
    modeLost = true
    publishSnapshot()
    return false
  }

  /**
   * Unwinds exactly what this failed attempt did, and nothing a live older owner still holds.
   *
   * The mode is only put back when this attempt was the one that moved it: with an older owner
   * still running, whatever the mode is now belongs to that owner, and "restoring" it here would
   * be this failed attempt reaching over a session that is still live.
   */
  private fun abandonFailedAttempt(
    audioManager: AudioManager,
    focus: FocusOutcome,
    hadOwner: Boolean,
    setterRan: Boolean,
    restoreTo: Int,
  ) {
    if (!hadOwner && setterRan) {
      // restoreTo is always MODE_NORMAL for a first acquisition, so a failed attempt withdraws
      // its own request rather than asserting whatever it happened to find.
      runCatching { audioManager.mode = restoreTo }
        .onFailure { Log.w(tag, "failed acquisition could not undo its own mode write: ${it.message}") }
    }
    if (focus == FocusOutcome.Acquired) releaseFocus(audioManager)
  }

  private fun readMode(
    audioManager: AudioManager,
    fallback: Int,
  ): Int = runCatching { audioManager.mode }.getOrDefault(fallback)

  /**
   * What teardown writes to give the mode back: always normal.
   *
   * `getMode()` reports the device's *effective* mode; `setMode` records *this app's* request. They
   * are not the same value, and replaying the first as the second is how a session that merely
   * *found* the device in some mode ends up asserting that mode as its own -- a standing request
   * nothing ever withdraws. Communication mode was the case that motivated this, but the shape is
   * wrong for every mode: replaying `MODE_IN_CALL` found during a real call would have this app
   * asserting a telephony mode it has no business requesting.
   *
   * Asking for normal withdraws only this entry. Since API 31 the platform arbitrates per-app
   * requests, so an app that genuinely still wants another mode keeps it through its own request.
   */
  private fun withdrawTarget(): Int = AudioManager.MODE_NORMAL

  /**
   * Retries an acquisition that a transient focus holder refused.
   *
   * Focus denial is fatal to the mode, so without this a notification chime at the wrong instant
   * would leave a whole Talk session silently half duplex. Called from the same watcher that
   * verifies the mode, so recovery costs no extra machinery.
   */
  @Synchronized
  fun retryIfUnclaimed(audioManager: AudioManager): Long {
    if (activeOwner != null) return NO_OWNER
    // Only a focus refusal is retried, and only a bounded number of times. A mode refusal is not
    // transient in the same way: retrying it re-acquires and re-abandons focus on every tick,
    // which pauses and resumes whatever else is playing twice a second for the whole session.
    if (lastFailure != LastFailure.FocusDenied || focusRetriesLeft <= 0) return NO_OWNER
    focusRetriesLeft -= 1
    return enterLocked(audioManager)
  }

  private fun publishSnapshot() {
    modeActiveSnapshot = activeOwner != null && !modeLost
  }

  private fun acquireFocus(audioManager: AudioManager): FocusOutcome {
    if (focusRequest != null) return FocusOutcome.AlreadyHeld
    val request =
      AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(realtimeCommunicationPlaybackAttributes())
        .build()
    val granted = runCatching { audioManager.requestAudioFocus(request) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      Log.w(tag, "communication audio focus not granted (code $granted)")
      return FocusOutcome.Denied
    }
    focusRequest = request
    return FocusOutcome.Acquired
  }

  private fun releaseFocus(audioManager: AudioManager) {
    focusRequest?.let { request ->
      runCatching { audioManager.abandonAudioFocusRequest(request) }
      focusRequest = null
    }
  }

  internal companion object {
    /** The token value a session that never acquired the mode carries. */
    const val NO_OWNER = 0L
    private const val FOCUS_RETRY_BUDGET = 6
    private const val tag = "RealtimeAudio"
  }
}
