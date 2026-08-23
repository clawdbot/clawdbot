package ai.openclaw.app.voice

import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.HandlerThread
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

  /**
   * Which focus request the listener callbacks belong to.
   *
   * Focus callbacks arrive asynchronously and can outlive the request that caused them, so a
   * delayed LOSS from a torn-down session must not be allowed to close full duplex for the
   * session that replaced it. Every request carries its own generation and a callback that does
   * not match the current one is inert.
   */
  private var focusGeneration = 0L

  /** Whether this app currently holds focus. Revocable session state, not an acquisition fact. */
  private var focusActive = false

  /**
   * The generation a loss callback has already revoked.
   *
   * The platform may deliver a callback while `requestAudioFocus` is still on the stack, and the
   * monitor is reentrant, so that callback runs *inside* the acquisition. Without this the grant
   * path would then overwrite the revocation it just received and report focus this app no longer
   * holds.
   */
  private var focusRevokedGeneration = -1L

  /** The mode was taken after acquisition. The token stays valid so teardown can still unwind. */
  private var modeLost = false
  private var lastFailure = LastFailure.None
  private var focusRetriesLeft = 0

  /**
   * Lock-free mirror of [communicationAudioEligible] for the capture read loop.
   *
   * The monitor this class uses is held across AudioService binder calls, so a per-frame read that
   * entered it would put an IPC round trip on the critical path of `AudioRecord.read` -- the exact
   * coupling the capture-side cache exists to remove.
   */
  @Volatile private var eligibilitySnapshot = false

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
   * Whether this session's communication audio is currently good enough to run full duplex.
   *
   * Three independent live facts, all revocable, and the single source of truth for the parts of
   * the full-duplex decision this class owns:
   *  - a live session still holds the token,
   *  - the device is still in communication mode (`getMode()` reports the device's *effective*
   *    mode; Android exposes no per-app owner query, so this is "the device is in communication
   *    mode", not "this app put it there" -- the distinction must not be overstated),
   *  - this app still holds audio focus.
   *
   * Focus belongs here rather than being an acquisition-time assumption: the platform can hand it
   * to another app at any moment, and once it has, that app is on the same speaker the echo
   * canceller uses as its reference. Forwarding the microphone during playback then means
   * forwarding audio the canceller cannot subtract.
   *
   * Recovery is asymmetric, deliberately. A *transient* loss is followed by a GAIN callback and
   * eligibility returns. A *permanent* loss is not: the platform sends no GAIN, and this class
   * does not re-request, because a session that re-asks every tick is the focus thrash a previous
   * review round had to remove. Such a session stays half duplex until Talk is restarted.
   */
  @get:Synchronized
  val communicationAudioEligible: Boolean
    get() = activeOwner != null && !modeLost && focusActive

  /** The same fact, readable without entering the monitor. For the capture read loop only. */
  val communicationAudioEligibleUnsynchronized: Boolean
    get() = eligibilitySnapshot

  /**
   * Re-reads the device mode, then reports whether communication audio is eligible overall.
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
  fun verifyCommunicationAudioEligible(audioManager: AudioManager): Boolean {
    if (activeOwner == null) return false
    if (readMode(audioManager, AudioManager.MODE_INVALID) == AudioManager.MODE_IN_COMMUNICATION) {
      modeLost = false
    } else {
      if (!modeLost) Log.w(tag, "communication mode no longer active; dropping to half duplex")
      modeLost = true
    }
    publishSnapshot()
    // The mode is the only fact this re-reads; focus is maintained by the platform's own callback
    // and the token by the session lifecycle. Returning the conjunction keeps one source of truth.
    return activeOwner != null && !modeLost && focusActive
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
    eligibilitySnapshot = activeOwner != null && !modeLost && focusActive
  }

  private fun acquireFocus(audioManager: AudioManager): FocusOutcome {
    if (focusRequest != null) return FocusOutcome.AlreadyHeld
    val generation = ++focusGeneration
    // This generation starts un-held; only a grant that no callback has already revoked sets it.
    focusActive = false
    val request =
      AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(realtimeCommunicationPlaybackAttributes())
        // The listener is what makes focus a live fact rather than an acquisition-time one.
        // Bound to this request's generation so a callback that outlives it cannot speak for
        // whatever session came next.
        //
        // Dispatched on a private thread, not the default. The single-argument overload delivers
        // on the main Looper, and this callback takes the monitor that `enter` and `restore` hold
        // across AudioService calls -- a loss arriving during one of those would park the UI
        // thread for the length of a HAL round trip.
        .setOnAudioFocusChangeListener({ change -> onFocusChange(generation, change) }, focusCallbackHandler())
        .build()
    val granted = runCatching { audioManager.requestAudioFocus(request) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      Log.w(tag, "communication audio focus not granted (code $granted)")
      // requestAudioFocus registers the listener before it consults the service and does not
      // unregister on refusal, so a denied request would otherwise pin its listener -- and this
      // owner through it -- in a process-global map for the process lifetime. Each request now
      // carries a distinct capturing lambda, so those entries would accumulate per denial.
      runCatching { audioManager.abandonAudioFocusRequest(request) }
      publishSnapshot()
      return FocusOutcome.Denied
    }
    focusRequest = request
    // Not unconditional: a reentrant loss delivered during the call above already spoke for this
    // generation, and the grant must not overwrite it.
    if (focusGeneration == generation && focusRevokedGeneration != generation) focusActive = true
    publishSnapshot()
    return FocusOutcome.Acquired
  }

  /**
   * The platform telling this app what happened to its focus.
   *
   * Every loss variant this app is told about revokes full-duplex eligibility, CAN_DUCK included:
   * ducking still puts another app's audio on the loudspeaker the echo canceller is referencing,
   * and the canceller has no reference for it.
   *
   * CAN_DUCK is delivered only when the platform cannot duck this app itself. Because the playout
   * track is CONTENT_TYPE_SPEECH the platform declines to duck it and notifies instead -- but only
   * while such a track is actually started. A duckable loss arriving between responses is handled
   * silently by the platform and produces no callback, so this arm covers the case that matters
   * (a duck during playback) rather than every duck.
   *
   * Callbacks are dispatched by the platform on its own thread, so this takes the monitor. It
   * performs no AudioManager call, so it cannot block on a binder round trip while holding it.
   */
  @Synchronized
  private fun onFocusChange(
    generation: Long,
    change: Int,
  ) {
    // A callback from an abandoned or superseded request must never touch newer state.
    if (generation != focusGeneration) return
    when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> {
        // Only a live owner may be restored. Focus returning says nothing about the mode, which
        // keeps its own independent read-back.
        if (activeOwner == null) return
        focusActive = true
      }
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,
      -> {
        if (focusActive) Log.w(tag, "communication audio focus lost (change=$change); closing full duplex")
        focusActive = false
        focusRevokedGeneration = generation
      }
      else -> return
    }
    publishSnapshot()
  }

  private fun releaseFocus(audioManager: AudioManager) {
    // Revoked before the abandon, not after: the snapshot must never report eligible for a
    // request that is already on its way out.
    focusActive = false
    focusGeneration += 1
    publishSnapshot()
    focusRequest?.let { request ->
      val result = runCatching { audioManager.abandonAudioFocusRequest(request) }
      val code = result.getOrNull()
      if (result.isFailure || code != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        // Worth seeing, because the platform may still consider this app a focus holder. The
        // handle is dropped anyway: keeping it would make the next session's acquireFocus report
        // AlreadyHeld and leave that session permanently ineligible, which is strictly worse than
        // a stale platform-side request whose listener this generation fence has already made
        // inert.
        Log.w(tag, "communication audio focus not abandoned cleanly (code=${code ?: "threw"})")
      }
      focusRequest = null
    }
  }

  internal companion object {
    /**
     * One process-wide thread for focus callbacks.
     *
     * Private rather than the main Looper so a callback can block on this class's monitor without
     * parking the UI thread. Started once and left running: it is a single idle Looper thread for
     * the process, and tying its lifetime to individual sessions would reintroduce the teardown
     * race the generation fence exists to remove.
     */
    private val focusCallbackThread by lazy {
      HandlerThread("realtime-audio-focus").also { it.start() }
    }

    private val focusCallbackHandlerInstance by lazy { Handler(focusCallbackThread.looper) }

    private fun focusCallbackHandler(): Handler = focusCallbackHandlerInstance

    /** The token value a session that never acquired the mode carries. */
    const val NO_OWNER = 0L
    private const val FOCUS_RETRY_BUDGET = 6
    private const val tag = "RealtimeAudio"
  }
}
