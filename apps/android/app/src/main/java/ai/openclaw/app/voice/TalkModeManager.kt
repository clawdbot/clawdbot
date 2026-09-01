package ai.openclaw.app.voice

import ai.openclaw.app.gateway.ChatSendAck
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.TalkSessionCancelOutputResult
import ai.openclaw.app.gateway.chatSendAckHistorySinceSeconds
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.IOException
import java.util.LinkedHashMap
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.coroutineContext

/**
 * Gateway payload returned when Android starts a push-to-talk capture.
 */
data class TalkPttStartPayload(
  val captureId: String,
) {
  fun toJson(): String = """{"captureId":"$captureId"}"""
}

/**
 * Gateway payload returned when a push-to-talk capture ends or is cancelled.
 */
data class TalkPttStopPayload(
  val captureId: String,
  val transcript: String?,
  val status: String,
) {
  fun toJson(): String =
    buildJsonObject {
      put("captureId", JsonPrimitive(captureId))
      if (transcript != null) {
        put("transcript", JsonPrimitive(transcript))
      }
      put("status", JsonPrimitive(status))
    }.toString()
}

internal sealed interface TalkPttOnceStart {
  data class Busy(
    val payload: TalkPttStopPayload,
  ) : TalkPttOnceStart

  data class Started(
    val captureId: String,
    val completion: CompletableDeferred<TalkPttStopPayload>,
  ) : TalkPttOnceStart
}

internal suspend fun requestPhoneRealtimeSessionWithLanguageFallback(
  language: String?,
  request: suspend (language: String?) -> String,
): String =
  try {
    request(language)
  } catch (err: GatewayRequestRejected) {
    if (language == null || !err.gatewayError.isUnsupportedSessionLanguageParam()) {
      throw err
    }
    request(null)
  }

private enum class TalkStatusState {
  Off,
  Active,
  TalkFailure,
}

private data class TalkStatus(
  val text: NativeText,
  val state: TalkStatusState,
  val awaitingAgent: Boolean = false,
)

/** One capture generation's answer about platform echo cancellation, published as a unit. */
private data class RealtimeAecCapability(
  val generation: Long,
  val enabled: Boolean,
)

private data class PendingRealtimePlaybackMark(
  val sessionId: String,
  val name: String,
  val targetFrame: Long? = null,
)

private class PushToTalkAudioSource(
  val readDescriptor: ParcelFileDescriptor,
  private val writeStream: ParcelFileDescriptor.AutoCloseOutputStream,
  private val audioRecord: AudioRecord,
) {
  private val finishRequested = AtomicBoolean(false)
  private val inputFinished = AtomicBoolean(false)
  private val descriptorClosed = AtomicBoolean(false)
  var pumpJob: Job? = null

  fun requestFinish() {
    if (!finishRequested.compareAndSet(false, true)) return
    runCatching { audioRecord.stop() }
  }

  fun finishFromPump() {
    if (!inputFinished.compareAndSet(false, true)) return
    runCatching { audioRecord.stop() }
    runCatching { audioRecord.release() }
    runCatching { writeStream.close() }
  }

  fun close() {
    requestFinish()
    pumpJob?.cancel()
    finishFromPump()
    pumpJob = null
    if (descriptorClosed.compareAndSet(false, true)) {
      runCatching { readDescriptor.close() }
    }
  }
}

private sealed interface PushToTalkRecognitionRung {
  val candidate: PushToTalkRecognitionCandidate

  data class RawAudioSegmented(
    val source: PushToTalkAudioSource,
  ) : PushToTalkRecognitionRung {
    override val candidate = PushToTalkRecognitionCandidate.RawAudioSegmented
  }

  data object SilenceSegmented : PushToTalkRecognitionRung {
    override val candidate = PushToTalkRecognitionCandidate.SilenceSegmented
  }

  data object RestartingSingleSession : PushToTalkRecognitionRung {
    override val candidate = PushToTalkRecognitionCandidate.RestartingSingleSession
  }
}

