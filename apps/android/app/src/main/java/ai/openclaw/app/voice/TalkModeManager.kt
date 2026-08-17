package ai.openclaw.app.voice

import ai.openclaw.app.gateway.ChatSendAck
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
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
import android.media.AudioTrack
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
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
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
import java.util.concurrent.atomic.AtomicLong
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

internal data class RealtimeWireAudioContract(
  val encoding: String?,
  val sampleRateHz: Int?,
)

/**
 * TalkSessionCreateResultSchema.audio is optional (older/simpler Gateway peers omit it
 * entirely); an absent field is the established legacy PCM16/24kHz relay format iOS also
 * still defaults to (RealtimeTalkRelaySession.configureAudioContract), not an unsupported
 * contract. A field that IS present but doesn't parse as a usable pcm16 rate stays
 * fail-closed via the caller's existing null checks.
 */
internal fun parseRealtimeWireAudioContract(root: JsonObject?): RealtimeWireAudioContract {
  val rawAudioContract = root?.get("audio") ?: return RealtimeWireAudioContract("pcm16", 24_000)
  val audioContract = rawAudioContract.asObjectOrNull()
  return RealtimeWireAudioContract(
    encoding = audioContract?.get("inputEncoding").asStringOrNull(),
    sampleRateHz = audioContract?.get("inputSampleRateHz").asIntOrNull(),
  )
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

/**
 * Commands the Gateway message pump enqueues (trySend only, never blocking)
 * for the single realtime playout owner coroutine to process. Audio/Mark
 * carry the epoch that was current when the Gateway event arrived, so the
 * owner can discard a command superseded by a later Clear/Stop without
 * needing to touch AudioTrack or any owner-exclusive state from the pump.
 */
private sealed interface RealtimePlaybackCommand {
  data class Audio(
    val epoch: Long,
    val bytes: ByteArray,
  ) : RealtimePlaybackCommand

  data class Mark(
    val sessionId: String,
    val markName: String,
  ) : RealtimePlaybackCommand

  data class Clear(
    val epoch: Long,
    val completion: CompletableDeferred<Unit>?,
  ) : RealtimePlaybackCommand

  data class Stop(
    /**
     * True only for real relay teardown, which drops pending marks unacknowledged.
     * A plain playback stop (PTT pause, TTS stop, playback disabled) keeps them: the
     * provider's own `clear` for that cancelled turn arrives afterwards and is what
     * acknowledges them.
     */
    val discardMarks: Boolean,
  ) : RealtimePlaybackCommand

  data object PollIdle : RealtimePlaybackCommand
}

/** One opened realtime capture session together with the converter its negotiated rate resolved to. */
private class RealtimeCaptureOpen(
  val session: AndroidAudioInputSession,
  val resampler: RealtimeCaptureResampler,
  val captureSampleRateHz: Int,
)

private data class PendingRealtimePlaybackMark(
  val sessionId: String,
  val name: String,
  var targetFrame: Long? = null,
)

/**
 * Testable seam for the one hardware call realtime playout depends on.
 * Default writes non-blocking so the playout owner never does a blocking
 * data-transfer call; production behavior is otherwise identical to a plain
 * AudioTrack.write call.
 */
internal fun interface RealtimeAudioTrackWriter {
  fun write(
    track: AudioTrack,
    bytes: ByteArray,
    offset: Int,
    length: Int,
  ): Int

  companion object {
    val Default =
      RealtimeAudioTrackWriter { track, bytes, offset, length ->
        track.write(bytes, offset, length, AudioTrack.WRITE_NON_BLOCKING)
      }
  }
}

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
  private val realtimeAudioTrackWriter: RealtimeAudioTrackWriter = RealtimeAudioTrackWriter.Default,
  // Separate from `scope` only so tests can exempt this specific
  // intentionally-infinite coroutine (and its idle-poll ticker) from
  // kotlinx-coroutines-test's "all child jobs of the test scope must
  // complete" check, without also exempting gatewayWorkScope (which is
  // built from `scope`'s CoroutineContext and must stay normally tracked).
  // Production always defaults this to `scope` — same lifetime either way.
  private val realtimePlaybackOwnerScope: CoroutineScope = scope,
) {
  companion object {
    private const val tag = "TalkMode"

    // Realtime playback (provider -> device) is Gateway-declared PCM16 wire
    // audio, played back verbatim; realtime capture (device -> provider) uses
    // a device-portable hardware rate and is resampled to the Gateway's
    // declared wire rate before appendAudio (see startRealtimeCaptureLocked).
    // These are deliberately separate constants: Android 14 CDD only
    // guarantees 16k/44.1k/48k raw PCM capture, so capture cannot assume the
    // wire rate is a usable AudioRecord rate on every device.
    private const val realtimeOutputSampleRateHz = 24_000
    private const val realtimeCapturePortableSampleRateHz = 48_000
    private const val realtimeAudioFrameMs = 100
    private const val chatFinalWaitMs = 45_000L
    private const val maxCachedRunCompletions = 128
    private const val maxConversationEntries = 40
    private const val realtimePlaybackBufferMs = 240
    private const val realtimePlaybackIdlePollMs = 20L

    // Retry backoff after AudioTrack.write(..., WRITE_NON_BLOCKING) reports 0
    // bytes accepted (hardware buffer momentarily full). This delay runs
    // inside the single playout owner coroutine only — never under a lock
    // the Gateway message pump needs — so it cannot reproduce the receive
    // head-of-line blocking this design replaces (see
    // processRealtimeAudioCommandOwnerOnly). Bounded and short relative to
    // realtimeAudioFrameMs (100ms provider cadence).
    private const val realtimePlaybackWriteRetryDelayMs = 5L
    private const val realtimeUserFinalRewriteGraceMs = 1_500L
    private const val pushToTalkSampleRateHz = 16_000
    private const val pushToTalkReleaseGraceMs = 5_000L
    private const val pushToTalkReleaseDrainTimeoutMs = 6_000L
    private const val pushToTalkRestartDelayMs = 200L
  }

  private val mainHandler = Handler(Looper.getMainLooper())
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
  private var realtimeWireAudioSampleRateHz: Int? = null
  private var realtimeWireAudioEncoding: String? = null
  private var realtimeCaptureJob: Job? = null
  private var realtimeAppendJob: Job? = null
  private val realtimeCapturePauseLock = Any()
  private var realtimeCapturePause: RealtimeCapturePause? = null

  // True only while communication-profile capture reports platform AEC actually
  // enabled; drives the full-duplex forwarding policy in
  // shouldSuppressRealtimeCaptureForPlayback. Cleared at the start of every
  // capture generation and again when the job that set it ends, so it only ever
  // describes the capture session currently running - never the previous one.
  @Volatile private var realtimeAecEnabled = false

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

  // Single logical owner of AudioTrack create/write/pause/flush/stop/release
  // and every field below it in this group: the Gateway message pump only
  // ever enqueues commands here (trySend, never blocking, never touches
  // AudioTrack or these fields directly) — see realtimeAudioWriterJob and
  // RealtimePlaybackCommand. Long-lived for this TalkModeManager's full
  // lifetime rather than recreated per session, so there is no per-session
  // channel-close/recreate race to guard against.
  private val realtimePlaybackCommands = Channel<RealtimePlaybackCommand>(Channel.UNLIMITED)
  private val realtimePlaybackEpoch = AtomicLong(0L)
  private var realtimeAudioTrack: AudioTrack? = null
  private var realtimeWrittenFrames = 0L
  private val pendingRealtimePlaybackMarks = LinkedHashMap<String, PendingRealtimePlaybackMark>()
  private var realtimePlaybackIdleJob: Job? = null

  // Declared above the launch below: the coroutine body mutates them, and a
  // field initializer that starts a coroutine must not depend on fields the
  // constructor has not reached yet.
  private val realtimeAudioWriterJob: Job =
    realtimePlaybackOwnerScope.launch(realtimePlaybackDispatcher) {
      for (command in realtimePlaybackCommands) {
        // Per-command boundary: an uncaught throw here (e.g. AudioTrack
        // creation/write failing on a route/dead-object error) would
        // otherwise end this for-loop and terminate the owner job for the
        // rest of the manager's lifetime — the channel is long-lived and
        // never recreated, so every later command would enqueue into a
        // consumer that no longer exists. Retire the track so the next
        // Audio command starts clean instead of reusing a track that may be
        // in whatever state the failure left it.
        try {
          when (command) {
            is RealtimePlaybackCommand.Audio -> processRealtimeAudioCommandOwnerOnly(command)
            is RealtimePlaybackCommand.Mark -> processRealtimeMarkCommandOwnerOnly(command)
            is RealtimePlaybackCommand.Clear -> processRealtimeClearCommandOwnerOnly(command)
            is RealtimePlaybackCommand.Stop -> processRealtimeStopCommandOwnerOnly(command)
            RealtimePlaybackCommand.PollIdle -> processRealtimePollIdleCommandOwnerOnly()
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          Log.w(tag, "realtime playback command failed: ${err.message ?: err::class.simpleName}")
          // Treat a failure like Clear for any mark still pending against the
          // track being retired: retireRealtimeAudioTrackOwnerOnly() resets
          // realtimeWrittenFrames to 0, so a stale positive targetFrame would
          // otherwise never be satisfied again — takeCompletedRealtimePlaybackMarksOwnerOnly()
          // would poll it forever and the provider would never get its ack.
          val strandedMarks = pendingRealtimePlaybackMarks.values.toList()
          pendingRealtimePlaybackMarks.clear()
          retireRealtimeAudioTrackOwnerOnly()
          acknowledgeRealtimePlaybackMarks(strandedMarks)
        }
      }
    }

  @Volatile private var pendingRealtimeOutputClear: CompletableDeferred<Unit>? = null
  private val realtimeOutputCancellationMutex = Mutex()

  @Volatile
  private var realtimePlaybackEndsAtMs = 0L

  @Volatile
  private var realtimeOutputSuppressed = false

  @Volatile
  private var playbackEnabled = true
  private val playbackGeneration = AtomicLong(0L)

  private var ttsJob: Job? = null
  private val ttsJobLock = Any()
  private val ttsLock = Any()
  private var textToSpeech: TextToSpeech? = null
  private var textToSpeechInit: CompletableDeferred<TextToSpeech>? = null

  @Volatile private var currentUtteranceId: String? = null

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
      is PushToTalkStartResult.Existing ->
        TalkPttOnceStart.Busy(
          TalkPttStopPayload(
            captureId = start.payload.captureId,
            transcript = null,
            status = "busy",
          ),
        )
      is PushToTalkStartResult.Started ->
        TalkPttOnceStart.Started(
          captureId = start.payload.captureId,
          completion = completion,
        )
    }
  }

  /** Waits for a started one-shot turn without keeping NodeRuntime preparation locked. */
  internal suspend fun awaitPushToTalkOnce(start: TalkPttOnceStart): TalkPttStopPayload =
    when (start) {
      is TalkPttOnceStart.Busy -> start.payload
      is TalkPttOnceStart.Started ->
        try {
          start.completion.await()
        } catch (err: Throwable) {
          withContext(NonCancellable) {
            cancelPushToTalk(start.captureId)
          }
          throw err
        }
    }

  /** When true, play TTS for all final chat responses (even ones we didn't initiate). */
  @Volatile var ttsOnAllResponses = false

  /** Plays one text response through the configured Android/TalkMode TTS output. */
  fun playTtsForText(text: String) {
    val playbackToken = playbackGeneration.incrementAndGet()
    cancelActivePlayback()
    gatewayWorkScope.launch {
      reloadConfig()
      runPlaybackSession(playbackToken) {
        playAssistant(text, playbackToken)
      }
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

    // Only speak events for the active session — prevents TTS from other
    // sessions/channels leaking into voice mode (privacy + correctness).
    val eventSession = obj["sessionKey"]?.asStringOrNull()
    val activeSession = mainSessionKey.ifBlank { "main" }
    if (eventSession != null && eventSession != activeSession) return

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
    if (playbackEnabled == enabled) return
    playbackEnabled = enabled
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
    val playbackToken = playbackGeneration.incrementAndGet()
    cancelActivePlayback()
    ensureConfigLoaded()
    runPlaybackSession(playbackToken) {
      playAssistant(text, playbackToken)
    }
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
    shutdownTextToSpeech()
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
    stopTextToSpeechPlayback()
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

    // Capture must resample to whatever wire rate the Gateway declares here,
    // never a rate Android assumes on its own (see realtimeCapturePortableSampleRateHz).
    val wireAudioContract = parseRealtimeWireAudioContract(root)
    realtimeWireAudioEncoding = wireAudioContract.encoding
    realtimeWireAudioSampleRateHz = wireAudioContract.sampleRateHz

    var captureInstalled = false
    val capturePaused =
      synchronized(realtimeCapturePauseLock) {
        // Session publication and capture installation are one transition. PTT
        // therefore either blocks startup or detaches every installed capture job.
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
          captureInstalled = startRealtimeCaptureLocked(sessionId)
          false
        }
      }
    if (capturePaused) {
      Log.d(tag, "realtime session ready; capture paused for PTT relaySessionId=$sessionId")
      return
    }
    if (!captureInstalled) return
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
      null, "completed" -> TalkStatus(text = nativeText("Off"), state = TalkStatusState.Off)
      "error" ->
        TalkStatus(
          text = nativeText("Talk failed: Realtime provider closed unexpectedly."),
          state = TalkStatusState.TalkFailure,
        )
      else ->
        TalkStatus(
          text = nativeText("Talk failed: Realtime provider closed: \$reason", reason),
          state = TalkStatusState.TalkFailure,
        )
    }

  /**
   * Caller holds [realtimeCapturePauseLock] so PTT cannot miss newly installed jobs.
   * Returns false when the session was failed instead of capture being installed, so
   * callers do not report a session that is already being torn down as started.
   */
  @SuppressLint("MissingPermission")
  private fun startRealtimeCaptureLocked(sessionId: String): Boolean {
    val wireSampleRateHz = realtimeWireAudioSampleRateHz
    val wireEncoding = realtimeWireAudioEncoding
    // Only the wire half of the contract can be judged before the microphone is
    // open: whether a converter exists depends on the rate AudioRecord actually
    // negotiates, which is checked once below. Rejecting a declared wire rate
    // here against the merely requested capture rate would fail sessions this
    // device can still serve.
    if (wireEncoding != "pcm16" || wireSampleRateHz == null) {
      Log.w(
        tag,
        "realtime capture rejected: unsupported wire audio format encoding=$wireEncoding sampleRateHz=$wireSampleRateHz",
      )
      failRealtimeRelay(sessionId, "unsupported realtime audio format")
      return false
    }
    realtimeCaptureJob?.cancel()
    realtimeAppendJob?.cancel()
    val inputGeneration = audioInputGeneration.incrementAndGet()
    // The superseded job's finally is generation-guarded, so it will decline to
    // clear this - by then the generation is already this one's. Clearing here,
    // at the boundary itself, is what keeps the flag from describing the session
    // that just ended: until the new capture reports its own AEC state, no
    // session has reported one, and the safe answer is "not enabled".
    realtimeAecEnabled = false
    onAppliedAudioInputChanged(null)
    val audioFrames =
      Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    realtimeAppendJob =
      gatewayWorkScope.launch(realtimeCaptureDispatcher) {
        for (frame in audioFrames) {
          if (realtimeSessionId != sessionId) continue
          if (shouldSuppressRealtimeCaptureForPlayback()) continue
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
        try {
          val frameBytes = realtimeCapturePortableSampleRateHz * 2 * realtimeAudioFrameMs / 1000
          val opened =
            openRealtimeCaptureSession(
              // The portable rate is a preference, not a requirement: a device that
              // cannot open it, or whose negotiated rate cannot reach the wire rate,
              // must not lose Talk entirely — capturing straight at the wire rate is
              // what this endpoint did before and needs no conversion at all.
              candidateSampleRatesHz = listOf(realtimeCapturePortableSampleRateHz, wireSampleRateHz),
              wireSampleRateHz = wireSampleRateHz,
              frameBytes = frameBytes,
              inputGeneration = inputGeneration,
            )
          val openedAudioInput = opened.session
          audioInput = openedAudioInput
          val captureSampleRateHz = opened.captureSampleRateHz
          val resampler = opened.resampler
          val aecEnabled = openedAudioInput.communicationEchoCancellationEnabled
          // Generation-guarded: this coroutine's own cancellation is not
          // synchronous with the caller that requested it (realtimeCaptureJob?.cancel()
          // above returns immediately), so a superseded job can still be
          // between its cancellation check and here when a newer one starts.
          if (audioInputGeneration.get() == inputGeneration) {
            realtimeAecEnabled = aecEnabled
          }
          Log.d(tag, "realtime capture opened rateHz=$captureSampleRateHz aecEnabled=$aecEnabled")
          // One read stays realtimeAudioFrameMs of audio at the negotiated rate,
          // so uplink pacing does not stretch when that rate is below the
          // requested one. Never larger than the buffer the recorder was sized for.
          val buffer = ByteArray(minOf(captureSampleRateHz * 2 * realtimeAudioFrameMs / 1000, frameBytes))
          audioInput.startRecording()
          while (coroutineContext.isActive && _isEnabled.value && realtimeSessionId == sessionId) {
            val read = audioInput.read(buffer, 0, buffer.size)
            if (read <= 0) continue
            _inputLevel.value = TalkAudioLevel.smoothed(_inputLevel.value, TalkAudioLevel.pcm16Level(buffer, read))
            val resampled = resampler.process(buffer, read)
            if (!shouldAppendRealtimeCapturedFrame(resampled.size)) continue
            audioFrames.trySend(resampled)
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          Log.w(tag, "realtime capture failed: ${err.message ?: err::class.simpleName}")
          failRealtimeRelay(sessionId, err.message ?: err::class.simpleName ?: "capture failed")
        } finally {
          audioFrames.close()
          audioInput?.close()
          _inputLevel.value = 0f
          // Same generation guard as the assignment above: a newer capture
          // job may already have set realtimeAecEnabled for its own session
          // by the time this superseded job's finally runs.
          if (audioInputGeneration.get() == inputGeneration) {
            realtimeAecEnabled = false
          }
        }
      }
    return true
  }

  /**
   * Opens realtime capture at the first of [candidateSampleRatesHz] the device both accepts
   * and can be converted to [wireSampleRateHz] from. `AudioRecord` rejects a rate it cannot
   * deliver by throwing from its builder, and the rate it actually negotiates is only
   * readable once open, so both halves have to be decided per candidate: a rate that opens
   * but yields no converter is closed again and the next candidate tried. A device that has
   * no usable candidate fails the session closed.
   */
  @SuppressLint("MissingPermission")
  private fun openRealtimeCaptureSession(
    candidateSampleRatesHz: List<Int>,
    wireSampleRateHz: Int,
    frameBytes: Int,
    inputGeneration: Long,
  ): RealtimeCaptureOpen {
    var lastFailure: Throwable? = null
    for (sampleRateHz in candidateSampleRatesHz.distinct()) {
      val session =
        try {
          AndroidAudioInputSession.open(
            context,
            sampleRateHz,
            frameBytes,
            preferredAudioInputDevice(),
            { key ->
              if (audioInputGeneration.get() == inputGeneration) onAppliedAudioInputChanged(key)
            },
            profile = AndroidAudioInputProfile.VoiceCommunication,
          )
        } catch (err: RuntimeException) {
          Log.w(tag, "realtime capture could not open at ${sampleRateHz}Hz: ${err.message ?: err::class.simpleName}")
          lastFailure = err
          continue
        }
      // The recorder, not the request, owns the capture clock.
      val captureSampleRateHz = session.actualSampleRateHz
      val resampler = resolveRealtimeCaptureResampler(captureSampleRateHz, wireSampleRateHz)
      if (resampler != null) {
        return RealtimeCaptureOpen(session = session, resampler = resampler, captureSampleRateHz = captureSampleRateHz)
      }
      Log.w(tag, "realtime capture negotiated ${captureSampleRateHz}Hz, which cannot convert to the ${wireSampleRateHz}Hz wire rate")
      session.close()
      lastFailure = IllegalStateException("microphone audio cannot be converted to this session's format")
    }
    throw lastFailure ?: IllegalStateException("no usable microphone capture rate")
  }

  // Centralizes the full-duplex forwarding policy so the append-loop and
  // capture-loop suppression checks cannot drift: communication-profile capture
  // with platform AEC actually enabled keeps forwarding through assistant
  // playback; otherwise the pre-existing playback-time suppression is the safe
  // fallback (route-independent — no Bluetooth/wired/USB heuristic).
  private fun shouldSuppressRealtimeCaptureForPlayback(): Boolean = isRealtimePlaybackActive() && !realtimeAecEnabled

  private fun shouldAppendRealtimeCapturedFrame(length: Int): Boolean = !shouldSuppressRealtimeCaptureForPlayback() && length > 0

  private fun isRealtimePlaybackActive(): Boolean = _isSpeaking.value || SystemClock.elapsedRealtime() < realtimePlaybackEndsAtMs

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
        finishRealtimeConversationEntry(VoiceConversationRole.User)
        val audioBase64 = obj["audioBase64"].asStringOrNull() ?: return
        val bytes =
          try {
            Base64.decode(audioBase64, Base64.DEFAULT)
          } catch (err: Throwable) {
            Log.w(tag, "realtime audio decode failed: ${err.message ?: err::class.simpleName}")
            return
          }
        playRealtimeAudio(bytes)
      }
      "clear" -> requestRealtimePlaybackClear()
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
            "user" -> upsertRealtimeConversation(VoiceConversationRole.User, text, isFinal)
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
      "toolResult" -> Unit
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

  // --- Gateway message pump side: enqueue only, never touch AudioTrack, a
  // playback-owned lock, or owner-exclusive state (see realtimeAudioWriterJob
  // above and the *OwnerOnly functions below). ---

  private fun playRealtimeAudio(bytes: ByteArray) {
    if (!playbackEnabled || realtimeOutputSuppressed || bytes.isEmpty()) return
    val enqueued =
      synchronized(realtimePlaybackCommandLock) {
        val epoch = realtimePlaybackEpoch.get()
        realtimePlaybackCommands.trySend(RealtimePlaybackCommand.Audio(epoch, bytes)).isSuccess
      }
    if (!enqueued) Log.w(tag, "realtime audio queue full")
  }

  private fun queueRealtimePlaybackMark(
    sessionId: String,
    markName: String,
  ) {
    // Enqueued under the same lock as every other producer. A mark carries no
    // epoch of its own and relies purely on arriving before the Clear or Stop
    // that owes it an acknowledgement, so it must not be able to slip between
    // another producer's epoch bump and that producer's own enqueue.
    val enqueued =
      synchronized(realtimePlaybackCommandLock) {
        realtimePlaybackCommands.trySend(RealtimePlaybackCommand.Mark(sessionId, markName)).isSuccess
      }
    if (!enqueued) {
      // Channel is unlimited and lives for this TalkModeManager's whole
      // lifetime, so this is not expected to happen — but a lost mark must
      // not leave the provider waiting forever for an acknowledgement.
      acknowledgeRealtimePlaybackMarks(listOf(PendingRealtimePlaybackMark(sessionId = sessionId, name = markName)))
    }
  }

  // Stamping a command with the playback epoch and enqueueing it is one step,
  // for every producer. The epoch is what the owner uses to decide whether a
  // command is still current, so a read/bump that is not atomic with its own
  // trySend lets commands reach the owner in a different order than their
  // epochs imply: a Stop could overtake an earlier Clear and swallow the marks
  // that Clear still owed the provider, or a new turn's first audio chunk could
  // land ahead of a pending Stop and be retired away unplayed. The section is
  // an atomic read/increment plus a trySend on an unlimited channel, so it can
  // never block the Gateway message pump.
  private val realtimePlaybackCommandLock = Any()

  /**
   * Barge-in clear: bump the epoch immediately (cheap, no AudioTrack touch)
   * so any audio the owner is mid-write on is preempted at its next retry
   * check, then hand the actual hardware pause/flush to the owner. Captures
   * the currently pending cancelRealtimeOutput() deferred, if any, so the
   * owner completes exactly this generation's confirmation — never a later
   * caller's — once hardware-side clear has actually finished.
   */
  private fun requestRealtimePlaybackClear() {
    val completion = pendingRealtimeOutputClear
    val enqueued =
      synchronized(realtimePlaybackCommandLock) {
        val epoch = realtimePlaybackEpoch.incrementAndGet()
        realtimePlaybackCommands.trySend(RealtimePlaybackCommand.Clear(epoch, completion)).isSuccess
      }
    if (!enqueued) completion?.complete(Unit)
  }

  private fun requestRealtimePlaybackIdleCheck() {
    realtimePlaybackCommands.trySend(RealtimePlaybackCommand.PollIdle)
  }

  private fun stopRealtimePlayback(discardMarks: Boolean = false) {
    // Bump, enqueue and clear under one lock: the playout owner publishes the
    // speaking state under the same lock, so it can neither observe a stale
    // epoch nor reinstate this state afterwards.
    // Status and speaking state stay synchronous here (not deferred to the
    // owner) so callers like stopRealtimeRelay's preserveStatus re-application —
    // which runs immediately after this returns — can still override them,
    // matching the pre-single-owner ordering.
    // realtimePlaybackEndsAtMs deliberately is NOT cleared here. The speaker is
    // still emitting until the owner actually pauses and flushes the track, and
    // isRealtimePlaybackActive() reads that deadline: clearing it early would
    // lift microphone suppression on the half-duplex path while assistant audio
    // is still audible. retireRealtimeAudioTrackOwnerOnly() clears it once the
    // hardware really has stopped.
    synchronized(realtimePlaybackCommandLock) {
      realtimePlaybackEpoch.incrementAndGet()
      realtimePlaybackCommands.trySend(RealtimePlaybackCommand.Stop(discardMarks = discardMarks))
      _isSpeaking.value = false
      _outputLevel.value = null
      if (_isEnabled.value) {
        setStatus(nativeText("Listening"))
      }
    }
  }

  // --- Playout owner side: the only code below this point that may touch
  // AudioTrack, realtimeAudioTrack, realtimeWrittenFrames,
  // pendingRealtimePlaybackMarks, or realtimePlaybackIdleJob. All of it runs
  // sequentially inside realtimeAudioWriterJob, so none of it needs a lock. ---

  private suspend fun processRealtimeAudioCommandOwnerOnly(command: RealtimePlaybackCommand.Audio) {
    if (realtimePlaybackEpoch.get() != command.epoch) return
    // playbackEnabled/realtimeSessionId are @Volatile and safe to read here;
    // toggling either already bumps the epoch via stopRealtimePlayback(), but
    // this direct check preserves the dequeue-time guard the previous
    // single-queue design also had, in case a future caller changes either
    // without routing through a Stop/Clear command.
    if (!playbackEnabled || realtimeOutputSuppressed || realtimeSessionId == null) return
    val track = obtainRealtimeAudioTrackOwnerOnly(command.bytes.size)
    val bytes = command.bytes
    var writtenBytes = 0
    // A non-blocking write returning 0 normally means "buffer full, retry"; on
    // some devices it also means the OS stopped draining this track for good.
    // Retrying forever would wedge the single playout owner, so allow only as
    // many consecutive empty writes as it takes to drain one buffer plus this
    // frame. Counted rather than timed so the bound does not depend on how
    // promptly the dispatcher resumes each retry.
    // Sized from the track's real buffer, not just the requested one: AudioTrack
    // may allocate more than realtimePlaybackBufferMs asked for, and draining a
    // bigger buffer legitimately takes longer than the constant would allow.
    val trackBufferMs =
      maxOf(
        realtimePlaybackBufferMs.toLong(),
        track.bufferSizeInFrames.toLong() * 1000L / realtimeOutputSampleRateHz,
      )
    val maxConsecutiveEmptyWrites =
      (
        (trackBufferMs + (bytes.size / 2L) * 1000L / realtimeOutputSampleRateHz) /
          realtimePlaybackWriteRetryDelayMs
      ).toInt()
    var consecutiveEmptyWrites = 0
    while (writtenBytes < bytes.size) {
      // Re-checked on every retry (not just once per command) so a clear/stop
      // that lands mid-frame discards the remaining bytes immediately rather
      // than waiting for this frame to finish writing.
      if (realtimePlaybackEpoch.get() != command.epoch) return
      val result = realtimeAudioTrackWriter.write(track, bytes, writtenBytes, bytes.size - writtenBytes)
      when {
        result > 0 -> {
          writtenBytes += result
          // Any progress means the track is draining after all.
          consecutiveEmptyWrites = 0
        }
        result == 0 -> {
          if (++consecutiveEmptyWrites > maxConsecutiveEmptyWrites) {
            // Stuck, not merely backpressured. Fail this command so the shared
            // recovery path retires the dead track and acknowledges any mark
            // stranded against it, instead of playing on silently forever.
            throw IllegalStateException("realtime audio write stalled after $writtenBytes/${bytes.size} bytes")
          }
          delay(realtimePlaybackWriteRetryDelayMs)
        }
        // A negative result is terminal for this track (e.g. ERROR_DEAD_OBJECT
        // after the audio server died). Same recovery path: without it the dead
        // track stays installed and every later command is silently discarded.
        else -> throw IllegalStateException("realtime audio write failed: $result")
      }
    }
    if (writtenBytes <= 0) return
    if (realtimePlaybackEpoch.get() != command.epoch) return
    if (track.playState != AudioTrack.PLAYSTATE_PLAYING) {
      track.play()
    }
    // Publishing the speaking state and re-checking the epoch are one step,
    // under the same lock stopRealtimePlayback()/requestRealtimePlaybackClear()
    // use to bump that epoch and clear this state. Without it a stop landing
    // between the check above and these assignments would be overwritten, and
    // the UI would stay on "Speaking…" with a future playback deadline after
    // Talk was already stopped — which also keeps the microphone suppressed on
    // the half-duplex path. Nothing in here blocks.
    synchronized(realtimePlaybackCommandLock) {
      if (realtimePlaybackEpoch.get() != command.epoch) return
      _outputLevel.value = TalkAudioLevel.smoothed(_outputLevel.value ?: 0f, TalkAudioLevel.pcm16Level(bytes, writtenBytes))
      _isSpeaking.value = true
      setStatus(nativeText("Speaking…"))
      val durationMs = ((writtenBytes / 2.0) / realtimeOutputSampleRateHz * 1000.0).toLong()
      realtimeWrittenFrames += writtenBytes / 2L
      val now = SystemClock.elapsedRealtime()
      realtimePlaybackEndsAtMs = maxOf(now, realtimePlaybackEndsAtMs) + durationMs
    }
    ensureRealtimePlaybackIdlePollingOwnerOnly()
  }

  private fun obtainRealtimeAudioTrackOwnerOnly(pendingBytes: Int): AudioTrack {
    realtimeAudioTrack?.let { return it }
    val minBuffer =
      AudioTrack.getMinBufferSize(
        realtimeOutputSampleRateHz,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    val bufferSizeBytes =
      maxOf(
        minBuffer * 2,
        realtimeOutputSampleRateHz * 2 * realtimePlaybackBufferMs / 1000,
        pendingBytes * 4,
      )
    val created =
      AudioTrack
        .Builder()
        .setAudioAttributes(
          AudioAttributes
            .Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        ).setAudioFormat(
          AudioFormat
            .Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(realtimeOutputSampleRateHz)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        ).setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(bufferSizeBytes)
        .build()
    realtimeAudioTrack = created
    realtimeWrittenFrames = 0L
    return created
  }

  private fun processRealtimeMarkCommandOwnerOnly(command: RealtimePlaybackCommand.Mark) {
    // Not epoch-gated: registration must be unconditional so a Mark made
    // stale by a Clear/Stop enqueued right after it is still visible to that
    // Clear/Stop's own mark handling once dequeued (single sequential owner
    // guarantees this Mark is always processed first) — an epoch check here
    // would instead drop the mark before either handler ever sees it,
    // silently losing its acknowledgement.
    val mark = PendingRealtimePlaybackMark(sessionId = command.sessionId, name = command.markName)
    // Every Audio command enqueued before this Mark has already been
    // processed in order by the time this runs (single sequential owner), so
    // realtimeWrittenFrames already reflects the correct target.
    mark.targetFrame = realtimeWrittenFrames
    pendingRealtimePlaybackMarks[command.markName] = mark
    val completed = takeCompletedRealtimePlaybackMarksOwnerOnly()
    acknowledgeRealtimePlaybackMarks(completed)
    ensureRealtimePlaybackIdlePollingOwnerOnly()
  }

  private fun takeCompletedRealtimePlaybackMarksOwnerOnly(): List<PendingRealtimePlaybackMark> {
    val playedFrames = realtimeAudioTrack?.playbackHeadPosition?.toLong()?.and(0xffff_ffffL) ?: realtimeWrittenFrames
    val completed =
      pendingRealtimePlaybackMarks.values.filter { mark ->
        val targetFrame = mark.targetFrame
        targetFrame != null && playedFrames >= targetFrame
      }
    completed.forEach { pendingRealtimePlaybackMarks.remove(it.name) }
    return completed
  }

  /**
   * Barge-in clear: retires the current track (pause/flush/stop/release) and
   * acknowledges every still-pending mark as cleared — existing semantics
   * already treated a clear as "these marks will never complete normally" —
   * then completes exactly the deferred captured when this Clear was
   * created. Runs unconditionally (not epoch-gated): a Clear is itself an
   * invalidating event, so retiring an already-retired track is a safe
   * no-op, and completing an already-superseded completion reference is
   * harmless because nothing still awaits it.
   */
  private fun processRealtimeClearCommandOwnerOnly(command: RealtimePlaybackCommand.Clear) {
    // Completed in a finally: a throw anywhere below would otherwise leave
    // cancelRealtimeOutput() waiting out its whole timeout and escalate a PTT
    // turn into a full relay restart.
    try {
      processRealtimeClearCommandBodyOwnerOnly()
    } finally {
      command.completion?.complete(Unit)
    }
  }

  private fun processRealtimeClearCommandBodyOwnerOnly() {
    val marks = pendingRealtimePlaybackMarks.values.toList()
    pendingRealtimePlaybackMarks.clear()
    retireRealtimeAudioTrackOwnerOnly()
    cancelRealtimePlaybackIdlePollingOwnerOnly()
    _isSpeaking.value = false
    _outputLevel.value = null
    // Same guard the idle path uses: a Clear dequeued after the relay was torn
    // down must not overwrite a failure status stopRealtimeRelay preserved.
    if (_isEnabled.value && realtimeSessionId != null) {
      setStatus(nativeText("Listening"))
    }
    acknowledgeRealtimePlaybackMarks(marks)
  }

  /** Teardown paths (stopRealtimeRelay, PTT pause, gateway scope change,
   * relay close): unlike Clear, pending marks are dropped without
   * acknowledgement — matches the marks discard stopRealtimeRelay already
   * did directly before this command queue existed. */
  private fun processRealtimeStopCommandOwnerOnly(command: RealtimePlaybackCommand.Stop) {
    // Status/_isSpeaking/_outputLevel are already handled synchronously by
    // stopRealtimePlayback() at enqueue time; this only tears down the
    // hardware-owned track/marks/ticker, which is safe to do asynchronously.
    // Marks survive a plain playback stop: PTT pause and stopTts are followed by
    // the provider's own clear for the cancelled turn, and that clear is what
    // acknowledges them. Only real relay teardown drops them unacknowledged.
    if (command.discardMarks) pendingRealtimePlaybackMarks.clear()
    retireRealtimeAudioTrackOwnerOnly()
    cancelRealtimePlaybackIdlePollingOwnerOnly()
    // Re-cleared here even though stopRealtimePlayback() already did it on the
    // Gateway thread: an Audio command that had passed its epoch check just
    // before the stop can still set these afterwards, and a stuck _isSpeaking
    // keeps isRealtimePlaybackActive() true, which suppresses the microphone on
    // the half-duplex path. The owner is sequential, so its own clear is last.
    // Status is deliberately not touched — stopRealtimeRelay(preserveStatus)
    // owns that, and Clear has its own guarded re-set.
    _isSpeaking.value = false
    _outputLevel.value = null
  }

  private fun retireRealtimeAudioTrackOwnerOnly() {
    realtimeAudioTrack?.let { track ->
      try {
        track.pause()
        track.flush()
        track.stop()
      } catch (_: Throwable) {
      }
      track.release()
    }
    realtimeAudioTrack = null
    realtimeWrittenFrames = 0L
    realtimePlaybackEndsAtMs = 0L
  }

  private fun processRealtimePollIdleCommandOwnerOnly() {
    val playbackTimeElapsed = SystemClock.elapsedRealtime() >= realtimePlaybackEndsAtMs
    val completed = takeCompletedRealtimePlaybackMarksOwnerOnly()
    // AudioTrack may lag the duration estimate by its device buffer. Keep
    // polling until queued marks prove the speaker reached the barrier.
    val awaitingPlaybackMark = pendingRealtimePlaybackMarks.values.any { it.targetFrame != null }
    val playbackIdle = playbackTimeElapsed && !awaitingPlaybackMark
    if (playbackIdle) {
      _isSpeaking.value = false
      _outputLevel.value = null
      cancelRealtimePlaybackIdlePollingOwnerOnly()
      if (_isEnabled.value && realtimeSessionId != null) {
        setStatus(nativeText("Listening"))
      }
    } else {
      ensureRealtimePlaybackIdlePollingOwnerOnly()
    }
    acknowledgeRealtimePlaybackMarks(completed)
  }

  /** Ticker only pings the owner (trySend) on a timer — it never reads
   * AudioTrack or owner-exclusive state itself; see PollIdle handling above. */
  private fun ensureRealtimePlaybackIdlePollingOwnerOnly() {
    if (realtimePlaybackIdleJob?.isActive == true) return
    realtimePlaybackIdleJob =
      realtimePlaybackOwnerScope.launch(realtimePlaybackDispatcher) {
        while (isActive) {
          delay(realtimePlaybackIdlePollMs)
          if (!realtimePlaybackCommands.trySend(RealtimePlaybackCommand.PollIdle).isSuccess) break
        }
      }
  }

  private fun cancelRealtimePlaybackIdlePollingOwnerOnly() {
    realtimePlaybackIdleJob?.cancel()
    realtimePlaybackIdleJob = null
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
    val (sessionId, captureJobs) =
      synchronized(realtimeCapturePauseLock) {
        val currentSessionId = realtimeSessionId
        val currentCaptureJobs = realtimeCaptureJob to realtimeAppendJob
        realtimeSessionId = null
        realtimeWireAudioSampleRateHz = null
        realtimeWireAudioEncoding = null
        realtimeCaptureJob = null
        realtimeAppendJob = null
        realtimeCapturePause = null
        currentSessionId to currentCaptureJobs
      }
    realtimeOutputSuppressed = false
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
    // Relay teardown is the one path that drops pending marks unacknowledged,
    // matching what this function did directly before mark ownership moved to
    // the playout owner. Every other stopRealtimePlayback() caller keeps them
    // for the provider's own clear to acknowledge.
    _speechActive.value = false
    _inputLevel.value = 0f
    stopRealtimePlayback(discardMarks = true)
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
    if (!cancelRealtimeOutput(reason = "android-push-to-talk")) {
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
        // Honour the install result: on the unsupported-contract path
        // startRealtimeCaptureLocked() already failed the relay, so reporting
        // "Listening" here would advertise a session that is being torn down.
        if (!startRealtimeCaptureLocked(sessionId)) {
          return@synchronized RealtimeCaptureResume.Skipped
        }
        _isListening.value = true
        setStatus(nativeText("Listening"))
        RealtimeCaptureResume.Resumed
      }
    when (outcome) {
      RealtimeCaptureResume.Skipped -> return
      RealtimeCaptureResume.Resumed -> return
      RealtimeCaptureResume.Restart -> start()
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
      VoiceConversationRole.Assistant -> realtimeAssistantEntryId = if (isFinal) null else resolvedEntryId
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
            PushToTalkRecognitionCandidate.RawAudioSegmented ->
              PushToTalkRecognitionRung.RawAudioSegmented(openPushToTalkAudioSource())
            PushToTalkRecognitionCandidate.SilenceSegmented -> PushToTalkRecognitionRung.SilenceSegmented
            PushToTalkRecognitionCandidate.RestartingSingleSession ->
              PushToTalkRecognitionRung.RestartingSingleSession
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
        is PushToTalkRecognitionRung.RawAudioSegmented ->
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            applyRawAudioSegmentedExtras(this, rung.source)
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
        is PushToTalkRecognitionRung.RawAudioSegmented ->
          if (advanceRung) {
            PushToTalkRecognitionCandidate.SilenceSegmented
          } else {
            PushToTalkRecognitionCandidate.RawAudioSegmented
          }
        PushToTalkRecognitionRung.SilenceSegmented ->
          if (advanceRung) {
            PushToTalkRecognitionCandidate.RestartingSingleSession
          } else {
            PushToTalkRecognitionCandidate.SilenceSegmented
          }
        PushToTalkRecognitionRung.RestartingSingleSession ->
          PushToTalkRecognitionCandidate.RestartingSingleSession
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
      val playbackToken = playbackGeneration.incrementAndGet()
      cancelActivePlayback()
      runPlaybackSession(playbackToken) {
        playAssistant(assistant, playbackToken)
      }
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
      -> runCatching { recognizer?.stopListening() }.onFailure { completion.complete(Unit) }
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
    val parsed = TalkDirectiveParser.parse(text)
    if (parsed.unknownKeys.isNotEmpty()) {
      Log.w(tag, "Unknown talk directive keys: ${parsed.unknownKeys}")
    }
    val directive = parsed.directive
    val cleaned = parsed.stripped.trim()
    if (cleaned.isEmpty()) return
    _lastAssistantText.value = cleaned
    ensurePlaybackActive(playbackToken)

    setStatus(nativeText("Generating voice…"), awaitingAgent = true)
    _isSpeaking.value = false
    lastSpokenText = cleaned

    try {
      val started = SystemClock.elapsedRealtime()
      when (val result = talkSpeakClient.synthesize(text = cleaned, directive = directive)) {
        is TalkSpeakResult.Success -> {
          ensurePlaybackActive(playbackToken)
          markAudioPlaybackStarting(playbackToken)
          talkAudioPlayer.play(result.audio)
          ensurePlaybackActive(playbackToken)
          Log.d(tag, "talk.speak ok durMs=${SystemClock.elapsedRealtime() - started}")
        }
        is TalkSpeakResult.FallbackToLocal -> {
          Log.d(tag, "talk.speak unavailable; using local TTS: ${result.message}")
          speakWithSystemTts(cleaned, directive, playbackToken)
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
      setStatus(nativeText("Speak failed: \$message", err.message ?: err::class.simpleName.orEmpty()))
      Log.w(tag, "talk playback failed: ${err.message ?: err::class.simpleName}")
    } finally {
      _isSpeaking.value = false
    }
  }

  private suspend fun runPlaybackSession(
    playbackToken: Long,
    block: suspend () -> Unit,
  ) {
    val currentJob = coroutineContext[Job]
    var shouldResumeAfterSpeak = false
    try {
      val claimedPlayback =
        synchronized(ttsJobLock) {
          if (!playbackEnabled || playbackToken != playbackGeneration.get()) {
            false
          } else {
            ttsJob = currentJob
            true
          }
        }
      if (!claimedPlayback) {
        ensurePlaybackActive(playbackToken)
        return
      }
      ensurePlaybackActive(playbackToken)
      shouldResumeAfterSpeak = true
      onBeforeSpeak()
      ensurePlaybackActive(playbackToken)
      block()
    } finally {
      synchronized(ttsJobLock) {
        if (ttsJob === currentJob) {
          ttsJob = null
        }
      }
      _isSpeaking.value = false
      if (shouldResumeAfterSpeak) {
        withContext(NonCancellable) {
          onAfterSpeak()
        }
      }
    }
  }

  private fun cancelActivePlayback() {
    val activeJob =
      synchronized(ttsJobLock) {
        ttsJob
      }
    activeJob?.cancel()
    talkAudioPlayer.stop()
    stopTextToSpeechPlayback()
  }

  private suspend fun speakWithSystemTts(
    text: String,
    directive: TalkDirective?,
    playbackToken: Long,
  ) {
    ensurePlaybackActive(playbackToken)
    val engine = ensureTextToSpeech()
    val utteranceId = UUID.randomUUID().toString()
    val finished = CompletableDeferred<Unit>()
    withContext(Dispatchers.Main) {
      ensurePlaybackActive(playbackToken)
      synchronized(ttsLock) {
        currentUtteranceId = utteranceId
        engine.stop()
      }
      val locale =
        TalkModeRuntime
          .validatedLanguage(directive?.language)
          ?.let(Locale::forLanguageTag)
          ?: Locale.getDefault()
      val localeResult = engine.setLanguage(locale)
      if (
        localeResult == TextToSpeech.LANG_MISSING_DATA ||
        localeResult == TextToSpeech.LANG_NOT_SUPPORTED
      ) {
        throw IllegalStateException("Language unavailable on this device")
      }
      engine.setSpeechRate((TalkModeRuntime.resolveSpeed(directive?.speed, directive?.rateWpm) ?: 1.0).toFloat())
      engine.setAudioAttributes(
        AudioAttributes
          .Builder()
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .build(),
      )
      engine.setOnUtteranceProgressListener(
        object : UtteranceProgressListener() {
          override fun onStart(utteranceId: String?) = Unit

          override fun onDone(utteranceId: String?) {
            if (utteranceId == currentUtteranceId) {
              finished.complete(Unit)
            }
          }

          @Suppress("OVERRIDE_DEPRECATION")
          @Deprecated("Deprecated in Java")
          override fun onError(utteranceId: String?) {
            if (utteranceId == currentUtteranceId) {
              finished.completeExceptionally(IllegalStateException("TextToSpeech playback failed"))
            }
          }

          override fun onError(
            utteranceId: String?,
            errorCode: Int,
          ) {
            if (utteranceId == currentUtteranceId) {
              finished.completeExceptionally(IllegalStateException("TextToSpeech playback failed ($errorCode)"))
            }
          }

          override fun onStop(
            utteranceId: String?,
            interrupted: Boolean,
          ) {
            if (utteranceId == currentUtteranceId) {
              finished.completeExceptionally(CancellationException("assistant speech cancelled"))
            }
          }
        },
      )
      markAudioPlaybackStarting(playbackToken)
      val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
      if (result != TextToSpeech.SUCCESS) {
        throw IllegalStateException("TextToSpeech start failed")
      }
    }
    try {
      finished.await()
      ensurePlaybackActive(playbackToken)
    } finally {
      synchronized(ttsLock) {
        if (currentUtteranceId == utteranceId) {
          currentUtteranceId = null
        }
      }
    }
  }

  private fun markAudioPlaybackStarting(playbackToken: Long) {
    ensurePlaybackActive(playbackToken)
    setStatus(nativeText("Speaking…"))
    _isSpeaking.value = true
    ensureInterruptListener()
    requestAudioFocusForTts()
  }

  fun stopTts() {
    realtimeOutputSuppressed = true
    stopRealtimePlayback()
    scope.launch { cancelRealtimeOutput(reason = "android-stop-tts") }
    stopSpeaking(resetInterrupt = true)
    _isSpeaking.value = false
    setStatus(nativeText("Listening"))
  }

  private suspend fun cancelRealtimeOutput(reason: String): Boolean =
    realtimeOutputCancellationMutex.withLock {
      val sessionId = realtimeSessionId ?: return@withLock true
      val clear = CompletableDeferred<Unit>()
      pendingRealtimeOutputClear = clear
      try {
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(sessionId))
            put("reason", JsonPrimitive(reason))
          }
        requestGateway("talk.session.cancelOutput", params.toString(), timeoutMs = 5_000)
        // The response confirms provider cancellation; clear confirms that the
        // old playback boundary reached Android before capture can resume.
        withTimeout(2_000) { clear.await() }
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
    playbackGeneration.incrementAndGet()
    if (!_isSpeaking.value) {
      cancelActivePlayback()
      abandonAudioFocus()
      return
    }
    if (resetInterrupt) {
      lastInterruptedAtSeconds = null
    }
    cancelActivePlayback()
    _isSpeaking.value = false
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

  private suspend fun ensureTextToSpeech(): TextToSpeech {
    val existing = synchronized(ttsLock) { textToSpeech }
    if (existing != null) {
      return existing
    }
    val deferred: CompletableDeferred<TextToSpeech>
    val created: Boolean
    synchronized(ttsLock) {
      val ready = textToSpeech
      if (ready != null) {
        deferred = CompletableDeferred<TextToSpeech>().also { it.complete(ready) }
        created = false
      } else {
        val pending = textToSpeechInit
        if (pending != null) {
          deferred = pending
          created = false
        } else {
          deferred = CompletableDeferred<TextToSpeech>()
          textToSpeechInit = deferred
          created = true
        }
      }
    }
    if (!created) {
      return deferred.await()
    }
    withContext(Dispatchers.Main) {
      synchronized(ttsLock) {
        textToSpeech?.let {
          textToSpeechInit = null
          deferred.complete(it)
          return@withContext
        }
      }
      var engine: TextToSpeech? = null
      engine =
        TextToSpeech(context) { status ->
          if (status == TextToSpeech.SUCCESS) {
            val initialized =
              engine ?: run {
                deferred.completeExceptionally(IllegalStateException("TextToSpeech init failed"))
                return@TextToSpeech
              }
            synchronized(ttsLock) {
              textToSpeech = initialized
              textToSpeechInit = null
            }
            deferred.complete(initialized)
          } else {
            synchronized(ttsLock) {
              textToSpeechInit = null
            }
            engine?.shutdown()
            deferred.completeExceptionally(IllegalStateException("TextToSpeech init failed ($status)"))
          }
        }
    }
    return deferred.await()
  }

  private fun stopTextToSpeechPlayback() {
    synchronized(ttsLock) {
      currentUtteranceId = null
      textToSpeech?.stop()
    }
  }

  private fun shutdownTextToSpeech() {
    synchronized(ttsLock) {
      currentUtteranceId = null
      textToSpeech?.stop()
      textToSpeech?.shutdown()
      textToSpeech = null
      textToSpeechInit = null
    }
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

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asDoubleOrNull(): Double? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toDoubleOrNull()
}

private fun JsonElement?.asIntOrNull(): Int? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toIntOrNull()
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
