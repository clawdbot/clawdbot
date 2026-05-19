package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewaySession
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
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

data class TalkPttStartPayload(
  val captureId: String,
) {
  fun toJson(): String = """{"captureId":"$captureId"}"""
}

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

internal data class RealtimeToolRun(
  val callId: String,
  val relaySessionId: String,
)

private data class RealtimeToolCompletion(
  val state: String,
  val messageEl: JsonElement?,
)

class TalkModeManager internal constructor(
  private val context: Context,
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val supportsChatSubscribe: Boolean,
  private val isConnected: () -> Boolean,
  private val onBeforeSpeak: suspend () -> Unit = {},
  private val onAfterSpeak: suspend () -> Unit = {},
  private val onStoppedByRelay: () -> Unit = {},
  private val talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(session = session),
  private val talkAudioPlayer: TalkAudioPlaying = TalkAudioPlayer(context),
) {
  companion object {
    private const val tag = "TalkMode"
    private const val realtimeSampleRateHz = 24_000
    private const val realtimeAudioFrameMs = 100
    private const val listenWatchdogMs = 12_000L
    private const val chatFinalWaitWithSubscribeMs = 45_000L
    private const val chatFinalWaitWithoutSubscribeMs = 6_000L
    private const val maxCachedRunCompletions = 128
    private const val maxConversationEntries = 40
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val json = Json { ignoreUnknownKeys = true }
  private val _isEnabled = MutableStateFlow(false)
  val isEnabled: StateFlow<Boolean> = _isEnabled

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening

  private val _isSpeaking = MutableStateFlow(false)
  val isSpeaking: StateFlow<Boolean> = _isSpeaking

  private val _statusText = MutableStateFlow("Off")
  val statusText: StateFlow<String> = _statusText

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
  private var chatSubscribedSessionKey: String? = null
  private var configLoaded = false
  private var executionMode = TalkModeExecutionMode.Native
  private val startGeneration = AtomicLong(0L)

  @Volatile private var realtimeSessionId: String? = null
  private var realtimeCaptureJob: Job? = null
  private var realtimeAppendJob: Job? = null
  private val realtimeToolRuns = LinkedHashMap<String, RealtimeToolRun>()
  private val pendingRealtimeToolCalls = LinkedHashSet<String>()
  private val pendingRealtimeToolCompletions = LinkedHashMap<String, RealtimeToolCompletion>()
  private var realtimeUserEntryId: String? = null
  private var realtimeAssistantEntryId: String? = null
  private val realtimePlaybackLock = Any()
  private var realtimeAudioTrack: AudioTrack? = null
  private var realtimePlaybackIdleJob: Job? = null

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

  suspend fun ensureChatSubscribed() {
    reloadConfig()
    subscribeChatIfNeeded(session = session, sessionKey = mainSessionKey.ifBlank { "main" })
  }

  fun setMainSessionKey(sessionKey: String?) {
    val trimmed = sessionKey?.trim().orEmpty()
    if (trimmed.isEmpty()) return
    mainSessionKey = trimmed
  }

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

  suspend fun beginPushToTalk(): TalkPttStartPayload {
    if (!isConnected()) {
      _statusText.value = "Gateway not connected"
      throw IllegalStateException("UNAVAILABLE: Gateway not connected")
    }
    activePttCaptureId?.let { return TalkPttStartPayload(captureId = it) }

    stopSpeaking(resetInterrupt = false)
    pttTimeoutJob?.cancel()
    pttTimeoutJob = null
    pttAutoStopEnabled = false
    pttCompletion = null
    silenceJob?.cancel()
    silenceJob = null
    listeningMode = false
    finalizeInFlight = false
    stopRequested = false
    lastTranscript = ""
    lastHeardAtMs = null

    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      _statusText.value = "Microphone permission required"
      throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      _statusText.value = "Speech recognizer unavailable"
      throw IllegalStateException("UNAVAILABLE: Speech recognizer unavailable")
    }

    val captureId = UUID.randomUUID().toString()
    activePttCaptureId = captureId
    withContext(Dispatchers.Main) {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
      startListeningInternal(markListening = true)
    }
    _statusText.value = "Listening (PTT)"
    return TalkPttStartPayload(captureId = captureId)
  }

  suspend fun endPushToTalk(): TalkPttStopPayload {
    val captureId = activePttCaptureId ?: UUID.randomUUID().toString()
    if (activePttCaptureId == null) {
      return finishPushToTalk(TalkPttStopPayload(captureId = captureId, transcript = null, status = "idle"))
    }

    clearPushToTalkRecognition()
    val transcript = lastTranscript.trim()
    lastTranscript = ""
    lastHeardAtMs = null

    if (transcript.isEmpty()) {
      _statusText.value = if (_isEnabled.value) "Listening" else "Ready"
      if (_isEnabled.value) {
        start()
      }
      return finishPushToTalk(TalkPttStopPayload(captureId = captureId, transcript = null, status = "empty"))
    }

    if (!isConnected()) {
      _statusText.value = "Gateway not connected"
      if (_isEnabled.value) {
        start()
      }
      return finishPushToTalk(TalkPttStopPayload(captureId = captureId, transcript = transcript, status = "offline"))
    }

    _statusText.value = "Thinking…"
    scope.launch {
      finalizeTranscript(transcript)
    }
    return finishPushToTalk(TalkPttStopPayload(captureId = captureId, transcript = transcript, status = "queued"))
  }

  suspend fun cancelPushToTalk(): TalkPttStopPayload {
    val captureId = activePttCaptureId ?: UUID.randomUUID().toString()
    if (activePttCaptureId == null) {
      return finishPushToTalk(TalkPttStopPayload(captureId = captureId, transcript = null, status = "idle"))
    }

    clearPushToTalkRecognition()
    lastTranscript = ""
    lastHeardAtMs = null
    _statusText.value = if (_isEnabled.value) "Listening" else "Ready"
    if (_isEnabled.value) {
      start()
    }
    return finishPushToTalk(TalkPttStopPayload(captureId = captureId, transcript = null, status = "cancelled"))
  }

  suspend fun runPushToTalkOnce(maxDurationMs: Long = 12_000L): TalkPttStopPayload {
    if (pttCompletion != null) {
      cancelPushToTalk()
    }
    if (activePttCaptureId != null) {
      return TalkPttStopPayload(
        captureId = activePttCaptureId ?: UUID.randomUUID().toString(),
        transcript = null,
        status = "busy",
      )
    }

    beginPushToTalk()
    val completion = CompletableDeferred<TalkPttStopPayload>()
    pttCompletion = completion
    pttAutoStopEnabled = true
    startSilenceMonitor()
    pttTimeoutJob =
      scope.launch {
        delay(maxDurationMs)
        if (pttAutoStopEnabled && activePttCaptureId != null) {
          endPushToTalk()
        }
      }
    return completion.await()
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
    scope.launch {
      try {
        reloadConfig()
        subscribeChatIfNeeded(session = session, sessionKey = mainSessionKey.ifBlank { "main" })
        val startedAt = System.currentTimeMillis().toDouble() / 1000.0
        val prompt = buildPrompt(command)
        val runId = sendChat(prompt, session)
        val ok = waitForChatFinal(runId)
        val assistant =
          consumeRunText(runId)
            ?: waitForAssistantText(session, startedAt, if (ok) 12_000 else 25_000)
        if (!assistant.isNullOrBlank()) {
          val playbackToken = playbackGeneration.incrementAndGet()
          cancelActivePlayback()
          _statusText.value = "Speaking…"
          runPlaybackSession(playbackToken) {
            playAssistant(assistant, playbackToken)
          }
        } else {
          _statusText.value = "No reply"
        }
      } catch (err: Throwable) {
        Log.w(tag, "speakWakeCommand failed: ${err.message}")
      }
      onComplete()
    }
  }

  /** When true, play TTS for all final chat responses (even ones we didn't initiate). */
  @Volatile var ttsOnAllResponses = false

  fun playTtsForText(text: String) {
    val playbackToken = playbackGeneration.incrementAndGet()
    cancelActivePlayback()
    scope.launch {
      reloadConfig()
      runPlaybackSession(playbackToken) {
        playAssistant(text, playbackToken)
      }
    }
  }

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

    if (maybeCompleteRealtimeToolCall(runId = runId, state = state, messageEl = obj["message"])) {
      return
    }
    if (holdPendingRealtimeToolCompletion(runId = runId, state = state, messageEl = obj["message"])) {
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

  fun setPlaybackEnabled(enabled: Boolean) {
    if (playbackEnabled == enabled) return
    playbackEnabled = enabled
    if (!enabled) {
      stopRealtimePlayback()
      stopSpeaking()
    }
  }

  suspend fun refreshConfig() {
    reloadConfig()
  }

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
    val generation = startGeneration.incrementAndGet()
    stopRequested = false
    listeningMode = true
    Log.d(tag, "start")
    scope.launch {
      try {
        ensureConfigLoaded()
        if (generation != startGeneration.get() || !_isEnabled.value || stopRequested) return@launch
        if (executionMode == TalkModeExecutionMode.RealtimeRelay) {
          startRealtimeRelay(generation)
        } else {
          startNativeRecognition(generation)
        }
      } catch (err: Throwable) {
        if (err is CancellationException) return@launch
        _statusText.value = "Start failed: ${err.message ?: err::class.simpleName}"
        Log.w(tag, "start failed: ${err.message ?: err::class.simpleName}")
        if (executionMode == TalkModeExecutionMode.RealtimeRelay) {
          stopRealtimeRelay(closeSession = false, preserveStatus = true)
          disableRealtimeModeAndNotifyOwner()
        }
      }
    }
  }

  private suspend fun startNativeRecognition(generation: Long) {
    withContext(Dispatchers.Main) {
      if (generation != startGeneration.get()) return@withContext
      if (!_isEnabled.value || stopRequested) return@withContext
      if (_isListening.value) return@withContext
      Log.d(tag, "start native")

      if (!SpeechRecognizer.isRecognitionAvailable(context)) {
        _statusText.value = "Speech recognizer unavailable"
        Log.w(tag, "speech recognizer unavailable")
        return@withContext
      }

      val micOk =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED
      if (!micOk) {
        _statusText.value = "Microphone permission required"
        Log.w(tag, "microphone permission required")
        return@withContext
      }

      recognizer?.destroy()
      recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
      startListeningInternal(markListening = true)
      startSilenceMonitor()
      Log.d(tag, "listening")
    }
  }

  private fun stop() {
    stopRequested = true
    finalizeInFlight = false
    listeningMode = false
    activePttCaptureId = null
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
    _statusText.value = "Off"
    stopRealtimeRelay()
    stopSpeaking()
    chatSubscribedSessionKey = null
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

  private suspend fun startRealtimeRelay(generation: Long) {
    if (!isConnected()) {
      _statusText.value = "Gateway not connected"
      Log.w(tag, "realtime start: gateway not connected")
      disableRealtimeModeAndNotifyOwner()
      return
    }

    val micOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    if (!micOk) {
      _statusText.value = "Microphone permission required"
      Log.w(tag, "realtime start: microphone permission required")
      disableRealtimeModeAndNotifyOwner()
      return
    }

    ensureConfigLoaded()
    cancelActivePlayback()
    stopTextToSpeechPlayback()
    withContext(Dispatchers.Main) {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }

    _statusText.value = "Connecting…"
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
        put("mode", JsonPrimitive("realtime"))
        put("transport", JsonPrimitive("gateway-relay"))
        put("brain", JsonPrimitive("agent-consult"))
      }
    val payload = session.request("talk.session.create", params.toString(), timeoutMs = 15_000)
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

    realtimeSessionId = sessionId
    realtimeOutputSuppressed = false
    _isListening.value = true
    _statusText.value = "Listening"
    startRealtimeCapture(sessionId)
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
    _statusText.value = "Talk failed: $message"
    stopRealtimeRelay(cancelCapture = false, cancelAppend = false, preserveStatus = true)
    disableRealtimeModeAndNotifyOwner()
  }

  @SuppressLint("MissingPermission")
  private fun startRealtimeCapture(sessionId: String) {
    realtimeCaptureJob?.cancel()
    realtimeAppendJob?.cancel()
    val audioFrames =
      Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    realtimeAppendJob =
      scope.launch(Dispatchers.IO) {
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
            session.sendRequestFrame(
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
      scope.launch(Dispatchers.IO) {
        var audioRecord: AudioRecord? = null
        try {
          val frameBytes = realtimeSampleRateHz * 2 * realtimeAudioFrameMs / 1000
          val minBuffer =
            AudioRecord.getMinBufferSize(
              realtimeSampleRateHz,
              AudioFormat.CHANNEL_IN_MONO,
              AudioFormat.ENCODING_PCM_16BIT,
            )
          if (minBuffer <= 0) {
            throw IllegalStateException("AudioRecord buffer unavailable")
          }
          audioRecord =
            AudioRecord
              .Builder()
              .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
              .setAudioFormat(
                AudioFormat
                  .Builder()
                  .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                  .setSampleRate(realtimeSampleRateHz)
                  .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                  .build(),
              ).setBufferSizeInBytes(maxOf(minBuffer, frameBytes * 4))
              .build()
          val buffer = ByteArray(frameBytes)
          audioRecord.startRecording()
          while (coroutineContext.isActive && _isEnabled.value && realtimeSessionId == sessionId) {
            val read = audioRecord.read(buffer, 0, buffer.size)
            if (read <= 0) continue
            if (!shouldAppendRealtimeCapturedFrame(read)) continue
            audioFrames.trySend(buffer.copyOf(read))
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          Log.w(tag, "realtime capture failed: ${err.message ?: err::class.simpleName}")
          failRealtimeRelay(sessionId, err.message ?: err::class.simpleName ?: "capture failed")
        } finally {
          audioFrames.close()
          audioRecord?.let { record ->
            try {
              record.stop()
            } catch (_: Throwable) {
            }
            record.release()
          }
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
        _isListening.value = true
        _statusText.value = "Listening"
      }
      "inputAudio" -> {
        _isListening.value = true
      }
      "audio" -> {
        if (realtimeOutputSuppressed) return
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
      "clear" -> stopRealtimePlayback()
      "mark" -> Unit
      "transcript" -> {
        val role = obj["role"].asStringOrNull()
        val text = obj["text"].asStringOrNull()?.trim().orEmpty()
        val isFinal = obj["final"].asBooleanOrNull() == true
        if (text.isNotEmpty()) {
          when (role) {
            "user" -> upsertRealtimeConversation(VoiceConversationRole.User, text, isFinal)
            "assistant" -> upsertRealtimeConversation(VoiceConversationRole.Assistant, text, isFinal)
          }
        }
        if (role == "assistant" && text.isNotEmpty()) {
          _lastAssistantText.value = text
        }
        if (isFinal && role == "user") {
          realtimeOutputSuppressed = false
          _statusText.value = "Thinking…"
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
        )
      }
      "toolResult" -> Unit
      "error" -> {
        val message = obj["message"].asStringOrNull() ?: "realtime talk error"
        _statusText.value = "Talk failed: $message"
        Log.w(tag, "realtime error: $message")
      }
      "close" -> {
        Log.d(tag, "realtime close reason=${obj["reason"].asStringOrNull()}")
        stopRealtimeRelay(closeSession = false)
        if (_isEnabled.value) {
          _isEnabled.value = false
          _statusText.value = "Off"
          onStoppedByRelay()
        }
      }
      else -> {
        if (type != null) Log.d(tag, "ignored realtime event type=$type")
      }
    }
  }

  private fun playRealtimeAudio(bytes: ByteArray) {
    if (!playbackEnabled || realtimeOutputSuppressed || bytes.isEmpty()) return
    synchronized(realtimePlaybackLock) {
      val track =
        realtimeAudioTrack ?: run {
          val minBuffer =
            AudioTrack.getMinBufferSize(
              realtimeSampleRateHz,
              AudioFormat.CHANNEL_OUT_MONO,
              AudioFormat.ENCODING_PCM_16BIT,
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
              .setBufferSizeInBytes(maxOf(minBuffer, bytes.size * 4))
              .build()
          created.play()
          realtimeAudioTrack = created
          created
        }
      _isSpeaking.value = true
      _statusText.value = "Speaking…"
      track.write(bytes, 0, bytes.size)
      val durationMs = ((bytes.size / 2.0) / realtimeSampleRateHz * 1000.0).toLong()
      val now = SystemClock.elapsedRealtime()
      realtimePlaybackEndsAtMs = maxOf(now, realtimePlaybackEndsAtMs) + durationMs
      scheduleRealtimePlaybackIdle()
    }
  }

  private fun scheduleRealtimePlaybackIdle() {
    realtimePlaybackIdleJob?.cancel()
    val delayMs = maxOf(0L, realtimePlaybackEndsAtMs - SystemClock.elapsedRealtime())
    realtimePlaybackIdleJob =
      scope.launch {
        delay(delayMs)
        val idle =
          synchronized(realtimePlaybackLock) {
            val playbackIdle = SystemClock.elapsedRealtime() >= realtimePlaybackEndsAtMs
            if (playbackIdle) _isSpeaking.value = false
            playbackIdle
          }
        if (idle && _isEnabled.value && realtimeSessionId != null) {
          _statusText.value = "Listening"
        }
      }
  }

  private fun stopRealtimePlayback() {
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
    if (_isEnabled.value) {
      _statusText.value = "Listening"
    }
  }

  private fun stopRealtimeRelay(
    closeSession: Boolean = true,
    cancelCapture: Boolean = true,
    cancelAppend: Boolean = true,
    preserveStatus: Boolean = false,
  ) {
    val status = _statusText.value
    val sessionId = realtimeSessionId
    realtimeSessionId = null
    realtimeOutputSuppressed = false
    if (cancelCapture) {
      realtimeCaptureJob?.cancel()
    }
    if (cancelAppend) {
      realtimeAppendJob?.cancel()
    }
    realtimeCaptureJob = null
    realtimeAppendJob = null
    realtimeToolRuns.clear()
    pendingRealtimeToolCalls.clear()
    pendingRealtimeToolCompletions.clear()
    realtimeUserEntryId = null
    realtimeAssistantEntryId = null
    stopRealtimePlayback()
    if (preserveStatus) {
      _statusText.value = status
    }
    _isListening.value = false
    if (closeSession && !sessionId.isNullOrBlank()) {
      scope.launch {
        closeRealtimeSession(sessionId)
      }
    }
  }

  private suspend fun closeRealtimeSession(sessionId: String) {
    try {
      val params = buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) }
      session.request("talk.session.close", params.toString(), timeoutMs = 5_000)
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
  ) {
    val relaySessionId = realtimeSessionId ?: return
    pendingRealtimeToolCalls.add(callId)
    scope.launch {
      try {
        val params =
          buildJsonObject {
            put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
            put("callId", JsonPrimitive(callId))
            put("name", JsonPrimitive(name))
            put("relaySessionId", JsonPrimitive(relaySessionId))
            if (args != null) put("args", args)
          }
        val response =
          session.request("talk.client.toolCall", params.toString(), timeoutMs = 15_000)
        val runId = parseRunId(response)
        if (!runId.isNullOrBlank()) {
          if (realtimeSessionId != relaySessionId) return@launch
          realtimeToolRuns[runId] =
            RealtimeToolRun(callId = callId, relaySessionId = relaySessionId)
          val completion = pendingRealtimeToolCompletions.remove(runId)
          if (completion != null) {
            maybeCompleteRealtimeToolCall(
              runId = runId,
              state = completion.state,
              messageEl = completion.messageEl,
            )
          } else {
            _statusText.value = "Thinking…"
          }
        } else {
          submitRealtimeToolError(callId, "tool call returned no run id", relaySessionId)
        }
      } catch (err: Throwable) {
        if (err is CancellationException) throw err
        Log.w(tag, "realtime toolCall failed: ${err.message ?: err::class.simpleName}")
        submitRealtimeToolError(callId, err.message ?: "tool call failed", relaySessionId)
      } finally {
        pendingRealtimeToolCalls.remove(callId)
      }
    }
  }

  private fun holdPendingRealtimeToolCompletion(
    runId: String,
    state: String,
    messageEl: JsonElement?,
  ): Boolean {
    if (realtimeSessionId == null || pendingRealtimeToolCalls.isEmpty()) return false
    if (state != "final" && state != "aborted" && state != "error") return false
    pendingRealtimeToolCompletions[runId] =
      RealtimeToolCompletion(state = state, messageEl = messageEl)
    return true
  }

  private fun maybeCompleteRealtimeToolCall(
    runId: String,
    state: String,
    messageEl: JsonElement?,
  ): Boolean {
    val toolRun = realtimeToolRuns[runId] ?: return false
    if (toolRun.relaySessionId != realtimeSessionId) {
      realtimeToolRuns.remove(runId)
      return true
    }
    when (state) {
      "final" -> {
        realtimeToolRuns.remove(runId)
        val text = extractTextFromChatEventMessage(messageEl).orEmpty()
        scope.launch {
          submitRealtimeToolResult(
            callId = toolRun.callId,
            result = buildJsonObject { put("text", JsonPrimitive(text)) },
            sessionId = toolRun.relaySessionId,
          )
        }
        return true
      }
      "aborted", "error" -> {
        realtimeToolRuns.remove(runId)
        scope.launch {
          submitRealtimeToolError(toolRun.callId, state, toolRun.relaySessionId)
        }
        return true
      }
    }
    return false
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
  ) {
    val activeSessionId = sessionId ?: return
    val params =
      buildJsonObject {
        put("sessionId", JsonPrimitive(activeSessionId))
        put("callId", JsonPrimitive(callId))
        put("result", result)
      }
    try {
      session.request("talk.session.submitToolResult", params.toString(), timeoutMs = 15_000)
    } catch (err: Throwable) {
      if (err is CancellationException) throw err
      Log.w(tag, "realtime submitToolResult failed: ${err.message ?: err::class.simpleName}")
    }
  }

  private fun upsertRealtimeConversation(
    role: VoiceConversationRole,
    text: String,
    isFinal: Boolean,
  ) {
    val entryId =
      when (role) {
        VoiceConversationRole.User -> realtimeUserEntryId
        VoiceConversationRole.Assistant -> realtimeAssistantEntryId
      }
    val resolvedEntryId =
      if (entryId == null) {
        appendConversation(role = role, text = text, isStreaming = !isFinal)
      } else {
        updateConversationEntry(id = entryId, text = text, isStreaming = !isFinal)
        entryId
      }
    when (role) {
      VoiceConversationRole.User -> realtimeUserEntryId = if (isFinal) null else resolvedEntryId
      VoiceConversationRole.Assistant -> realtimeAssistantEntryId = if (isFinal) null else resolvedEntryId
    }
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
  ) {
    val current = _conversation.value
    val targetIndex =
      when {
        current.isEmpty() -> -1
        current[current.lastIndex].id == id -> current.lastIndex
        else -> current.indexOfFirst { it.id == id }
      }
    if (targetIndex < 0) return
    val entry = current[targetIndex]
    if (entry.text == text && entry.isStreaming == isStreaming) return
    val updated = current.toMutableList()
    updated[targetIndex] = entry.copy(text = text, isStreaming = isStreaming)
    _conversation.value = updated
  }

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
      _statusText.value = "Listening"
      _isListening.value = true
    }
    r.startListening(intent)
  }

  private fun scheduleRestart(delayMs: Long = 350) {
    if (stopRequested) return
    restartJob?.cancel()
    restartJob =
      scope.launch {
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

  private fun startSilenceMonitor() {
    silenceJob?.cancel()
    silenceJob =
      scope.launch {
        while (_isEnabled.value || pttAutoStopEnabled) {
          delay(200)
          checkSilence()
        }
      }
  }

  private fun checkSilence() {
    if (!_isListening.value) return
    val transcript = lastTranscript.trim()
    if (transcript.isEmpty()) return
    val lastHeard = lastHeardAtMs ?: return
    val elapsed = SystemClock.elapsedRealtime() - lastHeard
    if (elapsed < silenceWindowMs) return
    if (activePttCaptureId != null) {
      if (pttAutoStopEnabled) {
        scope.launch { endPushToTalk() }
      }
      return
    }
    if (finalizeInFlight) return
    finalizeInFlight = true
    scope.launch {
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
    _statusText.value = "Thinking…"
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
      _statusText.value = "Gateway not connected"
      Log.w(tag, "finalize: gateway not connected")
      start()
      return
    }

    try {
      val startedAt = System.currentTimeMillis().toDouble() / 1000.0
      subscribeChatIfNeeded(session = session, sessionKey = mainSessionKey)
      Log.d(tag, "chat.send start sessionKey=${mainSessionKey.ifBlank { "main" }} chars=${prompt.length}")
      val runId = sendChat(prompt, session)
      Log.d(tag, "chat.send ok runId=$runId")
      val ok = waitForChatFinal(runId)
      if (!ok) {
        Log.w(tag, "chat final timeout runId=$runId; attempting history fallback")
      }
      // Use text cached from the final event first — avoids chat.history polling
      val assistant =
        consumeRunText(runId)
          ?: waitForAssistantText(session, startedAt, if (ok) 12_000 else 25_000)
      if (assistant.isNullOrBlank()) {
        _statusText.value = "No reply"
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
      _statusText.value = "Talk failed: ${err.message ?: err::class.simpleName}"
      Log.w(tag, "finalize failed: ${err.message ?: err::class.simpleName}")
    }

    if (_isEnabled.value) {
      start()
    }
  }

  private suspend fun clearPushToTalkRecognition() {
    pttTimeoutJob?.cancel()
    pttTimeoutJob = null
    pttAutoStopEnabled = false
    activePttCaptureId = null
    _isListening.value = false
    listeningMode = false
    clearListenWatchdog()
    withContext(Dispatchers.Main) {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }
  }

  private fun finishPushToTalk(payload: TalkPttStopPayload): TalkPttStopPayload {
    pttCompletion?.complete(payload)
    pttCompletion = null
    return payload
  }

  private suspend fun subscribeChatIfNeeded(
    session: GatewaySession,
    sessionKey: String,
  ) {
    if (!supportsChatSubscribe) return
    val key = sessionKey.trim()
    if (key.isEmpty()) return
    if (chatSubscribedSessionKey == key) return
    val sent = session.sendNodeEvent("chat.subscribe", """{"sessionKey":"$key"}""")
    if (sent) {
      chatSubscribedSessionKey = key
      Log.d(tag, "chat.subscribe ok sessionKey=$key")
    } else {
      Log.w(tag, "chat.subscribe failed sessionKey=$key")
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
  ): String {
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
      val res = session.request("chat.send", params.toString())
      val parsed = parseRunId(res) ?: runId
      if (parsed != runId) {
        pendingRunId = parsed
      }
      return parsed
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

    val timeoutMs = if (supportsChatSubscribe) chatFinalWaitWithSubscribeMs else chatFinalWaitWithoutSubscribeMs
    val result =
      try {
        withTimeout(timeoutMs) { deferred.await() }
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
    sinceSeconds: Double,
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
    val res = session.request("chat.history", "{\"sessionKey\":\"$key\"}")
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

    _statusText.value = "Generating voice…"
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
      _statusText.value = "Speak failed: ${err.message ?: err::class.simpleName}"
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
    _statusText.value = "Speaking…"
    _isSpeaking.value = true
    ensureInterruptListener()
    requestAudioFocusForTts()
  }

  fun stopTts() {
    realtimeOutputSuppressed = true
    stopRealtimePlayback()
    cancelRealtimeOutput(reason = "android-stop-tts")
    stopSpeaking(resetInterrupt = true)
    _isSpeaking.value = false
    _statusText.value = "Listening"
  }

  private fun cancelRealtimeOutput(reason: String) {
    val sessionId = realtimeSessionId ?: return
    scope.launch {
      try {
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(sessionId))
            put("reason", JsonPrimitive(reason))
          }
        session.request("talk.session.cancelOutput", params.toString(), timeoutMs = 5_000)
      } catch (err: Throwable) {
        if (err !is CancellationException) {
          Log.d(tag, "realtime cancelOutput ignored: ${err.message ?: err::class.simpleName}")
        }
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

  private fun shouldAllowSpeechInterrupt(): Boolean = !finalizeInFlight

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
    try {
      val res = session.request("talk.config", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val parsed = TalkModeGatewayConfigParser.parse(root?.get("config").asObjectOrNull())
      silenceWindowMs = parsed.silenceTimeoutMs
      parsed.interruptOnSpeech?.let { interruptOnSpeech = it }
      executionMode = parsed.executionMode
      configLoaded = true
    } catch (_: Throwable) {
      silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
      executionMode = TalkModeExecutionMode.Native
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
    // Don't create a new recognizer when we just destroyed one for TTS (finalizeInFlight=true).
    // Starting a new recognizer mid-TTS causes audio session conflict that kills AudioTrack
    // writes (returns 0) and MediaPlayer on OxygenOS/OnePlus devices.
    if (finalizeInFlight) return
    mainHandler.post {
      if (stopRequested || finalizeInFlight) return@post
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
        if (_isEnabled.value) {
          _statusText.value = if (_isListening.value) "Listening" else _statusText.value
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
          _statusText.value = "Microphone permission required"
          return
        }

        _statusText.value =
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
          }
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