class TalkModeManager internal constructor(
  private val context: Context,
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val isConnected: () -> Boolean,
  private val gatewayStableId: () -> String? = { null },
  private val preferredAudioInputDevice: () -> String? = { null },
  private val onAppliedAudioInputChanged: (String?) -> Unit = {},
  private val onBeforeSpeak: suspend () -> Unit = {},
  private val onAfterSpeak: suspend () -> Unit = {},
  private val onStoppedByRelay: () -> Unit = {},
  private val talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(session = session),
  private val talkAudioPlayer: TalkAudioPlaying = TalkAudioPlayer(context),
  private val realtimeCaptureDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val realtimePlaybackDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val realtimeMarkAcknowledger: (suspend (sessionId: String, markName: String) -> Unit)? = null,
  private val realtimeAudioSinkFactory: RealtimeAudioSinkFactory = RealtimeAudioSinkFactory.AudioTrackBacked,
) {
  companion object {
    private const val tag = "TalkMode"

    // Packed phases for the bounded uplink observation below. Ints rather than an enum so the
    // whole observation -- phase and the two facts that explain it -- is one lock-free word the
    // capture path can compare without allocating.
    private const val uplinkPhaseIdle = 0
    private const val uplinkPhaseSuppressed = 1
    private const val uplinkPhaseEnqueued = 2
    private const val uplinkPhaseFenced = 3
    private const val uplinkAecBit = 1 shl 2
    private const val uplinkCommBit = 1 shl 3
    private const val uplinkLocalBit = 1 shl 4
    private const val uplinkPhaseUnobserved = -1

    // Realtime playback plays the Gateway's declared wire audio verbatim, so its rate is a
    // property of that stream. Capture is a separate contract: the microphone negotiates its own
    // clock and the result is converted to whatever rate the Gateway declared for the uplink.
    private const val realtimeOutputSampleRateHz = 24_000

    // Preferred, not required. It is the rate Android guarantees most widely for raw capture, and
    // the one the portable path is built around; the wire rate is tried after it, and the rate the
    // recorder actually negotiates is what decides whether either candidate is usable.
    private const val realtimeCapturePortableSampleRateHz = 48_000

    private const val realtimeAudioFrameMs = 100
    private const val chatFinalWaitMs = 45_000L
    private const val maxCachedRunCompletions = 128
    private const val maxConversationEntries = 40
    private const val realtimePlaybackBufferMs = 240
    private const val realtimePlaybackIdlePollMs = 20L

    // How often the effect is re-measured off the capture read loop. Slow enough that the IPC is
    // negligible, fast enough that a route that lost its canceller closes the uplink within a
    // few frames rather than at the next route event.
    private const val realtimeAecRefreshMs = 500L

    // Queue depth is not evidence about the device. The relay forwards provider audio unpaced
    // and a realtime provider generates speech faster than the speaker plays it, so the backlog
    // grows with response length on a perfectly healthy device; a device that has actually
    // stopped draining is diagnosed by the write stall budget instead. What this ceiling bounds
    // is memory: roughly four minutes of queued PCM at the realtime rate, far more than any one
    // response, so reaching it means audio is accumulating without limit.
    private const val realtimePlaybackQueuedAudioCeilingBytes = 12L * 1024L * 1024L

    // The channel is still bounded, and the two bounds cover each other: this slot count is what
    // catches a provider streaming many tiny frames, which would reach no byte ceiling.
    private const val realtimePlaybackProviderQueueCapacity = 4_096

    // Clear and Stop are never counted against either bound. Teardown has to fit even when the
    // queue is full, or a full queue could never be drained. Sized well above the number of
    // control commands any real burst produces; PollIdle is deduped to one in flight.
    private const val realtimePlaybackControlQueueHeadroom = 32
    private const val realtimeUserFinalRewriteGraceMs = 1_500L
    private const val pushToTalkSampleRateHz = 16_000
    private const val pushToTalkReleaseGraceMs = 5_000L
    private const val pushToTalkReleaseDrainTimeoutMs = 6_000L
    private const val pushToTalkRestartDelayMs = 200L
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val systemAudioManager by lazy { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  private var gatewayWorkJob = SupervisorJob()
  private var gatewayWorkScope = CoroutineScope(scope.coroutineContext + gatewayWorkJob)
  private val gatewayGeneration = AtomicLong()

  init {
    scope.coroutineContext[Job]?.invokeOnCompletion { gatewayWorkJob.cancel() }
  }

  private val json = Json { ignoreUnknownKeys = true }
  private val _isEnabled = MutableStateFlow(false)
  val isEnabled: StateFlow<Boolean> = _isEnabled

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening

  private val _isSpeaking = MutableStateFlow(false)
  val isSpeaking: StateFlow<Boolean> = _isSpeaking

  private val _inputLevel = MutableStateFlow(0f)
  val inputLevel: StateFlow<Float> = _inputLevel

  // Null while no metered PCM playback is active. System TTS and talk.speak
  // compressed playback expose no envelope; the waveform then shows the
  // synthetic Speaking(null) pulse instead of a frozen line.
  private val _outputLevel = MutableStateFlow<Float?>(null)
  val outputLevel: StateFlow<Float?> = _outputLevel

  // True while the realtime provider streams a non-final user transcript, the
  // closest Android has to iOS endpointing's "speech detected" signal.
  private val _speechActive = MutableStateFlow(false)
  val speechActive: StateFlow<Boolean> = _speechActive

  private val playbackLock = Any()

  @Volatile
  private var currentStatus = TalkStatus(text = nativeText("Off"), state = TalkStatusState.Off)

  private val _statusText = MutableStateFlow(currentStatus.text)
  val statusText: StateFlow<String> = _statusText.resolveNativeText()

  // Typed "waiting on the agent" signal for the waveform's Thinking phase, so
  // UI never has to parse status strings. Every status change flows through
  // setStatus; forgetting the flag fails safe (wave shows Listening/Idle).
  private val _awaitingAgent = MutableStateFlow(false)
  val awaitingAgent: StateFlow<Boolean> = _awaitingAgent

  private fun setStatus(
    text: NativeText,
    state: TalkStatusState = TalkStatusState.Active,
    awaitingAgent: Boolean = false,
  ) {
    setStatus(TalkStatus(text = text, state = state, awaitingAgent = awaitingAgent))
  }

  private fun setStatus(status: TalkStatus) {
    currentStatus = status
    _statusText.value = status.text
    _awaitingAgent.value = status.awaitingAgent
  }

  private fun setTalkFailure(text: NativeText) {
    setStatus(text, state = TalkStatusState.TalkFailure)
  }

  private val _lastAssistantText = MutableStateFlow<String?>(null)
  val lastAssistantText: StateFlow<String?> = _lastAssistantText

  private val _conversation = MutableStateFlow<List<VoiceConversationEntry>>(emptyList())
  val conversation: StateFlow<List<VoiceConversationEntry>> = _conversation

  private var recognizer: SpeechRecognizer? = null
  private var restartJob: Job? = null
  private var stopRequested = false
  private var listeningMode = false
  private var activePttCaptureId: String? = null
  private var pttAutoStopEnabled = false
  private var pttTimeoutJob: Job? = null
  private var pttCompletion: CompletableDeferred<TalkPttStopPayload>? = null
  private var pttRecognitionRung: PushToTalkRecognitionRung? = null
  private var pttReleaseCompletion: CompletableDeferred<Unit>? = null
  private val pttFinalSegments = mutableListOf<String>()
  private var pttLivePartial = ""

  private var silenceJob: Job? = null
  private var silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
  private var lastTranscript: String = ""
  private var lastHeardAtMs: Long? = null
  private var lastSpokenText: String? = null
  private var lastInterruptedAtSeconds: Double? = null

  // Interrupt-on-speech is disabled by default: starting a SpeechRecognizer during
  // TTS creates an audio session conflict on some OEMs. Can be enabled via gateway talk config.
  private var interruptOnSpeech: Boolean = false
  private var mainSessionKey: String = "main"
  private var speechLocale: String? = null
  private var realtimeRelayModelSupported = true

  @Volatile private var pendingRunId: String? = null
  private var pendingFinal: CompletableDeferred<Boolean>? = null
  private val completedRunsLock = Any()
  private val completedRunStates = LinkedHashMap<String, Boolean>()
  private val completedRunTexts = LinkedHashMap<String, String>()
  private var configLoaded = false
  private val startGeneration = AtomicLong(0L)
  private val audioInputGeneration = AtomicLong(0L)

  @Volatile private var realtimeSessionId: String? = null

  // Declared once by talk.session.create and read by every capture install for this session,
  // including the one push-to-talk performs when it hands the microphone back.
  @Volatile private var realtimeWireAudioContract: RealtimeWireAudioContract? = null

  // Whether the running capture session reports platform echo cancellation as actually enabled,
  // published together with the generation that observed it. The pair is one atomic value on
  // purpose: a separate check-then-set lets a dying job win the race against the boundary that
  // was meant to fence it off, and leave the uplink open for a successor that has no canceller.
  private val realtimeAecCapability = AtomicReference(RealtimeAecCapability(0L, false))

  private val realtimeAecEnabled: Boolean
    get() = realtimeAecCapability.get().enabled

  /**
   * The last published state of the playback-time forwarding decision.
   *
   * The gate this class enforces is the only thing between the assistant's own voice and the
   * uplink, and it reported nothing: a session that kept the microphone open through playback was
   * indistinguishable, from outside, from one that had quietly fallen back to half duplex. Holding
   * the last state lets the decision be reported on its *edges* rather than per frame.
   */
  private val realtimeUplinkPhase = AtomicInteger(uplinkPhaseUnobserved)

  // Communication audio belongs to the relay session, not to a response. Only the realtime lane
  // acquires it, so one owner per manager is enough.
  private val realtimeCommunicationAudio = RealtimeCommunicationAudioOwner()

  @Volatile private var realtimeCommunicationAudioToken = RealtimeCommunicationAudioOwner.NO_OWNER

  init {
    // Registered here rather than beside the other completion hook: an already-completed scope
    // runs this handler synchronously inside the constructor, and the owner above must exist by
    // then. A scope that completes without a relay teardown would otherwise leave the device in
    // communication mode; the token guard makes it a no-op whenever teardown already ran.
    scope.coroutineContext[Job]?.invokeOnCompletion {
      realtimeCommunicationAudio.restore(systemAudioManager, realtimeCommunicationAudioToken)
    }
  }

  private var realtimeCaptureJob: Job? = null
  private var realtimeAppendJob: Job? = null
  private val realtimeCapturePauseLock = Any()
  private var realtimeCapturePause: RealtimeCapturePause? = null

  private val finishingPttLock = Any()

  @Volatile private var finishingPttCaptureId: String? = null

  @Volatile private var finishingPttJob: Job? = null

  private val realtimeAgentCoordinator =
    RealtimeAgentCoordinator(
      parentScope = scope,
      requestGateway = ::requestGateway,
      onWorking = { session ->
        if (realtimeSessionId == session.relaySessionId) {
          setStatus(nativeText("Thinking…"), awaitingAgent = true)
        }
      },
      onError = { _, message -> Log.w(tag, message) },
      onUnhandledCompletion = { completion ->
        handleNonRealtimeAgentChatEvent(
          sessionKey = completion.sessionKey,
          runId = completion.runId,
          state = completion.state,
          message = completion.message,
        )
      },
    )
  private var realtimeUserEntryId: String? = null
  private var realtimeUserEntryAwaitingFinal = false
  private var realtimeUserEntryAwaitingFinalStartedAtMs: Long? = null
  private var realtimeAssistantEntryId: String? = null

  // Single-owner realtime playout. Gateway ingress only ever enqueues onto
  // [realtimePlaybackCommands]; the output device and every field in this group are touched
  // exclusively by [realtimePlaybackOwner]. The two share no lock and no suspension, so an
  // inbound Gateway frame can never wait on hardware backpressure. (They do still share
  // [realtimeCapturePauseLock] on the teardown path, but only for field swaps -- no device
  // call and no suspension happens under it. Note that relay teardown itself does make one
  // synchronous AudioService call from the ingress pump, in stopRealtimeRelay's restore of the
  // communication mode -- once per teardown, not per frame; see the note there.)
  private val realtimePlaybackCommands =
    Channel<RealtimePlaybackCommand>(
      capacity = realtimePlaybackProviderQueueCapacity + realtimePlaybackControlQueueHeadroom,
    )
  private val queuedRealtimeProviderCommands = AtomicInteger(0)
  private val queuedRealtimeAudioBytes = AtomicLong(0L)
  private val realtimePlaybackPollIdleQueued = AtomicBoolean(false)
  private val realtimePlaybackEpoch = AtomicLong(0L)
  private var realtimeAudioSink: RealtimeAudioSink? = null
  private var realtimePlaybackIdleJob: Job? = null
  private var realtimeWrittenFrames = 0L
  private val pendingRealtimePlaybackMarks = LinkedHashMap<String, PendingRealtimePlaybackMark>()

  @Volatile private var pendingRealtimeOutputClear: CompletableDeferred<String?>? = null

  @Volatile private var realtimeOutputTurnId: String? = null
  private val realtimeOutputCancellationMutex = Mutex()

  @Volatile
  private var realtimePlaybackEndsAtMs = 0L

  @Volatile
  private var realtimeOutputSuppressed = false

  @Volatile
  private var playbackEnabled = true
  private val playbackGeneration = AtomicLong(0L)

  private enum class PlaybackPhase {
    Preparing,
    Playing,
  }

  // Its own job rather than a child of [scope]: the owner outlives every gateway scope and
  // is torn down with the manager itself, below. Declared after every field the command
  // handlers read, because `launch` can start the body on another thread before this
  // constructor returns.
  private val realtimePlaybackOwnerJob = SupervisorJob()
  private val realtimePlaybackOwnerScope = CoroutineScope(scope.coroutineContext + realtimePlaybackOwnerJob)
  private val realtimePlaybackOwner: Job =
    realtimePlaybackOwnerScope.launch(realtimePlaybackDispatcher) {
      try {
        for (command in realtimePlaybackCommands) {
          if (command is RealtimePlaybackCommand.Audio || command is RealtimePlaybackCommand.Mark) {
            queuedRealtimeProviderCommands.decrementAndGet()
          }
          if (command is RealtimePlaybackCommand.Audio) {
            queuedRealtimeAudioBytes.addAndGet(-command.bytes.size.toLong())
          }
          try {
            when (command) {
              is RealtimePlaybackCommand.Audio -> processRealtimeAudioOwnerOnly(command)
              is RealtimePlaybackCommand.Mark -> processRealtimeMarkOwnerOnly(command)
              is RealtimePlaybackCommand.Clear -> processRealtimeClearOwnerOnly(command)
              is RealtimePlaybackCommand.Stop -> processRealtimeStopOwnerOnly(command)
              RealtimePlaybackCommand.PollIdle -> processRealtimePollIdleOwnerOnly()
            }
          } catch (err: CancellationException) {
            throw err
          } catch (err: Throwable) {
            // One command must never end this loop. The channel is long-lived and never
            // recreated, so a dead owner would swallow every later command in silence.
            val message = err.message ?: err::class.simpleName ?: "playback command failed"
            Log.w(tag, "realtime playback command failed: $message")
            failRealtimePlaybackOwnerOnly(message)
          }
        }
      } finally {
        // The owner is the only thing that may touch the device, so it is also the only thing
        // that can release it. Cancellation (scope completion), an exception escaping the loop,
        // and channel closure all land here; without it a cancelled owner leaves an AudioTrack
        // alive with residual audio still presenting, and leaves the capture gate believing the
        // assistant is still speaking. Idempotent with Stop/Clear: both already emptied the map
        // and nulled the sink, so this is a no-op on the normal paths.
        retirePlayoutOnOwnerExitOwnerOnly()
      }
    }

  init {
    // Declared here rather than beside the owner's job so it runs after that job exists.
    scope.coroutineContext[Job]?.invokeOnCompletion { realtimePlaybackOwnerJob.cancel() }
  }

  private data class PlaybackLease(
    val token: Long,
    val job: Job,
    var phase: PlaybackPhase = PlaybackPhase.Preparing,
  )

  private var localPlayback: PlaybackLease? = null
  private var realtimePlaying = false

  /**
   * Lock-free mirrors of the two speaking sources, republished by [publishSpeakingState].
   *
   * The capture path cannot take [playbackLock] to ask which source is playing, and it must not
   * ask [_isSpeaking], because that is deliberately the union of both. Mirrors rather than a
   * second state machine: they are derived in exactly one place, from the same read that
   * publishes the projection.
   */
  @Volatile private var realtimeCommunicationPlaybackActive = false

  @Volatile private var localMediaPlaybackActive = false
  private val systemSpeech = SystemSpeechSpeaker(context)

  @Volatile private var finalizeInFlight = false
  private var listenWatchdogJob: Job? = null

  private var audioFocusRequest: AudioFocusRequest? = null
  private val audioFocusListener =
    AudioManager.OnAudioFocusChangeListener { focusChange ->
      when (focusChange) {
        AudioManager.AUDIOFOCUS_LOSS,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        -> {
          if (_isSpeaking.value) {
            Log.d(tag, "audio focus lost; stopping TTS")
            stopSpeaking(resetInterrupt = true)
          }
        }

        else -> { /* regained or duck — ignore */ }
      }
    }

  /** Updates the chat session used for TalkMode turns and wake-command replies. */
  fun setMainSessionKey(sessionKey: String?) {
    val trimmed = sessionKey?.trim().orEmpty()
    if (trimmed.isEmpty()) return
    mainSessionKey = trimmed
  }

  /** Starts or stops continuous realtime TalkMode capture. */
  fun setEnabled(enabled: Boolean) {
    if (_isEnabled.value == enabled) return
    _isEnabled.value = enabled
    if (enabled) {
      Log.d(tag, "enabled")
      start()
    } else {
      Log.d(tag, "disabled")
      stop()
    }
  }

  /** Stops continuous, one-shot, or push-to-talk capture regardless of the enabled flag. */
  fun stopAllCapture() {
    _isEnabled.value = false
    stop()
  }

  /** Cancels work carrying voice/session data before a replacement gateway can connect. */
  fun onGatewayScopeChanging() {
    stopRealtimeRelay(closeSession = false)
    realtimeAgentCoordinator.resetTransport()
    gatewayGeneration.incrementAndGet()
    gatewayWorkJob.cancel()
    gatewayWorkJob = SupervisorJob()
    gatewayWorkScope = CoroutineScope(scope.coroutineContext + gatewayWorkJob)
    _conversation.value = emptyList()
    _lastAssistantText.value = null
    configLoaded = false
    silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
    interruptOnSpeech = false
    speechLocale = null
    realtimeRelayModelSupported = true
  }

  private suspend fun requestGateway(
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
  ): String {
    val gatewayId = gatewayStableId()?.trim()?.takeIf { it.isNotEmpty() }
    return if (gatewayId == null) {
      session.request(method, paramsJson, timeoutMs)
    } else {
      session.requestForEndpoint(gatewayId, method, paramsJson, timeoutMs)
    }
  }

  private suspend fun sendGatewayRequestFrame(
    method: String,
    paramsJson: String?,
    timeoutMs: Long,
    onError: (GatewaySession.ErrorShape) -> Unit,
  ) {
    val gatewayId = gatewayStableId()?.trim()?.takeIf { it.isNotEmpty() }
    if (gatewayId == null) {
      session.sendRequestFrame(method, paramsJson, timeoutMs, onError)
    } else {
      session.sendRequestFrameForEndpoint(gatewayId, method, paramsJson, timeoutMs, onError)
    }
  }

  internal val activePushToTalkCaptureId: String?
    get() = activePttCaptureId

  internal val finishingPushToTalkCaptureId: String?
    get() = finishingPttCaptureId

  /** Starts a push-to-talk capture session for gateway node.invoke callers. */
  suspend fun beginPushToTalk(
    allowNewCapture: Boolean,
    canStartCapture: () -> Boolean = { true },
  ): TalkPttStartPayload =
    startPushToTalk(
      allowNewCapture = allowNewCapture,
      canStartCapture = canStartCapture,
      completion = null,
    ).payload

  private sealed interface PushToTalkStartResult {
    val payload: TalkPttStartPayload

    data class Started(
      override val payload: TalkPttStartPayload,
    ) : PushToTalkStartResult

    data class Existing(
      override val payload: TalkPttStartPayload,
    ) : PushToTalkStartResult
  }

  private data class ClearedPushToTalkCapture(
    val transcript: String,
    val completion: CompletableDeferred<TalkPttStopPayload>?,
  )

  private data class RealtimeCapturePause(
    // Null while relay creation is still in flight. Keeping the PTT turn here
    // prevents a late relay response from opening a second microphone capture.
    val sessionId: String?,
    val pttCaptureId: String,
    val restartRelay: Boolean = false,
  )

  private enum class RealtimeCaptureResume {
    Skipped,
    Resumed,
    Restart,
    Disconnected,
  }

  private suspend fun startPushToTalk(
    allowNewCapture: Boolean,
    canStartCapture: () -> Boolean,
    completion: CompletableDeferred<TalkPttStopPayload>?,
    autoStopAfterMs: Long? = null,
  ): PushToTalkStartResult {
    if (!allowNewCapture) {
      // A background retry may reconcile an existing capture, but must never create one.
      return activePttCaptureId
        ?.let(::TalkPttStartPayload)
        ?.let { PushToTalkStartResult.Existing(it) }
        ?: throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
    }
    // PTT begin is idempotent so gateway retries don't start multiple recognizers.
    activePttCaptureId?.let {
      if (pttReleaseCompletion == null) {
        return PushToTalkStartResult.Existing(TalkPttStartPayload(captureId = it))
      }
    }
    finishingPttCaptureId?.let {
      throw IllegalStateException("PTT_BUSY: previous push-to-talk turn is still finishing")
    }
    if (!isConnected()) {
      setStatus(nativeText("Gateway not connected"))
      throw IllegalStateException("UNAVAILABLE: Gateway not connected")
    }

    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      setStatus(nativeText("Microphone permission required"))
      throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      setStatus(nativeText("Speech recognizer unavailable"))
      throw IllegalStateException("UNAVAILABLE: Speech recognizer unavailable")
    }

    val captureId = UUID.randomUUID().toString()
    val captureGeneration = startGeneration.get()
    return try {
      withContext(Dispatchers.Main) {
        val hasPendingRelease = pttReleaseCompletion != null
        if (hasPendingRelease) {
          drainPushToTalkReleaseBeforeBegin()
        }
        activePttCaptureId?.let {
          if (!hasPendingRelease) {
            return@withContext PushToTalkStartResult.Existing(TalkPttStartPayload(captureId = it))
          }
        }
        finishingPttCaptureId?.let {
          throw IllegalStateException("PTT_BUSY: previous push-to-talk turn is still finishing")
        }
        if (captureGeneration != startGeneration.get() || !canStartCapture()) {
          throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
        }
        stopSpeaking(resetInterrupt = false)
        pttTimeoutJob?.cancel()
        pttTimeoutJob = null
        pttAutoStopEnabled = false
        silenceJob?.cancel()
        silenceJob = null
        listeningMode = false
        _isListening.value = false
        finalizeInFlight = false
        stopRequested = false
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        closePushToTalkRung()
        pttReleaseCompletion = null
        pttFinalSegments.clear()
        pttLivePartial = ""
        lastTranscript = ""
        lastHeardAtMs = null
        activePttCaptureId = captureId
        pttCompletion = completion
        try {
          // PTT owns the microphone until its turn finishes. Waiting here prevents
          // SpeechRecognizer from racing the realtime AudioRecord teardown.
          withContext(NonCancellable) {
            pauseRealtimeCaptureForPushToTalk(captureId)
          }
          if (
            activePttCaptureId != captureId ||
            captureGeneration != startGeneration.get() ||
            !canStartCapture() ||
            stopRequested
          ) {
            throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
          }
          recognizer =
            SpeechRecognizer.createSpeechRecognizer(context).also {
              it.setRecognitionListener(recognitionListener(captureId))
            }
          startPushToTalkRecognition(captureId)
        } catch (err: Throwable) {
          closePushToTalkRung()
          runCatching { recognizer?.cancel() }
          runCatching { recognizer?.destroy() }
          recognizer = null
          _isListening.value = false
          listeningMode = false
          clearListenWatchdog()
          activePttCaptureId = null
          pttCompletion = null
          completion?.cancel()
          resumeRealtimeCaptureAfterPushToTalk(captureId)
          setStatus(if (_isEnabled.value) nativeText("Listening") else nativeText("Ready"))
          throw err
        }
        setStatus(nativeText("Listening (PTT)"))
        if (autoStopAfterMs != null) {
          pttAutoStopEnabled = true
          // Install one-shot jobs before yielding to lifecycle changes. Otherwise a
          // background stop can run between capture startup and job registration.
          startSilenceMonitor(captureId)
          pttTimeoutJob =
            gatewayWorkScope.launch {
              delay(autoStopAfterMs)
              if (pttAutoStopEnabled) {
                endPushToTalk(captureId)
              }
            }
        }
        PushToTalkStartResult.Started(TalkPttStartPayload(captureId = captureId))
      }
    } catch (err: Throwable) {
      withContext(NonCancellable) {
        cancelPushToTalk(captureId)
      }
      throw err
    }
  }

  /** Stops push-to-talk capture and queues the transcript for gateway chat. */
  suspend fun endPushToTalk(): TalkPttStopPayload {
    val captureId = activePttCaptureId ?: UUID.randomUUID().toString()
    return endPushToTalk(captureId)
  }

  internal suspend fun endPushToTalk(captureId: String): TalkPttStopPayload =
    try {
      withContext(Dispatchers.Main) {
        awaitPushToTalkRelease(captureId)
        val cleared =
          clearPushToTalkRecognition(captureId)
            ?: return@withContext TalkPttStopPayload(captureId = captureId, transcript = null, status = "idle")
        val transcript = cleared.transcript

        if (transcript.isEmpty()) {
          return@withContext finishClearedPushToTalk(captureId, cleared, status = "empty")
        }

        if (!isConnected()) {
          return@withContext finishClearedPushToTalk(
            captureId,
            cleared,
            status = "offline",
            transcript = transcript,
            statusText = nativeText("Gateway not connected"),
          )
        }

        setStatus(nativeText("Thinking…"), awaitingAgent = true)
        lateinit var finishingJob: Job
        finishingJob =
          // Gateway-scoped so a switch drops the stale finalize; the NonCancellable
          // finally still resumes capture when the scope cancels this job.
          gatewayWorkScope.launch(start = CoroutineStart.LAZY) {
            try {
              finalizeTranscript(transcript)
            } finally {
              withContext(NonCancellable + Dispatchers.Main) {
                resumeRealtimeCaptureAfterPushToTalk(captureId)
                clearFinishingPushToTalk(captureId, finishingJob)
              }
            }
          }
        // Cancellation can win before a lazy coroutine enters its body, in which
        // case its Main-confined finally block never runs. Clear only the exact
        // owner here, then resume its microphone on Main if the parent is live.
        finishingJob.invokeOnCompletion {
          if (clearFinishingPushToTalk(captureId, finishingJob)) {
            scope.launch(Dispatchers.Main.immediate) {
              resumeRealtimeCaptureAfterPushToTalk(captureId)
            }
          }
        }
        // Publish the job before it can run so stop() cannot clear ownership while
        // an untracked finalizer still uses shared chat and playback state.
        synchronized(finishingPttLock) {
          finishingPttCaptureId = captureId
          finishingPttJob = finishingJob
          finishingJob.start()
        }
        finishPushToTalk(
          TalkPttStopPayload(captureId = captureId, transcript = transcript, status = "queued"),
          cleared.completion,
        )
      }
    } catch (err: CancellationException) {
      // Mirror the normal termination tail: resume realtime capture, restore status, and
      // resolve the PTT completion so a cancelled end (gateway drop) cannot leave Talk
      // paused or an awaiter stuck behind the release wait.
      withContext(NonCancellable + Dispatchers.Main) {
        val cleared = clearPushToTalkRecognition(captureId)
        if (cleared != null) {
          finishClearedPushToTalk(
            captureId,
            cleared,
            status = "cancelled",
            transcript = cleared.transcript.ifEmpty { null },
          )
        }
      }
      throw err
    }

  /** Cancels push-to-talk capture without sending the current transcript. */
  suspend fun cancelPushToTalk(): TalkPttStopPayload {
    val captureId = activePttCaptureId ?: UUID.randomUUID().toString()
    return cancelPushToTalk(captureId)
  }

  internal suspend fun cancelPushToTalk(captureId: String): TalkPttStopPayload =
    withContext(Dispatchers.Main) {
      val cleared =
        clearPushToTalkRecognition(captureId)
          ?: return@withContext TalkPttStopPayload(captureId = captureId, transcript = null, status = "idle")
      finishClearedPushToTalk(captureId, cleared, status = "cancelled")
    }

  /** Starts a bounded one-shot PTT turn that auto-stops on silence or timeout. */
  internal suspend fun beginPushToTalkOnce(
    maxDurationMs: Long = 12_000L,
    canStartCapture: () -> Boolean = { true },
  ): TalkPttOnceStart {
    val busyCaptureId = activePttCaptureId ?: finishingPttCaptureId
    if (busyCaptureId != null) {
      return TalkPttOnceStart.Busy(
        TalkPttStopPayload(
          captureId = busyCaptureId,
          transcript = null,
          status = "busy",
        ),
      )
    }

    val completion = CompletableDeferred<TalkPttStopPayload>()
    return when (
      val start =
        startPushToTalk(
          allowNewCapture = true,
          canStartCapture = canStartCapture,
          completion = completion,
          autoStopAfterMs = maxDurationMs,
        )
    ) {
      is PushToTalkStartResult.Existing -> {
        TalkPttOnceStart.Busy(
          TalkPttStopPayload(
            captureId = start.payload.captureId,
            transcript = null,
            status = "busy",
          ),
        )
      }

      is PushToTalkStartResult.Started -> {
        TalkPttOnceStart.Started(
          captureId = start.payload.captureId,
          completion = completion,
        )
      }
    }
  }

  /** Waits for a started one-shot turn without keeping NodeRuntime preparation locked. */
  internal suspend fun awaitPushToTalkOnce(start: TalkPttOnceStart): TalkPttStopPayload =
    when (start) {
      is TalkPttOnceStart.Busy -> {
        start.payload
      }

      is TalkPttOnceStart.Started -> {
        try {
          start.completion.await()
        } catch (err: Throwable) {
          withContext(NonCancellable) {
            cancelPushToTalk(start.captureId)
          }
          throw err
        }
      }
    }

  /** When true, play TTS for all final chat responses (even ones we didn't initiate). */
  @Volatile var ttsOnAllResponses = false

  /** Plays one text response through the configured Android/TalkMode TTS output. */
  fun playTtsForText(text: String) {
    val playbackToken = cancelActivePlayback()
    gatewayWorkScope.launch {
      reloadConfig()
      playAssistant(text, playbackToken)
    }
  }

  /** Routes gateway talk/chat events into realtime playback, pending PTT turns, and TTS. */
  fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (event == "talk.event") {
      handleRealtimeTalkEvent(payloadJson)
      return
    }
    if (ttsOnAllResponses) {
      Log.d(tag, "gateway event: $event")
    }
    if (event == "agent" && ttsOnAllResponses) {
      return
    }
    if (event != "chat") return
    if (payloadJson.isNullOrBlank()) return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val runId = obj["runId"].asStringOrNull() ?: return
    val state = obj["state"].asStringOrNull() ?: return

    val eventSession = obj["sessionKey"]?.asStringOrNull()
    // Consults use the acknowledged agent target, which can differ from the
    // voice key. Ordinary chat keeps its session privacy filter below.
    if (
      realtimeAgentCoordinator.handleChatEvent(
        sessionKey = eventSession,
        runId = runId,
        state = state,
        message = obj["message"],
      )
    ) {
      return
    }

    handleNonRealtimeAgentChatEvent(
      sessionKey = eventSession,
      runId = runId,
      state = state,
      message = obj["message"],
    )
  }

  private fun handleNonRealtimeAgentChatEvent(
    sessionKey: String?,
    runId: String,
    state: String,
    message: JsonElement?,
  ) {
    val activeSession = mainSessionKey.ifBlank { "main" }
    if (sessionKey != null && sessionKey != activeSession) return

    // If this is a response we initiated, handle normally below.
    // Otherwise, if ttsOnAllResponses, finish streaming TTS on terminal events.
    val pending = pendingRunId
    val knownRun = pending == runId || hasRunCompletion(runId)
    if (!knownRun) {
      if (ttsOnAllResponses && state == "final") {
        val text = extractTextFromChatEventMessage(message)
        if (!text.isNullOrBlank()) {
          playTtsForText(text)
        }
      }
      return
    }
    Log.d(tag, "chat event arrived runId=$runId state=$state pendingRunId=$pendingRunId")
    val terminal =
      when (state) {
        "final" -> true
        "aborted", "error" -> false
        else -> null
      } ?: return
    // Cache text from final event so we never need to poll chat.history
    if (terminal) {
      val text = extractTextFromChatEventMessage(message)
      if (!text.isNullOrBlank()) {
        synchronized(completedRunsLock) {
          completedRunTexts[runId] = text
          while (completedRunTexts.size > maxCachedRunCompletions) {
            completedRunTexts.entries.firstOrNull()?.let { completedRunTexts.remove(it.key) }
          }
        }
      }
    }
    cacheRunCompletion(runId, terminal)

    if (runId != pendingRunId) return
    pendingFinal?.complete(terminal)
    pendingFinal = null
    pendingRunId = null
  }

  internal suspend fun runE2eRealtimeTurn(
    userText: String,
    assistantText: String,
    timeoutMs: Long,
  ) {
    if (!_isEnabled.value) {
      setEnabled(true)
    }
    val sessionId = awaitRealtimeSessionId(timeoutMs)
    handleGatewayEvent("talk.event", realtimeTranscriptPayload(sessionId = sessionId, role = "user", text = userText))
    handleGatewayEvent("talk.event", realtimeTranscriptPayload(sessionId = sessionId, role = "assistant", text = assistantText))
  }

  /** Enables or disables local assistant audio playback and stops active audio when disabled. */
  fun setPlaybackEnabled(enabled: Boolean) {
    synchronized(playbackLock) {
      if (playbackEnabled == enabled) return
      playbackEnabled = enabled
    }
    if (!enabled) {
      stopRealtimePlayback()
      stopSpeaking()
    }
  }

  /** Reloads TalkMode voice/TTS settings from the gateway. */
  suspend fun refreshConfig() {
    reloadConfig()
  }

  internal suspend fun resolveRealtimeLanguageHint(requestedLanguage: String?): String? {
    ensureConfigLoaded()
    return resolveRealtimeTranscriptionLanguageHint(
      configuredLocaleTag = speechLocale,
      requestedLanguage = requestedLanguage,
      deviceLocaleTag = Locale.getDefault().toLanguageTag(),
    )
  }

  /** Speaks a chat assistant reply when playback is enabled. */
  suspend fun speakAssistantReply(text: String) {
    if (!playbackEnabled) return
    val playbackToken = cancelActivePlayback()
    ensureConfigLoaded()
    playAssistant(text, playbackToken)
  }

  private fun start() {
    if (realtimeSessionId != null || realtimeCaptureJob?.isActive == true) return
    if (scope.coroutineContext[Job]?.isActive == false) return
    val generation = startGeneration.incrementAndGet()
    stopRequested = false
    listeningMode = true
    Log.d(tag, "start")
    gatewayWorkScope.launch {
      try {
        ensureConfigLoaded()
        if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) return@launch
        if (realtimeRelayModelSupported) {
          startRealtimeRelay(generation)
        } else {
          startNativeTalk(generation)
        }
      } catch (err: Throwable) {
        if (err is CancellationException) return@launch
        setStatus(nativeText("Start failed: \$message", err.message ?: err::class.simpleName.orEmpty()))
        Log.w(tag, "start failed: ${err.message ?: err::class.simpleName}")
        stopRealtimeRelay(closeSession = false, preserveStatus = true)
        disableRealtimeModeAndNotifyOwner()
      }
    }
  }

  private fun stop() {
    stopRequested = true
    finalizeInFlight = false
    listeningMode = false
    activePttCaptureId = null
    synchronized(finishingPttLock) {
      finishingPttJob?.cancel()
    }
    pttAutoStopEnabled = false
    pttCompletion?.cancel()
    pttCompletion = null
    startGeneration.incrementAndGet()
    pttTimeoutJob?.cancel()
    pttTimeoutJob = null
    restartJob?.cancel()
    restartJob = null
    silenceJob?.cancel()
    silenceJob = null
    closePushToTalkRung()
    pttReleaseCompletion?.cancel()
    pttReleaseCompletion = null
    pttFinalSegments.clear()
    pttLivePartial = ""
    lastTranscript = ""
    lastHeardAtMs = null
    _isListening.value = false
    _inputLevel.value = 0f
    setStatus(nativeText("Off"), state = TalkStatusState.Off)
    stopRealtimeRelay()
    stopSpeaking()
    pendingRunId = null
    pendingFinal?.cancel()
    pendingFinal = null
    synchronized(completedRunsLock) {
      completedRunStates.clear()
      completedRunTexts.clear()
    }

    mainHandler.post {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }
    systemSpeech.shutdown()
  }

  private suspend fun awaitRealtimeSessionId(timeoutMs: Long): String =
    withTimeout(timeoutMs) {
      while (true) {
        realtimeSessionId?.let { return@withTimeout it }
        val status = currentStatus
        if (!_isEnabled.value && status.state != TalkStatusState.Off) {
          throw IllegalStateException(status.text.resolveNativeText())
        }
        delay(100L)
      }
      error("unreachable")
    }

  private suspend fun startRealtimeRelay(generation: Long) {
    if (!isConnected()) {
      setStatus(nativeText("Gateway not connected"))
      Log.w(tag, "realtime start: gateway not connected")
      disableRealtimeModeAndNotifyOwner()
      return
    }

    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      setStatus(nativeText("Microphone permission required"))
      Log.w(tag, "realtime start: microphone permission required")
      disableRealtimeModeAndNotifyOwner()
      return
    }

    ensureConfigLoaded()
    cancelActivePlayback()
    withContext(Dispatchers.Main) {
      if (activePttCaptureId == null) {
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
      }
    }

    setStatus(nativeText("Connecting…"), awaitingAgent = true)
    val language = realtimeTranscriptionLanguage(resolvedSpeechLocaleTag())
    val payload =
      requestPhoneRealtimeSessionWithLanguageFallback(language) { requestedLanguage ->
        val params =
          buildJsonObject {
            put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
            put("mode", JsonPrimitive("realtime"))
            put("transport", JsonPrimitive("gateway-relay"))
            put("brain", JsonPrimitive("agent-consult"))
            requestedLanguage?.let { put("language", JsonPrimitive(it)) }
          }
        requestGateway("talk.session.create", params.toString(), timeoutMs = 15_000)
      }
    val root = json.parseToJsonElement(payload).asObjectOrNull()
    val relaySession = root?.get("relaySessionId").asStringOrNull()
    val sessionId = relaySession ?: root?.get("sessionId").asStringOrNull()
    if (sessionId.isNullOrBlank()) {
      throw IllegalStateException("talk.session.create returned no session id")
    }
    if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) {
      closeRealtimeSession(sessionId)
      throw CancellationException("realtime talk stopped while connecting")
    }

    val wireAudioContract = parseRealtimeWireAudioContract(root, realtimeOutputSampleRateHz)
    // Outside the monitor below. Entering communication mode is a synchronous system call, and
    // Gateway ingress takes that same monitor for its own events -- holding it across the call
    // would make an inbound frame wait on an audio-route reconfiguration.
    val communicationAudioToken = acquireRealtimeCommunicationAudio()
    var captureFailure: String? = null
    // The claim above is a device call made outside the transition monitor, so a stop can land
    // between it and the publication below. Whether it was published decides who owns it.
    var publishedCommunicationAudio = false
    val capturePaused =
      synchronized(realtimeCapturePauseLock) {
        // Re-tested inside the monitor, not only before the claim above: acquiring communication
        // audio is a device call made outside this monitor, so a stop can complete in that window
        // and find nothing to tear down. Publishing a session after that stop would resurrect it
        // and wedge start(), which refuses while realtimeSessionId is non-null.
        if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) {
          return@synchronized null
        }
        // Session publication and capture installation are one transition. PTT
        // therefore either blocks startup or detaches every installed capture job.
        // The wire contract is published with the session id, not before it: a stop that lands
        // between the two would otherwise leave a live session with no contract to capture under.
        realtimeWireAudioContract = wireAudioContract
        realtimeCommunicationAudioToken = communicationAudioToken
        publishedCommunicationAudio = true
        realtimeAgentCoordinator.beginSession(
          RealtimeAgentSession(
            relaySessionId = sessionId,
            sessionKey = mainSessionKey.ifBlank { "main" },
          ),
        )
        realtimeSessionId = sessionId
        val pause = realtimeCapturePause
        if (pause != null) {
          realtimeCapturePause = pause.copy(sessionId = sessionId)
          realtimeOutputSuppressed = true
          true
        } else {
          realtimeOutputSuppressed = false
          _isListening.value = true
          setStatus(nativeText("Listening"))
          captureFailure = startRealtimeCaptureLocked(sessionId)
          false
        }
      }
    if (!publishedCommunicationAudio) {
      // A stop won the race: nothing holds this token, so it must be handed back here rather than
      // left standing with the device in communication mode and focus held.
      realtimeCommunicationAudio.restore(systemAudioManager, communicationAudioToken)
      closeRealtimeSession(sessionId)
      throw CancellationException("realtime talk stopped while connecting")
    }
    if (capturePaused == true) {
      Log.d(tag, "realtime session ready; capture paused for PTT relaySessionId=$sessionId")
      return
    }
    // Reported here rather than inside the lock: failing the relay tears the session down through
    // the same monitor, and doing that mid-transition would unwind a state change still in flight.
    captureFailure?.let { reason ->
      failRealtimeRelay(sessionId, reason)
      return
    }
    Log.d(tag, "realtime session started relaySessionId=$sessionId")
  }

  private suspend fun startNativeTalk(generation: Long) {
    if (!isConnected()) {
      setStatus(nativeText("Gateway not connected"))
      disableRealtimeModeAndNotifyOwner()
      return
    }
    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      setStatus(nativeText("Microphone permission required"))
      disableRealtimeModeAndNotifyOwner()
      return
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      setStatus(nativeText("Speech recognizer unavailable"))
      disableRealtimeModeAndNotifyOwner()
      return
    }
    withContext(Dispatchers.Main) {
      if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) return@withContext
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
      startListeningInternal(markListening = true)
    }
  }

  private fun disableRealtimeModeAndNotifyOwner() {
    if (!_isEnabled.value) return
    _isEnabled.value = false
    _isListening.value = false
    onStoppedByRelay()
  }

  private fun failRealtimeRelay(
    sessionId: String,
    message: String,
  ) {
    if (realtimeSessionId != sessionId) return
    setTalkFailure(nativeText("Talk failed: \$message", message))
    stopRealtimeRelay(cancelCapture = false, cancelAppend = false, preserveStatus = true)
    disableRealtimeModeAndNotifyOwner()
  }

  private fun realtimeCloseStatus(reason: String?): TalkStatus =
    when (reason) {
      null, "completed" -> {
        TalkStatus(text = nativeText("Off"), state = TalkStatusState.Off)
      }

      "error" -> {
        TalkStatus(
          text = nativeText("Talk failed: Realtime provider closed unexpectedly."),
          state = TalkStatusState.TalkFailure,
        )
      }

      else -> {
        TalkStatus(
          text = nativeText("Talk failed: Realtime provider closed: \$reason", reason),
          state = TalkStatusState.TalkFailure,
        )
      }
    }

  /**
   * Caller holds [realtimeCapturePauseLock] so PTT cannot miss newly installed jobs.
   *
   * Returns null once capture is installed, or the reason the session must fail. The caller
   * reports that reason after leaving the lock: teardown re-enters the same monitor.
   */
  @SuppressLint("MissingPermission")
  private fun startRealtimeCaptureLocked(sessionId: String): String? {
    // The only half of the contract that can be judged before the microphone is open. Whether a
    // converter exists depends on the rate the recorder negotiates, which is checked per candidate.
    val wireAudio = realtimeWireAudioContract
    if (wireAudio !is RealtimeWireAudioContract.Pcm16) {
      val detail = (wireAudio as? RealtimeWireAudioContract.Unsupported)?.detail ?: "no audio contract"
      Log.w(tag, "realtime capture rejected: unsupported wire audio contract ($detail)")
      return "unsupported realtime audio format"
    }
    val wireSampleRateHz = wireAudio.sampleRateHz
    realtimeCaptureJob?.cancel()
    realtimeAppendJob?.cancel()
    val inputGeneration = audioInputGeneration.incrementAndGet()
    // Cleared at the boundary itself, which also raises the published generation: from here a
    // superseded job cannot win the compare-and-set, so until the new capture reports its own
    // state no session has reported one, and the answer to "may the uplink stay open" is no.
    publishRealtimeAecCapability(inputGeneration, false)
    onAppliedAudioInputChanged(null)
    val audioFrames =
      Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    realtimeAppendJob =
      gatewayWorkScope.launch(realtimeCaptureDispatcher) {
        for (frame in audioFrames) {
          if (!shouldSubmitDequeuedRealtimeFrame(sessionId)) continue
          val audioBase64 = Base64.encodeToString(frame, Base64.NO_WRAP)
          val params =
            buildJsonObject {
              put("sessionId", JsonPrimitive(sessionId))
              put("audioBase64", JsonPrimitive(audioBase64))
              put("timestamp", JsonPrimitive(SystemClock.elapsedRealtime()))
            }
          try {
            sendGatewayRequestFrame(
              "talk.session.appendAudio",
              params.toString(),
              timeoutMs = 8_000,
            ) { error ->
              Log.w(tag, "realtime appendAudio failed: ${error.message}")
              failRealtimeRelay(sessionId, error.message)
            }
            // After the call returns, not before it: a send that threw never reached the socket.
            observeRealtimeFrameEnqueued()
          } catch (err: Throwable) {
            if (err is CancellationException) throw err
            Log.w(tag, "realtime appendAudio failed: ${err.message ?: err::class.simpleName}")
            failRealtimeRelay(sessionId, err.message ?: err::class.simpleName ?: "request failed")
          }
        }
      }
    realtimeCaptureJob =
      gatewayWorkScope.launch(realtimeCaptureDispatcher) {
        var audioInput: AndroidAudioInputSession? = null
        var health: RealtimeCaptureHealthReport? = null
        try {
          // Opening a candidate applies its route, and a candidate can still be rejected. Only the
          // selected session's route describes the microphone actually in use, so route changes are
          // published from the point the selection settles.
          val captureRouteSettled = AtomicBoolean(false)
          val selection =
            selectRealtimeCaptureSession(
              candidateRatesHz = realtimeCaptureCandidateRatesHz(realtimeCapturePortableSampleRateHz, wireSampleRateHz),
              wireRateHz = wireSampleRateHz,
            ) { candidateRateHz ->
              AndroidAudioInputSession.open(
                context,
                candidateRateHz,
                candidateRateHz * 2 * realtimeAudioFrameMs / 1000,
                preferredAudioInputDevice(),
                { key ->
                  if (captureRouteSettled.get() && audioInputGeneration.get() == inputGeneration) {
                    onAppliedAudioInputChanged(key)
                  }
                },
                profile = AndroidAudioInputProfile.VoiceCommunication,
              )
            }
          val openedAudioInput = selection.candidate
          audioInput = openedAudioInput
          val resampler = selection.resampler
          captureRouteSettled.set(true)
          if (audioInputGeneration.get() == inputGeneration) {
            onAppliedAudioInputChanged(openedAudioInput.appliedPreferredDeviceKey)
          }
          // Measured off the read loop, and gated on mode ownership: an effect that reports
          // enabled while some other app owns MODE_IN_COMMUNICATION is not cancelling this
          // session's downlink, so it must not open the uplink.
          val aecEnabled = realtimeEchoCancellationGranted(openedAudioInput, measure = true)
          publishRealtimeAecCapability(inputGeneration, aecEnabled)
          val captureHealth =
            RealtimeCaptureHealthReport(
              "requested=${selection.requestedSampleRateHz} actual=${selection.captureSampleRateHz} " +
                "wire=$wireSampleRateHz aecEnabled=$aecEnabled " +
                "commOut=${openedAudioInput.appliedCommunicationDeviceType ?: "platform"}",
            )
          health = captureHealth
          Log.d(
            tag,
            "realtime capture opened requested=${selection.requestedSampleRateHz}Hz " +
              "negotiated=${selection.captureSampleRateHz}Hz wire=${wireSampleRateHz}Hz " +
              "aecEnabled=$aecEnabled commOut=${openedAudioInput.appliedCommunicationDeviceType ?: "platform"}",
          )
          // One read is realtimeAudioFrameMs of audio at the rate the recorder negotiated, so
          // uplink pacing follows the negotiated clock rather than the requested one.
          val buffer = ByteArray(selection.captureSampleRateHz * 2 * realtimeAudioFrameMs / 1000)
          audioInput.startRecording()
          // The effect is re-measured here, not in the read loop below. Measuring takes the
          // capture session's lifecycle lock, which a route refresh holds across several
          // AudioManager binder calls; doing that between reads would put a route change on the
          // critical path of AudioRecord.read and overrun the recorder. This watcher can block
          // there instead, where blocking costs nothing.
          val aecWatcher =
            launch(realtimeCaptureDispatcher) {
              while (isActive) {
                delay(realtimeAecRefreshMs)
                // A transient focus holder at start time must not leave the whole session half
                // duplex; retrying here costs nothing when the mode is already held. Fenced on
                // this generation and session: a retry that raced teardown would otherwise claim
                // the device for a session that has ended.
                recoverRealtimeCommunicationAudio(inputGeneration, sessionId)
                publishRealtimeAecCapability(inputGeneration, realtimeEchoCancellationGranted(openedAudioInput, measure = true))
              }
            }
          try {
            while (coroutineContext.isActive && _isEnabled.value && realtimeSessionId == sessionId) {
              val read = audioInput.read(buffer, 0, buffer.size)
              if (read <= 0) continue
              // Lock-free and IPC-free: the cached capability the watcher above maintains, so a
              // slow route refresh can never stall forwarding. Still re-read every frame, because
              // a capability that could only ever be granted would never let the uplink close
              // again on a route that lost its canceller.
              publishRealtimeAecCapability(inputGeneration, realtimeEchoCancellationGranted(openedAudioInput, measure = false))
              val rms = TalkAudioLevel.pcm16Rms(buffer, read)
              captureHealth.observe(rms)
              _inputLevel.value = TalkAudioLevel.smoothed(_inputLevel.value, TalkAudioLevel.normalized(rms))
              // Converted before the forwarding policy is consulted, so the filter sees one
              // continuous stream rather than one with the suppressed frames punched out of it.
              val wireFrame = resampler.convert(buffer, read)
              if (!shouldAppendRealtimeCapturedFrame(wireFrame.size)) {
                observeRealtimeCaptureHeldBack()
                continue
              }
              audioFrames.trySend(wireFrame)
            }
          } finally {
            // Joined, not just cancelled: publishRealtimeAecCapability does not suspend, so an
            // iteration already past its delay would otherwise land its `true` after the teardown
            // below published `false` for the same generation, which the guard cannot drop.
            // NonCancellable because the dominant teardown path cancels this coroutine first, and
            // a plain join would then return immediately instead of waiting.
            withContext(NonCancellable) { aecWatcher.cancelAndJoin() }
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          Log.w(tag, "realtime capture failed: ${err.message ?: err::class.simpleName}")
          failRealtimeRelay(sessionId, err.message ?: err::class.simpleName ?: "capture failed")
        } finally {
          audioFrames.close()
          audioInput?.close()
          health?.reportSessionEnd()
          _inputLevel.value = 0f
          publishRealtimeAecCapability(inputGeneration, false)
        }
      }
    return null
  }

  /**
   * Whether this session may treat the platform as cancelling its own echo.
   *
   * Two independent sources, and three facts. The effect must report enabled -- read back, never
   * inferred -- and the owner must report its communication audio eligible, which is itself the
   * conjunction of a live session token, the device still being in communication mode, and this
   * app still holding audio focus. Any one of them failing means the canceller does not have this
   * session's downlink as its reference, and forwarding the microphone during playback would send
   * the assistant's own voice back to the provider.
   *
   * [measure] re-measures the effect over IPC under the capture session's lifecycle lock, and may
   * block behind a route refresh. Only callers that are not the capture read loop may pass true.
   */
  private fun realtimeEchoCancellationGranted(
    session: AndroidAudioInputSession,
    measure: Boolean,
  ): Boolean {
    val effectEnabled =
      if (measure) session.refreshCommunicationEchoCancellation() else session.communicationEchoCancellationEnabled
    // The measuring path also re-reads the device mode: acquisition proved it at one instant, and
    // another app can move it afterwards. The read-loop path consults the snapshot the owner
    // maintains, so it stays free of the binder call.
    val communicationAudioEligible =
      if (measure) {
        realtimeCommunicationAudio.verifyCommunicationAudioEligible(systemAudioManager)
      } else {
        // Lock-free mirror: the owner monitor is held across AudioService calls, so entering it
        // once per frame would put an IPC round trip back on the AudioRecord.read path.
        realtimeCommunicationAudio.communicationAudioEligibleUnsynchronized
      }
    return effectEnabled && communicationAudioEligible
  }

  /**
   * Re-claims communication audio for a session whose first attempt a transient focus holder
   * refused, and publishes the token where teardown will find it.
   *
   * The claim and its publication cannot be one atomic step -- claiming touches the device and
   * must not happen under the transition monitor -- so a claim that loses the race to teardown
   * unwinds itself here. Leaving it published would put the device in communication mode with no
   * live token to restore it.
   */
  private fun recoverRealtimeCommunicationAudio(
    inputGeneration: Long,
    sessionId: String,
  ) {
    if (audioInputGeneration.get() != inputGeneration || realtimeSessionId != sessionId) return
    val recovered = realtimeCommunicationAudio.retryIfUnclaimed(systemAudioManager)
    if (recovered == RealtimeCommunicationAudioOwner.NO_OWNER) return
    val published =
      synchronized(realtimeCapturePauseLock) {
        // Field swap only -- no device call under the monitor the Gateway pump also takes.
        if (realtimeSessionId == sessionId) {
          realtimeCommunicationAudioToken = recovered
          true
        } else {
          false
        }
      }
    if (!published) realtimeCommunicationAudio.restore(systemAudioManager, recovered)
  }

  /**
   * Enters communication audio for a session that is about to be published.
   *
   * Separated from the publication so the system call happens outside the transition monitor.
   */
  private fun acquireRealtimeCommunicationAudio(): Long = realtimeCommunicationAudio.enter(systemAudioManager)

  /**
   * Publishes what one capture generation found out about echo cancellation.
   *
   * Cancelling a capture coroutine is not synchronous with the caller that requested it, so a
   * superseded job can still be between its own checks when its replacement is already running.
   * A generation may only answer for itself: without this guard a dying job's cleanup would
   * silently drop its successor back to half duplex, or worse, keep the uplink open for a
   * session that never had an echo canceller.
   */
  private fun publishRealtimeAecCapability(
    inputGeneration: Long,
    enabled: Boolean,
  ) {
    while (true) {
      val current = realtimeAecCapability.get()
      if (current.generation > inputGeneration) return
      if (realtimeAecCapability.compareAndSet(current, RealtimeAecCapability(inputGeneration, enabled))) return
    }
  }

  /**
   * The one place the full-duplex decision is made.
   *
   * Assistant playback only closes the uplink when the platform is not cancelling its echo. With
   * echo cancellation actually enabled, what the microphone hears during playback is the user, so
   * forwarding it is what lets the provider notice an interruption at all. Without it, the same
   * frames would be the assistant's own voice and the provider would interrupt itself.
   *
   * Two reads, not one. [realtimeAecEnabled] is the per-capture-generation capability, republished
   * once per frame; the owner's own snapshot is consulted live so that focus lost between two
   * frames closes the uplink on the very next forwarded frame instead of the next publication.
   * Both are lock-free volatile reads, so this stays free of the monitor and of any IPC.
   */
  private fun shouldSuppressRealtimeCaptureForPlayback(): Boolean {
    // Local assistant speech plays on the media path, not the communication downlink this rule is
    // about. The canceller is subtracting the realtime downlink; it is not subtracting local media,
    // so local playback -- alone or overlapping realtime playout -- can contaminate the microphone
    // reference and must never qualify for the exception.
    if (localMediaPlaybackActive) return true
    if (!isRealtimeCommunicationPlaybackActive()) return false
    return !(realtimeAecEnabled && realtimeCommunicationAudio.communicationAudioEligibleUnsynchronized)
  }

  /**
   * Two independent reasons to hold a captured frame back, and both must be clear.
   *
   * [pendingRealtimeOutputClear] is the cancellation boundary: while a cancelOutput is in flight
   * the old response has not finished leaving the device, and a frame forwarded now would be
   * attributed to a turn that is being torn down. That fence is unconditional -- full-duplex
   * capability does not exempt it, because the question there is not echo but which turn owns
   * the uplink.
   *
   * [shouldSuppressRealtimeCaptureForPlayback] is the echo question, and only that: during
   * ordinary playback the uplink stays open exactly when the platform is cancelling the
   * assistant's own voice for us.
   */
  private fun shouldAppendRealtimeCapturedFrame(length: Int): Boolean =
    length > 0 &&
      pendingRealtimeOutputClear == null &&
      !shouldSuppressRealtimeCaptureForPlayback()

  /**
   * Publishes a change in the playback-time forwarding decision, and only a change.
   *
   * Bounded by construction: the packed state is compared before anything is formatted, so a
   * session that stays in one state logs once no matter how many frames pass through it. The
   * compare-and-set is what keeps the capture loop and the append loop from both reporting the
   * same edge.
   */
  private fun observeRealtimeUplinkPhase(
    phase: Int,
    aecEnabled: Boolean,
    communicationEligible: Boolean,
    localPlayback: Boolean,
  ) {
    val encoded =
      phase or
        (if (aecEnabled) uplinkAecBit else 0) or
        (if (communicationEligible) uplinkCommBit else 0) or
        (if (localPlayback) uplinkLocalBit else 0)
    val previous = realtimeUplinkPhase.get()
    if (previous == encoded) return
    if (!realtimeUplinkPhase.compareAndSet(previous, encoded)) return
    val name =
      when (phase) {
        uplinkPhaseEnqueued -> "ENQUEUED_DURING_PLAYBACK"
        uplinkPhaseSuppressed -> "SUPPRESSED_DURING_PLAYBACK"
        uplinkPhaseFenced -> "HELD_BY_CANCELLATION_FENCE"
        else -> "IDLE_NO_PLAYBACK"
      }
    Log.i(
      tag,
      "realtime uplink $name aecEnabled=$aecEnabled commEligible=$communicationEligible " +
        "localPlayback=$localPlayback",
    )
  }

  /**
   * Why a captured frame was held back, keeping the two invariants apart.
   *
   * The cancellation fence and the echo gate both drop frames, but for unrelated reasons: one is
   * about which turn owns the uplink, the other about whose voice the microphone is hearing.
   * Reporting a fenced frame as an echo-gate refusal would send a reader looking at the wrong
   * device state, so the fence keeps its own name and is checked first, as the gate checks it.
   */
  private fun observeRealtimeCaptureHeldBack() {
    val fenced = pendingRealtimeOutputClear != null
    val local = localMediaPlaybackActive
    // A frame dropped while nothing is playing and nothing is fenced carries no decision worth
    // reporting -- it is an empty converted frame, not a policy outcome.
    if (!fenced && !local && !isRealtimeCommunicationPlaybackActive()) return
    observeRealtimeUplinkPhase(
      if (fenced) uplinkPhaseFenced else uplinkPhaseSuppressed,
      realtimeAecEnabled,
      realtimeCommunicationAudio.communicationAudioEligibleUnsynchronized,
      local,
    )
  }

  /**
   * The decision taken after a frame leaves the capture queue and before it is submitted.
   *
   * Separate from the capture-side check on purpose. A frame can clear that check, wait in the
   * bounded queue, and be dequeued after `cancelOutput` has taken the turn; the fence is
   * unconditional, so the full-duplex exception must not carry such a frame past it. Ownership is
   * what makes this the right place: it is the last point that still holds the frame. A request
   * already handed to the socket may be in flight and is not recalled here, and nothing in this
   * design claims otherwise.
   */
  private fun shouldSubmitDequeuedRealtimeFrame(sessionId: String): Boolean {
    if (realtimeSessionId != sessionId) return false
    if (pendingRealtimeOutputClear != null) {
      observeRealtimeCaptureHeldBack()
      return false
    }
    if (shouldSuppressRealtimeCaptureForPlayback()) {
      observeRealtimeCaptureHeldBack()
      return false
    }
    return true
  }

  /**
   * A captured frame has just been submitted locally as a `talk.session.appendAudio` request.
   *
   * Named for exactly what the call proves and no more. [sendGatewayRequestFrame] returns once the
   * request has been handed to the socket; the Gateway's response, including a rejection, arrives
   * later on the error callback. So this reports that the frame passed Android's playback-time gate
   * and left the app -- not that the Gateway accepted it, not that the provider received it, and
   * certainly not that a turn resulted.
   *
   * Published here rather than at the predicate on purpose: the question a reviewer has is not
   * whether the policy said yes, but whether a real frame reached the local send boundary while the
   * communication downlink was playing. Only this point knows both.
   */
  private fun observeRealtimeFrameEnqueued() {
    observeRealtimeUplinkPhase(
      if (isRealtimeCommunicationPlaybackActive()) uplinkPhaseEnqueued else uplinkPhaseIdle,
      realtimeAecEnabled,
      realtimeCommunicationAudio.communicationAudioEligibleUnsynchronized,
      localMediaPlaybackActive,
    )
  }

  /**
   * Is the *realtime communication* downlink playing, as opposed to anything that merely makes the
   * app "speaking"? Both terms are realtime-owner facts: the published source flag, and the
   * playout deadline the owner extends per written frame, which covers the tail after the last
   * write while the device is still draining.
   */
  private fun isRealtimeCommunicationPlaybackActive(): Boolean = realtimeCommunicationPlaybackActive || SystemClock.elapsedRealtime() < realtimePlaybackEndsAtMs

  private fun handleRealtimeTalkEvent(payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val sessionId = obj["relaySessionId"].asStringOrNull() ?: obj["sessionId"].asStringOrNull()
    val currentSessionId = realtimeSessionId
    if (currentSessionId == null || sessionId != currentSessionId) return

    when (val type = obj["type"].asStringOrNull()) {
      "ready" -> {
        if (isRealtimeCapturePaused()) return
        _isListening.value = true
        setStatus(nativeText("Listening"))
      }

      "inputAudio" -> {
        synchronized(realtimeCapturePauseLock) {
          if (realtimeCapturePause != null) return
          // Output remains suppressed through the cancelled pre-PTT turn. The
          // first accepted resumed frame establishes the next provider turn.
          realtimeOutputSuppressed = false
        }
        _isListening.value = true
      }

      "audio" -> {
        if (realtimeOutputSuppressed) return
        val turnId = obj["talkEvent"].asObjectOrNull()?.get("turnId").asStringOrNull() ?: return
        if (turnId.isBlank()) return
        realtimeOutputTurnId = turnId
        finishRealtimeConversationEntry(VoiceConversationRole.User)
        val audioBase64 = obj["audioBase64"].asStringOrNull() ?: return
        val bytes =
          try {
            Base64.decode(audioBase64, Base64.DEFAULT)
          } catch (err: Throwable) {
            Log.w(tag, "realtime audio decode failed: ${err.message ?: err::class.simpleName}")
            return
          }
        playRealtimeAudio(sessionId, bytes)
      }

      "clear" -> {
        // Turn identity is validated here, on the receiving thread, exactly as upstream does: a
        // clear naming a turn other than the live one belongs to a response that is already gone
        // and must not touch the current playback. Retirement itself is not done here -- it is
        // queued to the playout owner, which is the only thing allowed to reach the device.
        val turnId = obj["talkEvent"].asObjectOrNull()?.get("turnId").asStringOrNull()
        val activeTurnId = realtimeOutputTurnId
        if (!turnId.isNullOrBlank() && activeTurnId != null && turnId != activeTurnId) return
        realtimeOutputTurnId = null
        requestRealtimePlaybackClear(turnId)
      }

      "mark" -> {
        val markName = obj["markName"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return
        queueRealtimePlaybackMark(sessionId, markName)
      }

      "transcript" -> {
        val role = obj["role"].asStringOrNull()
        val isFinal = obj["final"].asBooleanOrNull() == true
        // A streaming (non-final) user transcript is the provider's speech
        // signal; it raises the waveform floor like iOS endpointing does.
        if (role == "user") {
          _speechActive.value = !isFinal
        }
        val text = realtimeTranscriptText(obj["text"].asStringOrNull(), isFinal)
        var assistantText: String? = null
        if (text != null) {
          when (role) {
            "user" -> {
              upsertRealtimeConversation(VoiceConversationRole.User, text, isFinal)
            }

            "assistant" -> {
              finishRealtimeConversationEntry(VoiceConversationRole.User)
              assistantText = upsertRealtimeConversation(VoiceConversationRole.Assistant, text, isFinal)
            }
          }
        }
        if (assistantText != null) {
          _lastAssistantText.value = assistantText.trim()
        }
        if (isFinal && role == "user") {
          setStatus(nativeText("Thinking…"), awaitingAgent = true)
        } else if (isFinal && role == "assistant") {
          requestRealtimePlaybackIdleCheck()
        }
      }

      "toolCall" -> {
        val callId = obj["callId"].asStringOrNull() ?: return
        val name = obj["name"].asStringOrNull() ?: return
        realtimeAgentCoordinator.handleToolCall(
          callId = callId,
          name = name,
          args = obj["args"],
          forced = obj["forced"].asBooleanOrNull() == true,
        )
      }

      "toolResult" -> {}

      "error" -> {
        val message = obj["message"].asStringOrNull() ?: "realtime talk error"
        setTalkFailure(nativeText("Talk failed: \$message", message))
        Log.w(tag, "realtime error: $message")
      }

      "close" -> {
        val closeReason = obj["reason"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
        val closeStatus =
          currentStatus.takeIf { it.state == TalkStatusState.TalkFailure } ?: realtimeCloseStatus(closeReason)
        Log.d(tag, "realtime close reason=$closeReason")
        stopRealtimeRelay(closeSession = false, preserveStatus = true)
        if (_isEnabled.value) {
          _isEnabled.value = false
          setStatus(closeStatus)
          onStoppedByRelay()
        }
      }

      else -> {
        if (type != null) Log.d(tag, "ignored realtime event type=$type")
      }
    }
  }

  private fun realtimeTranscriptPayload(
    sessionId: String,
    role: String,
    text: String,
  ): String =
    buildJsonObject {
      put("relaySessionId", JsonPrimitive(sessionId))
      put("type", JsonPrimitive("transcript"))
      put("role", JsonPrimitive(role))
      put("text", JsonPrimitive(text))
      put("final", JsonPrimitive(true))
    }.toString()

  /**
   * Gateway ingress for assistant audio. Enqueues and returns; it never touches the output
   * device, so the message pump does not wait on hardware backpressure.
   */
  private fun playRealtimeAudio(
    sessionId: String,
    bytes: ByteArray,
  ) {
    if (!playbackEnabled || realtimeOutputSuppressed || bytes.isEmpty()) return
    submitRealtimeProviderPlaybackCommand(
      sessionId,
      RealtimePlaybackCommand.Audio(epoch = realtimePlaybackEpoch.get(), bytes = bytes),
    )
  }

  /** Gateway ingress for a provider playback barrier. Enqueue only, same as audio. */
  private fun queueRealtimePlaybackMark(
    sessionId: String,
    markName: String,
  ) {
    submitRealtimeProviderPlaybackCommand(
      sessionId,
      RealtimePlaybackCommand.Mark(epoch = realtimePlaybackEpoch.get(), sessionId = sessionId, name = markName),
    )
  }

  /**
   * Enqueues one provider-driven playback command against the shared provider bound.
   *
   * Overflow is a media failure rather than a dropped frame: audio the device never received
   * would otherwise be reported as played by the barrier queued behind it.
   */
  private fun submitRealtimeProviderPlaybackCommand(
    sessionId: String,
    command: RealtimePlaybackCommand,
  ) {
    val audioBytes = (command as? RealtimePlaybackCommand.Audio)?.bytes?.size?.toLong() ?: 0L
    val queuedCommands = queuedRealtimeProviderCommands.incrementAndGet()
    val queuedBytes = queuedRealtimeAudioBytes.addAndGet(audioBytes)
    val overCapacity =
      queuedCommands > realtimePlaybackProviderQueueCapacity ||
        queuedBytes > realtimePlaybackQueuedAudioCeilingBytes
    if (overCapacity || !realtimePlaybackCommands.trySend(command).isSuccess) {
      queuedRealtimeProviderCommands.decrementAndGet()
      queuedRealtimeAudioBytes.addAndGet(-audioBytes)
      overflowRealtimePlayback(sessionId, queuedCommands, queuedBytes)
      return
    }
  }

  /**
   * Asks the owner to re-evaluate barrier completion and idleness. Deduped to one queued
   * check, so a burst of events cannot fill the control headroom.
   */
  private fun requestRealtimePlaybackIdleCheck() {
    if (!realtimePlaybackPollIdleQueued.compareAndSet(false, true)) return
    if (!realtimePlaybackCommands.trySend(RealtimePlaybackCommand.PollIdle).isSuccess) {
      realtimePlaybackPollIdleQueued.set(false)
    }
  }

  private fun overflowRealtimePlayback(
    sessionId: String,
    queuedCommands: Int,
    queuedBytes: Long,
  ) {
    Log.w(tag, "realtime playback queue full: commands=$queuedCommands bytes=$queuedBytes")
    failRealtimeRelay(sessionId, "audio playback queue overflow")
  }

  /**
   * Publishes a new playback generation.
   *
   * Called on the requesting thread, before the matching Clear or Stop is queued, so audio
   * already waiting for the owner is discarded and a write in flight is preempted at its next
   * retry. The state the capture gate reads is reset here too, at exactly the point the
   * previous implementation reset it, so callers keep the ordering they had.
   */
  private fun invalidateRealtimePlaybackEpoch() {
    realtimePlaybackEpoch.incrementAndGet()
    realtimePlaybackEndsAtMs = 0L
    setRealtimePlaying(false)
    _outputLevel.value = null
  }

  /** Barge-in or provider clear: invalidate the generation, then retire the device. */
  private fun requestRealtimePlaybackClear(turnId: String?) {
    val completion = pendingRealtimeOutputClear
    invalidateRealtimePlaybackEpoch()
    if (!realtimePlaybackCommands.trySend(RealtimePlaybackCommand.Clear(turnId, completion)).isSuccess) {
      // The generation is already dead, so nothing new can play, but the device residue survives
      // because the owner never got the command. Release the waiter so cancelOutput does not hang
      // on it -- with a null identity, never the caller's turn. Answering with the matching turn
      // would tell cancelOutput the boundary was physically reached, lifting the capture fence
      // over a sink that was never retired. Null fails the turn check closed, and the caller
      // closes the relay, which is the honest outcome for a clear that never reached the device.
      Log.w(tag, "realtime playback clear could not be queued")
      completion?.complete(null)
    }
    if (_isEnabled.value) {
      setStatus(nativeText("Listening"))
    }
  }

  /**
   * Ends playback. [terminal] is relay teardown, which drops pending barriers unacknowledged;
   * a plain playback stop keeps them for the provider's own clear to release.
   */
  private fun stopRealtimePlayback(terminal: Boolean = false) {
    invalidateRealtimePlaybackEpoch()
    if (!realtimePlaybackCommands.trySend(RealtimePlaybackCommand.Stop(terminal)).isSuccess) {
      Log.w(tag, "realtime playback stop could not be queued")
    }
    if (_isEnabled.value) {
      setStatus(nativeText("Listening"))
    }
  }

  private suspend fun processRealtimeAudioOwnerOnly(command: RealtimePlaybackCommand.Audio) {
    if (command.epoch != realtimePlaybackEpoch.get()) return
    if (!playbackEnabled || realtimeOutputSuppressed || realtimeSessionId == null) return
    val bytes = command.bytes
    if (bytes.isEmpty()) return
    val sink =
      realtimeAudioSink ?: realtimeAudioSinkFactory
        .open(realtimeOutputSampleRateHz, realtimePlaybackBufferMs, bytes.size)
        .also { opened ->
          realtimeAudioSink = opened
          realtimeWrittenFrames = 0L
        }
    // Published before anything reaches the speaker, not after the frame finishes writing. On a
    // session without echo cancellation this state *is* the capture gate, so a late publication
    // would let the microphone forward the assistant's own first words back to the provider.
    beginRealtimePlaybackOwnerOnly()
    // A refused non-blocking write only makes progress once the device is draining, so
    // presentation starts before the first write rather than after it.
    sink.play()
    val retryDelayMs = realtimePlaybackWriteRetryDelayMs(sink.bufferDurationMs)
    // One command may legitimately have to wait out its own playback duration when the device
    // buffer is already full, so the budget covers that on top of the stall allowance. It is
    // deliberately never reset by partial progress: a device accepting a couple of bytes per
    // retry is as broken as one accepting none, and resetting would let it grind out the frame.
    val frameDurationMs = (bytes.size / 2).toLong() * 1000L / realtimeOutputSampleRateHz
    val stallBudgetMs = realtimePlaybackWriteStallBudgetMs(sink.bufferDurationMs) + frameDurationMs
    var writtenBytes = 0
    var stalledMs = 0L
    while (writtenBytes < bytes.size) {
      if (command.epoch != realtimePlaybackEpoch.get()) break
      val accepted = sink.write(bytes, writtenBytes, bytes.size - writtenBytes)
      if (accepted < 0) {
        // A device error code, not backpressure: the same class of terminal playout failure as a
        // device that accepts nothing for the whole stall budget, and routed the same way. The
        // owner's handler retires the sink and fails the relay. Breaking instead would bank the
        // accepted prefix as played, extend the presentation deadline by a frame the device never
        // finished, and leave later audio and marks running against a dead sink.
        throw IllegalStateException("realtime audio write failed with device error $accepted")
      }
      if (accepted == 0) {
        if (stalledMs >= stallBudgetMs) {
          throw IllegalStateException("realtime audio device accepted nothing for ${stalledMs}ms")
        }
        delay(retryDelayMs)
        stalledMs += retryDelayMs
        continue
      }
      writtenBytes += accepted
    }
    if (writtenBytes <= 0) return
    // A generation invalidated mid-write must not publish playback state. The Clear or Stop
    // behind this command is about to discard these frames, and only the owner is serialized
    // against this publication -- the requester's own reset already happened, before the write.
    if (command.epoch != realtimePlaybackEpoch.get()) return
    _outputLevel.value =
      TalkAudioLevel.smoothed(_outputLevel.value ?: 0f, TalkAudioLevel.pcm16Level(bytes, writtenBytes))
    val durationMs = ((writtenBytes / 2.0) / realtimeOutputSampleRateHz * 1000.0).toLong()
    realtimeWrittenFrames += writtenBytes / 2L
    val now = SystemClock.elapsedRealtime()
    realtimePlaybackEndsAtMs = maxOf(now, realtimePlaybackEndsAtMs) + durationMs
    ensureRealtimePlaybackIdleTickerOwnerOnly()
  }

  /**
   * Marks playback as starting, from the owner, before the device is written to.
   *
   * The idle ticker is started here rather than after the write for a reason: if the write then
   * accepts nothing, or a barge-in preempts it, this is the only thing that will later observe
   * that nothing is playing and reopen the gate. Without it a failed first write would leave the
   * microphone shut with nothing left to reopen it.
   */
  private fun beginRealtimePlaybackOwnerOnly() {
    setRealtimePlaying(true)
    setStatus(nativeText("Speaking…"))
    ensureRealtimePlaybackIdleTickerOwnerOnly()
  }

  private fun processRealtimeMarkOwnerOnly(command: RealtimePlaybackCommand.Mark) {
    if (command.epoch != realtimePlaybackEpoch.get()) {
      // The barrier belongs to a response cancelled before it reached the device.
      // Acknowledging releases the provider's playback gate; it never claims the audio played.
      acknowledgeRealtimePlaybackMarks(
        listOf(PendingRealtimePlaybackMark(sessionId = command.sessionId, name = command.name)),
      )
      return
    }
    pendingRealtimePlaybackMarks[command.name] =
      PendingRealtimePlaybackMark(
        sessionId = command.sessionId,
        name = command.name,
        targetFrame = realtimeWrittenFrames,
      )
    acknowledgeRealtimePlaybackMarks(takeCompletedRealtimePlaybackMarksOwnerOnly())
    ensureRealtimePlaybackIdleTickerOwnerOnly()
  }

  private fun processRealtimeClearOwnerOnly(command: RealtimePlaybackCommand.Clear) {
    try {
      val marks = pendingRealtimePlaybackMarks.values.toList()
      pendingRealtimePlaybackMarks.clear()
      retireRealtimeAudioSinkOwnerOnly()
      acknowledgeRealtimePlaybackMarks(marks)
      publishRealtimePlaybackIdleOwnerOnly()
    } finally {
      // cancelOutput waits on this to learn the old boundary reached the device, so it is
      // completed here -- after the owner has actually retired the sink -- and never earlier.
      // A failure above must not turn into a two-second stall and a relay close on top of it.
      command.completion?.complete(command.turnId)
    }
  }

  private fun processRealtimeStopOwnerOnly(command: RealtimePlaybackCommand.Stop) {
    val marks = pendingRealtimePlaybackMarks.values.toList()
    pendingRealtimePlaybackMarks.clear()
    retireRealtimeAudioSinkOwnerOnly()
    // Retiring resets the frame counter every target frame was measured against, so a barrier
    // carried across it could never complete -- it would poll forever and hold the provider's
    // playback gate shut. Relay teardown has no provider left to release, so its barriers are
    // dropped; every other stop answers them.
    if (!command.terminal) acknowledgeRealtimePlaybackMarks(marks)
    publishRealtimePlaybackIdleOwnerOnly()
  }

  /**
   * Re-publishes the quiescent playback state, from the owner.
   *
   * The requester already reset it before queueing Clear or Stop, but an Audio command that was
   * inside its write loop at that moment can publish "speaking" again afterwards, and the
   * retirement here also cancels the idle ticker that would otherwise have cleared it -- leaving
   * the capture gate shut with nothing left to reopen it. The owner is the only thing serialized
   * against that publication, so this is where the reset has to be final.
   *
   * The status is left alone once the session is gone: relay teardown nulls the session id before
   * queueing its Stop, which is what keeps a preserved failure status from being overwritten here.
   */
  private fun publishRealtimePlaybackIdleOwnerOnly() {
    realtimePlaybackEndsAtMs = 0L
    setRealtimePlaying(false)
    _outputLevel.value = null
    if (_isEnabled.value && realtimeSessionId != null) {
      setStatus(nativeText("Listening"))
    }
  }

  private fun processRealtimePollIdleOwnerOnly() {
    realtimePlaybackPollIdleQueued.set(false)
    val playbackTimeElapsed = SystemClock.elapsedRealtime() >= realtimePlaybackEndsAtMs
    val completed = takeCompletedRealtimePlaybackMarksOwnerOnly()
    // The device may lag the duration estimate by its own buffer. Keep polling until queued
    // barriers prove the speaker reached them.
    val awaitingPlaybackMark = pendingRealtimePlaybackMarks.values.any { it.targetFrame != null }
    val playbackIdle = playbackTimeElapsed && !awaitingPlaybackMark
    if (playbackIdle) {
      setRealtimePlaying(false)
      _outputLevel.value = null
    }
    acknowledgeRealtimePlaybackMarks(completed)
    if (!playbackIdle) {
      // A check requested from outside the owner may arrive with no ticker running.
      ensureRealtimePlaybackIdleTickerOwnerOnly()
      return
    }
    realtimePlaybackIdleJob?.cancel()
    realtimePlaybackIdleJob = null
    if (_isEnabled.value && realtimeSessionId != null) {
      setStatus(nativeText("Listening"))
    }
  }

  /**
   * Final owner-only cleanup, on any exit from the command loop.
   *
   * Barriers are dropped rather than acknowledged, the same choice terminal Stop makes: the owner
   * is gone, so there is nothing left to measure a target frame against, and the gateway scope
   * this would acknowledge through is being torn down with it.
   */
  private fun retirePlayoutOnOwnerExitOwnerOnly() {
    pendingRealtimePlaybackMarks.clear()
    retireRealtimeAudioSinkOwnerOnly()
    realtimePlaybackEndsAtMs = 0L
    setRealtimePlaying(false)
    _outputLevel.value = null
    // A Clear still queued when the owner died would otherwise leave cancelOutput waiting out its
    // whole timeout for a boundary no one is left to reach. Released with a null identity, not the
    // caller's turn: the owner is gone, so no turn was physically retired and nothing here may
    // claim one. cancelOutput's turn check then fails closed and the caller closes the relay,
    // which is the correct outcome -- the boundary really was never reached.
    pendingRealtimeOutputClear?.complete(null)
  }

  /** Owner-only cleanup shared by Clear, Stop, and the command loop's failure path. */
  private fun retireRealtimeAudioSinkOwnerOnly() {
    realtimeAudioSink?.let { sink -> runCatching { sink.close() } }
    realtimeAudioSink = null
    realtimeWrittenFrames = 0L
    realtimePlaybackIdleJob?.cancel()
    realtimePlaybackIdleJob = null
  }

  private fun failRealtimePlaybackOwnerOnly(message: String) {
    // Retiring resets the frame counter every pending target frame was measured against, so
    // a surviving barrier could never complete and would hold the provider's gate forever.
    val stranded = pendingRealtimePlaybackMarks.values.toList()
    pendingRealtimePlaybackMarks.clear()
    retireRealtimeAudioSinkOwnerOnly()
    acknowledgeRealtimePlaybackMarks(stranded)
    publishRealtimePlaybackIdleOwnerOnly()
    val sessionId = realtimeSessionId ?: return
    failRealtimeRelay(sessionId, message)
  }

  /**
   * Ticks the owner so barrier completion and idleness are re-evaluated while audio is still
   * being presented. The ticker only enqueues; it never touches the device or the barriers.
   */
  private fun ensureRealtimePlaybackIdleTickerOwnerOnly() {
    if (realtimePlaybackIdleJob?.isActive == true) return
    realtimePlaybackIdleJob =
      realtimePlaybackOwnerScope.launch(realtimePlaybackDispatcher) {
        while (isActive) {
          delay(realtimePlaybackIdlePollMs)
          if (!realtimePlaybackPollIdleQueued.compareAndSet(false, true)) continue
          if (!realtimePlaybackCommands.trySend(RealtimePlaybackCommand.PollIdle).isSuccess) {
            realtimePlaybackPollIdleQueued.set(false)
          }
        }
      }
  }

  private fun takeCompletedRealtimePlaybackMarksOwnerOnly(): List<PendingRealtimePlaybackMark> {
    val playedFrames = realtimeAudioSink?.presentedFrames ?: realtimeWrittenFrames
    val completed =
      pendingRealtimePlaybackMarks.values.filter { mark ->
        val targetFrame = mark.targetFrame
        targetFrame != null && playedFrames >= targetFrame
      }
    completed.forEach { pendingRealtimePlaybackMarks.remove(it.name) }
    return completed
  }

  private fun acknowledgeRealtimePlaybackMarks(marks: List<PendingRealtimePlaybackMark>) {
    for (mark in marks) {
      gatewayWorkScope.launch {
        try {
          val acknowledge = realtimeMarkAcknowledger
          if (acknowledge != null) {
            acknowledge(mark.sessionId, mark.name)
          } else {
            val params =
              buildJsonObject {
                put("sessionId", JsonPrimitive(mark.sessionId))
                put("markName", JsonPrimitive(mark.name))
              }
            requestGateway("talk.session.acknowledgeMark", params.toString(), timeoutMs = 8_000)
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          Log.d(tag, "realtime mark acknowledgement ignored: ${err.message ?: err::class.simpleName}")
        }
      }
    }
  }

  private fun stopRealtimeRelay(
    closeSession: Boolean = true,
    cancelCapture: Boolean = true,
    cancelAppend: Boolean = true,
    preserveStatus: Boolean = false,
  ) {
    // Preserve the canonical status as one value so cleanup cannot split its
    // user-visible text from typed failure and awaiting-agent semantics.
    val status = currentStatus
    var communicationAudioToken = RealtimeCommunicationAudioOwner.NO_OWNER
    val (sessionId, captureJobs) =
      synchronized(realtimeCapturePauseLock) {
        val currentSessionId = realtimeSessionId
        val currentCaptureJobs = realtimeCaptureJob to realtimeAppendJob
        communicationAudioToken = realtimeCommunicationAudioToken
        realtimeCommunicationAudioToken = RealtimeCommunicationAudioOwner.NO_OWNER
        realtimeSessionId = null
        realtimeWireAudioContract = null
        realtimeCaptureJob = null
        realtimeAppendJob = null
        realtimeCapturePause = null
        currentSessionId to currentCaptureJobs
      }
    // Outside the monitor: changing the device mode is a system call, and the owner declines the
    // restore anyway if a newer session has taken over since. This is still one synchronous
    // AudioService call on the Gateway ingress pump when teardown arrives as a "close" event --
    // once per relay teardown rather than per frame, unlike the write backpressure this design
    // removed, but it is the one remaining device call reachable from ingress.
    realtimeCommunicationAudio.restore(systemAudioManager, communicationAudioToken)
    realtimeOutputSuppressed = false
    realtimeOutputTurnId = null
    pendingRealtimeOutputClear?.cancel()
    pendingRealtimeOutputClear = null
    if (cancelCapture) {
      captureJobs.first?.cancel()
    }
    if (cancelAppend) {
      captureJobs.second?.cancel()
    }
    realtimeAgentCoordinator.endSession(sessionId)
    realtimeUserEntryId = null
    realtimeUserEntryAwaitingFinal = false
    realtimeUserEntryAwaitingFinalStartedAtMs = null
    realtimeAssistantEntryId = null
    _speechActive.value = false
    _inputLevel.value = 0f
    stopRealtimePlayback(terminal = true)
    if (preserveStatus) {
      setStatus(status)
    }
    _isListening.value = false
    if (closeSession && !sessionId.isNullOrBlank()) {
      gatewayWorkScope.launch {
        closeRealtimeSession(sessionId)
      }
    }
  }

  internal suspend fun pauseRealtimeCaptureForPushToTalk(captureId: String) {
    val cancellationSessionId = realtimeSessionId
    val cancellationTurnId = realtimeOutputTurnId?.trim()?.takeIf(String::isNotEmpty)
    val captureJobs =
      synchronized(realtimeCapturePauseLock) {
        val currentSessionId = realtimeSessionId
        val currentCaptureJobs = realtimeCaptureJob to realtimeAppendJob
        realtimeCapturePause = RealtimeCapturePause(sessionId = currentSessionId, pttCaptureId = captureId)
        realtimeOutputSuppressed = true
        realtimeCaptureJob = null
        realtimeAppendJob = null
        currentCaptureJobs
      }
    stopRealtimePlayback()
    val (captureJob, appendJob) = captureJobs
    captureJob?.cancelAndJoin()
    appendJob?.cancelAndJoin()
    // Stop input first so no frame can create new provider output while the
    // cancellation boundary is being established.
    if (
      !cancelRealtimeOutput(
        reason = "android-push-to-talk",
        sessionId = cancellationSessionId,
        turnId = cancellationTurnId,
      )
    ) {
      Log.w(tag, "realtime output cancellation was not confirmed; closing relay")
      stopRealtimeRelay(preserveStatus = true)
      synchronized(realtimeCapturePauseLock) {
        realtimeCapturePause =
          RealtimeCapturePause(
            sessionId = null,
            pttCaptureId = captureId,
            restartRelay = true,
          )
        realtimeOutputSuppressed = true
      }
    }
  }

  private fun isRealtimeCapturePaused(): Boolean = synchronized(realtimeCapturePauseLock) { realtimeCapturePause != null }

  internal fun resumeRealtimeCaptureAfterPushToTalk(captureId: String) {
    var resumeFailure: String? = null
    var resumeSessionId: String? = null
    val outcome =
      synchronized(realtimeCapturePauseLock) {
        val current = realtimeCapturePause ?: return@synchronized RealtimeCaptureResume.Skipped
        if (current.pttCaptureId != captureId || activePttCaptureId != null) {
          return@synchronized RealtimeCaptureResume.Skipped
        }
        if (!_isEnabled.value || stopRequested) {
          realtimeCapturePause = null
          return@synchronized RealtimeCaptureResume.Skipped
        }
        if (current.restartRelay && current.sessionId == null) {
          realtimeCapturePause = null
          return@synchronized RealtimeCaptureResume.Restart
        }
        val sessionId = current.sessionId
        if (sessionId == null || realtimeSessionId != sessionId) {
          realtimeCapturePause = null
          return@synchronized RealtimeCaptureResume.Skipped
        }
        if (!isConnected()) return@synchronized RealtimeCaptureResume.Disconnected
        if (realtimeCaptureJob?.isActive == true || realtimeAppendJob?.isActive == true) {
          realtimeCapturePause = null
          return@synchronized RealtimeCaptureResume.Skipped
        }
        realtimeCapturePause = null
        _isListening.value = true
        setStatus(nativeText("Listening"))
        resumeFailure = startRealtimeCaptureLocked(sessionId)
        resumeSessionId = sessionId
        RealtimeCaptureResume.Resumed
      }
    when (outcome) {
      RealtimeCaptureResume.Skipped -> {
        return
      }

      RealtimeCaptureResume.Resumed -> {
        val reason = resumeFailure ?: return
        resumeSessionId?.let { failRealtimeRelay(it, reason) }
        return
      }

      RealtimeCaptureResume.Restart -> {
        start()
      }

      RealtimeCaptureResume.Disconnected -> {
        setStatus(nativeText("Gateway not connected"))
        stopRealtimeRelay(preserveStatus = true)
        disableRealtimeModeAndNotifyOwner()
      }
    }
  }

  private suspend fun closeRealtimeSession(sessionId: String) {
    try {
      val params = buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) }
      requestGateway("talk.session.close", params.toString(), timeoutMs = 5_000)
    } catch (err: Throwable) {
      if (err !is CancellationException) {
        Log.d(tag, "realtime close ignored: ${err.message ?: err::class.simpleName}")
      }
    }
  }

  private fun upsertRealtimeConversation(
    role: VoiceConversationRole,
    text: String,
    isFinal: Boolean,
  ): String {
    var entryId =
      when (role) {
        VoiceConversationRole.User -> realtimeUserEntryId
        VoiceConversationRole.Assistant -> realtimeAssistantEntryId
      }
    if (role == VoiceConversationRole.Assistant) {
      finishRealtimeConversationEntry(VoiceConversationRole.User)
    }
    val shouldStartNewUserEntry =
      role == VoiceConversationRole.User &&
        entryId != null &&
        shouldStartNewRealtimeUserEntry(entryId, text, isFinal)
    if (
      role == VoiceConversationRole.User &&
      (entryId == null || shouldStartNewUserEntry)
    ) {
      finishRealtimeConversationEntry(VoiceConversationRole.Assistant)
    }
    if (shouldStartNewUserEntry) {
      finishRealtimeConversationEntry(VoiceConversationRole.User)
      entryId = null
      realtimeUserEntryAwaitingFinal = false
      realtimeUserEntryAwaitingFinalStartedAtMs = null
    }
    var resolvedText: String
    val resolvedEntryId =
      if (entryId == null) {
        resolvedText = text.trimStart()
        appendConversation(role = role, text = resolvedText, isStreaming = !isFinal)
      } else {
        resolvedText = updateConversationEntry(id = entryId, text = text, isStreaming = !isFinal)
        entryId
      }
    when (role) {
      VoiceConversationRole.User -> {
        realtimeUserEntryId = if (isFinal) null else resolvedEntryId
        realtimeUserEntryAwaitingFinal = false
        realtimeUserEntryAwaitingFinalStartedAtMs = null
      }

      VoiceConversationRole.Assistant -> {
        realtimeAssistantEntryId = if (isFinal) null else resolvedEntryId
      }
    }
    return resolvedText
  }

  private fun finishRealtimeConversationEntry(role: VoiceConversationRole) {
    val entryId =
      when (role) {
        VoiceConversationRole.User -> realtimeUserEntryId
        VoiceConversationRole.Assistant -> realtimeAssistantEntryId
      } ?: return
    val current = _conversation.value
    val targetIndex = current.indexOfFirst { it.id == entryId }
    if (targetIndex >= 0 && current[targetIndex].isStreaming) {
      val updated = current.toMutableList()
      updated[targetIndex] = current[targetIndex].copy(isStreaming = false)
      _conversation.value = updated
      if (role == VoiceConversationRole.User) {
        realtimeUserEntryAwaitingFinal = true
        realtimeUserEntryAwaitingFinalStartedAtMs = SystemClock.elapsedRealtime()
      }
    }
    when (role) {
      VoiceConversationRole.User -> Unit
      VoiceConversationRole.Assistant -> realtimeAssistantEntryId = null
    }
  }

  private fun shouldStartNewRealtimeUserEntry(
    entryId: String,
    incoming: String,
    isFinal: Boolean,
  ): Boolean {
    val entry = _conversation.value.firstOrNull { it.id == entryId } ?: return false
    if (entry.isStreaming) return false
    val existing = entry.text
    if (existing.isBlank() || incoming.isBlank()) return false
    if (incoming.firstOrNull()?.isWhitespace() == true) return false
    if (incoming == existing || incoming.startsWith(existing) || existing.endsWith(incoming)) return false
    if (isFinal && realtimeUserEntryAwaitingFinal) {
      val elapsedMs =
        realtimeUserEntryAwaitingFinalStartedAtMs?.let { SystemClock.elapsedRealtime() - it } ?: Long.MAX_VALUE
      if (elapsedMs <= realtimeUserFinalRewriteGraceMs && looksLikeTranscriptReplacement(existing, incoming)) {
        return false
      }
    }
    return true
  }

  private fun appendConversation(
    role: VoiceConversationRole,
    text: String,
    isStreaming: Boolean,
  ): String {
    val id = UUID.randomUUID().toString()
    _conversation.value =
      (_conversation.value + VoiceConversationEntry(id = id, role = role, text = text, isStreaming = isStreaming))
        .takeLast(maxConversationEntries)
    return id
  }

  private fun updateConversationEntry(
    id: String,
    text: String,
    isStreaming: Boolean,
  ): String {
    val current = _conversation.value
    val targetIndex =
      when {
        current.isEmpty() -> -1
        current[current.lastIndex].id == id -> current.lastIndex
        else -> current.indexOfFirst { it.id == id }
      }
    if (targetIndex < 0) return text
    val entry = current[targetIndex]
    val updatedText = mergeRealtimeTranscriptText(entry.text, text, isFinal = !isStreaming)
    if (entry.text == updatedText && entry.isStreaming == isStreaming) return entry.text
    val updated = current.toMutableList()
    updated[targetIndex] = entry.copy(text = updatedText, isStreaming = isStreaming)
    _conversation.value = updated
    return updatedText
  }

  private fun realtimeTranscriptText(
    rawText: String?,
    isFinal: Boolean,
  ): String? {
    val text = rawText ?: return null
    return text.takeIf { if (isFinal) it.isNotBlank() else it.isNotEmpty() }
  }

  private fun mergeRealtimeTranscriptText(
    existing: String,
    incoming: String,
    isFinal: Boolean,
  ): String {
    if (existing.isBlank()) return incoming.trimStart()
    if (incoming.isEmpty()) return existing
    if (incoming == existing || existing.endsWith(incoming)) return existing
    if (incoming.startsWith(existing)) return incoming
    if (incoming.firstOrNull()?.isWhitespace() == true) return existing + incoming
    if (isFinal && looksLikeTranscriptReplacement(existing, incoming)) return incoming
    val overlap = findTranscriptTextOverlap(existing, incoming)
    val suffix = if (overlap > 0) incoming.drop(overlap) else incoming
    if (suffix.isEmpty()) return existing
    val separator =
      if (overlap > 0 || !shouldInsertTranscriptSpace(existing, suffix)) {
        ""
      } else {
        " "
      }
    return existing + separator + suffix
  }

  private fun looksLikeTranscriptReplacement(
    existing: String,
    incoming: String,
  ): Boolean {
    val existingWords = transcriptWords(existing)
    val incomingWords = transcriptWords(incoming)
    if (existingWords.isEmpty() || incomingWords.isEmpty()) return false
    if (existingWords[0] != incomingWords[0]) return false
    if (existingWords.size > 1 && incomingWords.size > 1 && existingWords[1] == incomingWords[1]) return true
    val existingText = normalizeTranscriptText(existing)
    val incomingText = normalizeTranscriptText(incoming)
    val commonPrefix = commonPrefixLength(existingText, incomingText)
    val shortest = minOf(existingText.length, incomingText.length)
    return commonPrefix >= 6 && commonPrefix.toDouble() / maxOf(1, shortest).toDouble() >= 0.45
  }

  private fun transcriptWords(value: String): List<String> =
    Regex("""[\p{L}\p{N}]+""")
      .findAll(value.lowercase(Locale.ROOT))
      .map { it.value }
      .toList()

  private fun normalizeTranscriptText(value: String): String = value.lowercase(Locale.ROOT).replace(Regex("""\s+"""), " ").trim()

  private fun commonPrefixLength(
    left: String,
    right: String,
  ): Int {
    val max = minOf(left.length, right.length)
    var index = 0
    while (index < max && left[index] == right[index]) {
      index += 1
    }
    return index
  }

  private fun findTranscriptTextOverlap(
    existing: String,
    incoming: String,
  ): Int {
    val base = existing.lowercase(Locale.ROOT)
    val next = incoming.lowercase(Locale.ROOT)
    val max = minOf(base.length, next.length)
    for (length in max downTo 3) {
      if (base.endsWith(next.take(length))) {
        return length
      }
    }
    return 0
  }

  private fun shouldInsertTranscriptSpace(
    existing: String,
    incoming: String,
  ): Boolean {
    val last = existing.lastOrNull() ?: return false
    val first = incoming.firstOrNull() ?: return false
    if (last.isWhitespace() || first.isWhitespace()) return false
    return first.isLetterOrDigit() &&
      (last.isLetterOrDigit() || transcriptSpaceAfterPunctuation.contains(last))
  }

  private val transcriptSpaceAfterPunctuation =
    setOf('.', '!', '?', ',', ':', ';', ')', ']', '}', '"', '\'', '’', '”')

  // API 33 adds segmented callbacks and caller-owned audio. Keep this ordered ladder
  // in one place: removing the restart rung makes older devices drop speech after a pause.
  private fun pushToTalkCandidates(first: PushToTalkRecognitionCandidate?): List<PushToTalkRecognitionCandidate> =
    pushToTalkRecognitionCandidates(
      supportsSegmentedRecognition = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU,
      first = first,
    )

  private fun startPushToTalkRecognition(
    captureId: String,
    firstCandidate: PushToTalkRecognitionCandidate? = null,
  ) {
    val recognizerInstance = recognizer ?: error("Speech recognizer unavailable")
    var lastFailure: Throwable? = null
    for (candidate in pushToTalkCandidates(firstCandidate)) {
      try {
        val rung =
          when (candidate) {
            PushToTalkRecognitionCandidate.RawAudioSegmented -> {
              PushToTalkRecognitionRung.RawAudioSegmented(openPushToTalkAudioSource())
            }

            PushToTalkRecognitionCandidate.SilenceSegmented -> {
              PushToTalkRecognitionRung.SilenceSegmented
            }

            PushToTalkRecognitionCandidate.RestartingSingleSession -> {
              PushToTalkRecognitionRung.RestartingSingleSession
            }
          }
        pttRecognitionRung = rung
        recognizerInstance.startListening(pushToTalkRecognizerIntent(rung))
        _isListening.value = true
        setStatus(nativeText("Listening (PTT)"))
        return
      } catch (err: Throwable) {
        lastFailure = err
        closePushToTalkRung()
        Log.w(tag, "PTT recognizer rung failed captureId=$captureId rung=$candidate: ${err.message}")
      }
    }
    throw lastFailure ?: IllegalStateException("Speech recognizer unavailable")
  }

  private fun pushToTalkRecognizerIntent(rung: PushToTalkRecognitionRung): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, resolvedSpeechLocaleTag())
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
      putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
      when (rung) {
        is PushToTalkRecognitionRung.RawAudioSegmented -> {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            applyRawAudioSegmentedExtras(this, rung.source)
          }
        }

        PushToTalkRecognitionRung.SilenceSegmented -> {
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500)
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            applySilenceSegmentedExtras(this)
          }
        }

        PushToTalkRecognitionRung.RestartingSingleSession -> {
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500)
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800)
        }
      }
    }

  // API 33 RecognizerIntent extras live behind @RequiresApi so min-SDK lint stays meaningful;
  // segmented rungs are only ever constructed on TIRAMISU+ (see pushToTalkRecognitionCandidates).
  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun applyRawAudioSegmentedExtras(
    intent: Intent,
    source: PushToTalkAudioSource,
  ) {
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, source.readDescriptor)
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, pushToTalkSampleRateHz)
    intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun applySilenceSegmentedExtras(intent: Intent) {
    intent.putExtra(
      RecognizerIntent.EXTRA_SEGMENTED_SESSION,
      RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
    )
  }

  @SuppressLint("MissingPermission")
  private fun openPushToTalkAudioSource(): PushToTalkAudioSource {
    check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
    val minBufferSize =
      AudioRecord.getMinBufferSize(
        pushToTalkSampleRateHz,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    check(minBufferSize > 0) { "AudioRecord buffer unavailable" }

    val pipe = ParcelFileDescriptor.createPipe()
    var recorder: AudioRecord? = null
    var writeStream: ParcelFileDescriptor.AutoCloseOutputStream? = null
    try {
      recorder =
        AudioRecord(
          MediaRecorder.AudioSource.VOICE_RECOGNITION,
          pushToTalkSampleRateHz,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          minBufferSize * 2,
        )
      check(recorder.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord initialization failed" }
      recorder.startRecording()
      check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "AudioRecord did not start" }
      val activeRecorder = checkNotNull(recorder)
      val activeWriteStream = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
      writeStream = activeWriteStream
      val source = PushToTalkAudioSource(pipe[0], activeWriteStream, activeRecorder)
      source.pumpJob =
        gatewayWorkScope.launch(Dispatchers.IO) {
          val buffer = ByteArray(minBufferSize.coerceAtLeast(4_096))
          try {
            while (currentCoroutineContext().isActive) {
              val bytesRead = activeRecorder.read(buffer, 0, buffer.size)
              if (bytesRead <= 0) break
              _inputLevel.value =
                TalkAudioLevel.smoothed(_inputLevel.value, TalkAudioLevel.pcm16Level(buffer, bytesRead))
              activeWriteStream.write(buffer, 0, bytesRead)
            }
          } catch (err: IOException) {
            Log.d(tag, "PTT audio pipe closed: ${err.message}")
          } finally {
            source.finishFromPump()
          }
        }
      return source
    } catch (err: Throwable) {
      runCatching { recorder?.stop() }
      runCatching { recorder?.release() }
      runCatching { writeStream?.close() }
      if (writeStream == null) runCatching { pipe[1].close() }
      runCatching { pipe[0].close() }
      throw err
    }
  }

  private fun schedulePushToTalkRestart(
    delayMs: Long,
    advanceRung: Boolean,
  ) {
    val captureId = activePttCaptureId ?: return
    if (pttReleaseCompletion != null) return
    val rung = pttRecognitionRung ?: return
    val firstCandidate =
      when (rung) {
        is PushToTalkRecognitionRung.RawAudioSegmented -> {
          if (advanceRung) {
            PushToTalkRecognitionCandidate.SilenceSegmented
          } else {
            PushToTalkRecognitionCandidate.RawAudioSegmented
          }
        }

        PushToTalkRecognitionRung.SilenceSegmented -> {
          if (advanceRung) {
            PushToTalkRecognitionCandidate.RestartingSingleSession
          } else {
            PushToTalkRecognitionCandidate.SilenceSegmented
          }
        }

        PushToTalkRecognitionRung.RestartingSingleSession -> {
          PushToTalkRecognitionCandidate.RestartingSingleSession
        }
      }
    commitPushToTalkLivePartial()
    closePushToTalkRung()
    restartJob?.cancel()
    restartJob =
      gatewayWorkScope.launch {
        delay(delayMs)
        mainHandler.post {
          if (activePttCaptureId != captureId || pttReleaseCompletion != null || stopRequested) return@post
          try {
            startPushToTalkRecognition(captureId, firstCandidate)
          } catch (err: Throwable) {
            _isListening.value = false
            setTalkFailure(nativeText("Talk failed: \$message", err.message ?: err::class.simpleName.orEmpty()))
          }
        }
      }
  }

  private fun closePushToTalkRung() {
    (pttRecognitionRung as? PushToTalkRecognitionRung.RawAudioSegmented)?.source?.close()
    pttRecognitionRung = null
  }

  private fun commitPushToTalkLivePartial() {
    val partial = pttLivePartial.trim()
    if (partial.isNotEmpty()) {
      pttFinalSegments += partial
    }
    pttLivePartial = ""
  }

  private fun startListeningInternal(markListening: Boolean) {
    val r = recognizer ?: return
    val intent =
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, resolvedSpeechLocaleTag())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        // Use cloud recognition — it handles natural speech and pauses better
        // than on-device which cuts off aggressively after short silences.
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800)
      }

    if (markListening) {
      setStatus(nativeText("Listening"))
      _isListening.value = true
    }
    r.startListening(intent)
  }

  private fun scheduleRestart(delayMs: Long = 350) {
    if (stopRequested) return
    restartJob?.cancel()
    restartJob =
      gatewayWorkScope.launch {
        delay(delayMs)
        mainHandler.post {
          if (stopRequested) return@post
          try {
            recognizer?.cancel()
            val shouldListen = listeningMode && !finalizeInFlight
            val shouldInterrupt = _isSpeaking.value && interruptOnSpeech && shouldAllowSpeechInterrupt()
            if (!shouldListen && !shouldInterrupt) return@post
            startListeningInternal(markListening = shouldListen)
          } catch (_: Throwable) {
            // handled by onError
          }
        }
      }
  }

  private fun handleTranscript(
    text: String,
    isFinal: Boolean,
  ) {
    val trimmed = text.trim()
    if (activePttCaptureId != null) {
      if (trimmed.isNotEmpty()) {
        if (isFinal) {
          pttFinalSegments += trimmed
          pttLivePartial = ""
        } else {
          pttLivePartial = trimmed
        }
        lastHeardAtMs = SystemClock.elapsedRealtime()
      }
      return
    }
    if (_isSpeaking.value && interruptOnSpeech) {
      if (shouldInterrupt(trimmed)) {
        stopSpeaking()
      }
      return
    }

    if (!_isListening.value) return

    if (trimmed.isNotEmpty()) {
      lastTranscript = trimmed
      lastHeardAtMs = SystemClock.elapsedRealtime()
    }

    if (isFinal) {
      lastTranscript = trimmed
      // Don't finalize immediately — let the silence monitor trigger after
      // silenceWindowMs. This allows the recognizer to fire onResults and
      // still give the user a natural pause before we send.
    }
  }

  private fun startSilenceMonitor(captureId: String) {
    silenceJob?.cancel()
    silenceJob =
      gatewayWorkScope.launch {
        while (_isEnabled.value || pttAutoStopEnabled) {
          delay(200)
          checkSilence(captureId)
        }
      }
  }

  private fun checkSilence(captureId: String) {
    if (!_isListening.value) return
    val transcript =
      if (activePttCaptureId != null) {
        PushToTalkTranscriptMerger.merge(pttFinalSegments, pttLivePartial)
      } else {
        lastTranscript.trim()
      }
    if (transcript.isEmpty()) return
    val lastHeard = lastHeardAtMs ?: return
    val elapsed = SystemClock.elapsedRealtime() - lastHeard
    if (elapsed < silenceWindowMs) return
    if (activePttCaptureId != null) {
      if (pttAutoStopEnabled) {
        if (pttReleaseCompletion != null) return
        gatewayWorkScope.launch { endPushToTalk(captureId) }
      }
      return
    }
    if (finalizeInFlight) return
    finalizeInFlight = true
    gatewayWorkScope.launch {
      try {
        finalizeTranscript(transcript)
      } finally {
        finalizeInFlight = false
      }
    }
  }

  private suspend fun finalizeTranscript(transcript: String) {
    listeningMode = false
    _isListening.value = false
    setStatus(nativeText("Thinking…"), awaitingAgent = true)
    lastTranscript = ""
    lastHeardAtMs = null
    // Release SpeechRecognizer before making the API call and playing TTS.
    // Must use withContext(Main) — not post() — so we WAIT for destruction before
    // proceeding. A fire-and-forget post() races with TTS startup: the recognizer
    // stays alive, picks up TTS audio as speech (onBeginningOfSpeech), and the
    // OS kills the AudioTrack write (returns 0) on OxygenOS/OnePlus devices.
    withContext(Dispatchers.Main) {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }

    ensureConfigLoaded()
    val prompt = buildPrompt(transcript)
    if (!isConnected()) {
      setStatus(nativeText("Gateway not connected"))
      Log.w(tag, "finalize: gateway not connected")
      start()
      return
    }

    try {
      val startedAt = System.currentTimeMillis().toDouble() / 1000.0
      Log.d(tag, "chat.send start sessionKey=${mainSessionKey.ifBlank { "main" }} chars=${prompt.length}")
      val ack = sendChat(prompt, session)
      val runId = ack.runId ?: throw IllegalStateException("chat.send returned no run id")
      Log.d(tag, "chat.send ok runId=$runId status=${ack.status}")
      if (ack.isTerminalFailure) {
        setStatus(if (ack.normalizedStatus == "error") nativeText("Chat error") else nativeText("Aborted"))
        start()
        return
      }
      val ok = if (ack.isTerminalSuccess) true else waitForChatFinal(runId)
      if (!ok) {
        Log.w(tag, "chat final timeout runId=$runId; attempting history fallback")
      }
      // Use text cached from the final event first — avoids chat.history polling
      val assistant =
        consumeRunText(runId)
          ?: waitForAssistantText(
            session,
            chatSendAckHistorySinceSeconds(ack, startedAt),
            if (ok) 12_000 else 25_000,
          )
      if (assistant.isNullOrBlank()) {
        setStatus(nativeText("No reply"))
        Log.w(tag, "assistant text timeout runId=$runId")
        start()
        return
      }
      Log.d(tag, "assistant text ok chars=${assistant.length}")
      val playbackToken = cancelActivePlayback()
      playAssistant(assistant, playbackToken)
    } catch (err: Throwable) {
      if (err is CancellationException) {
        Log.d(tag, "finalize speech cancelled")
        return
      }
      setTalkFailure(nativeText("Talk failed: \$message", err.message ?: err::class.simpleName.orEmpty()))
      Log.w(tag, "finalize failed: ${err.message ?: err::class.simpleName}")
    }

    if (_isEnabled.value) {
      start()
    }
  }

  private suspend fun awaitPushToTalkRelease(captureId: String) {
    if (activePttCaptureId != captureId) return
    restartJob?.cancel()
    restartJob = null
    val rung = pttRecognitionRung ?: return
    // onResults, onError, and onEndOfSegmentedSession normally arrive well under a second,
    // so typical release latency is unchanged. The five-second bound only caps pathological recognizers;
    // leaving early truncates final words, which is worse than waiting.
    pttReleaseCompletion?.let { existing ->
      awaitPushToTalkReleaseCompletion(existing, pushToTalkReleaseGraceMs)
      return
    }
    if (!_isListening.value || recognizer == null) return

    val completion = CompletableDeferred<Unit>()
    pttReleaseCompletion = completion
    _isListening.value = false
    _inputLevel.value = 0f
    when (rung) {
      is PushToTalkRecognitionRung.RawAudioSegmented -> {
        rung.source.requestFinish()
        // EXTRA_AUDIO_SOURCE is optional: a service may ignore the pipe and run its own mic,
        // so closing our AudioRecord alone would leave it listening past release. stopListening
        // forces its endpointer; for pipe-consuming services it is redundant after EOF.
        runCatching { recognizer?.stopListening() }.onFailure { completion.complete(Unit) }
      }

      PushToTalkRecognitionRung.SilenceSegmented,
      PushToTalkRecognitionRung.RestartingSingleSession,
      -> {
        runCatching { recognizer?.stopListening() }.onFailure { completion.complete(Unit) }
      }
    }
    awaitPushToTalkReleaseCompletion(completion, pushToTalkReleaseGraceMs)
    if (pttReleaseCompletion === completion) {
      pttReleaseCompletion = null
    }
  }

  private suspend fun drainPushToTalkReleaseBeforeBegin() {
    val deadline = SystemClock.elapsedRealtime() + pushToTalkReleaseDrainTimeoutMs
    while (true) {
      val remainingMs = deadline - SystemClock.elapsedRealtime()
      val release = pttReleaseCompletion
      if (release != null && remainingMs > 0) {
        awaitPushToTalkReleaseCompletion(release, remainingMs)
      }
      if (activePttCaptureId == null && pttReleaseCompletion == null) return
      if (SystemClock.elapsedRealtime() >= deadline) return
      yield()
    }
  }

  private suspend fun awaitPushToTalkReleaseCompletion(
    completion: CompletableDeferred<Unit>,
    timeoutMs: Long,
  ) {
    try {
      withTimeoutOrNull(timeoutMs) { completion.await() }
    } catch (err: CancellationException) {
      if (completion.isCancelled && currentCoroutineContext().isActive) return
      throw err
    }
  }

  private fun clearPushToTalkRecognition(captureId: String): ClearedPushToTalkCapture? {
    if (activePttCaptureId != captureId) return null
    val transcript = PushToTalkTranscriptMerger.merge(pttFinalSegments, pttLivePartial)
    val completion = pttCompletion
    pttTimeoutJob?.cancel()
    pttTimeoutJob = null
    pttAutoStopEnabled = false
    pttCompletion = null
    pttReleaseCompletion?.cancel()
    pttReleaseCompletion = null
    activePttCaptureId = null
    _isListening.value = false
    listeningMode = false
    clearListenWatchdog()
    recognizer?.cancel()
    recognizer?.destroy()
    recognizer = null
    closePushToTalkRung()
    pttFinalSegments.clear()
    pttLivePartial = ""
    lastTranscript = ""
    lastHeardAtMs = null
    _inputLevel.value = 0f
    return ClearedPushToTalkCapture(transcript = transcript, completion = completion)
  }

  private fun finishPushToTalk(
    payload: TalkPttStopPayload,
    completion: CompletableDeferred<TalkPttStopPayload>?,
  ): TalkPttStopPayload {
    completion?.complete(payload)
    return payload
  }

  private fun finishClearedPushToTalk(
    captureId: String,
    cleared: ClearedPushToTalkCapture,
    status: String,
    transcript: String? = null,
    statusText: NativeText = if (_isEnabled.value) nativeText("Listening") else nativeText("Ready"),
  ): TalkPttStopPayload {
    setStatus(statusText)
    resumeRealtimeCaptureAfterPushToTalk(captureId)
    return finishPushToTalk(
      TalkPttStopPayload(captureId = captureId, transcript = transcript, status = status),
      cleared.completion,
    )
  }

  private fun clearFinishingPushToTalk(
    captureId: String,
    job: Job,
  ): Boolean =
    synchronized(finishingPttLock) {
      if (finishingPttCaptureId != captureId || finishingPttJob !== job) {
        return@synchronized false
      }
      finishingPttCaptureId = null
      finishingPttJob = null
      true
    }

  private fun buildPrompt(transcript: String): String {
    val lines =
      mutableListOf(
        "Talk Mode active. Reply in a concise, spoken tone.",
        "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {\"voice\":\"<id>\",\"once\":true}.",
      )
    lastInterruptedAtSeconds?.let {
      lines.add("Assistant speech interrupted at ${"%.1f".format(it)}s.")
      lastInterruptedAtSeconds = null
    }
    lines.add("")
    lines.add(transcript)
    return lines.joinToString("\n")
  }

  private suspend fun sendChat(
    message: String,
    session: GatewaySession,
  ): ChatSendAck {
    val runId = UUID.randomUUID().toString()
    armPendingRun(runId)
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
        put("message", JsonPrimitive(message))
        put("thinking", JsonPrimitive("low"))
        put("timeoutMs", JsonPrimitive(30_000))
        put("idempotencyKey", JsonPrimitive(runId))
      }
    try {
      val res = requestGateway("chat.send", params.toString())
      val parsed = parseChatSendAck(json, res)
      val actualRunId = parsed.runId ?: runId
      if (actualRunId != runId) {
        pendingRunId = actualRunId
      }
      if (parsed.isTerminal) {
        clearPendingRun(actualRunId)
      }
      return parsed.copy(runId = actualRunId)
    } catch (err: Throwable) {
      clearPendingRun(runId)
      throw err
    }
  }

  internal suspend fun waitForChatFinal(runId: String): Boolean {
    consumeRunCompletion(runId)?.let { return it }
    val deferred =
      if (pendingRunId == runId) {
        pendingFinal ?: armPendingRun(runId)
      } else {
        armPendingRun(runId)
      }

    consumeRunCompletion(runId)?.let { return it }

    val result =
      try {
        withTimeout(chatFinalWaitMs) { deferred.await() }
      } catch (_: TimeoutCancellationException) {
        false
      }

    if (!result && pendingRunId == runId) {
      clearPendingRun(runId)
    }
    return result
  }

  private fun armPendingRun(runId: String): CompletableDeferred<Boolean> {
    pendingFinal?.cancel()
    val deferred = CompletableDeferred<Boolean>()
    pendingRunId = runId
    pendingFinal = deferred
    return deferred
  }

  private fun clearPendingRun(runId: String) {
    if (pendingRunId == runId) {
      pendingFinal = null
      pendingRunId = null
    }
  }

  private fun cacheRunCompletion(
    runId: String,
    isFinal: Boolean,
  ) {
    synchronized(completedRunsLock) {
      completedRunStates[runId] = isFinal
      while (completedRunStates.size > maxCachedRunCompletions) {
        val first = completedRunStates.entries.firstOrNull() ?: break
        completedRunStates.remove(first.key)
      }
    }
  }

  private fun consumeRunCompletion(runId: String): Boolean? {
    synchronized(completedRunsLock) {
      return completedRunStates.remove(runId)
    }
  }

  private fun hasRunCompletion(runId: String): Boolean {
    synchronized(completedRunsLock) {
      return completedRunStates.containsKey(runId)
    }
  }

  private fun consumeRunText(runId: String): String? {
    synchronized(completedRunsLock) {
      return completedRunTexts.remove(runId)
    }
  }

  private fun extractTextFromChatEventMessage(messageEl: JsonElement?): String? = ChatEventText.assistantTextFromMessage(messageEl)

  private suspend fun waitForAssistantText(
    session: GatewaySession,
    sinceSeconds: Double?,
    timeoutMs: Long,
  ): String? {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      val text = fetchLatestAssistantText(session, sinceSeconds)
      if (!text.isNullOrBlank()) return text
      delay(300)
    }
    return null
  }

  private suspend fun fetchLatestAssistantText(
    session: GatewaySession,
    sinceSeconds: Double? = null,
  ): String? {
    val key = mainSessionKey.ifBlank { "main" }
    val res = requestGateway("chat.history", "{\"sessionKey\":\"$key\"}")
    val root = json.parseToJsonElement(res).asObjectOrNull() ?: return null
    val messages = root["messages"] as? JsonArray ?: return null
    for (item in messages.reversed()) {
      val obj = item.asObjectOrNull() ?: continue
      if (obj["role"].asStringOrNull() != "assistant") continue
      if (sinceSeconds != null) {
        val timestamp = obj["timestamp"].asDoubleOrNull()
        if (timestamp != null && !TalkModeRuntime.isMessageTimestampAfter(timestamp, sinceSeconds)) continue
      }
      val content = obj["content"] as? JsonArray ?: continue
      val text =
        content
          .mapNotNull { entry ->
            entry
              .asObjectOrNull()
              ?.get("text")
              ?.asStringOrNull()
              ?.trim()
          }.filter { it.isNotEmpty() }
      if (text.isNotEmpty()) return text.joinToString("\n")
    }
    return null
  }

  private suspend fun playAssistant(
    text: String,
    playbackToken: Long,
  ) {
    val lease = PlaybackLease(playbackToken, checkNotNull(coroutineContext[Job]))
    var shouldResumeAfterSpeak = false
    var failure: NativeText? = null
    try {
      synchronized(playbackLock) {
        ensurePlaybackActive(playbackToken)
        if (!lease.job.isActive) throw CancellationException("assistant speech cancelled")
        localPlayback = lease
      }
      shouldResumeAfterSpeak = true
      onBeforeSpeak()
      ensurePlaybackActive(playbackToken)
      val parsed = TalkDirectiveParser.parse(text)
      if (parsed.unknownKeys.isNotEmpty()) Log.w(tag, "Unknown talk directive keys: ${parsed.unknownKeys}")
      val directive = parsed.directive
      val cleaned = parsed.stripped.trim()
      if (cleaned.isEmpty()) return
      synchronized(playbackLock) {
        ensurePlaybackActive(playbackToken)
        _lastAssistantText.value = cleaned
        lastSpokenText = cleaned
        setStatus(nativeText("Generating voice…"), awaitingAgent = true)
      }
      try {
        val started = SystemClock.elapsedRealtime()
        when (val result = talkSpeakClient.synthesize(text = cleaned, directive = directive)) {
          is TalkSpeakResult.Success -> {
            markAudioPlaybackStarting(playbackToken)
            talkAudioPlayer.play(result.audio)
            ensurePlaybackActive(playbackToken)
            Log.d(tag, "talk.speak ok durMs=${SystemClock.elapsedRealtime() - started}")
          }

          is TalkSpeakResult.FallbackToLocal -> {
            Log.d(tag, "talk.speak unavailable; using local TTS: ${result.message}")
            ensurePlaybackActive(playbackToken)
            systemSpeech.speak(
              text = cleaned,
              locale = TalkModeRuntime.validatedLanguage(directive?.language)?.let(Locale::forLanguageTag) ?: Locale.getDefault(),
              speechRate = (TalkModeRuntime.resolveSpeed(directive?.speed, directive?.rateWpm) ?: 1.0).toFloat(),
              beforeSpeak = { markAudioPlaybackStarting(playbackToken) },
            )
            ensurePlaybackActive(playbackToken)
            Log.d(tag, "system tts ok durMs=${SystemClock.elapsedRealtime() - started}")
          }

          is TalkSpeakResult.Failure -> {
            throw IllegalStateException(result.message)
          }
        }
      } catch (err: Throwable) {
        if (isPlaybackCancelled(err, playbackToken)) {
          Log.d(tag, "assistant speech cancelled")
          return
        }
        failure = nativeText("Speak failed: \$message", err.message ?: err::class.simpleName.orEmpty())
        Log.w(tag, "talk playback failed: ${err.message ?: err::class.simpleName}")
      }
    } finally {
      synchronized(playbackLock) {
        // Cancellation does not join: an old caller can finish after its replacement.
        if (localPlayback === lease) {
          localPlayback = null
          publishSpeakingState()
          failure?.let { setStatus(it) }
        }
      }
      if (shouldResumeAfterSpeak) {
        withContext(NonCancellable) {
          onAfterSpeak()
        }
      }
    }
  }

  private fun cancelActivePlayback(): Long {
    val (token, activeJob) =
      synchronized(playbackLock) {
        val token = playbackGeneration.incrementAndGet()
        val job = localPlayback?.job
        localPlayback = null
        publishSpeakingState()
        token to job
      }
    // SystemSpeech's beforeSpeak callback takes playbackLock; never reverse that edge.
    activeJob?.cancel()
    talkAudioPlayer.stop()
    systemSpeech.stop()
    return token
  }

  private fun setRealtimePlaying(playing: Boolean) =
    synchronized(playbackLock) {
      realtimePlaying = playing
      publishSpeakingState()
    }

  // Called under playbackLock. The realtime source no longer has a lock of its own: it reaches
  // this state only through [setRealtimePlaying], from the playout owner or from the requester
  // that invalidates an epoch. playbackLock stays a leaf held across field writes alone, so the
  // Gateway receive path never waits on the device behind it.
  // Either source can keep speaking after the other source completes or is cancelled.
  private fun publishSpeakingState() {
    val realtime = realtimePlaying
    val local = localPlayback?.phase == PlaybackPhase.Playing
    // Published as two facts, not one. [_isSpeaking] is the UI projection and must stay the union
    // of both sources; the forwarding policy needs to know *which* source is playing, because only
    // the realtime downlink is the audio the platform canceller is subtracting.
    realtimeCommunicationPlaybackActive = realtime
    localMediaPlaybackActive = local
    _isSpeaking.value = realtime || local
  }

  private fun markAudioPlaybackStarting(playbackToken: Long) {
    synchronized(playbackLock) {
      ensurePlaybackActive(playbackToken)
      val lease = localPlayback
      if (lease?.token != playbackToken || !lease.job.isActive) throw CancellationException("assistant speech cancelled")
      lease.phase = PlaybackPhase.Playing
      publishSpeakingState()
      setStatus(nativeText("Speaking…"))
    }
    ensureInterruptListener()
    requestAudioFocusForTts()
  }

  fun stopTts() {
    val sessionId = realtimeSessionId
    val turnId = realtimeOutputTurnId?.trim()?.takeIf(String::isNotEmpty)
    realtimeOutputSuppressed = true
    stopRealtimePlayback()
    if (sessionId != null && turnId != null) {
      scope.launch {
        cancelRealtimeOutput(
          reason = "android-stop-tts",
          sessionId = sessionId,
          turnId = turnId,
        )
      }
    }
    stopSpeaking(resetInterrupt = true)
    setStatus(nativeText("Listening"))
  }

  private suspend fun cancelRealtimeOutput(
    reason: String,
    sessionId: String?,
    turnId: String?,
  ): Boolean =
    realtimeOutputCancellationMutex.withLock {
      sessionId ?: return@withLock true
      turnId ?: return@withLock false
      val clear = CompletableDeferred<String?>()
      pendingRealtimeOutputClear = clear
      try {
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(sessionId))
            put("reason", JsonPrimitive(reason))
            put("turnId", JsonPrimitive(turnId))
          }
        val response = requestGateway("talk.session.cancelOutput", params.toString(), timeoutMs = 5_000)
        val result = requireAcceptedRealtimeOutputCancellation(response, turnId)
        if (result.status == "stale" || result.status == "idle") return@withLock true
        // The response confirms provider cancellation; clear confirms that the
        // old playback boundary reached Android before capture can resume.
        val clearedTurnId = withTimeout(2_000) { clear.await() }
        check(clearedTurnId == turnId) {
          "talk.session.cancelOutput clear turnId did not match"
        }
        true
      } catch (err: TimeoutCancellationException) {
        Log.d(tag, "realtime cancelOutput unconfirmed: ${err.message ?: "timeout"}")
        false
      } catch (err: CancellationException) {
        if (!currentCoroutineContext().isActive) throw err
        Log.d(tag, "realtime cancelOutput interrupted by relay shutdown")
        false
      } catch (err: Throwable) {
        Log.d(tag, "realtime cancelOutput failed: ${err.message ?: err::class.simpleName}")
        false
      } finally {
        if (pendingRealtimeOutputClear === clear) {
          pendingRealtimeOutputClear = null
        }
      }
    }

  private fun stopSpeaking(resetInterrupt: Boolean = true) {
    if (resetInterrupt && _isSpeaking.value) {
      lastInterruptedAtSeconds = null
    }
    cancelActivePlayback()
    abandonAudioFocus()
  }

  internal fun shouldAllowSpeechInterrupt(): Boolean = !finalizeInFlight && !isRealtimeCapturePaused()

  private fun clearListenWatchdog() {
    listenWatchdogJob?.cancel()
    listenWatchdogJob = null
  }

  private fun requestAudioFocusForTts(): Boolean {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return true
    val req =
      AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(
          AudioAttributes
            .Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        ).setOnAudioFocusChangeListener(audioFocusListener)
        .build()
    audioFocusRequest = req
    val result = am.requestAudioFocus(req)
    Log.d(tag, "audio focus request result=$result")
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED || result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED
  }

  private fun abandonAudioFocus() {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    audioFocusRequest?.let {
      am.abandonAudioFocusRequest(it)
      Log.d(tag, "audio focus abandoned")
    }
    audioFocusRequest = null
  }

  private fun shouldInterrupt(transcript: String): Boolean {
    val trimmed = transcript.trim()
    if (trimmed.length < 3) return false
    val spoken = lastSpokenText?.lowercase()
    if (spoken != null && spoken.contains(trimmed.lowercase())) return false
    return true
  }

  private fun ensurePlaybackActive(playbackToken: Long) {
    if (!playbackEnabled || playbackToken != playbackGeneration.get()) {
      throw CancellationException("assistant speech cancelled")
    }
  }

  private fun isPlaybackCancelled(
    err: Throwable?,
    playbackToken: Long,
  ): Boolean {
    if (err is CancellationException) return true
    return !playbackEnabled || playbackToken != playbackGeneration.get()
  }

  private suspend fun ensureConfigLoaded() {
    if (!configLoaded) {
      reloadConfig()
    }
  }

  private suspend fun reloadConfig() {
    val generation = gatewayGeneration.get()
    try {
      val res = requestGateway("talk.config", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val parsed = TalkModeGatewayConfigParser.parse(root?.get("config").asObjectOrNull())
      if (generation != gatewayGeneration.get()) return
      silenceWindowMs = parsed.silenceTimeoutMs
      speechLocale = parsed.speechLocale
      realtimeRelayModelSupported = parsed.realtimeRelayModelSupported
      parsed.interruptOnSpeech?.let { interruptOnSpeech = it }
      configLoaded = true
    } catch (_: Throwable) {
      if (generation != gatewayGeneration.get()) return
      silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
      speechLocale = null
      realtimeRelayModelSupported = true
      configLoaded = false
    }
  }

  private fun resolvedSpeechLocaleTag(): String = speechLocale ?: Locale.getDefault().toLanguageTag()

  private object TalkModeRuntime {
    fun resolveSpeed(
      speed: Double?,
      rateWpm: Int?,
    ): Double? {
      if (rateWpm != null && rateWpm > 0) {
        val resolved = rateWpm.toDouble() / 175.0
        if (resolved <= 0.5 || resolved >= 2.0) return null
        return resolved
      }
      if (speed != null) {
        if (speed <= 0.5 || speed >= 2.0) return null
        return speed
      }
      return null
    }

    fun validatedLanguage(value: String?): String? {
      val normalized = value?.trim()?.lowercase() ?: return null
      if (normalized.length != 2) return null
      if (!normalized.all { it in 'a'..'z' }) return null
      return normalized
    }

    fun isMessageTimestampAfter(
      timestamp: Double,
      sinceSeconds: Double,
    ): Boolean {
      val sinceMs = sinceSeconds * 1000
      return if (timestamp > 10_000_000_000) {
        timestamp >= sinceMs - 500
      } else {
        timestamp >= sinceSeconds - 0.5
      }
    }
  }

  private fun ensureInterruptListener() {
    if (!interruptOnSpeech || !_isEnabled.value || !shouldAllowSpeechInterrupt()) return
    // Starting a recognizer during finalization or a paused PTT turn can kill
    // TTS playback and compete with the realtime recorder for microphone ownership.
    mainHandler.post {
      // Recheck after dispatch so a listener queued before PTT cannot reclaim
      // the microphone while the full PTT turn still owns it.
      if (stopRequested || !shouldAllowSpeechInterrupt()) return@post
      if (!SpeechRecognizer.isRecognitionAvailable(context)) return@post
      try {
        if (recognizer == null) {
          recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
        }
        recognizer?.cancel()
        startListeningInternal(markListening = false)
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  private val listener = recognitionListener(captureId = null)

  private fun recognitionListener(captureId: String?): RecognitionListener =
    object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {
        if (!acceptRecognitionCallback(captureId)) return
        // Only a live listening session may claim the status; a speech-interrupt
        // recognizer readying during playback must not touch Thinking state.
        if (activePttCaptureId != null && _isListening.value) {
          setStatus(nativeText("Listening (PTT)"))
        } else if (_isEnabled.value && _isListening.value) {
          setStatus(nativeText("Listening"))
        }
      }

      override fun onBeginningOfSpeech() {
        if (!acceptRecognitionCallback(captureId)) return
      }

      override fun onRmsChanged(rmsdB: Float) {
        if (!acceptRecognitionCallback(captureId)) return
        if (activePttCaptureId != null && pttRecognitionRung !is PushToTalkRecognitionRung.RawAudioSegmented) {
          _inputLevel.value = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
        }
      }

      override fun onBufferReceived(buffer: ByteArray?) {}

      override fun onEndOfSpeech() {
        if (!acceptRecognitionCallback(captureId)) return
        clearListenWatchdog()
        _inputLevel.value = 0f
        if (activePttCaptureId != null) return
        // Don't restart while a transcript is being processed — the recognizer
        // competing for audio resources kills AudioTrack PCM playback.
        if (!finalizeInFlight) {
          scheduleRestart()
        }
      }

      override fun onError(error: Int) {
        if (!acceptRecognitionCallback(captureId)) return
        if (stopRequested) return
        _isListening.value = false
        _inputLevel.value = 0f
        val pushToTalkActive = activePttCaptureId != null
        if (pushToTalkActive) {
          pttReleaseCompletion?.let {
            it.complete(Unit)
            return
          }
        }
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
          setStatus(nativeText("Microphone permission required"))
          return
        }

        setStatus(
          when (error) {
            SpeechRecognizer.ERROR_AUDIO -> nativeText("Audio error")

            SpeechRecognizer.ERROR_CLIENT -> nativeText("Client error")

            SpeechRecognizer.ERROR_NETWORK -> nativeText("Network error")

            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> nativeText("Network timeout")

            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
            -> if (pushToTalkActive) nativeText("Listening (PTT)") else nativeText("Listening")

            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> nativeText("Recognizer busy")

            SpeechRecognizer.ERROR_SERVER -> nativeText("Server error")

            else -> nativeText("Speech error (\$error)", error)
          },
        )
        if (pushToTalkActive) {
          schedulePushToTalkRestart(
            delayMs = 600L,
            advanceRung = pttRecognitionRung !is PushToTalkRecognitionRung.RestartingSingleSession,
          )
          return
        }
        scheduleRestart(delayMs = 600)
      }

      override fun onResults(results: Bundle?) {
        if (!acceptRecognitionCallback(captureId)) return
        val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
        list.firstOrNull()?.let { handleTranscript(it, isFinal = true) }
        if (activePttCaptureId != null) {
          _isListening.value = false
          _inputLevel.value = 0f
          pttReleaseCompletion?.let {
            it.complete(Unit)
            return
          }
          schedulePushToTalkRestart(
            delayMs = pushToTalkRestartDelayMs,
            advanceRung = pttRecognitionRung !is PushToTalkRecognitionRung.RestartingSingleSession,
          )
          return
        }
        scheduleRestart()
      }

      override fun onPartialResults(partialResults: Bundle?) {
        if (!acceptRecognitionCallback(captureId)) return
        val list = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
        list.firstOrNull()?.let { handleTranscript(it, isFinal = false) }
      }

      override fun onSegmentResults(segmentResults: Bundle) {
        if (!acceptRecognitionCallback(captureId) || activePttCaptureId == null) return
        val list = segmentResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
        list.firstOrNull()?.let { handleTranscript(it, isFinal = true) }
      }

      override fun onEndOfSegmentedSession() {
        if (!acceptRecognitionCallback(captureId) || activePttCaptureId == null) return
        _isListening.value = false
        _inputLevel.value = 0f
        pttReleaseCompletion?.let {
          it.complete(Unit)
          return
        }
        schedulePushToTalkRestart(
          delayMs = 180L,
          advanceRung = shouldAdvancePushToTalkRungAfterSegmentedSession(pttRecognitionRung?.candidate ?: return),
        )
      }

      override fun onEvent(
        eventType: Int,
        params: Bundle?,
      ) {}
    }

  // SpeechRecognizer can post callbacks after destroy. Binding each listener to its
  // capture prevents a retired session from mutating normal Talk or the next PTT hold.
  private fun acceptRecognitionCallback(captureId: String?): Boolean = captureId == activePttCaptureId
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

internal fun requireAcceptedRealtimeOutputCancellation(
  response: String,
  turnId: String?,
): TalkSessionCancelOutputResult {
  val result = Json.decodeFromString<TalkSessionCancelOutputResult>(response)
  check(result.ok) { "talk.session.cancelOutput was not accepted" }
  when (result.status) {
    null,
    "applied",
    "stale",
    "idle",
    -> Unit

    else -> error("unknown talk.session.cancelOutput status")
  }
  check(turnId == null || result.turnId == null || result.turnId == turnId) {
    "talk.session.cancelOutput turnId did not match"
  }
  return result
}

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asDoubleOrNull(): Double? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toDoubleOrNull()
}

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  val content = primitive.content.trim().lowercase()
  return when (content) {
    "true", "yes", "1" -> true
    "false", "no", "0" -> false
    else -> null
  }
}

private fun GatewaySession.ErrorShape.isUnsupportedSessionLanguageParam(): Boolean =
  code == "INVALID_REQUEST" &&
    message
      .lowercase(Locale.ROOT)
      .contains("invalid talk.session.create params")
