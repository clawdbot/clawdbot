package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkRole
import android.Manifest
import android.app.Activity
import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognizerIntent
import android.view.HapticFeedbackConstants
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.delay
import java.util.Locale

class MainActivity : ComponentActivity() {
  private val viewModel: WearViewModel by viewModels()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      OpenClawWearApp(
        viewModel = viewModel,
        settingsStore = remember { WearSettingsStore(applicationContext) },
        speaker = remember { WearReplySpeaker(applicationContext) },
      )
    }
  }

  override fun onStart() {
    super.onStart()
    (application as WearApplication).onActivityStarted()
  }

  override fun onStop() {
    (application as WearApplication).onActivityStopped()
    super.onStop()
  }
}

@Composable
internal fun OpenClawWearApp(
  viewModel: WearViewModel,
  settingsStore: WearSettingsStore,
  speaker: WearReplySpeaker,
) {
  val state by viewModel.state.collectAsState()
  val snapshot = state.toConversationSnapshot()
  val speaking by speaker.isSpeaking.collectAsState()
  val view = LocalView.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val activity = LocalActivity.current
  val initialSettings = remember(settingsStore) { settingsStore.read() }
  var interaction by remember { mutableStateOf(WearInteractionState.READY) }
  var themeMode by remember { mutableStateOf(initialSettings.themeMode) }
  var autoSpeak by remember { mutableStateOf(initialSettings.autoSpeak) }
  var notificationsGranted by remember {
    mutableStateOf(
      Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(view.context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED,
    )
  }
  var expectedAssistantKey by remember { mutableStateOf<String?>(null) }
  var awaitingReplySessionId by remember { mutableStateOf<String?>(null) }
  var awaitingReply by remember { mutableStateOf(false) }
  var previousRealtimeSnapshot by remember { mutableStateOf(snapshot) }
  var realtimeThinkingTurnId by remember { mutableStateOf<String?>(null) }
  val speakPrompt = stringResource(R.string.speak_to_agent)
  val messageLabel = stringResource(R.string.message)
  val messageTitle = stringResource(R.string.message_agent)
  val sendLabel = stringResource(R.string.send)

  fun submitMessage(rawMessage: String) {
    val message = rawMessage.trim()
    val sessionId = snapshot?.activeSessionId
    if (message.isEmpty()) {
      interaction = WearInteractionState.READY
      return
    }
    if (state.sending || !state.streamText.isNullOrBlank()) {
      interaction = WearInteractionState.READY
      view.performHapticFeedback(HapticFeedbackConstants.REJECT)
      return
    }
    if (!state.connected || sessionId == null) {
      interaction = WearInteractionState.READY
      view.performHapticFeedback(HapticFeedbackConstants.REJECT)
      return
    }
    expectedAssistantKey = snapshot.latestAssistantMessage()?.stableKey()
    awaitingReplySessionId = sessionId
    awaitingReply = true
    interaction = WearInteractionState.SENDING
    speaker.stop()
    viewModel.sendReply(message)
  }

  val speechLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val transcript =
        result.data
          ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
          ?.firstOrNull()
      if (result.resultCode == Activity.RESULT_OK && !transcript.isNullOrBlank()) {
        submitMessage(transcript)
      } else {
        interaction = WearInteractionState.READY
      }
    }
  val textLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val text =
        result.data
          ?.let(RemoteInput::getResultsFromIntent)
          ?.getCharSequence(REMOTE_INPUT_KEY)
          ?.toString()
      if (result.resultCode == Activity.RESULT_OK && !text.isNullOrBlank()) {
        submitMessage(text)
      } else {
        interaction = WearInteractionState.READY
      }
    }

  fun startRealtimeTalk() {
    speaker.stop()
    viewModel.startRealtimeTalk()
  }

  fun leaveConversationContext() {
    awaitingReply = false
    awaitingReplySessionId = null
    expectedAssistantKey = null
    interaction = WearInteractionState.READY
    speaker.stop()
  }

  val audioPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (granted) {
        startRealtimeTalk()
      } else {
        interaction = WearInteractionState.ERROR
        view.performHapticFeedback(HapticFeedbackConstants.REJECT)
      }
    }

  val notificationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      notificationsGranted = granted
    }

  DisposableEffect(lifecycleOwner, view.context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          notificationsGranted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(view.context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  fun toggleRealtimeTalk() {
    if (state.talkBusy || state.controlBusy) return
    if (state.realtimeTalk.active || state.realtimeCapturing) {
      viewModel.stopRealtimeTalk()
      return
    }
    if (!state.connected || state.selectedSession == null) return
    if (
      ContextCompat.checkSelfPermission(view.context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      startRealtimeTalk()
    } else {
      audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
  }

  LaunchedEffect(
    snapshot?.activeSessionId,
    state.messages,
    state.activeRunId,
    state.sending,
    state.error,
    awaitingReply,
  ) {
    if (!awaitingReply) return@LaunchedEffect
    val activeSnapshot = snapshot
    if (
      state.error != null ||
      activeSnapshot == null ||
      activeSnapshot.activeSessionId != awaitingReplySessionId
    ) {
      awaitingReply = false
      awaitingReplySessionId = null
      expectedAssistantKey = null
      interaction = WearInteractionState.READY
      return@LaunchedEffect
    }
    if (state.sending || state.activeRunId != null) return@LaunchedEffect
    val reply =
      newAssistantReplyForSession(
        awaitingSessionId = awaitingReplySessionId,
        activeSessionId = activeSnapshot.activeSessionId,
        expectedAssistantKey = expectedAssistantKey,
        latestAssistantMessage = activeSnapshot.latestAssistantMessage(),
      )
    if (reply != null) {
      awaitingReply = false
      awaitingReplySessionId = null
      expectedAssistantKey = null
      interaction = WearInteractionState.READY
      view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
      if (autoSpeak) speaker.speak(reply.text)
    }
  }

  LaunchedEffect(snapshot?.realtimeTalk) {
    val next = snapshot
    realtimeThinkingTurnId =
      if (next == null) {
        null
      } else {
        nextRealtimeThinkingTurnId(previousRealtimeSnapshot, next, realtimeThinkingTurnId)
      }
    previousRealtimeSnapshot = next
  }
  LaunchedEffect(realtimeThinkingTurnId) {
    val turnId = realtimeThinkingTurnId ?: return@LaunchedEffect
    delay(MINIMUM_REALTIME_THINKING_VISIBLE_MILLIS)
    if (realtimeThinkingTurnId == turnId) {
      realtimeThinkingTurnId = null
    }
  }

  DisposableEffect(speaker) {
    onDispose(speaker::shutdown)
  }

  val failure =
    when {
      state.phoneNodeId == null && !state.loading -> WearConversationFailure.PHONE_UNAVAILABLE
      state.error?.contains("update", ignoreCase = true) == true ->
        WearConversationFailure.INCOMPATIBLE
      else -> null
    }
  val resolvedInteraction =
    when {
      state.error != null -> WearInteractionState.ERROR
      state.sending -> WearInteractionState.SENDING
      state.activeRunId != null -> WearInteractionState.AGENT_WORKING
      else -> interaction
    }

  OpenClawWearTheme(themeMode = themeMode) {
    AppScaffold {
      OpenClawWearScreens(
        snapshot = snapshot,
        failure = failure,
        loading = state.loading,
        interaction = resolvedInteraction,
        speaking = speaking,
        realtimeCapturing = state.realtimeCapturing,
        realtimePlaying = state.realtimePlaying,
        realtimeMouthLevel = state.realtimeMouthLevel,
        realtimePlaybackFailed = state.realtimePlaybackFailed,
        realtimeThinkingOverride = realtimeThinkingTurnId != null,
        actionBusy =
          state.loading ||
            state.sending ||
            state.talkBusy ||
            state.controlBusy ||
            state.activeRunId != null ||
            !state.streamText.isNullOrBlank() ||
            state.realtimeTalk.active ||
            state.realtimeCapturing ||
            state.realtimePlaying,
        inputEnabled = state.connected && snapshot?.activeSessionId != null,
        canAbort = state.activeRunId != null || !state.streamText.isNullOrBlank(),
        themeMode = themeMode,
        autoSpeak = autoSpeak,
        notificationsGranted = notificationsGranted,
        onTalk = {
          if (!state.connected || snapshot?.activeSessionId == null) return@OpenClawWearScreens
          interaction = WearInteractionState.LISTENING
          val intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
              .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
              .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
              .putExtra(RecognizerIntent.EXTRA_PROMPT, speakPrompt)
          try {
            speechLauncher.launch(intent)
          } catch (_: ActivityNotFoundException) {
            interaction = WearInteractionState.ERROR
            view.performHapticFeedback(HapticFeedbackConstants.REJECT)
          }
        },
        onType = {
          if (!state.connected || snapshot?.activeSessionId == null) return@OpenClawWearScreens
          interaction = WearInteractionState.TYPING
          val remoteInput =
            RemoteInput
              .Builder(REMOTE_INPUT_KEY)
              .setLabel(messageLabel)
              .build()
          val intent =
            RemoteInputIntentHelper
              .createActionRemoteInputIntent()
              .also { inputIntent ->
                RemoteInputIntentHelper.putRemoteInputsExtra(inputIntent, listOf(remoteInput))
                RemoteInputIntentHelper.putTitleExtra(inputIntent, messageTitle)
                RemoteInputIntentHelper.putConfirmLabelExtra(inputIntent, sendLabel)
              }
          textLauncher.launch(intent)
        },
        onRealtimeTalk = ::toggleRealtimeTalk,
        onAbort = {
          awaitingReply = false
          awaitingReplySessionId = null
          expectedAssistantKey = null
          interaction = WearInteractionState.READY
          speaker.stop()
          viewModel.abort()
        },
        onSelectAgent = { agentId ->
          leaveConversationContext()
          viewModel.selectAgent(agentId)
        },
        onSelectSession = { sessionKey ->
          state.sessions.firstOrNull { it.key == sessionKey }?.let { session ->
            leaveConversationContext()
            viewModel.openSession(session)
          }
        },
        onSelectModel = { modelRef ->
          leaveConversationContext()
          viewModel.selectModel(modelRef)
        },
        onRefresh = viewModel::refresh,
        onGatewayEnabledChange = { enabled ->
          speaker.stop()
          viewModel.setGatewayEnabled(enabled)
        },
        onThemeModeChange = { selectedMode ->
          themeMode = selectedMode
          settingsStore.writeThemeMode(selectedMode)
        },
        onAutoSpeakChange = { enabled ->
          autoSpeak = enabled
          settingsStore.writeAutoSpeak(enabled)
          if (!enabled) speaker.stop()
        },
        onRequestNotifications = {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
          }
        },
        onOpenNotificationSettings = {
          if (activity != null) {
            val notificationSettings =
              Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
            try {
              activity.startActivity(notificationSettings)
            } catch (_: ActivityNotFoundException) {
              activity.startActivity(
                Intent(
                  Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                  "package:${activity.packageName}".toUri(),
                ),
              )
            }
          }
        },
        onSpeakLatest = {
          snapshot.latestAssistantMessage()?.text?.let(speaker::speak)
        },
        onStopSpeaking = speaker::stop,
      )
    }
  }
}

private fun WearConversationSnapshot?.latestAssistantMessage(): WearChatMessage? =
  this
    ?.messages
    ?.lastOrNull { message ->
      message.chatRole == WearChatRole.ASSISTANT && message.text.isNotBlank()
    }

private fun WearChatMessage.stableKey(): String = id ?: role + ":" + timestamp + ":" + text.hashCode()

internal fun newAssistantReplyForSession(
  awaitingSessionId: String?,
  activeSessionId: String?,
  expectedAssistantKey: String?,
  latestAssistantMessage: WearChatMessage?,
): WearChatMessage? =
  latestAssistantMessage?.takeIf { message ->
    awaitingSessionId != null &&
      awaitingSessionId == activeSessionId &&
      message.stableKey() != expectedAssistantKey
  }

internal fun nextRealtimeThinkingTurnId(
  previous: WearConversationSnapshot?,
  next: WearConversationSnapshot,
  currentTurnId: String?,
): String? {
  if (!next.realtimeTalk.active) return null
  return newlyCompletedRealtimeUserTurnId(previous, next) ?: currentTurnId
}

internal fun newlyCompletedRealtimeUserTurnId(
  previous: WearConversationSnapshot?,
  next: WearConversationSnapshot,
): String? {
  if (previous?.realtimeTalk?.active != true || !next.realtimeTalk.active) return null
  val previousFinalUserTurnIds =
    previous.realtimeTalk.conversation
      .asSequence()
      .filter { entry -> entry.role == WearRealtimeTalkRole.USER && !entry.streaming }
      .map { entry -> entry.id }
      .toSet()
  return next.realtimeTalk.conversation
    .lastOrNull { entry ->
      entry.role == WearRealtimeTalkRole.USER &&
        !entry.streaming &&
        entry.id !in previousFinalUserTurnIds
    }?.id
}

internal const val REPLY_RESULT_KEY = "openclaw_watch_message"
private const val REMOTE_INPUT_KEY = REPLY_RESULT_KEY
private const val MINIMUM_REALTIME_THINKING_VISIBLE_MILLIS = 900L
