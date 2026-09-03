package ai.openclaw.app.voice

import ai.openclaw.app.gateway.ChatSendAck
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.TalkSessionCancelOutputResult
import ai.openclaw.app.gateway.chatSendAckHistorySinceSeconds
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.i18n.LocaleResolvingStateFlow
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
import kotlinx.coroutines.Deferred
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
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
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

private enum class TalkStatusState {
  Off,
  Active,
  TalkFailure,
}

private class TalkStatusOwner(
  val responseTurnId: String? = null,
)

private data class TalkStatus(
  val text: NativeText,
  val state: TalkStatusState,
  val awaitingAgent: Boolean = false,
  val owner: TalkStatusOwner = TalkStatusOwner(),
)

private class PushToTalkAudioSource(
  val readDescriptor: ParcelFileDescriptor,
  private val writeStream: ParcelFileDescriptor.AutoCloseOutputStream,
  private val audioRecord: AudioRecord,
) {
  private var finishRequested = false
  private var inputFinished = false
  private var descriptorClosed = false
  var pumpJob: Job? = null

  @Synchronized
  fun requestFinish() {
    if (finishRequested) return
    finishRequested = true
    runCatching { audioRecord.stop() }
  }

  // close() must wait for a pump already inside release, not just observe its claim.
  @Synchronized
  fun finishFromPump() {
    if (inputFinished) return
    inputFinished = true
    runCatching { audioRecord.stop() }
    runCatching { audioRecord.release() }
    runCatching { writeStream.close() }
  }

  @Synchronized
  fun close() {
    requestFinish()
    pumpJob?.cancel()
    finishFromPump()
    pumpJob = null
    if (!descriptorClosed) {
      descriptorClosed = true
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
  private val captureRelayStopNotification: () -> ((isCurrent: () -> Boolean) -> Unit) = { {} },
  private val talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(session = session),
  private val talkAudioPlayer: TalkAudioPlaying = TalkAudioPlayer(context),
  private val realtimeCaptureDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val realtimePlaybackDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val realtimeMarkAcknowledger: (suspend (sessionId: String, markName: String) -> Unit)? = null,
) {
  companion object {
    private const val tag = "TalkMode"
    private const val realtimeSampleRateHz = 24_000
    private const val realtimeAudioFrameMs = 100
    private const val chatFinalWaitMs = 45_000L
    private const val maxCachedRunCompletions = 128
    private const val maxConversationEntries = 40
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

  private val playbackLock = Any()

  private val status = MutableStateFlow(TalkStatus(text = nativeText("Off"), state = TalkStatusState.Off))
  private val currentStatus: TalkStatus get() = status.value
  val statusText: StateFlow<String> = LocaleResolvingStateFlow(status) { it.text.resolveNativeText() }
  val awaitingAgent: StateFlow<Boolean> = LocaleResolvingStateFlow(status) { it.awaitingAgent }

  private fun setStatus(
    text: NativeText,
    state: TalkStatusState = TalkStatusState.Active,
    awaitingAgent: Boolean = false,
  ) {
    setStatus(TalkStatus(text = text, state = state, awaitingAgent = awaitingAgent))
  }

  private fun setStatus(next: TalkStatus) {
    status.value = next
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
  private var relayStopNotification: ((() -> Boolean) -> Unit) = {}
  private val audioInputGeneration = AtomicLong(0L)

  @Volatile private var realtimeSessionId: String? = null
  private var realtimeRequestLease: GatewaySession.RequestLease? = null
  private var realtimeCaptureJob: Job? = null
  private var realtimeAppendJob: Job? = null
  private val realtimeCapturePauseLock = Any()
  internal val audioRetirement = AudioRetirement(scope)

  @Volatile private var realtimeCapturePause: RealtimeCapturePause? = null

  private val finishingPttLock = Any()

  @Volatile private var finishingPttCaptureId: String? = null

  @Volatile private var finishingPttJob: Job? = null

  private val realtimeAgentCoordinator =
    RealtimeAgentCoordinator(
      parentScope = scope,
      requestGateway = ::requestGateway,
      onWorking = { session ->
        synchronized(realtimeCapturePauseLock) {
          if (realtimeSessionId == session.relaySessionId) {
            setStatus(nativeText("Thinking…"), awaitingAgent = true)
          }
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

  @Volatile private var realtimeAudioInput: AndroidAudioInputSession? = null

  @Volatile private var localMediaPlaybackActive = false

  @Volatile private var realtimePlayoutSession: RealtimePlayout.Session? = null
  private val realtimePlayoutDelegate =
    lazy {
      RealtimePlayout(scope, realtimePlaybackDispatcher, realtimeSampleRateHz)
    }
  private val realtimePlayout by realtimePlayoutDelegate

  @Volatile private var pendingRealtimeOutputClear: CompletableDeferred<String?>? = null

  private data class RealtimeOutputTurn(
    val id: String?,
    val statusOwner: TalkStatusOwner,
  )

  @Volatile private var realtimeOutputTurn: RealtimeOutputTurn? = null
  private val realtimeOutputCancellationMutex = Mutex()

  @Volatile
  private var realtimeOutputSuppressed = false

  @Volatile
  private var playbackEnabled = true
  private val playbackGeneration = AtomicLong(0L)

  private enum class PlaybackPhase {
    Preparing,
    Playing,
  }

  private data class PlaybackLease(
    val token: Long,
    val job: Job,
    var phase: PlaybackPhase = PlaybackPhase.Preparing,
    var releaseAudioFocus: (() -> Unit)? = null,
  )

  private var localPlayback: PlaybackLease? = null
  private var realtimePlaying = false
  private val systemSpeech = SystemSpeechSpeaker(context)

  @Volatile private var finalizeInFlight = false
  private var listenWatchdogJob: Job? = null

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
  fun stopAllCapture(failure: NativeText? = null) {
    _isEnabled.value = false
    stop()
    failure?.let(::setTalkFailure)
  }

  /** Cancels work carrying voice/session data before a replacement gateway can connect. */
  fun onGatewayScopeChanging() {
    synchronized(realtimeCapturePauseLock) {
      gatewayGeneration.incrementAndGet()
      stopRealtimeRelay(closeSession = false)
    }
    realtimeAgentCoordinator.resetTransport()
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
        cancelActivePlayback()
        // Capture outside pauseLock: Gateway enqueue takes its lifecycle lock before this owner lock.
        val lease = session.captureRequestLease(gatewayStableId())
        val finishPause =
          synchronized(realtimeCapturePauseLock) {
            if (captureGeneration != startGeneration.get() || !canStartCapture()) {
              throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
            }
            pttTimeoutJob?.cancel()
            pttTimeoutJob = null
            pttAutoStopEnabled = false
            silenceJob?.cancel()
            silenceJob = null
            listeningMode = false
            _isListening.value = false
            finalizeInFlight = false
            stopRequested = false
            retireRecognizer()
            closePushToTalkRung()
            pttReleaseCompletion = null
            pttFinalSegments.clear()
            pttLivePartial = ""
            lastTranscript = ""
            lastHeardAtMs = null
            activePttCaptureId = captureId
            pttCompletion = completion
            prepareRealtimeCapturePause(captureId, lease)
          }
        try {
          // PTT owns the microphone until its turn finishes. Waiting here prevents
          // SpeechRecognizer from racing the realtime AudioRecord teardown.
          withContext(NonCancellable) {
            finishPause()
          }
          synchronized(realtimeCapturePauseLock) {
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
                it.setRecognitionListener(recognitionListener(captureId, it))
              }
            startPushToTalkRecognition(captureId)
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
          }
        } catch (err: Throwable) {
          if (clearPushToTalkRecognition(captureId) != null) {
            synchronized(realtimeCapturePauseLock) {
              if (captureGeneration == startGeneration.get()) {
                setStatus(if (_isEnabled.value) nativeText("Listening") else nativeText("Ready"))
              }
            }
            resumeRealtimeCaptureAfterPushToTalk(captureId)
          }
          completion?.cancel()
          throw err
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
      cancelActivePlayback()
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
    val notifyStopped = captureRelayStopNotification()
    val generation =
      synchronized(realtimeCapturePauseLock) {
        relayStopNotification = notifyStopped
        stopRequested = false
        listeningMode = true
        startGeneration.incrementAndGet()
      }
    Log.d(tag, "start")
    gatewayWorkScope.launch {
      try {
        audioRetirement.await()
        ensureConfigLoaded()
        if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) return@launch
        if (realtimeRelayModelSupported) {
          startRealtimeRelay(generation)
        } else {
          startNativeTalk(generation)
        }
      } catch (err: Throwable) {
        if (err is CancellationException) return@launch
        Log.w(tag, "start failed: ${err.message ?: err::class.simpleName}")
        disableRealtimeModeAndNotifyOwner(generation, nativeText("Start failed: \$message", err.message ?: err::class.simpleName.orEmpty()))
      }
    }
  }

  private fun stop() {
    val cancelled =
      synchronized(realtimeCapturePauseLock) {
        stopRequested = true
        finalizeInFlight = false
        listeningMode = false
        activePttCaptureId = null
        startGeneration.incrementAndGet()
        val jobs =
          listOfNotNull(
            synchronized(finishingPttLock) { finishingPttJob },
            pttCompletion,
            pttReleaseCompletion,
            pttTimeoutJob,
            restartJob,
            silenceJob,
            pendingFinal,
          )
        pttAutoStopEnabled = false
        pttCompletion = null
        pttReleaseCompletion = null
        pttTimeoutJob = null
        restartJob = null
        silenceJob = null
        closePushToTalkRung()
        pttFinalSegments.clear()
        pttLivePartial = ""
        lastTranscript = ""
        lastHeardAtMs = null
        _isListening.value = false
        _inputLevel.value = 0f
        setStatus(nativeText("Off"), state = TalkStatusState.Off)
        stopRealtimeRelay()
        pendingRunId = null
        pendingFinal = null
        synchronized(completedRunsLock) {
          completedRunStates.clear()
          completedRunTexts.clear()
        }
        retireRecognizer()
        jobs
      }
    // Completion handlers and SystemSpeech's beforeSpeak callback can reenter capture ownership.
    cancelled.forEach { it.cancel() }
    cancelActivePlayback()
    systemSpeech.shutdown()
  }

  private fun retireRecognizer() =
    synchronized(realtimeCapturePauseLock) {
      val retired = recognizer ?: return@synchronized
      recognizer = null
      val completion = CompletableDeferred<Unit>()
      audioRetirement.retire(cleanup = completion)
      val cleanup =
        Runnable {
          try {
            retired.cancel()
            retired.destroy()
            completion.complete(Unit)
          } catch (error: Exception) {
            completion.completeExceptionally(error)
          }
        }
      if (Looper.myLooper() == mainHandler.looper) {
        cleanup.run()
      } else if (!mainHandler.post(cleanup)) {
        completion.completeExceptionally(IllegalStateException("Speech recognizer cleanup unavailable"))
      }
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
      Log.w(tag, "realtime start: gateway not connected")
      disableRealtimeModeAndNotifyOwner(generation, nativeText("Gateway not connected"))
      return
    }

    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      Log.w(tag, "realtime start: microphone permission required")
      disableRealtimeModeAndNotifyOwner(generation, nativeText("Microphone permission required"))
      return
    }

    ensureConfigLoaded()
    cancelActivePlayback()
    synchronized(realtimeCapturePauseLock) {
      if (generation != startGeneration.get() || stopRequested) throw CancellationException("realtime talk stopped while connecting")
      if (activePttCaptureId == null) retireRecognizer()
    }
    audioRetirement.await()

    synchronized(realtimeCapturePauseLock) {
      if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) throw CancellationException("realtime talk stopped while connecting")
      setStatus(nativeText("Connecting…"), awaitingAgent = true)
    }
    val language = realtimeTranscriptionLanguage(resolvedSpeechLocaleTag())
    val lease = session.captureRequestLease(gatewayStableId()) ?: error("Gateway not connected")
    val transportGeneration = gatewayGeneration.get()
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
        lease.request("talk.session.create", params.toString(), timeoutMs = 15_000) { enqueue ->
          synchronized(realtimeCapturePauseLock) {
            if (generation != startGeneration.get() || transportGeneration != gatewayGeneration.get() || !_isEnabled.value || stopRequested) {
              throw CancellationException("realtime talk stopped while connecting")
            }
            enqueue()
          }
        }
      }
    val root = json.parseToJsonElement(payload).asObjectOrNull()
    val relaySession = root?.get("relaySessionId").asStringOrNull()
    val sessionId = relaySession ?: root?.get("sessionId").asStringOrNull()
    if (sessionId.isNullOrBlank()) {
      throw IllegalStateException("talk.session.create returned no session id")
    }
    val admitted =
      synchronized(realtimeCapturePauseLock) {
        if (generation != startGeneration.get() || transportGeneration != gatewayGeneration.get() || !lease.isCurrent() || !_isEnabled.value || stopRequested) {
          return@synchronized false
        }
        // Session publication and capture installation are one transition. PTT
        // therefore either blocks startup or detaches every installed capture job.
        realtimeAgentCoordinator.beginSession(
          RealtimeAgentSession(
            relaySessionId = sessionId,
            sessionKey = mainSessionKey.ifBlank { "main" },
          ),
        )
        realtimeSessionId = sessionId
        realtimeRequestLease = lease
        realtimePlayoutSession = createRealtimePlayoutSession(sessionId, lease)
        val pause = realtimeCapturePause
        if (pause != null) {
          realtimeCapturePause = pause.copy(sessionId = sessionId)
          realtimeOutputSuppressed = true
        } else {
          realtimeOutputSuppressed = false
          _isListening.value = true
          setStatus(nativeText("Listening"))
          startRealtimeCaptureLocked(sessionId)
        }
        true
      }
    if (!admitted) {
      // Stop never owned this session; the creator must close it even if its job was cancelled.
      withContext(NonCancellable) {
        runCatching { lease.request("talk.session.close", buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) }.toString()) }
      }
      throw CancellationException("realtime talk stopped while connecting")
    }
    Log.d(tag, "realtime session ready relaySessionId=$sessionId")
  }

  private suspend fun startNativeTalk(generation: Long) {
    if (!isConnected()) {
      disableRealtimeModeAndNotifyOwner(generation, nativeText("Gateway not connected"))
      return
    }
    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      disableRealtimeModeAndNotifyOwner(generation, nativeText("Microphone permission required"))
      return
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      disableRealtimeModeAndNotifyOwner(generation, nativeText("Speech recognizer unavailable"))
      return
    }
    synchronized(realtimeCapturePauseLock) {
      if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) return
      retireRecognizer()
    }
    audioRetirement.await()
    withContext(Dispatchers.Main) {
      synchronized(realtimeCapturePauseLock) {
        if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) return@withContext
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(recognitionListener(null, it)) }
        startListeningInternal(markListening = true)
      }
    }
  }

  private fun disableRealtimeModeAndNotifyOwner(
    generation: Long,
    status: NativeText,
  ) {
    val stopped =
      synchronized(realtimeCapturePauseLock) {
        if (generation != startGeneration.get()) return
        setStatus(status)
        stopRealtimeRelay(closeSession = false, preserveStatus = true)
        disableRealtimeModeLocked()
      }
    stopped?.invoke()
  }

  /** Returned claim is checked by the outer capture owner under its own lock. */
  private fun disableRealtimeModeLocked(): (() -> Unit)? {
    if (!_isEnabled.value) return null
    _isEnabled.value = false
    _isListening.value = false
    val generation = startGeneration.get()
    val notify = relayStopNotification
    return { notify { synchronized(realtimeCapturePauseLock) { startGeneration.get() == generation && !_isEnabled.value } } }
  }

  private fun failRealtimeRelay(
    sessionId: String,
    message: String,
    owner: RealtimePlayout.Session? = null,
    inputGeneration: Long? = null,
  ) {
    val stopped =
      synchronized(realtimeCapturePauseLock) {
        if (realtimeSessionId != sessionId ||
          (owner != null && realtimePlayoutSession !== owner) ||
          (inputGeneration != null && audioInputGeneration.get() != inputGeneration)
        ) {
          return
        }
        setTalkFailure(nativeText("Talk failed: \$message", message))
        stopRealtimeRelay(preserveStatus = true)
        disableRealtimeModeLocked()
      }
    stopped?.invoke()
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

  /** Caller holds [realtimeCapturePauseLock] so PTT cannot miss newly installed jobs. */
  @SuppressLint("MissingPermission")
  private fun startRealtimeCaptureLocked(sessionId: String) {
    val lease = realtimeRequestLease
    audioRetirement.retire(realtimeCaptureJob, realtimeAudioInput)
    realtimeAudioInput = null
    realtimeAppendJob?.cancel()
    val inputGeneration = audioInputGeneration.incrementAndGet()
    onAppliedAudioInputChanged(null)
    val audioFrames =
      Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    realtimeAppendJob =
      gatewayWorkScope.launch(realtimeCaptureDispatcher) {
        for (frame in audioFrames) {
          if (realtimeSessionId != sessionId || audioInputGeneration.get() != inputGeneration) continue
          if (!shouldAppendRealtimeCapturedFrame(frame.size)) continue
          val audioBase64 = Base64.encodeToString(frame, Base64.NO_WRAP)
          val params =
            buildJsonObject {
              put("sessionId", JsonPrimitive(sessionId))
              put("audioBase64", JsonPrimitive(audioBase64))
              put("timestamp", JsonPrimitive(SystemClock.elapsedRealtime()))
            }
          try {
            session.sendRequestFrameForEndpoint(
              lease?.endpointStableId,
              "talk.session.appendAudio",
              params.toString(),
              timeoutMs = 8_000,
              withEnqueue = { enqueue ->
                // Cancellation can claim capture while this frame waits for the socket.
                synchronized(realtimeCapturePauseLock) {
                  if (realtimeSessionId != sessionId || audioInputGeneration.get() != inputGeneration || !shouldAppendRealtimeCapturedFrame(frame.size)) {
                    throw CancellationException("realtime audio frame superseded")
                  }
                  check(lease?.isCurrent() == true) { "realtime audio connection changed" }
                  enqueue()
                }
              },
            ) { error ->
              Log.w(tag, "realtime appendAudio failed: ${error.message}")
              failRealtimeRelay(sessionId, error.message, inputGeneration = inputGeneration)
            }
          } catch (_: CancellationException) {
            // A rejected frame does not end capture; actual job cancellation does.
            currentCoroutineContext().ensureActive()
          } catch (err: Throwable) {
            Log.w(tag, "realtime appendAudio failed: ${err.message ?: err::class.simpleName}")
            failRealtimeRelay(sessionId, err.message ?: err::class.simpleName ?: "request failed", inputGeneration = inputGeneration)
          }
        }
      }
    realtimeCaptureJob =
      gatewayWorkScope.launch(realtimeCaptureDispatcher) {
        var audioInput: AndroidAudioInputSession? = null
        val captureJob = coroutineContext[Job]
        val isCurrent = { captureJob?.isActive == true && audioInputGeneration.get() == inputGeneration && realtimeSessionId == sessionId }
        try {
          audioRetirement.await()
          val frameBytes = realtimeSampleRateHz * 2 * realtimeAudioFrameMs / 1000
          val openedAudioInput =
            AndroidAudioInputSession.open(
              context,
              realtimeSampleRateHz,
              frameBytes,
              preferredAudioInputDevice(),
              { key ->
                if (isCurrent()) onAppliedAudioInputChanged(key)
              },
              communication = true,
              isCurrent = isCurrent,
              onFocusLost = { failRealtimeRelay(sessionId, "audio focus lost", inputGeneration = inputGeneration) },
            )
          audioInput = openedAudioInput
          synchronized(realtimeCapturePauseLock) {
            if (!isCurrent()) return@launch
            realtimeAudioInput = openedAudioInput
          }
          val buffer = ByteArray(frameBytes)
          audioInput.startRecording()
          while (isCurrent() && _isEnabled.value) {
            val read = audioInput.read(buffer, 0, buffer.size)
            if (read <= 0) continue
            _inputLevel.value = TalkAudioLevel.smoothed(_inputLevel.value, TalkAudioLevel.pcm16Level(buffer, read))
            if (!shouldAppendRealtimeCapturedFrame(read)) continue
            audioFrames.trySend(buffer.copyOf(read))
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          Log.w(tag, "realtime capture failed: ${err.message ?: err::class.simpleName}")
          failRealtimeRelay(sessionId, err.message ?: err::class.simpleName ?: "capture failed", inputGeneration = inputGeneration)
        } finally {
          audioFrames.close()
          synchronized(realtimeCapturePauseLock) {
            if (realtimeAudioInput === audioInput) realtimeAudioInput = null
          }
          audioInput?.close()
          if (audioInputGeneration.get() == inputGeneration) _inputLevel.value = 0f
        }
      }
  }

  private fun shouldAppendRealtimeCapturedFrame(length: Int): Boolean =
    length > 0 &&
      pendingRealtimeOutputClear == null &&
      realtimeCapturePause == null &&
      !localMediaPlaybackActive &&
      (!realtimePlayoutDelegate.isInitialized() || !realtimePlayout.isPlaying || realtimeAudioInput?.canCaptureDuringPlayback == true)

  // Playback retains the response that admitted it, even after newer work starts.
  private fun realtimeOutputStatusOwner(turnId: String?): TalkStatusOwner {
    val output = realtimeOutputTurn
    // Consult work has no provider response yet. Only subsequent output may adopt it;
    // a terminal event or a previously queued playback callback cannot finish it.
    val awaitingOutput = currentStatus.awaitingAgent && currentStatus.owner.responseTurnId == null
    if (!turnId.isNullOrBlank() && output?.id == turnId && !awaitingOutput) return output.statusOwner
    return currentStatus.owner.also { realtimeOutputTurn = RealtimeOutputTurn(turnId, it) }
  }

  private fun handleRealtimeTalkEvent(payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val sessionId = obj["relaySessionId"].asStringOrNull() ?: obj["sessionId"].asStringOrNull()
    var stopped: (() -> Unit)? = null
    var afterDispatch: (() -> Unit)? = null
    synchronized(realtimeCapturePauseLock) {
      val currentSessionId = realtimeSessionId
      if (currentSessionId == null || sessionId != currentSessionId) return
      val owner = realtimePlayoutSession
      val turnId = obj["talkEvent"].asObjectOrNull()?.get("turnId").asStringOrNull()
      when (val type = obj["type"].asStringOrNull()) {
        "ready" -> {
          if (isRealtimeCapturePaused()) return
          _isListening.value = true
          setStatus(nativeText("Listening"))
        }

        "inputAudio" -> {
          if (realtimeCapturePause != null) return
          // Output remains suppressed through the cancelled pre-PTT turn. The
          // first accepted resumed frame establishes the next provider turn.
          realtimeOutputSuppressed = false
          _isListening.value = true
        }

        "responseStarted" -> {
          val responseTurnId = obj["turnId"].asStringOrNull()?.takeIf(String::isNotBlank) ?: return
          if (realtimeOutputSuppressed || realtimeOutputTurn?.id == responseTurnId) return
          setStatus(TalkStatus(nativeText("Thinking…"), TalkStatusState.Active, awaitingAgent = true, owner = TalkStatusOwner(responseTurnId)))
          realtimeOutputStatusOwner(responseTurnId)
        }

        "audio" -> {
          if (realtimeOutputSuppressed) return
          if (turnId.isNullOrBlank()) return
          val statusOwner = realtimeOutputStatusOwner(turnId)
          finishRealtimeConversationEntry(VoiceConversationRole.User)
          val audioBase64 = obj["audioBase64"].asStringOrNull() ?: return
          val bytes =
            try {
              Base64.decode(audioBase64, Base64.DEFAULT)
            } catch (err: Throwable) {
              Log.w(tag, "realtime audio decode failed: ${err.message ?: err::class.simpleName}")
              return
            }
          if (playbackEnabled) afterDispatch = owner?.let { realtimePlayout.audio(it, bytes, statusOwner) }
        }

        "audioDone" -> {
          val output = realtimeOutputTurn?.takeIf { !turnId.isNullOrBlank() && it.id == turnId } ?: return
          // Empty responses settle too; queued PCM still owns its physical drain.
          afterDispatch = owner?.let { realtimePlayout.refreshState(it, output.statusOwner) }
        }

        "clear" -> {
          val cancelsTurn = obj["talkEvent"].asObjectOrNull()?.get("type").asStringOrNull() == "turn.cancelled"
          val activeTurnId = realtimeOutputTurn?.id
          if (cancelsTurn && !turnId.isNullOrBlank() && activeTurnId != null && turnId != activeTurnId) return
          // Provider clears flush the sink; only turn.cancelled acknowledges cancellation.
          val pending = pendingRealtimeOutputClear.takeIf { cancelsTurn && !turnId.isNullOrBlank() }
          val cleared = stopRealtimePlayback(owner)
          afterDispatch = {
            cleared.invokeOnCompletion { error -> pending?.complete(if (error == null) turnId else null) }
          }
        }

        "mark" -> {
          val markName = obj["markName"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return
          afterDispatch = owner?.let { realtimePlayout.mark(it, markName) }
        }

        "transcript" -> {
          val role = obj["role"].asStringOrNull()
          val isFinal = obj["final"].asBooleanOrNull() == true
          val statusOwner = if (role == "assistant") realtimeOutputStatusOwner(turnId) else currentStatus.owner
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
          if (isFinal && role == "assistant") {
            // Final text can precede audio; refresh after queued playback without closing the turn.
            afterDispatch = owner?.let { realtimePlayout.refreshState(it, statusOwner) }
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

        "toolResult" -> {
          Unit
        }

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
            setStatus(closeStatus)
            stopped = disableRealtimeModeLocked()
          }
        }

        else -> {
          if (type != null) Log.d(tag, "ignored realtime event type=$type")
        }
      }
    }
    afterDispatch?.invoke()
    stopped?.invoke()
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

  private fun createRealtimePlayoutSession(
    sessionId: String,
    lease: GatewaySession.RequestLease,
  ): RealtimePlayout.Session {
    val generation = gatewayGeneration.get()
    val workScope = gatewayWorkScope
    lateinit var owner: RealtimePlayout.Session

    fun isCurrent() = realtimePlayoutSession === owner && realtimeSessionId == sessionId && gatewayGeneration.get() == generation
    owner =
      RealtimePlayout.Session(
        onState = { playing, level, statusOwner ->
          synchronized(realtimeCapturePauseLock) {
            if (isCurrent()) {
              setRealtimePlaying(playing)
              _outputLevel.value = level
              // Device completion is physical; it cannot finish a newer user request's status.
              status.update { current ->
                if (_isEnabled.value && current.owner === statusOwner) {
                  current.copy(text = if (playing) nativeText("Speaking…") else nativeText("Listening"), state = TalkStatusState.Active, awaitingAgent = false)
                } else {
                  current
                }
              }
            }
          }
        },
        onMark = { markName ->
          workScope.launch {
            try {
              if (isCurrent() && owner.active) {
                val acknowledge = realtimeMarkAcknowledger
                if (acknowledge != null) {
                  acknowledge(sessionId, markName)
                } else {
                  val params =
                    buildJsonObject {
                      put("sessionId", JsonPrimitive(sessionId))
                      put("markName", JsonPrimitive(markName))
                    }
                  // The lease binds the physical socket; the enqueue check binds its live relay.
                  lease.request("talk.session.acknowledgeMark", params.toString(), 8_000) { enqueue ->
                    synchronized(realtimeCapturePauseLock) {
                      if (!isCurrent() || !owner.active) throw CancellationException("realtime session replaced")
                      enqueue()
                    }
                  }
                }
              }
            } catch (error: Throwable) {
              if (error is CancellationException) throw error
              Log.d(tag, "realtime mark acknowledgement ignored: ${error.message ?: error::class.simpleName}")
            }
          }
        },
        onFailure = { message -> failRealtimeRelay(sessionId, message, owner) },
      )
    return owner
  }

  private fun stopRealtimePlayback(owner: RealtimePlayout.Session? = realtimePlayoutSession): Deferred<Unit> =
    synchronized(realtimeCapturePauseLock) {
      audioRetirement.retire(cleanup = owner?.takeIf { realtimePlayoutDelegate.isInitialized() }?.let { realtimePlayout.clear(it) })
    }

  private fun stopRealtimeRelay(
    closeSession: Boolean = true,
    preserveStatus: Boolean = false,
  ) = synchronized(realtimeCapturePauseLock) {
    val status = currentStatus
    val sessionId = realtimeSessionId
    realtimeSessionId = null
    realtimeRequestLease = null
    audioInputGeneration.incrementAndGet()
    onAppliedAudioInputChanged(null)
    val cleared =
      realtimePlayoutSession?.let {
        it.active = false
        if (realtimePlayoutDelegate.isInitialized()) realtimePlayout.clear(it, acknowledge = false) else null
      }
    audioRetirement.retire(realtimeCaptureJob, realtimeAudioInput, cleared)
    realtimeAudioInput = null
    realtimePlayoutSession = null
    realtimeCaptureJob = null
    realtimeAppendJob?.cancel()
    realtimeAppendJob = null
    realtimeCapturePause = null
    realtimeOutputSuppressed = false
    realtimeOutputTurn = null
    pendingRealtimeOutputClear?.cancel()
    pendingRealtimeOutputClear = null
    realtimeAgentCoordinator.endSession(sessionId)
    realtimeUserEntryId = null
    realtimeUserEntryAwaitingFinal = false
    realtimeUserEntryAwaitingFinalStartedAtMs = null
    realtimeAssistantEntryId = null
    _speechActive.value = false
    _inputLevel.value = 0f
    setRealtimePlaying(false)
    _outputLevel.value = null
    if (preserveStatus) setStatus(status)
    _isListening.value = false
    if (closeSession && !sessionId.isNullOrBlank()) {
      gatewayWorkScope.launch { closeRealtimeSession(sessionId) }
    }
  }

  internal fun prepareRealtimeCapturePause(
    captureId: String,
    lease: GatewaySession.RequestLease?,
  ): suspend () -> Unit {
    val pause: RealtimeCapturePause
    val cancellationTurnId: String?
    val retirement: Deferred<Unit>
    val appendJob =
      synchronized(realtimeCapturePauseLock) {
        pause = RealtimeCapturePause(sessionId = realtimeSessionId, pttCaptureId = captureId)
        cancellationTurnId = realtimeOutputTurn?.id
        realtimeCapturePause = pause
        audioInputGeneration.incrementAndGet()
        onAppliedAudioInputChanged(null)
        realtimeOutputSuppressed = true
        stopRealtimePlayback()
        retirement = audioRetirement.retire(realtimeCaptureJob, realtimeAudioInput)
        realtimeAudioInput = null
        realtimeCaptureJob = null
        realtimeAppendJob.also { realtimeAppendJob = null }
      }
    return {
      audioRetirement.await(retirement)
      appendJob?.cancelAndJoin()
      // Stop input first so no frame can create new provider output while the
      // cancellation boundary is being established.
      if (
        !cancelRealtimeOutput(
          reason = "android-push-to-talk",
          sessionId = pause.sessionId,
          turnId = cancellationTurnId,
          lease = lease,
          isCurrent = { realtimeCapturePause === pause },
        )
      ) {
        synchronized(realtimeCapturePauseLock) {
          // Cancellation can finish after Off/On has admitted a replacement relay.
          if (realtimeCapturePause !== pause) return@synchronized
          Log.w(tag, "realtime output cancellation was not confirmed; closing relay")
          stopRealtimeRelay(preserveStatus = true)
          realtimeCapturePause = pause.copy(sessionId = null, restartRelay = true)
          realtimeOutputSuppressed = true
        }
      }
    }
  }

  private fun isRealtimeCapturePaused(): Boolean = synchronized(realtimeCapturePauseLock) { realtimeCapturePause != null }

  internal fun resumeRealtimeCaptureAfterPushToTalk(captureId: String) {
    val generation = startGeneration.get()
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
        startRealtimeCaptureLocked(sessionId)
        RealtimeCaptureResume.Resumed
      }
    when (outcome) {
      RealtimeCaptureResume.Skipped -> {
        return
      }

      RealtimeCaptureResume.Resumed -> {
        return
      }

      RealtimeCaptureResume.Restart -> {
        start()
      }

      RealtimeCaptureResume.Disconnected -> {
        disableRealtimeModeAndNotifyOwner(generation, nativeText("Gateway not connected"))
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
  ) = synchronized(realtimeCapturePauseLock) {
    if (activePttCaptureId != captureId || pttReleaseCompletion != null || stopRequested) return@synchronized
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
        return@synchronized
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
          synchronized(realtimeCapturePauseLock) {
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
  }

  private fun closePushToTalkRung() =
    synchronized(realtimeCapturePauseLock) {
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
        cancelActivePlayback()
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
    // Do not start synthesis while native recognition is still queued for teardown on Main.
    retireRecognizer()
    audioRetirement.await()

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
    val (cleared, release) =
      synchronized(realtimeCapturePauseLock) {
        if (activePttCaptureId != captureId) return null
        val transcript = PushToTalkTranscriptMerger.merge(pttFinalSegments, pttLivePartial)
        val completion = pttCompletion
        pttTimeoutJob?.cancel()
        pttTimeoutJob = null
        pttAutoStopEnabled = false
        pttCompletion = null
        val release = pttReleaseCompletion
        pttReleaseCompletion = null
        activePttCaptureId = null
        _isListening.value = false
        listeningMode = false
        clearListenWatchdog()
        retireRecognizer()
        closePushToTalkRung()
        pttFinalSegments.clear()
        pttLivePartial = ""
        lastTranscript = ""
        lastHeardAtMs = null
        _inputLevel.value = 0f
        ClearedPushToTalkCapture(transcript = transcript, completion = completion) to release
      }
    release?.cancel()
    return cleared
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
      try {
        lease.releaseAudioFocus?.invoke()
      } finally {
        if (shouldResumeAfterSpeak) {
          withContext(NonCancellable) {
            onAfterSpeak()
          }
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

  // Called under playbackLock; the capture gate reads the same local playback fact.
  // Either source can keep speaking after the other source completes or is cancelled.
  private fun publishSpeakingState() {
    localMediaPlaybackActive = localPlayback?.phase == PlaybackPhase.Playing
    _isSpeaking.value = realtimePlaying || localMediaPlaybackActive
  }

  private fun markAudioPlaybackStarting(playbackToken: Long) {
    synchronized(playbackLock) {
      ensurePlaybackActive(playbackToken)
      val lease = localPlayback
      if (lease?.token != playbackToken || !lease.job.isActive) throw CancellationException("assistant speech cancelled")
      lease.phase = PlaybackPhase.Playing
      publishSpeakingState()
      setStatus(nativeText("Speaking…"))
      requestAudioFocusForTts(lease)
    }
    ensureInterruptListener()
  }

  fun stopTts() {
    val lease = session.captureRequestLease(gatewayStableId())
    synchronized(realtimeCapturePauseLock) {
      val sessionId = realtimeSessionId
      val output = realtimeOutputTurn
      realtimeOutputSuppressed = true
      stopRealtimePlayback()
      setStatus(currentStatus.copy(text = nativeText("Listening"), state = TalkStatusState.Active, awaitingAgent = false))
      if (sessionId != null && output?.id != null) {
        scope.launch {
          cancelRealtimeOutput(
            reason = "android-stop-tts",
            sessionId = sessionId,
            turnId = output.id,
            lease = lease,
            isCurrent = { realtimeSessionId == sessionId && realtimeOutputTurn === output },
          )
        }
      }
    }
    cancelActivePlayback()
  }

  private suspend fun cancelRealtimeOutput(
    reason: String,
    sessionId: String?,
    turnId: String?,
    lease: GatewaySession.RequestLease?,
    isCurrent: () -> Boolean,
  ): Boolean =
    realtimeOutputCancellationMutex.withLock {
      sessionId ?: return@withLock true
      turnId ?: return@withLock false
      lease ?: return@withLock false
      val clear = CompletableDeferred<String?>()
      synchronized(realtimeCapturePauseLock) {
        if (!isCurrent() || !lease.isCurrent()) return@withLock false
        pendingRealtimeOutputClear = clear
      }
      try {
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(sessionId))
            put("reason", JsonPrimitive(reason))
            put("turnId", JsonPrimitive(turnId))
          }
        val response =
          lease.request("talk.session.cancelOutput", params.toString(), timeoutMs = 5_000) { enqueue ->
            synchronized(realtimeCapturePauseLock) {
              if (!isCurrent()) throw CancellationException("realtime output owner replaced")
              enqueue()
            }
          }
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
        synchronized(realtimeCapturePauseLock) {
          if (pendingRealtimeOutputClear === clear) pendingRealtimeOutputClear = null
        }
      }
    }

  internal fun shouldAllowSpeechInterrupt(): Boolean = !finalizeInFlight && !isRealtimeCapturePaused()

  private fun clearListenWatchdog() {
    listenWatchdogJob?.cancel()
    listenWatchdogJob = null
  }

  private fun requestAudioFocusForTts(lease: PlaybackLease) {
    if (realtimeAudioInput != null) return
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val req =
      AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(
          AudioAttributes
            .Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        ).setOnAudioFocusChangeListener { change ->
          if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            lease.job.cancel(CancellationException("audio focus lost"))
          }
        }.build()
    // Android keys focus by listener identity. Old cleanup and callbacks must
    // retain this playback's request rather than touching its replacement.
    lease.releaseAudioFocus = { am.abandonAudioFocusRequest(req) }
    val result = am.requestAudioFocus(req)
    Log.d(tag, "audio focus request result=$result")
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
      synchronized(realtimeCapturePauseLock) {
        // Recheck after dispatch so a listener queued before PTT cannot reclaim
        // the microphone while the full PTT turn still owns it.
        if (stopRequested || !shouldAllowSpeechInterrupt()) return@post
        if (!SpeechRecognizer.isRecognitionAvailable(context)) return@post
        try {
          if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(recognitionListener(null, it)) }
          }
          recognizer?.cancel()
          startListeningInternal(markListening = false)
        } catch (_: Throwable) {
          // ignore
        }
      }
    }
  }

  private fun recognitionListener(
    captureId: String?,
    owner: SpeechRecognizer,
  ): RecognitionListener =
    object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) =
        withCurrentRecognition(owner, captureId) {
          // Only a live listening session may claim the status; a speech-interrupt
          // recognizer readying during playback must not touch Thinking state.
          if (activePttCaptureId != null && _isListening.value) {
            setStatus(nativeText("Listening (PTT)"))
          } else if (_isEnabled.value && _isListening.value) {
            setStatus(nativeText("Listening"))
          }
        }

      override fun onBeginningOfSpeech() {}

      override fun onRmsChanged(rmsdB: Float) =
        withCurrentRecognition(owner, captureId) {
          if (activePttCaptureId != null && pttRecognitionRung !is PushToTalkRecognitionRung.RawAudioSegmented) {
            _inputLevel.value = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
          }
        }

      override fun onBufferReceived(buffer: ByteArray?) {}

      override fun onEndOfSpeech() =
        withCurrentRecognition(owner, captureId) {
          clearListenWatchdog()
          _inputLevel.value = 0f
          if (activePttCaptureId != null) return@withCurrentRecognition
          // Don't restart while a transcript is being processed — the recognizer
          // competing for audio resources kills AudioTrack PCM playback.
          if (!finalizeInFlight) {
            scheduleRestart()
          }
        }

      override fun onError(error: Int) =
        withCurrentRecognition(owner, captureId) {
          if (stopRequested) return@withCurrentRecognition
          _isListening.value = false
          _inputLevel.value = 0f
          val pushToTalkActive = activePttCaptureId != null
          if (pushToTalkActive) {
            pttReleaseCompletion?.let {
              it.complete(Unit)
              return@withCurrentRecognition
            }
          }
          if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
            setStatus(nativeText("Microphone permission required"))
            return@withCurrentRecognition
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
            return@withCurrentRecognition
          }
          scheduleRestart(delayMs = 600)
        }

      override fun onResults(results: Bundle?) =
        withCurrentRecognition(owner, captureId) {
          val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
          list.firstOrNull()?.let { handleTranscript(it, isFinal = true) }
          if (activePttCaptureId != null) {
            _isListening.value = false
            _inputLevel.value = 0f
            pttReleaseCompletion?.let {
              it.complete(Unit)
              return@withCurrentRecognition
            }
            schedulePushToTalkRestart(
              delayMs = pushToTalkRestartDelayMs,
              advanceRung = pttRecognitionRung !is PushToTalkRecognitionRung.RestartingSingleSession,
            )
            return@withCurrentRecognition
          }
          scheduleRestart()
        }

      override fun onPartialResults(partialResults: Bundle?) =
        withCurrentRecognition(owner, captureId) {
          val list = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
          list.firstOrNull()?.let { handleTranscript(it, isFinal = false) }
        }

      override fun onSegmentResults(segmentResults: Bundle) =
        withCurrentRecognition(owner, captureId) {
          if (activePttCaptureId == null) return@withCurrentRecognition
          val list = segmentResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
          list.firstOrNull()?.let { handleTranscript(it, isFinal = true) }
        }

      override fun onEndOfSegmentedSession() =
        withCurrentRecognition(owner, captureId) {
          if (activePttCaptureId == null) return@withCurrentRecognition
          _isListening.value = false
          _inputLevel.value = 0f
          pttReleaseCompletion?.let {
            it.complete(Unit)
            return@withCurrentRecognition
          }
          schedulePushToTalkRestart(
            delayMs = 180L,
            advanceRung = shouldAdvancePushToTalkRungAfterSegmentedSession(pttRecognitionRung?.candidate ?: return@withCurrentRecognition),
          )
        }

      override fun onEvent(
        eventType: Int,
        params: Bundle?,
      ) {}
    }

  // A destroyed recognizer can still deliver queued callbacks, including continuous Talk's null PTT id.
  private inline fun withCurrentRecognition(
    owner: SpeechRecognizer,
    captureId: String?,
    action: () -> Unit,
  ) {
    // SDK recognition callbacks and SystemSpeechSpeaker.beforeSpeak both run on Main; keep that ordering.
    synchronized(realtimeCapturePauseLock) {
      if (recognizer !== owner || captureId != activePttCaptureId) return
      action()
    }
  }
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
