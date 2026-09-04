package ai.openclaw.app.voice

import ai.openclaw.app.gateway.ChatSendAck
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.coroutineContext

/**
 * UI transcript role emitted by microphone capture and assistant streaming.
 */
enum class VoiceConversationRole {
  User,
  Assistant,
}

/** UI transcript entry retained for recent voice turns. */
data class VoiceConversationEntry(
  val id: String,
  val role: VoiceConversationRole,
  val text: String,
  val isStreaming: Boolean = false,
  val localizedSource: String? = null,
)

internal data class GatewayTranscriptionSession(
  val id: String,
  val gatewayId: String,
)

/** Coordinates live mic transcription, queued sends, and assistant audio replies. */
internal class MicCaptureManager(
  private val context: Context,
  private val scope: CoroutineScope,
  private val preferredAudioInputDevice: () -> String? = { null },
  private val onAppliedAudioInputChanged: (String?) -> Unit = {},
  private val createTranscriptionSession: suspend () -> GatewayTranscriptionSession,
  private val appendTranscriptionAudio: suspend (
    session: GatewayTranscriptionSession,
    audio: ByteArray,
    onError: (String) -> Unit,
  ) -> Unit,
  private val closeTranscriptionSession: suspend (session: GatewayTranscriptionSession) -> Unit,
  /**
   * Send [message] to the gateway and return the full chat.send ACK.
   * [onRunIdKnown] is called with the idempotency key *before* the network
   * round-trip so [pendingRunId] is set before any chat events can arrive.
   */
  private val sendToGateway: suspend (message: String, onRunIdKnown: (String) -> Unit) -> ChatSendAck,
  private val refreshAfterTerminalSuccess: suspend () -> Unit = {},
  private val speakAssistantReply: suspend (String) -> Unit = {},
) {
  companion object {
    private const val tag = "MicCapture"
    private const val transcriptionSampleRateHz = 8_000
    private const val transcriptionAudioFrameMs = 100
    private const val pcmuBias = 0x84
    private const val pcmuClip = 32635
    private const val transcriptIdleFlushMs = 1_600L
    private const val maxConversationEntries = 40
    private const val pendingRunTimeoutMs = 45_000L
  }

  private val json = Json { ignoreUnknownKeys = true }

  private val _micEnabled = MutableStateFlow(false)
  val micEnabled: StateFlow<Boolean> = _micEnabled

  private val _micCooldown = MutableStateFlow(false)
  val micCooldown: StateFlow<Boolean> = _micCooldown

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening

  private val _statusText = MutableStateFlow<NativeText>(nativeText("Mic off"))
  val statusText: StateFlow<String> = _statusText.resolveNativeText()

  private val _liveTranscript = MutableStateFlow<String?>(null)
  val liveTranscript: StateFlow<String?> = _liveTranscript

  private val _conversation = MutableStateFlow<List<VoiceConversationEntry>>(emptyList())
  val conversation: StateFlow<List<VoiceConversationEntry>> = _conversation

  private val _isSending = MutableStateFlow(false)
  val isSending: StateFlow<Boolean> = _isSending

  private val messageQueue = ArrayDeque<String>()
  private val messageQueueLock = Any()
  private var flushedPartialTranscript: String? = null

  // Correlates chat events with the idempotency key generated before sendChat returns.
  private var pendingRunId: String? = null
  private var pendingAssistantEntryId: String? = null
  private var gatewayConnected = false
  private var gatewayGeneration = 0L

  @Volatile private var transcriptionSession: GatewayTranscriptionSession? = null
  private var transcriptionStartJob: Job? = null
  private var transcriptionCaptureJob: Job? = null
  private val audioInputGeneration = AtomicLong()

  @Volatile private var transcriptionAudioInput: AndroidAudioInputSession? = null
  internal val audioRetirement = AudioRetirement(scope)
  private var transcriptionAppendJob: Job? = null
  private var transcriptionDrainJob: Job? = null
  private var transcriptFlushJob: Job? = null
  private var pendingRunTimeoutJob: Job? = null
  private var sendJob: Job? = null
  private var stopRequested = false
  private val ttsPauseLock = Any()
  private var ttsPauseDepth = 0
  private var resumeMicAfterTts = false

  private fun enqueueMessage(message: String) {
    synchronized(messageQueueLock) {
      messageQueue.addLast(message)
    }
  }

  private fun hasQueuedMessages(): Boolean =
    synchronized(messageQueueLock) {
      messageQueue.isNotEmpty()
    }

  private fun firstQueuedMessage(): String? =
    synchronized(messageQueueLock) {
      messageQueue.firstOrNull()
    }

  private fun removeFirstQueuedMessage(): String? =
    synchronized(messageQueueLock) {
      if (messageQueue.isEmpty()) null else messageQueue.removeFirst()
    }

  private fun queuedMessageCount(): Int =
    synchronized(messageQueueLock) {
      messageQueue.size
    }

  /** Toggles manual microphone capture, draining partial transcripts when capture turns off. */
  fun setMicEnabled(enabled: Boolean) {
    if (_micEnabled.value == enabled) return
    _micEnabled.value = enabled
    if (enabled) {
      val pausedForTts =
        synchronized(ttsPauseLock) {
          if (ttsPauseDepth > 0) {
            resumeMicAfterTts = true
            true
          } else {
            false
          }
        }
      if (pausedForTts) {
        _statusText.value = if (_isSending.value) nativeText("Speaking · waiting for reply") else nativeText("Speaking…")
        return
      }
      transcriptionDrainJob?.cancel()
      transcriptionDrainJob = null
      _micCooldown.value = false
      start()
      sendQueuedIfIdle()
    } else {
      transcriptionDrainJob?.cancel()
      _micCooldown.value = true
      transcriptionDrainJob =
        scope.launch {
          delay(2000L)
          stop()
          val partial = _liveTranscript.value?.trim().orEmpty()
          if (partial.isNotEmpty()) {
            queueRecognizedMessage(partial)
          }
          transcriptionDrainJob = null
          _micCooldown.value = false
          sendQueuedIfIdle()
        }
    }
  }

  /** Immediately stops capture and drops any unsent partial transcript. */
  fun cancelMicCapture() {
    transcriptionDrainJob?.cancel()
    transcriptionDrainJob = null
    _micEnabled.value = false
    _micCooldown.value = false
    _liveTranscript.value = null
    stop()
  }

  internal suspend fun awaitCaptureStopped() {
    transcriptionDrainJob?.join()
    audioRetirement.await()
  }

  /** Pauses capture while local TTS plays so speaker output is not transcribed as user speech. */
  suspend fun pauseForTts() {
    synchronized(ttsPauseLock) {
      ttsPauseDepth += 1
      if (ttsPauseDepth == 1) {
        resumeMicAfterTts = _micEnabled.value
        if (resumeMicAfterTts || transcriptionSession != null || _isListening.value) {
          stopRequested = true
          transcriptFlushJob?.cancel()
          transcriptFlushJob = null
          _isListening.value = false
          _liveTranscript.value = null
          _statusText.value = if (_isSending.value) nativeText("Speaking · waiting for reply") else nativeText("Speaking…")
          stopTranscription(preserveStatus = true)
        }
      }
    }
    audioRetirement.await()
  }

  /** Resumes capture after all nested TTS playback pauses have completed. */
  suspend fun resumeAfterTts() {
    val shouldResume =
      synchronized(ttsPauseLock) {
        if (ttsPauseDepth == 0) return@synchronized false
        ttsPauseDepth -= 1
        if (ttsPauseDepth > 0) return@synchronized false
        val resume = resumeMicAfterTts && _micEnabled.value
        resumeMicAfterTts = false
        if (!resume) {
          _statusText.value =
            when {
              _micEnabled.value && _isSending.value -> nativeText("Listening · sending queued voice")
              _micEnabled.value -> nativeText("Listening")
              _isSending.value -> nativeText("Mic off · sending…")
              else -> nativeText("Mic off")
            }
        }
        resume
      }
    if (!shouldResume) return
    stopRequested = false
    start()
    sendQueuedIfIdle()
  }

  /** Starts or stops gateway-dependent capture/send work when the operator session changes state. */
  fun onGatewayConnectionChanged(connected: Boolean) {
    gatewayConnected = connected
    if (connected) {
      if (_micEnabled.value && transcriptionSession == null) {
        start()
      }
      sendQueuedIfIdle()
      return
    }
    stopRequested = true
    stopTranscription(preserveStatus = true)
    pendingRunTimeoutJob?.cancel()
    pendingRunTimeoutJob = null
    pendingRunId = null
    pendingAssistantEntryId = null
    _isSending.value = false
    if (hasQueuedMessages()) {
      _statusText.value = queuedWaitingStatus()
    }
  }

  /** Retires voice data owned by the old gateway before another gateway can connect. */
  fun onGatewayScopeChanging() {
    gatewayGeneration += 1
    gatewayConnected = false
    transcriptionDrainJob?.cancel()
    transcriptionDrainJob = null
    transcriptFlushJob?.cancel()
    transcriptFlushJob = null
    transcriptionStartJob?.cancel()
    transcriptionStartJob = null
    sendJob?.cancel()
    sendJob = null
    pendingRunTimeoutJob?.cancel()
    pendingRunTimeoutJob = null
    pendingRunId = null
    pendingAssistantEntryId = null
    synchronized(messageQueueLock) { messageQueue.clear() }
    _conversation.value = emptyList()
    _liveTranscript.value = null
    flushedPartialTranscript = null
    _isSending.value = false
    stopRequested = true
    stopTranscription(preserveStatus = true)
    _statusText.value = if (_micEnabled.value) nativeText("Mic on · waiting for gateway") else nativeText("Mic off")
  }

  internal fun submitTranscribedMessage(text: String) {
    queueRecognizedMessage(text)
    sendQueuedIfIdle()
  }

  /** Handles transcription and chat events that update live voice transcript/reply state. */
  fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (event == "talk.event") {
      handleTranscriptionEvent(payloadJson)
      return
    }
    if (event != "chat") return
    if (payloadJson.isNullOrBlank()) return
    val payload =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return

    val runId =
      pendingRunId ?: run {
        Log.d("MicCapture", "no pendingRunId — drop")
        return
      }
    val eventRunId = payload["runId"].asStringOrNull() ?: return
    if (eventRunId != runId) {
      Log.d("MicCapture", "runId mismatch: event=$eventRunId pending=$runId")
      return
    }

    when (payload["state"].asStringOrNull()) {
      "delta" -> {
        val deltaText = parseAssistantText(payload)
        if (!deltaText.isNullOrBlank()) {
          upsertPendingAssistant(text = deltaText.trim(), isStreaming = true)
        }
      }

      "final" -> {
        val finalText = parseAssistantText(payload)?.trim().orEmpty()
        if (finalText.isNotEmpty()) {
          upsertPendingAssistant(text = finalText, isStreaming = false)
          playAssistantReplyAsync(finalText)
        } else if (pendingAssistantEntryId != null) {
          updateConversationEntry(pendingAssistantEntryId!!, text = null, isStreaming = false)
        }
        completePendingTurn()
      }

      "error" -> {
        val gatewayError =
          payload["errorMessage"]
            .asStringOrNull()
            ?.trim()
            .orEmpty()
        if (gatewayError.isNotEmpty()) {
          upsertPendingAssistant(text = gatewayError, isStreaming = false)
        } else {
          val failure = nativeText("Voice request failed")
          upsertPendingAssistant(
            text = failure.resolveNativeText(),
            isStreaming = false,
            localizedSource = failure.source,
          )
        }
        completePendingTurn()
      }

      "aborted" -> {
        val abortedText = nativeText("Response aborted")
        upsertPendingAssistant(
          text = abortedText.resolveNativeText(),
          isStreaming = false,
          localizedSource = abortedText.source,
        )
        completePendingTurn()
      }
    }
  }

  private fun start() {
    stopRequested = false
    if (!hasMicPermission()) {
      _statusText.value = nativeText("Microphone permission required")
      _micEnabled.value = false
      return
    }
    if (!gatewayConnected) {
      _statusText.value = nativeText("Mic on · waiting for gateway")
      return
    }
    synchronized(ttsPauseLock) {
      transcriptionSession?.let { session ->
        if (transcriptionCaptureJob?.isActive != true) {
          startTranscriptionCapture(session)
        }
        return
      }
    }
    if (transcriptionStartJob?.isActive == true) return

    val generation = audioInputGeneration.incrementAndGet()
    val startJob =
      scope.launch {
        var restartAfterCancellation = false
        try {
          audioRetirement.await()
          val session = createTranscriptionSession()
          val admitted =
            synchronized(ttsPauseLock) {
              if (generation != audioInputGeneration.get() || stopRequested || !_micEnabled.value) {
                false
              } else {
                transcriptionSession = session
                _isListening.value = true
                _statusText.value = listeningStatus()
                startTranscriptionCapture(session)
                true
              }
            }
          if (!admitted) {
            restartAfterCancellation = _micEnabled.value && gatewayConnected && !stopRequested
            closeTranscriptionSession(session)
            return@launch
          }
          Log.d(tag, "transcription session started sessionId=${session.id}")
        } catch (err: Throwable) {
          if (err is CancellationException) {
            restartAfterCancellation = _micEnabled.value && gatewayConnected && !stopRequested
            return@launch
          }
          val message = err.message ?: err::class.simpleName.orEmpty()
          if (!finishTranscription(generation = generation, failure = nativeText("Transcription unavailable: \$message", message))) {
            restartAfterCancellation = _micEnabled.value && gatewayConnected && !stopRequested
          }
        } finally {
          if (transcriptionStartJob === coroutineContext[Job]) {
            transcriptionStartJob = null
          }
          if (restartAfterCancellation) {
            start()
          }
        }
      }
    transcriptionStartJob = startJob
  }

  private fun stop() {
    stopRequested = true
    stopTranscription()
  }

  private fun stopTranscription(preserveStatus: Boolean = false) =
    synchronized(ttsPauseLock) {
      val status = _statusText.value
      val session = transcriptionSession
      transcriptionSession = null
      audioInputGeneration.incrementAndGet()
      onAppliedAudioInputChanged(null)
      if (session != null) {
        transcriptionStartJob?.cancel()
        transcriptionStartJob = null
      } else if (transcriptionStartJob?.isActive != true) {
        transcriptionStartJob = null
      }
      audioRetirement.retire(transcriptionCaptureJob, transcriptionAudioInput)
      transcriptionAudioInput = null
      transcriptionAppendJob?.cancel()
      transcriptionCaptureJob = null
      transcriptionAppendJob = null
      transcriptFlushJob?.cancel()
      transcriptFlushJob = null
      _isListening.value = false
      if (!preserveStatus) {
        _statusText.value = if (_isSending.value) nativeText("Mic off · sending…") else nativeText("Mic off")
      } else {
        _statusText.value = status
      }
      if (session != null) {
        scope.launch {
          try {
            closeTranscriptionSession(session)
          } catch (err: Throwable) {
            if (err !is CancellationException) {
              Log.d(tag, "transcription close ignored: ${err.message ?: err::class.simpleName}")
            }
          }
        }
      }
    }

  private fun queueRecognizedMessage(text: String) {
    val message = text.trim()
    _liveTranscript.value = null
    if (!message.hasTranscriptContent()) return
    appendConversation(
      role = VoiceConversationRole.User,
      text = message,
    )
    enqueueMessage(message)
  }

  private fun scheduleTranscriptFlush(expectedText: String) {
    transcriptFlushJob?.cancel()
    transcriptFlushJob =
      scope.launch {
        delay(transcriptIdleFlushMs)
        if (!_micEnabled.value || _isSending.value) return@launch
        val current = _liveTranscript.value?.trim().orEmpty()
        if (current.isEmpty() || current != expectedText) return@launch
        flushedPartialTranscript = current
        queueRecognizedMessage(current)
        sendQueuedIfIdle()
      }
  }

  private fun sendQueuedIfIdle() {
    if (_isSending.value) return
    if (!hasQueuedMessages()) {
      if (_micEnabled.value) {
        _statusText.value = nativeText("Listening")
      } else {
        _statusText.value = nativeText("Mic off")
      }
      return
    }
    if (!gatewayConnected) {
      _statusText.value = queuedWaitingStatus()
      return
    }

    val next = firstQueuedMessage() ?: return
    _isSending.value = true
    pendingRunTimeoutJob?.cancel()
    pendingRunTimeoutJob = null
    _statusText.value = if (_micEnabled.value) nativeText("Listening · sending queued voice") else nativeText("Sending queued voice")

    val sendGeneration = gatewayGeneration
    sendJob =
      scope.launch {
        try {
          val ack =
            sendToGateway(next) { earlyRunId ->
              // Called with the idempotency key before chat.send fires so that
              // pendingRunId is populated before any chat events can arrive.
              if (sendGeneration == gatewayGeneration) {
                pendingRunId = earlyRunId
              }
            }
          if (sendGeneration != gatewayGeneration) return@launch
          val runId = ack.runId
          // Update to the real runId if the gateway returned a different one.
          if (runId != null && runId != pendingRunId) pendingRunId = runId
          when {
            ack.isTerminalSuccess -> {
              completePendingTurn()
              refreshAfterTerminalSuccess()
            }

            ack.isTerminalFailure -> {
              completePendingTurn()
              _statusText.value = nativeText("Send failed: Chat failed before the run started; try again.")
            }

            runId == null -> {
              completePendingTurn()
            }

            else -> {
              armPendingRunTimeout(runId)
            }
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          if (sendGeneration != gatewayGeneration) return@launch
          pendingRunTimeoutJob?.cancel()
          pendingRunTimeoutJob = null
          _isSending.value = false
          pendingRunId = null
          pendingAssistantEntryId = null
          _statusText.value =
            if (!gatewayConnected) {
              queuedWaitingStatus()
            } else {
              nativeText("Send failed: \$message", err.message ?: err::class.simpleName.orEmpty())
            }
        } finally {
          if (sendGeneration == gatewayGeneration) {
            sendJob = null
          }
        }
      }
  }

  private fun armPendingRunTimeout(runId: String) {
    pendingRunTimeoutJob?.cancel()
    pendingRunTimeoutJob =
      scope.launch {
        delay(pendingRunTimeoutMs)
        if (pendingRunId != runId) return@launch
        pendingRunId = null
        pendingAssistantEntryId = null
        _isSending.value = false
        _statusText.value =
          if (gatewayConnected) {
            nativeText("Voice reply timed out; retrying queued turn")
          } else {
            queuedWaitingStatus()
          }
        sendQueuedIfIdle()
      }
  }

  private fun completePendingTurn() {
    pendingRunTimeoutJob?.cancel()
    pendingRunTimeoutJob = null
    removeFirstQueuedMessage()
    pendingRunId = null
    pendingAssistantEntryId = null
    _isSending.value = false
    sendQueuedIfIdle()
  }

  private fun queuedWaitingStatus(): NativeText = nativeText("\${queuedMessageCount()} queued · waiting for gateway", queuedMessageCount())

  private fun appendConversation(
    role: VoiceConversationRole,
    text: String,
    isStreaming: Boolean = false,
    localizedSource: String? = null,
  ): String {
    val id = UUID.randomUUID().toString()
    _conversation.value =
      (
        _conversation.value +
          VoiceConversationEntry(
            id = id,
            role = role,
            text = text,
            isStreaming = isStreaming,
            localizedSource = localizedSource,
          )
      ).takeLast(maxConversationEntries)
    return id
  }

  private fun updateConversationEntry(
    id: String,
    text: String?,
    isStreaming: Boolean,
    localizedSource: String? = null,
  ) {
    val current = _conversation.value
    if (current.isEmpty()) return

    val targetIndex =
      when {
        current[current.lastIndex].id == id -> current.lastIndex
        else -> current.indexOfFirst { it.id == id }
      }
    if (targetIndex < 0) return

    val entry = current[targetIndex]
    val updatedText = text ?: entry.text
    val updatedLocalizedSource =
      if (text == null && localizedSource == null) {
        entry.localizedSource
      } else {
        localizedSource
      }
    if (updatedText == entry.text && entry.isStreaming == isStreaming && entry.localizedSource == updatedLocalizedSource) return
    val updated = current.toMutableList()
    updated[targetIndex] = entry.copy(text = updatedText, isStreaming = isStreaming, localizedSource = updatedLocalizedSource)
    _conversation.value = updated
  }

  private fun upsertPendingAssistant(
    text: String,
    isStreaming: Boolean,
    localizedSource: String? = null,
  ) {
    val currentId = pendingAssistantEntryId
    if (currentId == null) {
      pendingAssistantEntryId =
        appendConversation(
          role = VoiceConversationRole.Assistant,
          text = text,
          isStreaming = isStreaming,
          localizedSource = localizedSource,
        )
      return
    }
    updateConversationEntry(
      id = currentId,
      text = text,
      isStreaming = isStreaming,
      localizedSource = localizedSource,
    )
  }

  private fun playAssistantReplyAsync(text: String) {
    val spoken = text.trim()
    if (spoken.isEmpty()) return
    scope.launch {
      try {
        speakAssistantReply(spoken)
      } catch (err: Throwable) {
        Log.w(tag, "assistant speech failed: ${err.message ?: err::class.simpleName}")
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun startTranscriptionCapture(session: GatewayTranscriptionSession) {
    audioRetirement.retire(transcriptionCaptureJob, transcriptionAudioInput)
    transcriptionAudioInput = null
    transcriptionAppendJob?.cancel()
    val inputGeneration = audioInputGeneration.incrementAndGet()

    fun fail(message: String) {
      finishTranscription(session, inputGeneration, nativeText("Transcription failed: \$message", message))
    }
    onAppliedAudioInputChanged(null)
    val audioFrames =
      Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    // Drop oldest frames under network backpressure so the live transcription
    // session stays close to real time instead of replaying stale audio.
    transcriptionAppendJob =
      scope.launch(Dispatchers.IO) {
        for (frame in audioFrames) {
          if (transcriptionSession != session || audioInputGeneration.get() != inputGeneration) continue
          try {
            appendTranscriptionAudio(session, pcm16ToPcmu(frame), ::fail)
          } catch (err: Throwable) {
            if (err is CancellationException) throw err
            fail(err.message ?: err::class.simpleName ?: "request failed")
          }
        }
      }
    transcriptionCaptureJob =
      scope.launch(Dispatchers.IO) {
        var audioInput: AndroidAudioInputSession? = null
        val captureJob = coroutineContext[Job]
        val isCurrent = { captureJob?.isActive == true && audioInputGeneration.get() == inputGeneration && transcriptionSession == session }
        try {
          audioRetirement.await()
          val frameBytes = transcriptionSampleRateHz * 2 * transcriptionAudioFrameMs / 1000
          val openedAudioInput =
            AndroidAudioInputSession.open(
              context,
              transcriptionSampleRateHz,
              frameBytes,
              preferredAudioInputDevice(),
              { key ->
                if (isCurrent()) onAppliedAudioInputChanged(key)
              },
              isCurrent = isCurrent,
            )
          audioInput = openedAudioInput
          synchronized(ttsPauseLock) {
            if (!isCurrent()) return@launch
            transcriptionAudioInput = openedAudioInput
          }
          val buffer = ByteArray(frameBytes)
          audioInput.startRecording()
          while (isCurrent() && _micEnabled.value) {
            val read = audioInput.read(buffer, 0, buffer.size)
            if (read <= 0) continue
            audioFrames.trySend(buffer.copyOf(read))
          }
        } catch (err: Throwable) {
          if (err is CancellationException) throw err
          fail(err.message ?: err::class.simpleName ?: "capture failed")
        } finally {
          audioFrames.close()
          synchronized(ttsPauseLock) {
            if (transcriptionAudioInput === audioInput) transcriptionAudioInput = null
          }
          audioInput?.close()
          synchronized(ttsPauseLock) {
            // Re-enable can arrive after the read loop exits but before this job completes.
            if (captureJob?.isActive == true &&
              audioInputGeneration.get() == inputGeneration &&
              transcriptionSession == session &&
              _micEnabled.value &&
              !stopRequested
            ) {
              startTranscriptionCapture(session)
            }
          }
        }
      }
  }

  private fun handleTranscriptionEvent(payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val sessionId = obj["transcriptionSessionId"].asStringOrNull() ?: obj["sessionId"].asStringOrNull()
    val currentSession = transcriptionSession
    if (currentSession == null || sessionId != currentSession.id) return

    when (obj["type"].asStringOrNull()) {
      "ready", "inputAudio", "speechStart" -> {
        _isListening.value = true
        _statusText.value = listeningStatus()
      }

      "partial" -> {
        val text = obj["text"].asStringOrNull()?.trim().orEmpty()
        if (text.isNotEmpty()) {
          _liveTranscript.value = text
          scheduleTranscriptFlush(text)
        }
      }

      "transcript" -> {
        transcriptFlushJob?.cancel()
        transcriptFlushJob = null
        val text = obj["text"].asStringOrNull()?.trim().orEmpty()
        if (text.isNotEmpty()) {
          if (text != flushedPartialTranscript) {
            submitTranscribedMessage(text)
          } else {
            flushedPartialTranscript = null
            _liveTranscript.value = null
          }
        }
      }

      "error" -> {
        val message =
          obj["message"]
            .asStringOrNull()
            ?.trim()
            .orEmpty()
            .ifEmpty { "transcription failed" }
        finishTranscription(currentSession, failure = nativeText("Transcription failed: \$message", message))
      }

      "close" -> {
        finishTranscription(currentSession)
      }
    }
  }

  private fun finishTranscription(
    session: GatewayTranscriptionSession? = null,
    generation: Long? = null,
    failure: NativeText? = null,
  ): Boolean =
    synchronized(ttsPauseLock) {
      // A provider can outlive an input capture. Retained capture callbacks must match both owners.
      if ((session != null && transcriptionSession != session) || (generation != null && audioInputGeneration.get() != generation)) return false
      _micEnabled.value = false
      if (failure != null) _statusText.value = failure
      stopTranscription(preserveStatus = failure != null)
      true
    }

  private fun listeningStatus(): NativeText =
    when {
      _isSending.value -> nativeText("Listening · sending queued voice")
      hasQueuedMessages() -> nativeText("Listening · \${queuedMessageCount()} queued", queuedMessageCount())
      else -> nativeText("Listening")
    }

  private fun pcm16ToPcmu(pcm16: ByteArray): ByteArray {
    val output = ByteArray(pcm16.size / 2)
    var inputIndex = 0
    var outputIndex = 0
    while (inputIndex + 1 < pcm16.size) {
      val sample =
        (
          (pcm16[inputIndex].toInt() and 0xff) or
            (pcm16[inputIndex + 1].toInt() shl 8)
        ).toShort().toInt()
      output[outputIndex] = linear16ToPcmu(sample)
      inputIndex += 2
      outputIndex += 1
    }
    return output
  }

  private fun linear16ToPcmu(sample: Int): Byte {
    var sign = 0
    var magnitude = sample
    if (magnitude < 0) {
      sign = 0x80
      magnitude = -magnitude
    }
    if (magnitude > pcmuClip) {
      magnitude = pcmuClip
    }
    magnitude += pcmuBias

    var exponent = 7
    var mask = 0x4000
    while ((magnitude and mask) == 0 && exponent > 0) {
      exponent -= 1
      mask = mask shr 1
    }
    val mantissa = (magnitude shr (exponent + 3)) and 0x0f
    return (sign or (exponent shl 4) or mantissa).inv().toByte()
  }

  private fun hasMicPermission(): Boolean =
    (
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    )

  private fun parseAssistantText(payload: JsonObject): String? = ChatEventText.assistantTextFromPayload(payload)
}

private fun kotlinx.serialization.json.JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun kotlinx.serialization.json.JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun String.hasTranscriptContent(): Boolean = any { it.isLetterOrDigit() }
