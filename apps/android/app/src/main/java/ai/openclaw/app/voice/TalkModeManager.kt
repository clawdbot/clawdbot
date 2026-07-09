package ai.openclaw.app.voice

import ai.openclaw.app.gateway.ChatSendAck
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.chatSendAckHistorySinceSeconds
import ai.openclaw.app.gateway.parseChatSendAck
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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

internal data class RealtimeToolRun(
  val callId: String,
  val relaySessionId: String,
)

private const val REALTIME_AGENT_CONSULT_TOOL = "openclaw_agent_consult"
private const val REALTIME_AGENT_CONTROL_TOOL = "openclaw_agent_control"

private data class RealtimeToolCompletion(
  val state: String,
  val messageEl: JsonElement?,
)

private data class RealtimeToolCompletionDispatch(
  val toolRun: RealtimeToolRun,
  val state: String,
  val messageEl: JsonElement?,
)

private sealed interface RealtimeToolRegistration {
  data object SessionEnded : RealtimeToolRegistration

  data object AwaitingCompletion : RealtimeToolRegistration

  data class Completed(
    val dispatch: RealtimeToolCompletionDispatch,
  ) : RealtimeToolRegistration
}

private sealed interface RealtimeToolCompletionDecision {
  data object NotHandled : RealtimeToolCompletionDecision

  data object Consumed : RealtimeToolCompletionDecision

  data class Dispatch(
    val completion: RealtimeToolCompletionDispatch,
  ) : RealtimeToolCompletionDecision
}

