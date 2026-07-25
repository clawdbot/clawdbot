package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

internal enum class ChatDictationFailure {
  Unavailable,
  PermissionRequired,
  Busy,
  Network,
  NoSpeech,
  Generic,
}

internal sealed interface ChatDictationState {
  data object Idle : ChatDictationState

  data object Starting : ChatDictationState

  data object Listening : ChatDictationState

  data class Failure(
    val reason: ChatDictationFailure,
  ) : ChatDictationState
}

internal sealed interface ChatDictationRecognitionEvent {
  data object Ready : ChatDictationRecognitionEvent

  data class Transcript(
    val text: String,
  ) : ChatDictationRecognitionEvent

  data class Error(
    val code: Int,
  ) : ChatDictationRecognitionEvent
}

internal interface ChatDictationRecognizer {
  val isAvailable: Boolean

  fun start(onEvent: (ChatDictationRecognitionEvent) -> Unit)

  fun finish()

  fun cancel()

  fun destroy()
}

internal class AndroidChatDictationRecognizer(
  context: Context,
) : ChatDictationRecognizer {
  private val appContext = context.applicationContext
  override val isAvailable: Boolean =
    runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext) }.getOrDefault(false)
  private var generation = 0L
  private var recognizer: SpeechRecognizer? = null

  override fun start(onEvent: (ChatDictationRecognitionEvent) -> Unit) {
    generation += 1
    val operation = generation
    retireRecognizer()
    if (!isAvailable) {
      onEvent(ChatDictationRecognitionEvent.Error(SpeechRecognizer.ERROR_SERVER_DISCONNECTED))
      return
    }
    val active = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
    active.setRecognitionListener(
      object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
          emit(operation, onEvent, ChatDictationRecognitionEvent.Ready)
        }

        override fun onResults(results: Bundle?) {
          val transcript =
            results
              ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
              ?.firstOrNull()
              ?.trim()
              .orEmpty()
          if (transcript.isEmpty()) {
            emit(operation, onEvent, ChatDictationRecognitionEvent.Error(SpeechRecognizer.ERROR_NO_MATCH))
          } else {
            emit(operation, onEvent, ChatDictationRecognitionEvent.Transcript(transcript))
          }
        }

        override fun onError(error: Int) {
          emit(operation, onEvent, ChatDictationRecognitionEvent.Error(error))
        }

        override fun onBeginningOfSpeech() = Unit

        override fun onRmsChanged(rmsdB: Float) = Unit

        override fun onBufferReceived(buffer: ByteArray?) = Unit

        override fun onEndOfSpeech() = Unit

        override fun onPartialResults(partialResults: Bundle?) = Unit

        override fun onEvent(
          eventType: Int,
          params: Bundle?,
        ) = Unit
      },
    )
    recognizer = active
    try {
      active.startListening(
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
          putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
          putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, appContext.packageName)
        },
      )
    } catch (error: Throwable) {
      if (operation == generation) {
        retireRecognizer()
        onEvent(ChatDictationRecognitionEvent.Error(SpeechRecognizer.ERROR_CLIENT))
      }
    }
  }

  override fun finish() {
    runCatching { recognizer?.stopListening() }
  }

  override fun cancel() {
    generation += 1
    retireRecognizer()
  }

  override fun destroy() {
    generation += 1
    retireRecognizer()
  }

  private fun emit(
    operation: Long,
    onEvent: (ChatDictationRecognitionEvent) -> Unit,
    event: ChatDictationRecognitionEvent,
  ) {
    if (operation == generation) onEvent(event)
  }

  private fun retireRecognizer() {
    val active = recognizer
    recognizer = null
    runCatching { active?.cancel() }
    runCatching { active?.destroy() }
  }
}

