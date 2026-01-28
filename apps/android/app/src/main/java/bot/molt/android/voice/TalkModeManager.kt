package bot.molt.android.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.content.ContextCompat
import bot.molt.android.gateway.GatewaySession
import bot.molt.android.isCanonicalMainSessionKey
import bot.molt.android.normalizeMainKey
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.math.max

class TalkModeManager(
  private val context: Context,
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val supportsChatSubscribe: Boolean,
  private val isConnected: () -> Boolean,
) {
  companion object {
    private const val tag = "TalkMode"
    private const val defaultModelIdFallback = "eleven_v3"
    private const val defaultOutputFormatFallback = "pcm_24000"
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

  private val _usingFallbackTts = MutableStateFlow(false)
  val usingFallbackTts: StateFlow<Boolean> = _usingFallbackTts

  private var recognizer: SpeechRecognizer? = null
  private var restartJob: Job? = null
  private var stopRequested = false
  private var listeningMode = false

  private var silenceJob: Job? = null
  private val silenceWindowMs = 700L
  private var lastTranscript: String = ""
  private var lastHeardAtMs: Long? = null
  private var lastSpokenText: String? = null
  private var lastInterruptedAtSeconds: Double? = null

  private var defaultVoiceId: String? = null
  private var currentVoiceId: String? = null
  private var fallbackVoiceId: String? = null
  private var defaultModelId: String? = null
  private var currentModelId: String? = null
  private var defaultOutputFormat: String? = null
  private var apiKey: String? = null
  private var voiceAliases: Map<String, String> = emptyMap()
  private var interruptOnSpeech: Boolean = true
  private var voiceOverrideActive = false
  private var modelOverrideActive = false
  private var mainSessionKey: String = "main"

  private var pendingRunId: String? = null
  private var pendingFinal: CompletableDeferred<Boolean>? = null
  private var chatSubscribedSessionKey: String? = null

  private var player: MediaPlayer? = null
  private var streamingSource: StreamingMediaDataSource? = null
  private var pcmTrack: AudioTrack? = null
  @Volatile private var pcmStopRequested = false
  private var systemTts: TextToSpeech? = null
  private var systemTtsPending: CompletableDeferred<Unit>? = null
  private var systemTtsPendingId: String? = null

  fun setMainSessionKey(sessionKey: String?) {
    val trimmed = sessionKey?.trim().orEmpty()
    if (trimmed.isEmpty()) return
    if (isCanonicalMainSessionKey(mainSessionKey)) return
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

  fun handleGatewayEvent(event: String, payloadJson: String?) {
    if (event != "chat") return
    if (payloadJson.isNullOrBlank()) return
    val pending = pendingRunId ?: return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val runId = obj["runId"].asStringOrNull() ?: return
    if (runId != pending) return
    val state = obj["state"].asStringOrNull() ?: return
    if (state == "final") {
      pendingFinal?.complete(true)
      pendingFinal = null
      pendingRunId = null
    }
  }

  private fun start() {
    mainHandler.post {
      if (_isListening.value) return@post
      stopRequested = false
      listeningMode = true
      Log.d(tag, "start")

      if (!SpeechRecognizer.isRecognitionAvailable(context)) {
        _statusText.value = "Speech recognizer unavailable"
        Log.w(tag, "speech recognizer unavailable")
        return@post
      }

      val micOk =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED
      if (!micOk) {
        _statusText.value = "Microphone permission required"
        Log.w(tag, "microphone permission required")
        return@post
      }

      try {
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
        startListeningInternal(markListening = true)
        startSilenceMonitor()
        Log.d(tag, "listening")
      } catch (err: Throwable) {
        _statusText.value = "Start failed: ${err.message ?: err::class.simpleName}"
        Log.w(tag, "start failed: ${err.message ?: err::class.simpleName}")
      }
    }
  }

  private fun stop() {
    stopRequested = true
    listeningMode = false
    restartJob?.cancel()
    restartJob = null
    silenceJob?.cancel()
    silenceJob = null
    lastTranscript = ""
    lastHeardAtMs = null
    _isListening.value = false
    _statusText.value = "Off"
    stopSpeaking()
    _usingFallbackTts.value = false
    chatSubscribedSessionKey = null

    mainHandler.post {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }
    systemTts?.stop()
    systemTtsPending?.cancel()
    systemTtsPending = null
    systemTtsPendingId = null
  }

  private fun startListeningInternal(markListening: Boolean) {
    val r = recognizer ?: return
    val intent =
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
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
            val shouldListen = listeningMode
            val shouldInterrupt = _isSpeaking.value && interruptOnSpeech
            if (!shouldListen && !shouldInterrupt) return@post
            startListeningInternal(markListening = shouldListen)
          } catch (_: Throwable) {
            // handled by onError
          }
        }
      }
  }

  private fun handleTranscript(text: String, isFinal: Boolean) {
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
    }
  }

  private fun startSilenceMonitor() {
    silenceJob?.cancel()
    silenceJob =
      scope.launch {
        while (_isEnabled.value) {
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
    scope.launch { finalizeTranscript(transcript) }
  }

  private suspend fun finalizeTranscript(transcript: String) {
    listeningMode = false
    _isListening.value = false
    _statusText.value = "Thinking…"
    lastTranscript = ""
    lastHeardAtMs = null

    reloadConfig()
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
      val assistant = waitForAssistantText(session, startedAt, if (ok) 12_000 else 25_000)
      if (assistant.isNullOrBlank()) {
        _statusText.value = "No reply"
        Log.w(tag, "assistant text timeout runId=$runId")
        start()
        return
      }
      Log.d(tag, "assistant text ok chars=${assistant.length}")
      playAssistant(assistant)
    } catch (err: Throwable) {
      _statusText.value = "Talk failed: ${err.message ?: err::class.simpleName}"
      Log.w(tag, "finalize failed: ${err.message ?: err::class.simpleName}")
    }

    if (_isEnabled.value) {
      start()
    }
  }

  private suspend fun subscribeChatIfNeeded(session: GatewaySession, sessionKey: String) {
    if (!supportsChatSubscribe) return
    val key = sessionKey.trim()
    if (key.isEmpty()) return
    if (chatSubscribedSessionKey == key) return
    try {
      session.sendNodeEvent("chat.subscribe", """{"sessionKey":"$key"}""")
      chatSubscribedSessionKey = key
      Log.d(tag, "chat.subscribe ok sessionKey=$key")
    } catch (err: Throwable) {
      Log.w(tag, "chat.subscribe failed sessionKey=$key err=${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun buildPrompt(transcript: String): String {
    val lines = mutableListOf(
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

  private suspend fun sendChat(message: String, session: GatewaySession): String {
    val runId = UUID.randomUUID().toString()
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
        put("message", JsonPrimitive(message))
        put("thinking", JsonPrimitive("low"))
        put("timeoutMs", JsonPrimitive(30_000))
        put("idempotencyKey", JsonPrimitive(runId))
      }
    val res = session.request("chat.send", params.toString())
    val parsed = parseRunId(res) ?: runId
    if (parsed != runId) {
      pendingRunId = parsed
    }
    return parsed
  }

  private suspend fun waitForChatFinal(runId: String): Boolean {
    pendingFinal?.cancel()
    val deferred = CompletableDeferred<Boolean>()
    pendingRunId = runId
    pendingFinal = deferred

    val result =
      withContext(Dispatchers.IO) {
        try {
          kotlinx.coroutines.withTimeout(120_000) { deferred.await() }
        } catch (_: Throwable) {
          false
        }
      }

    if (!result) {
      pendingFinal = null
      pendingRunId = null
    }
    return result
  }

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
        content.mapNotNull { entry ->
          entry.asObjectOrNull()?.get("text")?.asStringOrNull()?.trim()
        }.filter { it.isNotEmpty() }
      if (text.isNotEmpty()) return text.joinToString("\n")
    }
    return null
  }

  private suspend fun playAssistant(text: String) {
    val parsed = TalkDirectiveParser.parse(text)
    if (parsed.unknownKeys.isNotEmpty()) {
      Log.w(tag, "Unknown talk directive keys: ${parsed.unknownKeys}")
    }
    val directive = parsed.directive
    val cleaned = parsed.stripped.trim()
    if (cleaned.isEmpty()) return
    _lastAssistantText.value = cleaned

    val requestedVoice = directive?.voiceId?.trim()?.takeIf { it.isNotEmpty() }
    val resolvedVoice = resolveVoiceAlias(requestedVoice)
    if (requestedVoice != null && resolvedVoice == null) {
      Log.w(tag, "unknown voice alias: $requestedVoice")
    }

    if (directive?.voiceId != null) {
      if (directive.once != true) {
        currentVoiceId = resolvedVoice
        voiceOverrideActive = true
      }
    }
    if (directive?.modelId != null) {
      if (directive.once != true) {
        currentModelId = directive.modelId
        modelOverrideActive = true
      }
    }

    val apiKey =
      apiKey?.trim()?.takeIf { it.isNotEmpty() }
        ?: System.getenv("ELEVENLABS_API_KEY")?.trim()
    val preferredVoice = resolvedVoice ?: currentVoiceId ?: defaultVoiceId
    val voiceId =
      if (!apiKey.isNullOrEmpty()) {
        resolveVoiceId(preferredVoice, apiKey)
      } else {
        null
      }

    _statusText.value = "Speaking…"
    _isSpeaking.value = true
    lastSpokenText = cleaned
    ensureInterruptListener()

    try {
      val canUseElevenLabs = !voiceId.isNullOrBlank() && !apiKey.isNullOrEmpty()
      if (!canUseElevenLabs) {
        if (voiceId.isNullOrBlank()) {
          Log.w(tag, "missing voiceId; falling back to system voice")
        }
        if (apiKey.isNullOrEmpty()) {
          Log.w(tag, "missing ELEVENLABS_API_KEY; falling back to system voice")
        }
        _usingFallbackTts.value = true
        _statusText.value = "Speaking (System)…"
        speakWithSystemTts(cleaned)
      } else {
        _usingFallbackTts.value = false
        val ttsStarted = SystemClock.elapsedRealtime()
        val modelId = directive?.modelId ?: currentModelId ?: defaultModelId
        val request =
          ElevenLabsRequest(
            text = cleaned,
            modelId = modelId,
            outputFormat =
              TalkModeRuntime.validatedOutputFormat(directive?.outputFormat ?: defaultOutputFormat),
            speed = TalkModeRuntime.resolveSpeed(directive?.speed, directive?.rateWpm),
            stability = TalkModeRuntime.validatedStability(directive?.stability, modelId),
            similarity = TalkModeRuntime.validatedUnit(directive?.similarity),
            style = TalkModeRuntime.validatedUnit(directive?.style),
            speakerBoost = directive?.speakerBoost,
            seed = TalkModeRuntime.validatedSeed(directive?.seed),
            normalize = TalkModeRuntime.validatedNormalize(directive?.normalize),
            language = TalkModeRuntime.validatedLanguage(directive?.language),
            latencyTier = TalkModeRuntime.validatedLatencyTier(directive?.latencyTier),
          )
        streamAndPlay(voiceId = voiceId!!, apiKey = apiKey!!, request = request)
        Log.d(tag, "elevenlabs stream ok durMs=${SystemClock.elapsedRealtime() - ttsStarted}")
      }
    } catch (err: Throwable) {
      Log.w(tag, "speak failed: ${err.message ?: err::class.simpleName}; falling back to system voice")
      try {
        _usingFallbackTts.value = true
        _statusText.value = "Speaking (System)…"
        speakWithSystemTts(cleaned)
      } catch (fallbackErr: Throwable) {
        _statusText.value = "Speak failed: ${fallbackErr.message ?: fallbackErr::class.simpleName}"
        Log.w(tag, "system voice failed: ${fallbackErr.message ?: fallbackErr::class.simpleName}")
      }
    }

    _isSpeaking.value = false
  }

  private suspend fun streamAndPlay(voiceId: String, apiKey: String, request: ElevenLabsRequest) {
    stopSpeaking(resetInterrupt = false)

    pcmStopRequested = false
    val pcmSampleRate = TalkModeRuntime.parsePcmSampleRate(request.outputFormat)
    if (pcmSampleRate != null) {
      try {
        streamAndPlayPcm(voiceId = voiceId, apiKey = apiKey, request = request, sampleRate = pcmSampleRate)
        return
      } catch (err: Throwable) {
        if (pcmStopRequested) return
        Log.w(tag, "pcm playback failed; falling back to mp3: ${err.message ?: err::class.simpleName}")
      }
    }

    streamAndPlayMp3(voiceId = voiceId, apiKey = apiKey, request = request)
  }

  private suspend fun streamAndPlayMp3(voiceId: String, apiKey: String, request: ElevenLabsRequest) {
    val dataSource = StreamingMediaDataSource()
    streamingSource = dataSource

    val player = MediaPlayer()
    this.player = player

    val prepared = CompletableDeferred<Unit>()
    val finished = CompletableDeferred<Unit>()

    player.setAudioAttributes(
      AudioAttributes.Builder()
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .build(),
    )
    player.setOnPreparedListener {
      it.start()
      prepared.complete(Unit)
    }
    player.setOnCompletionListener {
      finished.complete(Unit)
    }
    player.setOnErrorListener { _, _, _ ->
      finished.completeExceptionally(IllegalStateException("MediaPlayer error"))
      true
    }

    player.setDataSource(dataSource)
    withContext(Dispatchers.Main) {
      player.prepareAsync()
    }

    val fetchError = CompletableDeferred<Throwable?>()
    val fetchJob =
      scope.launch(Dispatchers.IO) {
        try {
          streamTts(voiceId = voiceId, apiKey = apiKey, request = request, sink = dataSource)
          fetchError.complete(null)
        } catch (err: Throwable) {
          dataSource.fail()
          fetchError.complete(err)
        }
      }

    Log.d(tag, "play start")
    try {
      prepared.await()
      finished.await()
      fetchError.await()?.let { throw it }
    } finally {
      fetchJob.cancel()
      cleanupPlayer()
    }
    Log.d(tag, "play done")
  }

  private suspend fun streamAndPlayPcm(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    sampleRate: Int,
  ) {
    val minBuffer =
      AudioTrack.getMinBufferSize(
        sampleRate,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    if (minBuffer <= 0) {
      throw IllegalStateException("AudioTrack buffer size invalid: $minBuffer")
    }

    val bufferSize = max(minBuffer * 2, 8 * 1024)
    val track =
      AudioTrack(
        AudioAttributes.Builder()
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .build(),
        AudioFormat.Builder()
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
        bufferSize,
        AudioTrack.MODE_STREAM,
        AudioManager.AUDIO_SESSION_ID_GENERATE,
      )
    if (track.state != AudioTrack.STATE_INITIALIZED) {
      track.release()
      throw IllegalStateException("AudioTrack init failed")
    }
    pcmTrack = track
    track.play()

    Log.d(tag, "pcm play start sampleRate=$sampleRate bufferSize=$bufferSize")
    try {
      streamPcm(voiceId = voiceId, apiKey = apiKey, request = request, track = track)
    } finally {
      cleanupPcmTrack()
    }
    Log.d(tag, "pcm play done")
  }

  private suspend fun speakWithSystemTts(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return
    val ok = ensureSystemTts()
    if (!ok) {
      throw IllegalStateException("system TTS unavailable")
    }

    val tts = systemTts ?: throw IllegalStateException("system TTS unavailable")
    val utteranceId = "talk-${UUID.randomUUID()}"
    val deferred = CompletableDeferred<Unit>()
    systemTtsPending?.cancel()
    systemTtsPending = deferred
    systemTtsPendingId = utteranceId

    withContext(Dispatchers.Main) {
      val params = Bundle()
      tts.speak(trimmed, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
    }

    withContext(Dispatchers.IO) {
      try {
        kotlinx.coroutines.withTimeout(180_000) { deferred.await() }
      } catch (err: Throwable) {
        throw err
      }
    }
  }

  private suspend fun ensureSystemTts(): Boolean {
    if (systemTts != null) return true
    return withContext(Dispatchers.Main) {
      val deferred = CompletableDeferred<Boolean>()
      val tts =
        try {
          TextToSpeech(context) { status ->
            deferred.complete(status == TextToSpeech.SUCCESS)
          }
        } catch (_: Throwable) {
          deferred.complete(false)
          null
        }
      if (tts == null) return@withContext false

      tts.setOnUtteranceProgressListener(
        object : UtteranceProgressListener() {
          override fun onStart(utteranceId: String?) {}

          override fun onDone(utteranceId: String?) {
            if (utteranceId == null) return
            if (utteranceId != systemTtsPendingId) return
            systemTtsPending?.complete(Unit)
            systemTtsPending = null
            systemTtsPendingId = null
          }

          @Suppress("OVERRIDE_DEPRECATION")
          @Deprecated("Deprecated in Java")
          override fun onError(utteranceId: String?) {
            if (utteranceId == null) return
            if (utteranceId != systemTtsPendingId) return
            systemTtsPending?.completeExceptionally(IllegalStateException("system TTS error"))
            systemTtsPending = null
            systemTtsPendingId = null
          }

          override fun onError(utteranceId: String?, errorCode: Int) {
            if (utteranceId == null) return
            if (utteranceId != systemTtsPendingId) return
            systemTtsPending?.completeExceptionally(IllegalStateException("system TTS error $errorCode"))
            systemTtsPending = null
            systemTtsPendingId = null
          }
        },
      )

      val ok =
        try {
          deferred.await()
        } catch (_: Throwable) {
          false
        }
      if (ok) {
        systemTts = tts
      } else {
        tts.shutdown()
      }
      ok
    }
  }

  private fun stopSpeaking(resetInterrupt: Boolean = true) {
    pcmStopRequested = true
    if (!_isSpeaking.value) {
      cleanupPlayer()
      cleanupPcmTrack()
      systemTts?.stop()
      systemTtsPending?.cancel()
      systemTtsPending = null
      systemTtsPendingId = null
      return
    }
    if (resetInterrupt) {
      val currentMs = player?.currentPosition?.toDouble() ?: 0.0
      lastInterruptedAtSeconds = currentMs / 1000.0
    }
    cleanupPlayer()
    cleanupPcmTrack()
    systemTts?.stop()
    systemTtsPending?.cancel()
    systemTtsPending = null
    systemTtsPendingId = null
    _isSpeaking.value = false
  }

  private fun cleanupPlayer() {
    player?.stop()
    player?.release()
    player = null
    streamingSource?.close()
    streamingSource = null
  }

  private fun cleanupPcmTrack() {
    val track = pcmTrack ?: return
    try {
      track.pause()
      track.flush()
      track.stop()
    } catch (_: Throwable) {
      // ignore cleanup errors
    } finally {
      track.release()
    }
    pcmTrack = null
  }

  private fun shouldInterrupt(transcript: String): Boolean {
    val trimmed = transcript.trim()
    if (trimmed.length < 3) return false
    val spoken = lastSpokenText?.lowercase()
    if (spoken != null && spoken.contains(trimmed.lowercase())) return false
    return true
  }

  private suspend fun reloadConfig() {
    val envVoice = System.getenv("ELEVENLABS_VOICE_ID")?.trim()
    val sagVoice = System.getenv("SAG_VOICE_ID")?.trim()
    val envKey = System.getenv("ELEVENLABS_API_KEY")?.trim()
    try {
      val res = session.request("config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val talk = config?.get("talk").asObjectOrNull()
      val sessionCfg = config?.get("session").asObjectOrNull()
      val mainKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull())
      val voice = talk?.get("voiceId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val aliases =
        talk?.get("voiceAliases").asObjectOrNull()?.entries?.mapNotNull { (key, value) ->
          val id = value.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
          normalizeAliasKey(key).takeIf { it.isNotEmpty() }?.let { it to id }
        }?.toMap().orEmpty()
      val model = talk?.get("modelId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val outputFormat = talk?.get("outputFormat")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val key = talk?.get("apiKey")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val interrupt = talk?.get("interruptOnSpeech")?.asBooleanOrNull()

      if (!isCanonicalMainSessionKey(mainSessionKey)) {
        mainSessionKey = mainKey
      }
      defaultVoiceId = voice ?: envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() }
      voiceAliases = aliases
      if (!voiceOverrideActive) currentVoiceId = defaultVoiceId
      defaultModelId = model ?: defaultModelIdFallback
      if (!modelOverrideActive) currentModelId = defaultModelId
      defaultOutputFormat = outputFormat ?: defaultOutputFormatFallback
      apiKey = key ?: envKey?.takeIf { it.isNotEmpty() }
      if (interrupt != null) interruptOnSpeech = interrupt
    } catch (_: Throwable) {
      defaultVoiceId = envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() }
      defaultModelId = defaultModelIdFallback
      if (!modelOverrideActive) currentModelId = defaultModelId
      apiKey = envKey?.takeIf { it.isNotEmpty() }
      voiceAliases = emptyMap()
      defaultOutputFormat = defaultOutputFormatFallback
    }
  }

  private fun parseRunId(jsonString: String): String? {
    val obj = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    return obj["runId"].asStringOrNull()
  }

  private suspend fun streamTts(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    sink: StreamingMediaDataSource,
  ) {
    withContext(Dispatchers.IO) {
      val conn = openTtsConnection(voiceId = voiceId, apiKey = apiKey, request = request)
      try {
        val payload = buildRequestPayload(request)
        conn.outputStream.use { it.write(payload.toByteArray()) }

        val code = conn.responseCode
        if (code >= 400) {
          val message = conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
          sink.fail()
          throw IllegalStateException("ElevenLabs failed: $code $message")
        }

        val buffer = ByteArray(8 * 1024)
        conn.inputStream.use { input ->
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            sink.append(buffer.copyOf(read))
          }
        }
        sink.finish()
      } finally {
        conn.disconnect()
      }
    }
  }

  private suspend fun streamPcm(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    track: AudioTrack,
  ) {
    withContext(Dispatchers.IO) {
      val conn = openTtsConnection(voiceId = voiceId, apiKey = apiKey, request = request)
      try {
        val payload = buildRequestPayload(request)
        conn.outputStream.use { it.write(payload.toByteArray()) }

        val code = conn.responseCode
        if (code >= 400) {
          val message = conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
          throw IllegalStateException("ElevenLabs failed: $code $message")
        }

        val buffer = ByteArray(8 * 1024)
        conn.inputStream.use { input ->
          while (true) {
            if (pcmStopRequested) return@withContext
            val read = input.read(buffer)
            if (read <= 0) break
            var offset = 0
            while (offset < read) {
              if (pcmStopRequested) return@withContext
              val wrote =
                try {
                  track.write(buffer, offset, read - offset)
                } catch (err: Throwable) {
                  if (pcmStopRequested) return@withContext
                  throw err
                }
              if (wrote <= 0) {
                if (pcmStopRequested) return@withContext
                throw IllegalStateException("AudioTrack write failed: $wrote")
              }
              offset += wrote
            }
          }
        }
      } finally {
        conn.disconnect()
      }
    }
  }

  private fun openTtsConnection(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
  ): HttpURLConnection {
    val baseUrl = "https://api.elevenlabs.io/v1/text-to-speech/$voiceId/stream"
    val latencyTier = request.latencyTier
    val url =
      if (latencyTier != null) {
        URL("$baseUrl?optimize_streaming_latency=$latencyTier")
      } else {
        URL(baseUrl)
      }
    val conn = url.openConnection() as HttpURLConnection
    conn.requestMethod = "POST"
    conn.connectTimeout = 30_000
    conn.readTimeout = 30_000
    conn.setRequestProperty("Content-Type", "application/json")
    conn.setRequestProperty("Accept", resolveAcceptHeader(request.outputFormat))
    conn.setRequestProperty("xi-api-key", apiKey)
    conn.doOutput = true
    return conn
  }

  private fun resolveAcceptHeader(outputFormat: String?): String {
    val normalized = outputFormat?.trim()?.lowercase().orEmpty()
    return if (normalized.startsWith("pcm_")) "audio/pcm" else "audio/mpeg"
  }

  private fun buildRequestPayload(request: ElevenLabsRequest): String {
    val voiceSettingsEntries =
      buildJsonObject {
        request.speed?.let { put("speed", JsonPrimitive(it)) }
        request.stability?.let { put("stability", JsonPrimitive(it)) }
        request.similarity?.let { put("similarity_boost", JsonPrimitive(it)) }
        request.style?.let { put("style", JsonPrimitive(it)) }
        request.speakerBoost?.let { put("use_speaker_boost", JsonPrimitive(it)) }
      }

    val payload =
      buildJsonObject {
        put("text", JsonPrimitive(request.text))
        request.modelId?.takeIf { it.isNotEmpty() }?.let { put("model_id", JsonPrimitive(it)) }
        request.outputFormat?.takeIf { it.isNotEmpty() }?.let { put("output_format", JsonPrimitive(it)) }
        request.seed?.let { put("seed", JsonPrimitive(it)) }
        request.normalize?.let { put("apply_text_normalization", JsonPrimitive(it)) }
        request.language?.let { put("language_code", JsonPrimitive(it)) }
        if (voiceSettingsEntries.isNotEmpty()) {
          put("voice_settings", voiceSettingsEntries)
        }
      }

    return payload.toString()
  }

  private data class ElevenLabsRequest(
    val text: String,
    val modelId: String?,
    val outputFormat: String?,
    val speed: Double?,
    val stability: Double?,
    val similarity: Double?,
    val style: Double?,
    val speakerBoost: Boolean?,
    val seed: Long?,
    val normalize: String?,
    val language: String?,
    val latencyTier: Int?,
  )

  private object TalkModeRuntime {
    fun resolveSpeed(speed: Double?, rateWpm: Int?): Double? {
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

    fun validatedUnit(value: Double?): Double? {
      if (value == null) return null
      if (value < 0 || value > 1) return null
      return value
    }

    fun validatedStability(value: Double?, modelId: String?): Double? {
      if (value == null) return null
      val normalized = modelId?.trim()?.lowercase()
      if (normalized == "eleven_v3") {
        return if (value == 0.0 || value == 0.5 || value == 1.0) value else null
      }
      return validatedUnit(value)
    }

    fun validatedSeed(value: Long?): Long? {
      if (value == null) return null
      if (value < 0 || value > 4294967295L) return null
      return value
    }

    fun validatedNormalize(value: String?): String? {
      val normalized = value?.trim()?.lowercase() ?: return null
      return if (normalized in listOf("auto", "on", "off")) normalized else null
    }

    fun validatedLanguage(value: String?): String? {
      val normalized = value?.trim()?.lowercase() ?: return null
      if (normalized.length != 2) return null
      if (!normalized.all { it in 'a'..'z' }) return null
      return normalized
    }

    fun validatedOutputFormat(value: String?): String? {
      val trimmed = value?.trim()?.lowercase() ?: return null
      if (trimmed.isEmpty()) return null
      if (trimmed.startsWith("mp3_")) return trimmed
      return if (parsePcmSampleRate(trimmed) != null) trimmed else null
    }

    fun validatedLatencyTier(value: Int?): Int? {
      if (value == null) return null
      if (value < 0 || value > 4) return null
      return value
    }

    fun parsePcmSampleRate(value: String?): Int? {
      val trimmed = value?.trim()?.lowercase() ?: return null
      if (!trimmed.startsWith("pcm_")) return null
      val suffix = trimmed.removePrefix("pcm_")
      val digits = suffix.takeWhile { it.isDigit() }
      val rate = digits.toIntOrNull() ?: return null
      return if (rate in setOf(16000, 22050, 24000, 44100)) rate else null
    }

    fun isMessageTimestampAfter(timestamp: Double, sinceSeconds: Double): Boolean {
      val sinceMs = sinceSeconds * 1000
      return if (timestamp > 10_000_000_000) {
        timestamp >= sinceMs - 500
      } else {
        timestamp >= sinceSeconds - 0.5
      }
    }
  }

  private fun ensureInterruptListener() {
    if (!interruptOnSpeech || !_isEnabled.value) return
    mainHandler.post {
      if (stopRequested) return@post
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

  private fun resolveVoiceAlias(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val normalized = normalizeAliasKey(trimmed)
    voiceAliases[normalized]?.let { return it }
    if (voiceAliases.values.any { it.equals(trimmed, ignoreCase = true) }) return trimmed
    return if (isLikelyVoiceId(trimmed)) trimmed else null
  }

  private suspend fun resolveVoiceId(preferred: String?, apiKey: String): String? {
    val trimmed = preferred?.trim().orEmpty()
    if (trimmed.isNotEmpty()) {
      val resolved = resolveVoiceAlias(trimmed)
      if (resolved != null) return resolved
      Log.w(tag, "unknown voice alias $trimmed")
    }
    fallbackVoiceId?.let { return it }

    return try {
      val voices = listVoices(apiKey)
      val first = voices.firstOrNull() ?: return null
      fallbackVoiceId = first.voiceId
      if (defaultVoiceId.isNullOrBlank()) {
        defaultVoiceId = first.voiceId
      }
      if (!voiceOverrideActive) {
        currentVoiceId = first.voiceId
      }
      val name = first.name ?: "unknown"
      Log.d(tag, "default voice selected $name (${first.voiceId})")
      first.voiceId
    } catch (err: Throwable) {
      Log.w(tag, "list voices failed: ${err.message ?: err::class.simpleName}")
      null
    }
  }

  private suspend fun listVoices(apiKey: String): List<ElevenLabsVoice> {
    return withContext(Dispatchers.IO) {
      val url = URL("https://api.elevenlabs.io/v1/voices")
      val conn = url.openConnection() as HttpURLConnection
      conn.requestMethod = "GET"
      conn.connectTimeout = 15_000
      conn.readTimeout = 15_000
      conn.setRequestProperty("xi-api-key", apiKey)

      val code = conn.responseCode
      val stream = if (code >= 400) conn.errorStream else conn.inputStream
      val data = stream.readBytes()
      if (code >= 400) {
        val message = data.toString(Charsets.UTF_8)
        throw IllegalStateException("ElevenLabs voices failed: $code $message")
      }

      val root = json.parseToJsonElement(data.toString(Charsets.UTF_8)).asObjectOrNull()
      val voices = (root?.get("voices") as? JsonArray) ?: JsonArray(emptyList())
      voices.mapNotNull { entry ->
        val obj = entry.asObjectOrNull() ?: return@mapNotNull null
        val voiceId = obj["voice_id"].asStringOrNull() ?: return@mapNotNull null
        val name = obj["name"].asStringOrNull()
        ElevenLabsVoice(voiceId, name)
      }
    }
  }

  private fun isLikelyVoiceId(value: String): Boolean {
    if (value.length < 10) return false
    return value.all { it.isLetterOrDigit() || it == '-' || it == '_' }
  }

  private fun normalizeAliasKey(value: String): String =
    value.trim().lowercase()

  private data class ElevenLabsVoice(val voiceId: String, val name: String?)

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
        scheduleRestart()
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

      override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)?.takeIf { it.isString }?.content

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
