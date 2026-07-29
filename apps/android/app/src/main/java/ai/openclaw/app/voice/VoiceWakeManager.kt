package ai.openclaw.app.voice

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal sealed interface VoiceWakeRecognitionEvent {
  data object Ready : VoiceWakeRecognitionEvent

  data class Transcript(
    val text: String,
    val isFinal: Boolean,
  ) : VoiceWakeRecognitionEvent

  data class Error(
    val code: Int,
  ) : VoiceWakeRecognitionEvent
}

internal interface VoiceWakeRecognizer {
  val isAvailable: Boolean

  fun start(
    operationId: Long,
    onEvent: (VoiceWakeRecognitionEvent) -> Unit,
  )

  fun stop(operationId: Long)

  fun destroy(operationId: Long)
}

internal class VoiceWakeRecognitionSession(
  private val onEvent: (VoiceWakeRecognitionEvent) -> Unit,
) {
  private val active = AtomicBoolean(true)

  fun emit(event: VoiceWakeRecognitionEvent) {
    if (active.get()) onEvent(event)
  }

  fun retire() {
    active.set(false)
  }
}

internal class AndroidOnDeviceVoiceWakeRecognizer(
  context: Context,
) : VoiceWakeRecognizer {
  private val appContext = context.applicationContext
  private val mainHandler = Handler(Looper.getMainLooper())
  override val isAvailable: Boolean =
    runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext) }.getOrDefault(false)
  private val latestOperationId = AtomicLong(0)
  private val platformOwnerOperationId = AtomicLong(0)
  private var recognizer: SpeechRecognizer? = null
  private var recognitionSession: VoiceWakeRecognitionSession? = null

  override fun start(
    operationId: Long,
    onEvent: (VoiceWakeRecognitionEvent) -> Unit,
  ) {
    if (!claimOperation(operationId)) return
    platformOwnerOperationId.set(operationId)
    if (operationId != latestOperationId.get()) {
      platformOwnerOperationId.compareAndSet(operationId, 0)
      return
    }
    runOnMain {
      if (operationId != latestOperationId.get()) {
        platformOwnerOperationId.compareAndSet(operationId, 0)
        return@runOnMain
      }
      retireRecognizer()
      platformOwnerOperationId.set(operationId)
      if (!isAvailable) {
        platformOwnerOperationId.compareAndSet(operationId, 0)
        onEvent(VoiceWakeRecognitionEvent.Error(SpeechRecognizer.ERROR_SERVER_DISCONNECTED))
        return@runOnMain
      }
      val session = VoiceWakeRecognitionSession(onEvent)
      try {
        val active = createRecognizer(session)
        recognitionSession = session
        recognizer = active
        active.startListening(recognizerIntent())
      } catch (_: Throwable) {
        session.retire()
        retireRecognizer()
        if (operationId == latestOperationId.get()) {
          onEvent(VoiceWakeRecognitionEvent.Error(SpeechRecognizer.ERROR_CLIENT))
        }
      }
    }
  }

  override fun stop(operationId: Long) {
    if (!claimOperation(operationId)) return
    if (platformOwnerOperationId.get() == 0L) return
    runOnMainSync {
      if (operationId == latestOperationId.get()) retireRecognizer()
    }
  }

  override fun destroy(operationId: Long) {
    if (!claimOperation(operationId)) return
    if (platformOwnerOperationId.get() == 0L) return
    runOnMainSync {
      if (operationId == latestOperationId.get()) retireRecognizer()
    }
  }

  private fun claimOperation(operationId: Long): Boolean {
    while (true) {
      val current = latestOperationId.get()
      if (operationId <= current) return false
      if (latestOperationId.compareAndSet(current, operationId)) return true
    }
  }

  private fun createRecognizer(session: VoiceWakeRecognitionSession): SpeechRecognizer =
    SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext).also { active ->
      active.setRecognitionListener(
        object : RecognitionListener {
          override fun onReadyForSpeech(params: Bundle?) {
            session.emit(VoiceWakeRecognitionEvent.Ready)
          }

          override fun onResults(results: Bundle?) {
            bestTranscript(results)?.let { session.emit(VoiceWakeRecognitionEvent.Transcript(it, isFinal = true)) }
              ?: session.emit(VoiceWakeRecognitionEvent.Error(SpeechRecognizer.ERROR_NO_MATCH))
          }

          override fun onPartialResults(partialResults: Bundle?) {
            bestTranscript(partialResults)?.let {
              session.emit(VoiceWakeRecognitionEvent.Transcript(it, isFinal = false))
            }
          }

          override fun onError(error: Int) {
            session.emit(VoiceWakeRecognitionEvent.Error(error))
          }

          override fun onBeginningOfSpeech() = Unit

          override fun onRmsChanged(rmsdB: Float) = Unit

          override fun onBufferReceived(buffer: ByteArray?) = Unit

          override fun onEndOfSpeech() = Unit

          override fun onEvent(
            eventType: Int,
            params: Bundle?,
          ) = Unit
        },
      )
    }

  private fun retireRecognizer() {
    // Retire callback ownership before cancel/destroy. Some recognizers emit a
    // late result or error after cancellation; it must not enter a new session.
    recognitionSession?.retire()
    recognitionSession = null
    platformOwnerOperationId.set(0)
    val active = recognizer
    recognizer = null
    runCatching { active?.cancel() }
    runCatching { active?.destroy() }
  }

  private fun runOnMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else mainHandler.post(action)
  }

  private fun runOnMainSync(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      action()
      return
    }
    val completed = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()
    check(
      mainHandler.post {
        try {
          action()
        } catch (err: Throwable) {
          failure.set(err)
        } finally {
          completed.countDown()
        }
      },
    ) { "main looper unavailable" }
    completed.await()
    failure.get()?.let { throw it }
  }

  private fun recognizerIntent(): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
    }

  private fun bestTranscript(bundle: Bundle?): String? =
    bundle
      ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
      ?.firstOrNull()
      ?.trim()
      ?.takeIf(String::isNotEmpty)
}