internal class ChatDictationController(
  private val recognizer: ChatDictationRecognizer,
  private val requestPermission: suspend () -> Boolean,
  private val acquireMic: () -> Boolean,
  private val releaseMic: () -> Unit,
) {
  private val lock = Any()
  private val _state = MutableStateFlow<ChatDictationState>(ChatDictationState.Idle)
  val state: StateFlow<ChatDictationState> = _state.asStateFlow()
  val isAvailable: Boolean
    get() = recognizer.isAvailable

  private var completion: CompletableDeferred<String?>? = null
  private var ownsMic = false
  private var generation = 0L

  suspend fun start(): String? {
    val operation =
      synchronized(lock) {
        if (_state.value is ChatDictationState.Starting || _state.value is ChatDictationState.Listening) return null
        generation += 1
        _state.value = ChatDictationState.Starting
        generation
      }
    if (!recognizer.isAvailable) {
      fail(operation, ChatDictationFailure.Unavailable)
      return null
    }
    val permitted =
      try {
        requestPermission()
      } catch (error: CancellationException) {
        cancel()
        throw error
      }
    if (!permitted) {
      fail(operation, ChatDictationFailure.PermissionRequired)
      return null
    }

    val pending =
      synchronized(lock) {
        if (operation != generation || _state.value !is ChatDictationState.Starting) return null
        if (!acquireMic()) {
          _state.value = ChatDictationState.Failure(ChatDictationFailure.Busy)
          return null
        }
        ownsMic = true
        CompletableDeferred<String?>().also {
          completion = it
          _state.value = ChatDictationState.Listening
        }
      }
    try {
      recognizer.start { event -> handleEvent(operation, event) }
    } catch (_: Throwable) {
      fail(operation, ChatDictationFailure.Generic)
    }
    return try {
      pending.await()
    } catch (error: CancellationException) {
      cancel()
      throw error
    }
  }

  fun finish() {
    when (state.value) {
      ChatDictationState.Starting -> cancel()
      ChatDictationState.Listening -> recognizer.finish()
      else -> Unit
    }
  }

  fun cancel() {
    val pending =
      synchronized(lock) {
        generation += 1
        val active = completion
        completion = null
        _state.value = ChatDictationState.Idle
        active
      }
    retireRecognizerAndReleaseMic()
    pending?.complete(null)
  }

  fun destroy() {
    cancel()
    recognizer.destroy()
  }

  private fun handleEvent(
    operation: Long,
    event: ChatDictationRecognitionEvent,
  ) {
    when (event) {
      ChatDictationRecognitionEvent.Ready -> Unit
      is ChatDictationRecognitionEvent.Transcript -> complete(operation, event.text)
      is ChatDictationRecognitionEvent.Error -> fail(operation, dictationFailureForError(event.code))
    }
  }

  private fun complete(
    operation: Long,
    transcript: String,
  ) {
    val pending =
      synchronized(lock) {
        if (operation != generation) return
        generation += 1
        val active = completion ?: return
        completion = null
        _state.value = ChatDictationState.Idle
        active
      }
    retireRecognizerAndReleaseMic()
    pending.complete(transcript.trim().takeIf(String::isNotEmpty))
  }

  private fun fail(
    operation: Long,
    reason: ChatDictationFailure,
  ) {
    val pending =
      synchronized(lock) {
        if (operation != generation) return
        generation += 1
        val active = completion
        completion = null
        _state.value = ChatDictationState.Failure(reason)
        active
      }
    retireRecognizerAndReleaseMic()
    pending?.complete(null)
  }

  private fun retireRecognizerAndReleaseMic() {
    // Keep shared microphone ownership until the platform recognizer is retired;
    // otherwise another capture path can start while SpeechRecognizer still owns it.
    recognizer.cancel()
    val shouldRelease =
      synchronized(lock) {
        if (!ownsMic) return@synchronized false
        ownsMic = false
        true
      }
    if (shouldRelease) releaseMic()
  }
}

internal fun dictationFailureForError(code: Int): ChatDictationFailure =
  when (code) {
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> ChatDictationFailure.PermissionRequired
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> ChatDictationFailure.Busy
    SpeechRecognizer.ERROR_NETWORK,
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
    -> ChatDictationFailure.Network
    SpeechRecognizer.ERROR_NO_MATCH,
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
    -> ChatDictationFailure.NoSpeech
    SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
    SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE,
    -> ChatDictationFailure.Unavailable
    else -> ChatDictationFailure.Generic
  }

@Composable
internal fun rememberChatDictationController(viewModel: MainViewModel): ChatDictationController {
  val context = LocalContext.current.applicationContext
  val lifecycleOwner = LocalLifecycleOwner.current
  val controller =
    remember(context, viewModel) {
      ChatDictationController(
        recognizer = AndroidChatDictationRecognizer(context),
        requestPermission = viewModel::requestDictationPermission,
        acquireMic = viewModel::tryAcquireDictationMic,
        releaseMic = viewModel::releaseDictationMic,
      )
    }
  DisposableEffect(controller, lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_STOP) controller.cancel()
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
      controller.destroy()
    }
  }
  return controller
}

@Composable
internal fun ChatComposerMicButton(
  dictationActive: Boolean,
  dictationEnabled: Boolean,
  voiceNoteEnabled: Boolean,
  onToggleDictation: () -> Unit,
  onStartVoiceNote: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val hapticFeedback = LocalHapticFeedback.current
  val interactionEnabled = dictationActive || dictationEnabled || voiceNoteEnabled
  val longPressAction: (() -> Unit)? =
    if (voiceNoteEnabled) {
      {
        hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
        onStartVoiceNote()
      }
    } else {
      null
    }
  val dictationActionLabel =
    if (dictationActive) {
      nativeString("Stop Dictation")
    } else {
      nativeString("Dictation")
    }

  Surface(
    modifier =
      modifier
        .size(ClawTheme.spacing.touchTarget)
        .combinedClickable(
          enabled = interactionEnabled,
          onClickLabel = dictationActionLabel,
          role = Role.Button,
          onLongClickLabel = if (voiceNoteEnabled) voiceNoteRecordLabel() else null,
          onLongClick = longPressAction,
          onClick = {
            if (dictationActive || dictationEnabled) onToggleDictation()
          },
        ),
    shape = CircleShape,
    color = if (dictationActive) ClawTheme.colors.primary else ClawTheme.colors.surfaceRaised,
    contentColor =
      when {
        dictationActive -> ClawTheme.colors.primaryText
        dictationEnabled || voiceNoteEnabled -> ClawTheme.colors.text
        else -> ClawTheme.colors.textSubtle
      },
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(
        imageVector = if (dictationActive) Icons.Default.Stop else Icons.Default.Mic,
        contentDescription = null,
        modifier = Modifier.size(18.dp),
      )
    }
  }
}

@Composable
internal fun ChatDictationError(state: ChatDictationState) {
  val reason = (state as? ChatDictationState.Failure)?.reason ?: return
  val message =
    when (reason) {
      ChatDictationFailure.Unavailable -> nativeString("On-device speech recognition is unavailable.")
      ChatDictationFailure.PermissionRequired -> nativeString("Microphone permission is required.")
      ChatDictationFailure.Busy -> nativeString("Recognizer busy")
      ChatDictationFailure.Network -> nativeString("Network error")
      ChatDictationFailure.NoSpeech -> nativeString("No matches")
      ChatDictationFailure.Generic -> nativeString("Speech recognition")
    }
  Text(text = message, style = ClawTheme.type.caption, color = ClawTheme.colors.danger)
}