class TalkModeManager internal constructor(
  private val context: Context,
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val isConnected: () -> Boolean,
  private val gatewayStableId: () -> String? = { null },
  private val onBeforeSpeak: suspend () -> Unit = {},
  private val onAfterSpeak: suspend () -> Unit = {},
  private val onStoppedByRelay: () -> Unit = {},
  private val talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(session = session),
  private val talkAudioPlayer: TalkAudioPlaying = TalkAudioPlayer(context),
  private val realtimeCaptureDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  companion object {
    private const val tag = "TalkMode"
    private const val realtimeSampleRateHz = 24_000
    private const val realtimeAudioFrameMs = 100
    private const val chatFinalWaitMs = 45_000L
    private const val maxCachedRunCompletions = 128
    private const val maxConversationEntries = 40
    private const val realtimePlaybackBufferMs = 240
    private const val realtimeUserFinalRewriteGraceMs = 1_500L
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

  private val _statusText = MutableStateFlow("Off")
  val statusText: StateFlow<String> = _statusText

  // Typed "waiting on the agent" signal for the waveform's Thinking phase, so
  // UI never has to parse status strings. Every status change flows through
  // setStatus; forgetting the flag fails safe (wave shows Listening/Idle).
  private val _awaitingAgent = MutableStateFlow(false)
  val awaitingAgent: StateFlow<Boolean> = _awaitingAgent

  private fun setStatus(
    text: String,
    awaitingAgent: Boolean = false,
  ) {
    _statusText.value = text
    _awaitingAgent.value = awaitingAgent
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

  @Volatile private var pendingRunId: String? = null
  private var pendingFinal: CompletableDeferred<Boolean>? = null
  private val completedRunsLock = Any()
  private val completedRunStates = LinkedHashMap<String, Boolean>()
  private val completedRunTexts = LinkedHashMap<String, String>()
  private var configLoaded = false
  private val startGeneration = AtomicLong(0L)

  @Volatile private var realtimeSessionId: String? = null
  private var realtimeCaptureJob: Job? = null
  private var realtimeAppendJob: Job? = null
  private val realtimeCapturePauseLock = Any()
  private var realtimeCapturePause: RealtimeCapturePause? = null

  private val finishingPttLock = Any()

  @Volatile private var finishingPttCaptureId: String? = null

  @Volatile private var finishingPttJob: Job? = null

  // Realtime tool calls can complete before their chat final arrives; cache by call/run id until both sides meet.
  private val realtimeToolLock = Any()
  private val realtimeToolRuns = LinkedHashMap<String, RealtimeToolRun>()
  private val pendingRealtimeToolCalls = LinkedHashSet<String>()
  private val pendingRealtimeToolCompletions = LinkedHashMap<String, RealtimeToolCompletion>()
  private var realtimeUserEntryId: String? = null
  private var realtimeUserEntryAwaitingFinal = false
  private var realtimeUserEntryAwaitingFinalStartedAtMs: Long? = null
  private var realtimeAssistantEntryId: String? = null
  private val realtimePlaybackLock = Any()
  private var realtimeAudioTrack: AudioTrack? = null
  private var realtimeAudioQueue: Channel<ByteArray>? = null
  private var realtimeAudioWriterJob: Job? = null
  private var realtimePlaybackIdleJob: Job? = null

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
    gatewayGeneration.incrementAndGet()
    gatewayWorkJob.cancel()
    gatewayWorkJob = SupervisorJob()
    gatewayWorkScope = CoroutineScope(scope.coroutineContext + gatewayWorkJob)
    _conversation.value = emptyList()
    _lastAssistantText.value = null
    configLoaded = false
    silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
    interruptOnSpeech = false
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
      return PushToTalkStartResult.Existing(TalkPttStartPayload(captureId = it))
    }
    finishingPttCaptureId?.let {
      throw IllegalStateException("PTT_BUSY: previous push-to-talk turn is still finishing")
    }
    if (!isConnected()) {
      setStatus("Gateway not connected")
      throw IllegalStateException("UNAVAILABLE: Gateway not connected")
    }

    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      setStatus("Microphone permission required")
      throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      setStatus("Speech recognizer unavailable")
      throw IllegalStateException("UNAVAILABLE: Speech recognizer unavailable")
    }

    val captureId = UUID.randomUUID().toString()
    val captureGeneration = startGeneration.get()
    return try {
      withContext(Dispatchers.Main) {
        activePttCaptureId?.let {
          return@withContext PushToTalkStartResult.Existing(TalkPttStartPayload(captureId = it))
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
          recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
          startListeningInternal(markListening = true)
        } catch (err: Throwable) {
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
          setStatus(if (_isEnabled.value) "Listening" else "Ready")
          throw err
        }
        setStatus("Listening (PTT)")
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
    withContext(Dispatchers.Main) {
      val cleared =
        clearPushToTalkRecognition(captureId)
          ?: return@withContext TalkPttStopPayload(captureId = captureId, transcript = null, status = "idle")
      val transcript = cleared.transcript

      if (transcript.isEmpty()) {
        setStatus(if (_isEnabled.value) "Listening" else "Ready")
        resumeRealtimeCaptureAfterPushToTalk(captureId)
        return@withContext finishPushToTalk(
          TalkPttStopPayload(captureId = captureId, transcript = null, status = "empty"),
          cleared.completion,
        )
      }

      if (!isConnected()) {
        setStatus("Gateway not connected")
        resumeRealtimeCaptureAfterPushToTalk(captureId)
        return@withContext finishPushToTalk(
          TalkPttStopPayload(captureId = captureId, transcript = transcript, status = "offline"),
          cleared.completion,
        )
      }

      setStatus("Thinking…", awaitingAgent = true)
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
      // case its finally block never runs. Completion still releases ownership.
      finishingJob.invokeOnCompletion { clearFinishingPushToTalk(captureId, finishingJob) }
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
      setStatus(if (_isEnabled.value) "Listening" else "Ready")
      resumeRealtimeCaptureAfterPushToTalk(captureId)
      finishPushToTalk(
        TalkPttStopPayload(captureId = captureId, transcript = null, status = "cancelled"),
        cleared.completion,
      )
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

  /**
   * Speak a wake-word command through TalkMode's full pipeline:
   * chat.send → wait for final → read assistant text → TTS.
   * Calls [onComplete] when done so the caller can disable TalkMode and re-arm VoiceWake.
   */
  fun speakWakeCommand(
    command: String,
    onComplete: () -> Unit,
  ) {
    gatewayWorkScope.launch {
      try {
        reloadConfig()
        val startedAt = System.currentTimeMillis().toDouble() / 1000.0
        val prompt = buildPrompt(command)
        val ack = sendChat(prompt, session)
        val runId = ack.runId ?: throw IllegalStateException("chat.send returned no run id")
        if (ack.isTerminalFailure) {
          setStatus(if (ack.normalizedStatus == "error") "Chat error" else "Aborted")
          return@launch
        }
        val ok = if (ack.isTerminalSuccess) true else waitForChatFinal(runId)
        val assistant =
          consumeRunText(runId)
            ?: waitForAssistantText(
              session,
              chatSendAckHistorySinceSeconds(ack, startedAt),
              if (ok) 12_000 else 25_000,
            )
        if (!assistant.isNullOrBlank()) {
          val playbackToken = playbackGeneration.incrementAndGet()
          cancelActivePlayback()
          setStatus("Speaking…")
          runPlaybackSession(playbackToken) {
            playAssistant(assistant, playbackToken)
          }
        } else {
          setStatus("No reply")
        }
      } catch (err: Throwable) {
        Log.w(tag, "speakWakeCommand failed: ${err.message}")
      } finally {
        onComplete()
      }
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

    if (handleRealtimeToolCompletion(runId = runId, state = state, messageEl = obj["message"])) {
      return
    }

    // If this is a response we initiated, handle normally below.
    // Otherwise, if ttsOnAllResponses, finish streaming TTS on terminal events.
    val pending = pendingRunId
    val knownRun = pending == runId || hasRunCompletion(runId)
    if (!knownRun) {
      if (ttsOnAllResponses && state == "final") {
        val text = extractTextFromChatEventMessage(obj["message"])
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
      val text = extractTextFromChatEventMessage(obj["message"])
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
        startRealtimeRelay(generation)
      } catch (err: Throwable) {
        if (err is CancellationException) return@launch
        setStatus("Start failed: ${err.message ?: err::class.simpleName}")
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
    lastTranscript = ""
    lastHeardAtMs = null
    _isListening.value = false
    setStatus("Off")
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
        val status = _statusText.value
        if (!_isEnabled.value && status != "Off") {
          throw IllegalStateException(status)
        }
        delay(100L)
      }
      error("unreachable")
    }

  private suspend fun startRealtimeRelay(generation: Long) {
    if (!isConnected()) {
      setStatus("Gateway not connected")
      Log.w(tag, "realtime start: gateway not connected")
      disableRealtimeModeAndNotifyOwner()
      return
    }

    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      setStatus("Microphone permission required")
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

    setStatus("Connecting…", awaitingAgent = true)
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
        put("mode", JsonPrimitive("realtime"))
        put("transport", JsonPrimitive("gateway-relay"))
        put("brain", JsonPrimitive("agent-consult"))
      }
    val payload = requestGateway("talk.session.create", params.toString(), timeoutMs = 15_000)
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

    val capturePaused =
      synchronized(realtimeCapturePauseLock) {
        // Session publication and capture installation are one transition. PTT
        // therefore either blocks startup or detaches every installed capture job.
        realtimeSessionId = sessionId
        val pause = realtimeCapturePause
        if (pause != null) {
          realtimeCapturePause = pause.copy(sessionId = sessionId)
          realtimeOutputSuppressed = true
          true
        } else {
          realtimeOutputSuppressed = false
          _isListening.value = true
          setStatus("Listening")
          startRealtimeCaptureLocked(sessionId)
          false
        }
      }
    if (capturePaused) {
      Log.d(tag, "realtime session ready; capture paused for PTT relaySessionId=$sessionId")
      return
    }
    Log.d(tag, "realtime session started relaySessionId=$sessionId")
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
    setStatus("Talk failed: $message")
    stopRealtimeRelay(cancelCapture = false, cancelAppend = false, preserveStatus = true)
    disableRealtimeModeAndNotifyOwner()
  }

  private fun realtimeCloseStatusText(reason: String?): String =
    when (reason) {
      null, "completed" -> "Off"
      "error" -> "Talk failed: Realtime provider closed unexpectedly."
      else -> "Talk failed: Realtime provider closed: $reason"
    }

  /** Caller holds [realtimeCapturePauseLock] so PTT cannot miss newly installed jobs. */
  @SuppressLint("MissingPermission")
  private fun startRealtimeCaptureLocked(sessionId: String) {
    realtimeCaptureJob?.cancel()
    realtimeAppendJob?.cancel()
    val audioFrames =
      Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    realtimeAppendJob =
      gatewayWorkScope.launch(realtimeCaptureDispatcher) {
        for (frame in audioFrames) {
          if (realtimeSessionId != sessionId) continue
          if (isRealtimePlaybackActive()) continue
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
          val frameBytes = realtimeSampleRateHz * 2 * realtimeAudioFrameMs / 1000
          audioInput = AndroidAudioInputSession.open(context, realtimeSampleRateHz, frameBytes)
          val buffer = ByteArray(frameBytes)
          audioInput.startRecording()
          while (coroutineContext.isActive && _isEnabled.value && realtimeSessionId == sessionId) {
            val read = audioInput.read(buffer, 0, buffer.size)
            if (read <= 0) continue
            _inputLevel.value = TalkAudioLevel.smoothed(_inputLevel.value, TalkAudioLevel.pcm16Level(buffer, read))
            if (!shouldAppendRealtimeCapturedFrame(read)) continue
            audioFrames.trySend(buffer.copyOf(read))
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          Log.w(tag, "realtime capture failed: ${err.message ?: err::class.simpleName}")
          failRealtimeRelay(sessionId, err.message ?: err::class.simpleName ?: "capture failed")
        } finally {
          audioFrames.close()
          audioInput?.close()
          _inputLevel.value = 0f
        }
      }
  }

  private fun shouldAppendRealtimeCapturedFrame(length: Int): Boolean = !isRealtimePlaybackActive() && length > 0

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
        setStatus("Listening")
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
      "clear" -> {
        stopRealtimePlayback()
        pendingRealtimeOutputClear?.complete(Unit)
      }
      "mark" -> Unit
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
          setStatus("Thinking…", awaitingAgent = true)
        } else if (isFinal && role == "assistant") {
          scheduleRealtimePlaybackIdle()
        }
      }
      "toolCall" -> {
        val callId = obj["callId"].asStringOrNull() ?: return
        val name = obj["name"].asStringOrNull() ?: return
        handleRealtimeToolCall(
          callId = callId,
          name = name,
          args = obj["args"],
          forced = obj["forced"].asBooleanOrNull() == true,
        )
      }
      "toolResult" -> Unit
      "error" -> {
        val message = obj["message"].asStringOrNull() ?: "realtime talk error"
        setStatus("Talk failed: $message")
        Log.w(tag, "realtime error: $message")
      }
      "close" -> {
        val closeReason = obj["reason"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
        val currentStatus = _statusText.value
        val closeStatus =
          if (currentStatus.startsWith("Talk failed:")) currentStatus else realtimeCloseStatusText(closeReason)
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

  private fun playRealtimeAudio(bytes: ByteArray) {
    if (!playbackEnabled || realtimeOutputSuppressed || bytes.isEmpty()) return
    val queue = ensureRealtimeAudioQueue()
    if (!queue.trySend(bytes).isSuccess) {
      Log.w(tag, "realtime audio queue full")
    }
  }

  private fun ensureRealtimeAudioQueue(): Channel<ByteArray> =
    synchronized(realtimePlaybackLock) {
      realtimeAudioQueue
        ?: Channel<ByteArray>(Channel.UNLIMITED).also { queue ->
          realtimeAudioQueue = queue
          realtimeAudioWriterJob =
            gatewayWorkScope.launch(Dispatchers.IO) {
              for (chunk in queue) {
                if (!playbackEnabled || realtimeOutputSuppressed || realtimeSessionId == null) continue
                try {
                  writeRealtimeAudio(chunk)
                } catch (err: CancellationException) {
                  throw err
                } catch (err: Throwable) {
                  Log.w(tag, "realtime audio playback failed: ${err.message ?: err::class.java.simpleName}")
                }
              }
            }
        }
    }

  private fun writeRealtimeAudio(bytes: ByteArray) {
    synchronized(realtimePlaybackLock) {
      val track =
        realtimeAudioTrack ?: run {
          val minBuffer =
            AudioTrack.getMinBufferSize(
              realtimeSampleRateHz,
              AudioFormat.CHANNEL_OUT_MONO,
              AudioFormat.ENCODING_PCM_16BIT,
            )
          val bufferSizeBytes =
            maxOf(
              minBuffer * 2,
              realtimeSampleRateHz * 2 * realtimePlaybackBufferMs / 1000,
              bytes.size * 4,
            )
          val created =
            AudioTrack
              .Builder()
              .setAudioAttributes(
                AudioAttributes
                  .Builder()
                  .setUsage(AudioAttributes.USAGE_MEDIA)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                  .build(),
              ).setAudioFormat(
                AudioFormat
                  .Builder()
                  .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                  .setSampleRate(realtimeSampleRateHz)
                  .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                  .build(),
              ).setTransferMode(AudioTrack.MODE_STREAM)
              .setBufferSizeInBytes(bufferSizeBytes)
              .build()
          realtimeAudioTrack = created
          created
        }
      var writtenBytes = 0
      while (writtenBytes < bytes.size) {
        val written = track.write(bytes, writtenBytes, bytes.size - writtenBytes)
        if (written <= 0) {
          Log.w(tag, "realtime audio write failed: $written")
          break
        }
        writtenBytes += written
      }
      if (writtenBytes <= 0) return
      if (track.playState != AudioTrack.PLAYSTATE_PLAYING) {
        track.play()
      }
      // Blocking MODE_STREAM writes are playback-paced once the track buffer
      // fills, so per-write metering tracks what the speaker actually plays.
      _outputLevel.value =
        TalkAudioLevel.smoothed(_outputLevel.value ?: 0f, TalkAudioLevel.pcm16Level(bytes, writtenBytes))
      _isSpeaking.value = true
      setStatus("Speaking…")
      val durationMs = ((writtenBytes / 2.0) / realtimeSampleRateHz * 1000.0).toLong()
      val now = SystemClock.elapsedRealtime()
      realtimePlaybackEndsAtMs = maxOf(now, realtimePlaybackEndsAtMs) + durationMs
      scheduleRealtimePlaybackIdle()
    }
  }

  private fun scheduleRealtimePlaybackIdle() {
    realtimePlaybackIdleJob?.cancel()
    val delayMs = maxOf(0L, realtimePlaybackEndsAtMs - SystemClock.elapsedRealtime())
    realtimePlaybackIdleJob =
      gatewayWorkScope.launch {
        delay(delayMs)
        val idle =
          synchronized(realtimePlaybackLock) {
            val playbackIdle = SystemClock.elapsedRealtime() >= realtimePlaybackEndsAtMs
            if (playbackIdle) {
              _isSpeaking.value = false
              _outputLevel.value = null
            }
            playbackIdle
          }
        if (idle && _isEnabled.value && realtimeSessionId != null) {
          setStatus("Listening")
        }
      }
  }

  private fun stopRealtimePlayback() {
    val audioQueue = realtimeAudioQueue
    val audioWriterJob = realtimeAudioWriterJob
    realtimeAudioQueue = null
    realtimeAudioWriterJob = null
    audioQueue?.close()
    audioWriterJob?.cancel()
    realtimePlaybackIdleJob?.cancel()
    realtimePlaybackIdleJob = null
    realtimePlaybackEndsAtMs = 0L
    synchronized(realtimePlaybackLock) {
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
    }
    _isSpeaking.value = false
    _outputLevel.value = null
    if (_isEnabled.value) {
      setStatus("Listening")
    }
  }

  private fun stopRealtimeRelay(
    closeSession: Boolean = true,
    cancelCapture: Boolean = true,
    cancelAppend: Boolean = true,
    preserveStatus: Boolean = false,
  ) {
    // Capture both halves of the status so a preserved restore cannot split
    // the user-visible text from the typed awaiting-agent flag.
    val status = _statusText.value
    val awaiting = _awaitingAgent.value
    val (sessionId, captureJobs) =
      synchronized(realtimeCapturePauseLock) {
        val currentSessionId = realtimeSessionId
        val currentCaptureJobs = realtimeCaptureJob to realtimeAppendJob
        realtimeSessionId = null
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
    synchronized(realtimeToolLock) {
      realtimeToolRuns.clear()
      pendingRealtimeToolCalls.clear()
      pendingRealtimeToolCompletions.clear()
    }
    realtimeUserEntryId = null
    realtimeUserEntryAwaitingFinal = false
    realtimeUserEntryAwaitingFinalStartedAtMs = null
    realtimeAssistantEntryId = null
    _speechActive.value = false
    _inputLevel.value = 0f
    stopRealtimePlayback()
    if (preserveStatus) {
      setStatus(status, awaitingAgent = awaiting)
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
        _isListening.value = true
        setStatus("Listening")
        startRealtimeCaptureLocked(sessionId)
        RealtimeCaptureResume.Resumed
      }
    when (outcome) {
      RealtimeCaptureResume.Skipped -> return
      RealtimeCaptureResume.Resumed -> return
      RealtimeCaptureResume.Restart -> start()
      RealtimeCaptureResume.Disconnected -> {
        setStatus("Gateway not connected")
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

  private fun handleRealtimeToolCall(
    callId: String,
    name: String,
    args: JsonElement?,
    forced: Boolean = false,
  ) {
    val relaySessionId = realtimeSessionId ?: return
    synchronized(realtimeToolLock) {
      pendingRealtimeToolCalls.add(callId)
    }
    gatewayWorkScope.launch {
      try {
        if (name == REALTIME_AGENT_CONTROL_TOOL) {
          submitRealtimeAgentControl(callId = callId, relaySessionId = relaySessionId, args = args)
          return@launch
        }
        if (forced) {
          submitRealtimeToolWorking(callId, relaySessionId)
        }
        val params =
          buildJsonObject {
            put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
            put("callId", JsonPrimitive(callId))
            put("name", JsonPrimitive(name))
            put("relaySessionId", JsonPrimitive(relaySessionId))
            if (args != null) put("args", args)
          }
        val response =
          requestGateway("talk.client.toolCall", params.toString(), timeoutMs = 15_000)
        val runId = parseRunId(response)
        if (!runId.isNullOrBlank()) {
          when (val registration = registerRealtimeToolRun(runId, callId, relaySessionId)) {
            RealtimeToolRegistration.SessionEnded -> return@launch
            RealtimeToolRegistration.AwaitingCompletion -> setStatus("Thinking…", awaitingAgent = true)
            is RealtimeToolRegistration.Completed ->
              dispatchRealtimeToolCompletion(registration.dispatch)
          }
        } else {
          submitRealtimeToolError(callId, "tool call returned no run id", relaySessionId)
        }
      } catch (err: Throwable) {
        if (err is CancellationException) throw err
        Log.w(tag, "realtime toolCall failed: ${err.message ?: err::class.simpleName}")
        submitRealtimeToolError(callId, err.message ?: "tool call failed", relaySessionId)
      } finally {
        synchronized(realtimeToolLock) {
          pendingRealtimeToolCalls.remove(callId)
        }
      }
    }
  }

  private fun registerRealtimeToolRun(
    runId: String,
    callId: String,
    relaySessionId: String,
  ): RealtimeToolRegistration =
    synchronized(realtimeToolLock) {
      if (realtimeSessionId != relaySessionId) {
        return@synchronized RealtimeToolRegistration.SessionEnded
      }
      val toolRun = RealtimeToolRun(callId = callId, relaySessionId = relaySessionId)
      val completion = pendingRealtimeToolCompletions.remove(runId)
      if (completion == null) {
        realtimeToolRuns[runId] = toolRun
        RealtimeToolRegistration.AwaitingCompletion
      } else {
        RealtimeToolRegistration.Completed(
          RealtimeToolCompletionDispatch(
            toolRun = toolRun,
            state = completion.state,
            messageEl = completion.messageEl,
          ),
        )
      }
    }

  private fun handleRealtimeToolCompletion(
    runId: String,
    state: String,
    messageEl: JsonElement?,
  ): Boolean {
    if (state != "final" && state != "aborted" && state != "error") return false
    val decision =
      synchronized(realtimeToolLock) {
        val toolRun = realtimeToolRuns.remove(runId)
        if (toolRun != null) {
          if (toolRun.relaySessionId != realtimeSessionId) {
            return@synchronized RealtimeToolCompletionDecision.Consumed
          }
          return@synchronized RealtimeToolCompletionDecision.Dispatch(
            RealtimeToolCompletionDispatch(toolRun = toolRun, state = state, messageEl = messageEl),
          )
        }
        if (realtimeSessionId == null || pendingRealtimeToolCalls.isEmpty()) {
          return@synchronized RealtimeToolCompletionDecision.NotHandled
        }
        pendingRealtimeToolCompletions[runId] =
          RealtimeToolCompletion(state = state, messageEl = messageEl)
        while (pendingRealtimeToolCompletions.size > maxCachedRunCompletions) {
          pendingRealtimeToolCompletions.remove(pendingRealtimeToolCompletions.keys.first())
        }
        RealtimeToolCompletionDecision.Consumed
      }
    return when (decision) {
      RealtimeToolCompletionDecision.NotHandled -> false
      RealtimeToolCompletionDecision.Consumed -> true
      is RealtimeToolCompletionDecision.Dispatch -> {
        dispatchRealtimeToolCompletion(decision.completion)
        true
      }
    }
  }

  private fun dispatchRealtimeToolCompletion(dispatch: RealtimeToolCompletionDispatch) {
    when (dispatch.state) {
      "final" -> {
        val text = extractTextFromChatEventMessage(dispatch.messageEl).orEmpty()
        val toolRun = dispatch.toolRun
        gatewayWorkScope.launch {
          submitRealtimeToolResult(
            callId = toolRun.callId,
            result = buildJsonObject { put("text", JsonPrimitive(text)) },
            sessionId = toolRun.relaySessionId,
          )
        }
      }
      "aborted", "error" -> {
        val toolRun = dispatch.toolRun
        val state = dispatch.state
        gatewayWorkScope.launch {
          submitRealtimeToolError(toolRun.callId, state, toolRun.relaySessionId)
        }
      }
    }
  }

  private suspend fun submitRealtimeToolError(
    callId: String,
    message: String,
    sessionId: String? = realtimeSessionId,
  ) {
    submitRealtimeToolResult(
      callId = callId,
      result = buildJsonObject { put("error", JsonPrimitive(message)) },
      sessionId = sessionId,
    )
  }

  private suspend fun submitRealtimeToolResult(
    callId: String,
    result: JsonObject,
    sessionId: String? = realtimeSessionId,
    options: JsonObject? = null,
  ) {
    val activeSessionId = sessionId ?: return
    val params =
      buildJsonObject {
        put("sessionId", JsonPrimitive(activeSessionId))
        put("callId", JsonPrimitive(callId))
        put("result", result)
        if (options != null) put("options", options)
      }
    try {
      requestGateway("talk.session.submitToolResult", params.toString(), timeoutMs = 15_000)
    } catch (err: Throwable) {
      if (err is CancellationException) throw err
      Log.w(tag, "realtime submitToolResult failed: ${err.message ?: err::class.simpleName}")
    }
  }

  private suspend fun submitRealtimeToolWorking(
    callId: String,
    sessionId: String,
  ) {
    submitRealtimeToolResult(
      callId = callId,
      sessionId = sessionId,
      result =
        buildJsonObject {
          put("status", JsonPrimitive("working"))
          put("tool", JsonPrimitive(REALTIME_AGENT_CONSULT_TOOL))
          put(
            "message",
            JsonPrimitive(
              "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
            ),
          )
        },
      options = buildJsonObject { put("willContinue", JsonPrimitive(true)) },
    )
  }

  private suspend fun submitRealtimeAgentControl(
    callId: String,
    relaySessionId: String,
    args: JsonElement?,
  ) {
    val argsObject = args.asObjectOrNull()
    val text =
      argsObject
        ?.get("text")
        .asStringOrNull()
        ?.trim()
        .orEmpty()
    val mode =
      argsObject
        ?.get("mode")
        .asStringOrNull()
        ?.trim()
    val params =
      buildJsonObject {
        put("sessionId", JsonPrimitive(relaySessionId))
        put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
        put("text", JsonPrimitive(text.ifEmpty { "status" }))
        if (!mode.isNullOrEmpty()) put("mode", JsonPrimitive(mode))
      }
    val response = requestGateway("talk.session.steer", params.toString(), timeoutMs = 15_000)
    val result = json.parseToJsonElement(response).asObjectOrNull()
    if (result != null) {
      submitRealtimeToolResult(callId = callId, result = result, sessionId = relaySessionId)
    } else {
      submitRealtimeToolError(callId, "control call returned no result", relaySessionId)
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

  private fun startListeningInternal(markListening: Boolean) {
    val r = recognizer ?: return
    val intent =
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        // Use cloud recognition — it handles natural speech and pauses better
        // than on-device which cuts off aggressively after short silences.
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800)
      }

    if (markListening) {
      setStatus("Listening")
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
    val transcript = lastTranscript.trim()
    if (transcript.isEmpty()) return
    val lastHeard = lastHeardAtMs ?: return
    val elapsed = SystemClock.elapsedRealtime() - lastHeard
    if (elapsed < silenceWindowMs) return
    if (activePttCaptureId != null) {
      if (pttAutoStopEnabled) {
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
    setStatus("Thinking…", awaitingAgent = true)
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
      setStatus("Gateway not connected")
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
        setStatus(if (ack.normalizedStatus == "error") "Chat error" else "Aborted")
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
        setStatus("No reply")
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
      setStatus("Talk failed: ${err.message ?: err::class.simpleName}")
      Log.w(tag, "finalize failed: ${err.message ?: err::class.simpleName}")
    }

    if (_isEnabled.value) {
      start()
    }
  }

  private fun clearPushToTalkRecognition(captureId: String): ClearedPushToTalkCapture? {
    if (activePttCaptureId != captureId) return null
    val transcript = lastTranscript.trim()
    val completion = pttCompletion
    pttTimeoutJob?.cancel()
    pttTimeoutJob = null
    pttAutoStopEnabled = false
    pttCompletion = null
    activePttCaptureId = null
    _isListening.value = false
    listeningMode = false
    clearListenWatchdog()
    recognizer?.cancel()
    recognizer?.destroy()
    recognizer = null
    lastTranscript = ""
    lastHeardAtMs = null
    return ClearedPushToTalkCapture(transcript = transcript, completion = completion)
  }

  private fun finishPushToTalk(
    payload: TalkPttStopPayload,
    completion: CompletableDeferred<TalkPttStopPayload>?,
  ): TalkPttStopPayload {
    completion?.complete(payload)
    return payload
  }

  private fun clearFinishingPushToTalk(
    captureId: String,
    job: Job,
  ) {
    synchronized(finishingPttLock) {
      if (finishingPttCaptureId == captureId && finishingPttJob === job) {
        finishingPttCaptureId = null
        finishingPttJob = null
      }
    }
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

    setStatus("Generating voice…", awaitingAgent = true)
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
      setStatus("Speak failed: ${err.message ?: err::class.simpleName}")
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
        TalkModeRuntime.validatedLanguage(directive?.language)?.let { Locale.forLanguageTag(it) }
      if (locale != null) {
        val localeResult = engine.setLanguage(locale)
        if (
          localeResult == TextToSpeech.LANG_MISSING_DATA ||
          localeResult == TextToSpeech.LANG_NOT_SUPPORTED
        ) {
          throw IllegalStateException("Language unavailable on this device")
        }
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
    setStatus("Speaking…")
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
    setStatus("Listening")
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
      parsed.interruptOnSpeech?.let { interruptOnSpeech = it }
      configLoaded = true
    } catch (_: Throwable) {
      if (generation != gatewayGeneration.get()) return
      silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
      configLoaded = false
    }
  }

  private fun parseRunId(jsonString: String): String? {
    val obj = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    return obj["runId"].asStringOrNull()
  }

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

  private val listener =
    object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {
        // Only a live listening session may claim the status; a speech-interrupt
        // recognizer readying during playback must not touch Thinking state.
        if (_isEnabled.value && _isListening.value) {
          setStatus("Listening")
        }
      }

      override fun onBeginningOfSpeech() {}

      override fun onRmsChanged(rmsdB: Float) {}

      override fun onBufferReceived(buffer: ByteArray?) {}

      override fun onEndOfSpeech() {
        clearListenWatchdog()
        // Don't restart while a transcript is being processed — the recognizer
        // competing for audio resources kills AudioTrack PCM playback.
        if (!finalizeInFlight) {
          scheduleRestart()
        }
      }

      override fun onError(error: Int) {
        if (stopRequested) return
        _isListening.value = false
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
          setStatus("Microphone permission required")
          return
        }

        setStatus(
          when (error) {
            SpeechRecognizer.ERROR_AUDIO -> "Audio error"
            SpeechRecognizer.ERROR_CLIENT -> "Client error"
            SpeechRecognizer.ERROR_NETWORK -> "Network error"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
            SpeechRecognizer.ERROR_NO_MATCH -> "Listening"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
            SpeechRecognizer.ERROR_SERVER -> "Server error"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Listening"
            else -> "Speech error ($error)"
          },
        )
        scheduleRestart(delayMs = 600)
      }

      override fun onResults(results: Bundle?) {
        val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
        list.firstOrNull()?.let { handleTranscript(it, isFinal = true) }
        scheduleRestart()
      }

      override fun onPartialResults(partialResults: Bundle?) {
        val list = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
        list.firstOrNull()?.let { handleTranscript(it, isFinal = false) }
      }

      override fun onEvent(
        eventType: Int,
        params: Bundle?,
      ) {}
    }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

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