internal enum class VoiceWakeSuppressionReason {
  Camera,
  Dictation,
  GatewaySync,
  VoiceCapture,
  VoiceNote,
  VoiceReplySpeech,
  MessageSpeech,
}

internal class VoiceWakeManager(
  private val context: Context,
  private val scope: CoroutineScope,
  private val recognizer: VoiceWakeRecognizer,
  initialTriggerWords: List<String>,
  private val onCommand: suspend (VoiceWakeMatch) -> Boolean,
  private val restartDelayMs: Long = 350L,
  private val hasRecordAudioPermission: () -> Boolean = {
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
  },
) {
  private sealed interface RecognizerAction {
    val operationId: Long

    data class Start(
      override val operationId: Long,
      val sessionGeneration: Long,
    ) : RecognizerAction

    data class Stop(
      override val operationId: Long,
    ) : RecognizerAction

    data class Destroy(
      override val operationId: Long,
    ) : RecognizerAction
  }

  private val lock = Any()
  private var enabled = false
  private var foreground = false
  private var sessionGeneration = 0L
  private var sessionActive = false
  private var commandInFlight = false
  private var commandJob: Job? = null
  private var restartJob: Job? = null
  private var recognizerOperationId = 0L
  private val suppressionReasons = mutableSetOf<VoiceWakeSuppressionReason>()
  private val suppressionRevisions = mutableMapOf<VoiceWakeSuppressionReason, Long>()
  private var triggerWords = VoiceWakePreferences.sanitizeTriggerWords(initialTriggerWords)

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

  private val _statusText = MutableStateFlow<NativeText>(nativeText("Off"))
  val statusText: StateFlow<String> = _statusText.resolveNativeText()

  private val _lastTriggeredCommand = MutableStateFlow<String?>(null)
  val lastTriggeredCommand: StateFlow<String?> = _lastTriggeredCommand.asStateFlow()

  val isAvailable: Boolean
    get() = recognizer.isAvailable

  fun setEnabled(value: Boolean) {
    val action =
      synchronized(lock) {
        enabled = value
        reconcileLocked()
      }
    performRecognizerAction(action)
  }

  fun setForeground(value: Boolean) {
    val action =
      synchronized(lock) {
        foreground = value
        reconcileLocked()
      }
    performRecognizerAction(action)
  }

  fun setSuppressed(
    reason: VoiceWakeSuppressionReason,
    suppressed: Boolean,
    revision: Long? = null,
  ) {
    val action =
      synchronized(lock) {
        if (revision != null) {
          val currentRevision = suppressionRevisions[reason] ?: 0L
          if (revision <= currentRevision) return
          suppressionRevisions[reason] = revision
        }
        if (suppressed) suppressionReasons += reason else suppressionReasons -= reason
        reconcileLocked()
      }
    performRecognizerAction(action)
  }

  fun updateTriggerWords(words: List<String>) {
    synchronized(lock) {
      triggerWords = VoiceWakePreferences.sanitizeTriggerWords(words)
    }
  }

  fun refreshPermission() {
    val action = synchronized(lock) { reconcileLocked() }
    performRecognizerAction(action)
  }

  fun shutdown() {
    val action =
      synchronized(lock) {
        enabled = false
        foreground = false
        val pendingAction = stopSessionLocked(destroy = true)
        _statusText.value = nativeText("Off")
        pendingAction
      }
    performRecognizerAction(action)
  }

  private fun reconcileLocked(): RecognizerAction? {
    val blockedStatus = blockedStatusLocked()
    if (blockedStatus != null) {
      val action = stopSessionLocked(destroy = !enabled || !foreground)
      _statusText.value = blockedStatus
      return action
    }
    if (!sessionActive && !commandInFlight && restartJob?.isActive != true) {
      return startSessionLocked()
    }
    return null
  }

  private fun blockedStatusLocked(): NativeText? =
    when {
      !enabled -> nativeText("Off")
      !recognizer.isAvailable -> nativeText("On-device speech recognition unavailable")
      !hasRecordAudioPermission() -> nativeText("Microphone permission required")
      !foreground || suppressionReasons.isNotEmpty() -> nativeText("Paused")
      else -> null
    }

  private fun startSessionLocked(): RecognizerAction {
    sessionGeneration += 1
    val generation = sessionGeneration
    sessionActive = true
    _isListening.value = false
    _statusText.value = nativeText("Starting…")
    return RecognizerAction.Start(nextRecognizerOperationIdLocked(), generation)
  }

  private fun handleRecognitionEvent(
    generation: Long,
    event: VoiceWakeRecognitionEvent,
  ) {
    val action =
      synchronized(lock) {
        if (generation != sessionGeneration || !sessionActive) return
        when (event) {
          VoiceWakeRecognitionEvent.Ready -> {
            _isListening.value = true
            _statusText.value = nativeText("Listening")
            null
          }
          is VoiceWakeRecognitionEvent.Transcript -> {
            // Android partials routinely stop mid-command. Only a final transcript
            // has the recognizer's end-of-utterance boundary and is safe to dispatch.
            if (!event.isFinal) return
            val transcriptAction = handleTranscriptLocked(event.text)
            if (transcriptAction == null) {
              sessionActive = false
              _isListening.value = false
              scheduleRestartLocked()
            }
            transcriptAction
          }
          is VoiceWakeRecognitionEvent.Error -> {
            sessionActive = false
            _isListening.value = false
            if (event.code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
              _statusText.value = nativeText("Microphone permission required")
            } else if (event.code == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED) {
              _statusText.value = nativeText("Device language not supported")
            } else if (event.code == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) {
              _statusText.value = nativeText("On-device language model unavailable")
            } else {
              scheduleRestartLocked(delayMs = retryDelayMs(event.code))
            }
            null
          }
        }
      }
    performRecognizerAction(action)
  }

  private fun handleTranscriptLocked(transcript: String): RecognizerAction? {
    if (commandInFlight) return null
    val match = VoiceWakePhraseMatcher.match(transcript, triggerWords) ?: return null
    sessionGeneration += 1
    val commandGeneration = sessionGeneration
    sessionActive = false
    commandInFlight = true
    _isListening.value = false
    _lastTriggeredCommand.value = match.command
    _statusText.value = nativeText("Triggered")
    val action = RecognizerAction.Stop(nextRecognizerOperationIdLocked())
    commandJob =
      scope.launch {
        var delivered = false
        try {
          delivered = onCommand(match)
        } finally {
          synchronized(lock) {
            if (commandGeneration == sessionGeneration) {
              commandJob = null
              commandInFlight = false
              scheduleRestartLocked()
              if (!delivered) _statusText.value = nativeText("Gateway unavailable")
            }
          }
        }
      }
    return action
  }

  private fun scheduleRestartLocked(delayMs: Long = restartDelayMs) {
    restartJob?.cancel()
    val blockedStatus = blockedStatusLocked()
    if (blockedStatus != null) {
      _statusText.value = blockedStatus
      return
    }
    _statusText.value = nativeText("Starting…")
    restartJob =
      scope.launch {
        delay(delayMs)
        val action =
          synchronized(lock) {
            restartJob = null
            reconcileLocked()
          }
        performRecognizerAction(action)
      }
  }

  private fun retryDelayMs(errorCode: Int): Long =
    when (errorCode) {
      SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> 15_000L
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
      SpeechRecognizer.ERROR_SERVER,
      SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
      SpeechRecognizer.ERROR_AUDIO,
      SpeechRecognizer.ERROR_CLIENT,
      -> 1_500L
      else -> restartDelayMs
    }

  private fun stopSessionLocked(destroy: Boolean): RecognizerAction? {
    restartJob?.cancel()
    restartJob = null
    commandJob?.cancel()
    commandJob = null
    commandInFlight = false
    sessionGeneration += 1
    val wasActive = sessionActive
    sessionActive = false
    _isListening.value = false
    return when {
      destroy -> RecognizerAction.Destroy(nextRecognizerOperationIdLocked())
      wasActive -> RecognizerAction.Stop(nextRecognizerOperationIdLocked())
      else -> null
    }
  }

  private fun nextRecognizerOperationIdLocked(): Long {
    recognizerOperationId += 1
    return recognizerOperationId
  }

  private fun performRecognizerAction(action: RecognizerAction?) {
    when (action) {
      is RecognizerAction.Start ->
        recognizer.start(action.operationId) { event ->
          handleRecognitionEvent(action.sessionGeneration, event)
        }
      is RecognizerAction.Stop -> recognizer.stop(action.operationId)
      is RecognizerAction.Destroy -> recognizer.destroy(action.operationId)
      null -> Unit
    }
  }
}

internal class PreviewVoiceWakeRecognizer : VoiceWakeRecognizer {
  override val isAvailable: Boolean = true

  override fun start(
    operationId: Long,
    onEvent: (VoiceWakeRecognitionEvent) -> Unit,
  ) {
    onEvent(VoiceWakeRecognitionEvent.Ready)
  }

  override fun stop(operationId: Long) = Unit

  override fun destroy(operationId: Long) = Unit
}
