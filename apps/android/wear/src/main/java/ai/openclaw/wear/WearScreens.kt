package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkEntry
import ai.openclaw.wear.shared.WearRealtimeTalkRole
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.HorizontalPagerScaffold
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.minimumInteractiveComponentSize
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import androidx.compose.ui.semantics.onClick as semanticsOnClick

internal enum class WearHomePage {
  Chat,
  Voice,
  Controls,
  Pulse,
}

internal fun wearHomePages(agentPulseSupported: Boolean): List<WearHomePage> =
  if (agentPulseSupported) {
    WearHomePage.entries
  } else {
    WearHomePage.entries.filterNot { it == WearHomePage.Pulse }
  }

private const val VOICE_MODE_COUNT = 2
private const val VOICE_HOME_MODE = 0
private const val VOICE_THREAD_MODE = 1

internal data class WearVoiceLayout(
  val horizontalPadding: Dp,
  val orbSize: Dp,
  val contentHeight: Dp,
)

internal fun wearVoiceLayout(
  maxWidth: Dp,
  fontScale: Float,
): WearVoiceLayout {
  val compact = maxWidth <= 192.dp
  val compactLargeText = compact && fontScale > 1.1f
  return WearVoiceLayout(
    horizontalPadding = if (fontScale > 1.1f) 4.dp else 6.dp,
    orbSize =
      when {
        compactLargeText -> 68.dp
        compact -> 80.dp
        else -> 92.dp
      },
    contentHeight =
      when {
        compactLargeText -> 132.dp
        compact -> 144.dp
        else -> 156.dp
      },
  )
}

@Composable
internal fun OpenClawWearScreens(
  snapshot: WearConversationSnapshot?,
  failure: WearConversationFailure?,
  loading: Boolean,
  interaction: WearInteractionState,
  speaking: Boolean,
  realtimeCapturing: Boolean,
  realtimePlaying: Boolean,
  realtimeMouthLevel: Float,
  realtimePlaybackFailed: Boolean,
  realtimeThinkingOverride: Boolean,
  actionBusy: Boolean,
  inputEnabled: Boolean,
  canAbort: Boolean,
  themeMode: WearThemeMode,
  autoSpeak: Boolean,
  notificationsGranted: Boolean,
  initialPage: WearHomePage = WearHomePage.Chat,
  navigationRequest: WearNavigationRequest? = null,
  voiceSwipeHintEnabled: Boolean = true,
  onNavigationRequestHandled: (Int) -> Unit = {},
  onTalk: () -> Unit,
  onType: () -> Unit,
  onRealtimeTalk: () -> Unit,
  onAbort: () -> Unit,
  onSelectAgent: (String) -> Unit,
  onSelectSession: (String) -> Unit,
  onSelectModel: (String) -> Unit,
  onSearchSessions: () -> Unit = {},
  onLoadMoreSessionSearch: () -> Unit = {},
  onClearSessionSearch: () -> Unit = {},
  onSearchModels: () -> Unit = {},
  onClearModelSearch: () -> Unit = {},
  onAgentPulseVisibilityChanged: (Boolean) -> Unit = {},
  onAgentPulseRefresh: () -> Unit = {},
  onRefresh: () -> Unit,
  onGatewayEnabledChange: (Boolean) -> Unit,
  onThemeModeChange: (WearThemeMode) -> Unit,
  onAutoSpeakChange: (Boolean) -> Unit,
  onRequestNotifications: () -> Unit,
  onOpenNotificationSettings: () -> Unit,
  onSpeakLatest: () -> Unit,
  onStopSpeaking: () -> Unit,
) {
  val lifecycleOwner = LocalLifecycleOwner.current
  val agentPulseSupported = snapshot?.agentPulseSupported == true
  val homePages = remember(agentPulseSupported) { wearHomePages(agentPulseSupported) }
  val initialPageIndex = homePages.indexOf(initialPage).takeIf { it >= 0 } ?: 0
  val pagerState =
    rememberPagerState(
      initialPage = initialPageIndex,
      pageCount = { homePages.size },
    )
  var lifecycleResumed by remember(lifecycleOwner) {
    mutableStateOf(
      lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),
    )
  }
  DisposableEffect(lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, _ ->
        val resumed =
          lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        lifecycleResumed = resumed
        if (!resumed) {
          onAgentPulseVisibilityChanged(false)
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
      onAgentPulseVisibilityChanged(false)
    }
  }
  LaunchedEffect(homePages) {
    if (homePages.getOrNull(pagerState.currentPage) == null) {
      pagerState.scrollToPage(homePages.indexOf(WearHomePage.Chat))
    }
  }
  LaunchedEffect(pagerState, lifecycleResumed, snapshot != null, homePages) {
    snapshotFlow { homePages.getOrNull(pagerState.currentPage) == WearHomePage.Pulse }
      .collect { selected ->
        onAgentPulseVisibilityChanged(snapshot != null && lifecycleResumed && selected)
      }
  }
  if (snapshot == null) {
    ConnectionStateScreen(
      loading = loading,
      failure = failure,
      onRefresh = onRefresh,
    )
    return
  }

  val colors = OpenClawWearTheme.colors
  val voicePagerState = rememberPagerState(pageCount = { VOICE_MODE_COUNT })
  val pagerScope = rememberCoroutineScope()
  val realtimeActive = snapshot.realtimeTalk.active || realtimeCapturing
  var showVoiceSwipeHint by remember { mutableStateOf(voiceSwipeHintEnabled) }
  var realtimeStartedAtMillis by remember { mutableLongStateOf(0L) }
  var realtimeElapsedSeconds by remember { mutableLongStateOf(0L) }
  LaunchedEffect(navigationRequest?.id) {
    val request = navigationRequest ?: return@LaunchedEffect
    val destination = wearLaunchPage(request.target, realtimeActive)
    val destinationIndex = homePages.indexOf(destination).takeIf { it >= 0 } ?: 0
    pagerState.scrollToPage(destinationIndex)
    onNavigationRequestHandled(request.id)
  }
  LaunchedEffect(pagerState.currentPage, showVoiceSwipeHint) {
    if (homePages.getOrNull(pagerState.currentPage) == WearHomePage.Voice && showVoiceSwipeHint) {
      delay(1_800L)
      showVoiceSwipeHint = false
    }
  }
  LaunchedEffect(realtimeActive) {
    if (!realtimeActive) {
      realtimeStartedAtMillis = 0L
      realtimeElapsedSeconds = 0L
      return@LaunchedEffect
    }
    if (realtimeStartedAtMillis == 0L) {
      realtimeStartedAtMillis = SystemClock.elapsedRealtime()
    }
    while (isActive) {
      realtimeElapsedSeconds =
        ((SystemClock.elapsedRealtime() - realtimeStartedAtMillis) / 1_000L)
          .coerceAtLeast(0L)
      delay(250L)
    }
  }
  BackHandler(enabled = homePages.getOrNull(pagerState.currentPage) == WearHomePage.Voice) {
    pagerScope.launch {
      pagerState.animateScrollToPage(homePages.indexOf(WearHomePage.Chat))
    }
  }
  HorizontalPagerScaffold(
    pagerState = pagerState,
    modifier =
      Modifier
        .fillMaxSize()
        .background(colors.canvas),
  ) {
    HorizontalPager(
      state = pagerState,
      modifier = Modifier.fillMaxSize(),
      rotaryScrollableBehavior = null,
      userScrollEnabled =
        homePages.getOrNull(pagerState.currentPage) != WearHomePage.Voice ||
          voicePagerState.currentPage == VOICE_HOME_MODE ||
          voicePagerState.currentPage == VOICE_THREAD_MODE,
    ) { page ->
      when (homePages.getOrNull(page)) {
        WearHomePage.Chat ->
          ChatPage(
            snapshot = snapshot,
            interaction = interaction,
            speaking = speaking,
            actionBusy = actionBusy,
            inputEnabled = inputEnabled,
            canAbort = canAbort,
            onTalk = onTalk,
            onType = onType,
            onAbort = onAbort,
            onSelectAgent = onSelectAgent,
            onSelectSession = onSelectSession,
            onSelectModel = onSelectModel,
            onSearchSessions = onSearchSessions,
            onLoadMoreSessionSearch = onLoadMoreSessionSearch,
            onClearSessionSearch = onClearSessionSearch,
            onSearchModels = onSearchModels,
            onClearModelSearch = onClearModelSearch,
            onSpeakLatest = onSpeakLatest,
            onStopSpeaking = onStopSpeaking,
          )
        WearHomePage.Voice ->
          VoicePage(
            voicePagerState = voicePagerState,
            showSwipeHint = showVoiceSwipeHint && homePages.getOrNull(pagerState.currentPage) == WearHomePage.Voice,
            realtimeTalk = snapshot.realtimeTalk,
            speaking = speaking,
            realtimeCapturing = realtimeCapturing,
            realtimePlaying = realtimePlaying,
            realtimeMouthLevel = realtimeMouthLevel,
            realtimePlaybackFailed = realtimePlaybackFailed,
            realtimeThinkingOverride = realtimeThinkingOverride,
            realtimeElapsedSeconds = realtimeElapsedSeconds,
            actionBusy = actionBusy,
            inputEnabled = inputEnabled,
            onTalk = onTalk,
            onType = onType,
            onRealtimeTalk = onRealtimeTalk,
            onStopSpeaking = onStopSpeaking,
          )
        WearHomePage.Controls ->
          ControlsPage(
            snapshot = snapshot,
            themeMode = themeMode,
            autoSpeak = autoSpeak,
            notificationsGranted = notificationsGranted,
            gatewayControlSupported = snapshot.gatewayControlsSupported,
            actionBusy = actionBusy,
            onThemeModeChange = onThemeModeChange,
            onAutoSpeakChange = onAutoSpeakChange,
            onRequestNotifications = onRequestNotifications,
            onOpenNotificationSettings = onOpenNotificationSettings,
            onRefresh = onRefresh,
            onGatewayEnabledChange = onGatewayEnabledChange,
          )
        WearHomePage.Pulse ->
          AgentPulsePage(
            snapshot = snapshot,
            onRefresh = {
              if (snapshot.agentPulseSupported) {
                onAgentPulseRefresh()
              } else {
                onRefresh()
              }
            },
          )
        else -> Unit
      }
    }
  }
}

internal fun wearLaunchPage(
  target: WearLaunchTarget,
  realtimeActive: Boolean,
): WearHomePage = if (realtimeActive) WearHomePage.Voice else target.initialPage

@Composable
private fun ChatPage(
  snapshot: WearConversationSnapshot,
  interaction: WearInteractionState,
  speaking: Boolean,
  actionBusy: Boolean,
  inputEnabled: Boolean,
  canAbort: Boolean,
  onTalk: () -> Unit,
  onType: () -> Unit,
  onAbort: () -> Unit,
  onSelectAgent: (String) -> Unit,
  onSelectSession: (String) -> Unit,
  onSelectModel: (String) -> Unit,
  onSearchSessions: () -> Unit,
  onLoadMoreSessionSearch: () -> Unit,
  onClearSessionSearch: () -> Unit,
  onSearchModels: () -> Unit,
  onClearModelSearch: () -> Unit,
  onSpeakLatest: () -> Unit,
  onStopSpeaking: () -> Unit,
) {
  val listState = rememberTransformingLazyColumnState()
  val coroutineScope = rememberCoroutineScope()
  val visibleMessages = snapshot.messages.takeLast(VISIBLE_MESSAGE_COUNT)
  val streamingText = snapshot.streamingAssistantText?.takeIf(String::isNotBlank)
  val hasAssistant = snapshot.messages.any { message -> message.chatRole == WearChatRole.ASSISTANT }
  val latestAnchorIndex =
    wearChatLatestAnchorIndex(
      visibleMessageCount = visibleMessages.size,
      hasStreaming = streamingText != null,
      canAbort = canAbort,
    )
  val contentRevision =
    wearChatContentRevision(
      sessionId = snapshot.activeSessionId,
      messages = visibleMessages,
      streamingText = streamingText,
      latestAnchorIndex = latestAnchorIndex,
    )
  var followState by remember(snapshot.activeSessionId) { mutableStateOf(WearThreadFollowState()) }
  var contextPicker by remember { mutableStateOf<WearContextPicker?>(null) }

  fun clearContextPickerSearch() {
    when (contextPicker) {
      WearContextPicker.Session -> onClearSessionSearch()
      WearContextPicker.Model -> onClearModelSearch()
      else -> Unit
    }
  }

  fun finishContextPicker() {
    clearContextPickerSearch()
    contextPicker = null
  }

  fun closeContextPicker() {
    clearContextPickerSearch()
    contextPicker = contextPicker?.let(::wearContextPickerAfterClose)
  }

  LaunchedEffect(listState, snapshot.activeSessionId) {
    snapshotFlow {
      WearThreadViewport(
        atLatest = !listState.canScrollForward,
        scrollingBackward = listState.isScrollInProgress && listState.lastScrolledBackward,
      )
    }.collect { viewport ->
      followState =
        nextWearThreadFollowForViewport(
          state = followState,
          atLatest = viewport.atLatest,
          scrollingBackward = viewport.scrollingBackward,
        )
    }
  }
  LaunchedEffect(snapshot.activeSessionId, contentRevision) {
    val update =
      nextWearThreadFollowForContent(
        state = followState,
        contentRevision = contentRevision,
      )
    followState = update.state
    if (update.scrollToLatest && latestAnchorIndex >= 0) {
      listState.requestScrollToItem(latestAnchorIndex)
    }
  }

  Box(modifier = Modifier.fillMaxSize()) {
    WearPage(
      pageLabel = stringResource(R.string.chat),
      listState = listState,
    ) {
      item {
        ConversationStatus(
          interaction = interaction,
          speaking = speaking,
          gatewayConnected = snapshot.gatewayState == WearGatewayState.CONNECTED,
        )
      }
      if (canAbort) {
        item {
          SecondaryButton(
            label = stringResource(R.string.abort_run),
            enabled = true,
            onClick = onAbort,
          )
        }
      }
      if (visibleMessages.isEmpty() && streamingText == null) {
        item {
          EmptyConversation()
        }
      } else {
        visibleMessages.forEach { message ->
          item(key = message.id ?: "${message.role}:${message.timestamp}:${message.text.hashCode()}") {
            MessageBubble(message = message)
          }
        }
        streamingText?.let { streaming ->
          item {
            StreamingBubble(text = streaming)
          }
        }
      }
      if (latestAnchorIndex >= 0) {
        item(key = "chat-end") {
          Spacer(modifier = Modifier.height(1.dp))
        }
      }
      if (hasAssistant) {
        item {
          SecondaryButton(
            label =
              if (speaking) {
                stringResource(R.string.stop_speaking)
              } else {
                stringResource(R.string.speak_reply)
              },
            enabled = !actionBusy || speaking,
            onClick = if (speaking) onStopSpeaking else onSpeakLatest,
          )
        }
      }
      item {
        Row(
          modifier =
            Modifier
              .fillMaxWidth()
              .padding(horizontal = 12.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          ActionButton(
            label = stringResource(R.string.talk),
            enabled = inputEnabled && !actionBusy && !speaking,
            onClick = onTalk,
            modifier = Modifier.weight(1f),
          )
          ActionButton(
            label = stringResource(R.string.type),
            enabled = inputEnabled && !actionBusy && !speaking,
            onClick = onType,
            modifier = Modifier.weight(1f),
          )
        }
      }
      item {
        ConversationContextPicker(
          snapshot = snapshot,
          actionBusy = actionBusy,
          onOpenContextPicker = { contextPicker = WearContextPicker.Session },
        )
      }
      snapshot.failure?.let { failure ->
        item {
          InlineError(text = failureDetail(failure))
        }
      }
    }
    if (followState.hasNewContent && contextPicker == null) {
      NewMessagesAction(
        modifier =
          Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = 8.dp),
      ) {
        followState = wearThreadFollowLatest(followState)
        if (latestAnchorIndex >= 0) {
          coroutineScope.launch {
            listState.animateScrollToItem(latestAnchorIndex)
          }
        }
      }
    }
    contextPicker?.let { picker ->
      ContextPickerOverlay(
        picker = picker,
        snapshot = snapshot,
        actionBusy = actionBusy,
        onDismiss = ::closeContextPicker,
        onOpenAgentPicker = { contextPicker = WearContextPicker.Agent },
        onOpenModelPicker = { contextPicker = WearContextPicker.Model },
        onSelectAgent = { agentId ->
          onSelectAgent(agentId)
          finishContextPicker()
        },
        onSelectSession = { sessionId ->
          onSelectSession(sessionId)
          finishContextPicker()
        },
        onSelectModel = { modelRef ->
          onSelectModel(modelRef)
          finishContextPicker()
        },
        onSearchSessions = onSearchSessions,
        onLoadMoreSessionSearch = onLoadMoreSessionSearch,
        onSearchModels = onSearchModels,
      )
    }
  }
}

@Composable
private fun VoicePage(
  voicePagerState: androidx.wear.compose.foundation.pager.PagerState,
  showSwipeHint: Boolean,
  realtimeTalk: WearRealtimeTalkSnapshot,
  speaking: Boolean,
  realtimeCapturing: Boolean,
  realtimePlaying: Boolean,
  realtimeMouthLevel: Float,
  realtimePlaybackFailed: Boolean,
  realtimeThinkingOverride: Boolean,
  realtimeElapsedSeconds: Long,
  actionBusy: Boolean,
  inputEnabled: Boolean,
  onTalk: () -> Unit,
  onType: () -> Unit,
  onRealtimeTalk: () -> Unit,
  onStopSpeaking: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val voicePagerScope = rememberCoroutineScope()
  val view = LocalView.current
  var previousMode by remember { mutableIntStateOf(voicePagerState.currentPage) }
  val swipeHintOffset =
    if (showSwipeHint) {
      val swipeHintTransition = rememberInfiniteTransition(label = "voice-swipe-hint")
      swipeHintTransition
        .animateFloat(
          initialValue = -14f,
          targetValue = 14f,
          animationSpec =
            infiniteRepeatable(
              animation = tween(durationMillis = 450),
              repeatMode = RepeatMode.Reverse,
            ),
          label = "voice-swipe-hint-offset",
        ).value
    } else {
      0f
    }
  LaunchedEffect(voicePagerState.currentPage) {
    if (voicePagerState.currentPage != previousMode) {
      view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      previousMode = voicePagerState.currentPage
    }
  }
  val selectMode: (Int) -> Unit = { mode ->
    voicePagerScope.launch {
      voicePagerState.animateScrollToPage(mode)
    }
  }
  Box(
    modifier =
      Modifier
        .fillMaxSize()
        .background(colors.canvas),
  ) {
    HorizontalPager(
      state = voicePagerState,
      modifier =
        Modifier
          .fillMaxSize()
          .padding(top = 28.dp, bottom = 28.dp)
          .graphicsLayer {
            translationX = if (showSwipeHint) swipeHintOffset else 0f
          },
      rotaryScrollableBehavior = null,
    ) { mode ->
      when (mode) {
        VOICE_HOME_MODE ->
          VoiceHomeMode(
            realtimeTalk = realtimeTalk,
            speaking = speaking,
            realtimeCapturing = realtimeCapturing,
            realtimePlaying = realtimePlaying,
            realtimeMouthLevel = realtimeMouthLevel,
            realtimePlaybackFailed = realtimePlaybackFailed,
            realtimeThinkingOverride = realtimeThinkingOverride,
            realtimeElapsedSeconds = realtimeElapsedSeconds,
            actionBusy = actionBusy,
            inputEnabled = inputEnabled,
            onTalk = onTalk,
            onRealtimeTalk = onRealtimeTalk,
            onStopSpeaking = onStopSpeaking,
            onOpenThread = { selectMode(VOICE_THREAD_MODE) },
          )
        else ->
          ThreadVoiceMode(
            conversation = realtimeTalk.conversation,
            thinking =
              realtimeThinkingOverride || realtimeTalk.status == WearRealtimeTalkStatus.THINKING,
            realtimeActive = realtimeTalk.active || realtimeCapturing,
            actionBusy = actionBusy,
            inputEnabled = inputEnabled,
            onType = onType,
            onRealtimeTalk = onRealtimeTalk,
          )
      }
    }
    if (showSwipeHint) {
      Text(
        text = stringResource(R.string.swipe_between_voice_modes),
        color = colors.textMuted,
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier =
          Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = 9.dp),
      )
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun VoiceHomeMode(
  realtimeTalk: WearRealtimeTalkSnapshot,
  speaking: Boolean,
  realtimeCapturing: Boolean,
  realtimePlaying: Boolean,
  realtimeMouthLevel: Float,
  realtimePlaybackFailed: Boolean,
  realtimeThinkingOverride: Boolean,
  realtimeElapsedSeconds: Long,
  actionBusy: Boolean,
  inputEnabled: Boolean,
  onTalk: () -> Unit,
  onRealtimeTalk: () -> Unit,
  onStopSpeaking: () -> Unit,
  onOpenThread: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val realtimeActive = realtimeTalk.active || realtimeCapturing
  val ttsOnly = speaking && !realtimeActive
  val state =
    realtimeVoiceButtonState(
      realtimeTalk = realtimeTalk,
      ttsOnly = ttsOnly,
      realtimeCapturing = realtimeCapturing,
      realtimePlaying = realtimePlaying,
      realtimePlaybackFailed = realtimePlaybackFailed,
      realtimeThinkingOverride = realtimeThinkingOverride,
    )
  var dictatePreview by remember { mutableStateOf(false) }
  val coroutineScope = rememberCoroutineScope()
  val dictateActionEnabled = inputEnabled && !actionBusy && !speaking && !realtimeActive && !dictatePreview
  val liveActionEnabled =
    (realtimeActive || ttsOnly || (inputEnabled && !actionBusy)) && !dictatePreview
  val startDictate: () -> Unit = {
    if (dictateActionEnabled) {
      coroutineScope.launch {
        dictatePreview = true
        delay(300L)
        dictatePreview = false
        onTalk()
      }
    }
  }
  val toggleLive: () -> Unit = {
    if (liveActionEnabled) {
      if (ttsOnly) {
        onStopSpeaking()
      } else {
        onRealtimeTalk()
      }
    }
  }
  val label =
    when (state) {
      RealtimeVoiceButtonState.IDLE -> null
      RealtimeVoiceButtonState.CONNECTING -> stringResource(R.string.connecting)
      RealtimeVoiceButtonState.LISTENING -> stringResource(R.string.listening)
      RealtimeVoiceButtonState.THINKING -> stringResource(R.string.thinking)
      RealtimeVoiceButtonState.SPEAKING -> stringResource(R.string.speaking)
      RealtimeVoiceButtonState.ERROR -> stringResource(R.string.real_time_audio_failed)
    }
  val statusText =
    when {
      dictatePreview -> stringResource(R.string.listening)
      label == null -> null
      realtimeActive -> "$label · ${formatVoiceElapsedTime(realtimeElapsedSeconds)}"
      else -> label
    }
  val accent =
    when {
      dictatePreview || state == RealtimeVoiceButtonState.IDLE -> colors.voiceAccent
      state == RealtimeVoiceButtonState.ERROR -> colors.danger
      else -> colors.voiceAccent
    }
  val avatarState = if (dictatePreview) RealtimeVoiceButtonState.LISTENING else state
  val liveVoiceDescription = stringResource(R.string.talk)
  val liveClickLabel =
    when {
      ttsOnly -> stringResource(R.string.stop_speaking)
      realtimeActive -> stringResource(R.string.stop_speaking)
      else -> stringResource(R.string.speak_to_agent)
    }
  val dictateClickLabel = stringResource(R.string.dictate)
  val orbClick = if (liveActionEnabled) toggleLive else startDictate
  val orbClickLabel = if (liveActionEnabled) liveClickLabel else dictateClickLabel
  val fontScale = LocalDensity.current.fontScale
  BoxWithConstraints(
    modifier = Modifier.fillMaxSize(),
  ) {
    val layout = wearVoiceLayout(maxWidth = maxWidth, fontScale = fontScale)
    val voiceControlOffset = if (fontScale > 1.1f) 20.dp else 16.dp
    Row(
      modifier =
        Modifier
          .align(Alignment.Center)
          .fillMaxWidth()
          .padding(horizontal = layout.horizontalPadding),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      VoiceGestureLabel(
        title = stringResource(R.string.hold),
        detail = stringResource(R.string.dictate),
        accent = colors.voiceAccent,
        onClick = if (dictateActionEnabled) startDictate else null,
        onClickLabel = dictateClickLabel,
        modifier =
          Modifier
            .offset(y = voiceControlOffset)
            .weight(1f),
      )
      Box(
        modifier =
          Modifier
            .width(layout.orbSize)
            .height(layout.contentHeight),
      ) {
        VoiceGestureLabel(
          title = stringResource(R.string.double_tap),
          detail = stringResource(R.string.thread),
          accent = colors.voiceAccent,
          onDoubleClick = onOpenThread,
          onClickLabel = stringResource(R.string.open_thread),
          verticalPadding = 0.dp,
          modifier =
            Modifier
              .align(Alignment.TopCenter)
              .fillMaxWidth()
              .minimumInteractiveComponentSize(),
        )
        Box(
          modifier =
            Modifier
              .align(Alignment.Center)
              .size(layout.orbSize)
              .offset(y = voiceControlOffset)
              .combinedClickable(
                // combinedClickable gates every gesture together; keep preview exclusive and fall back to Dictate.
                enabled = !dictatePreview && (liveActionEnabled || dictateActionEnabled),
                onClickLabel = orbClickLabel,
                role = Role.Button,
                onClick = orbClick,
                onDoubleClick = onOpenThread,
                onLongClickLabel = dictateClickLabel.takeIf { dictateActionEnabled },
                onLongClick = startDictate.takeIf { dictateActionEnabled },
              ).semantics {
                contentDescription = liveVoiceDescription
              },
          contentAlignment = Alignment.Center,
        ) {
          WearTalkAvatar(
            state = avatarState,
            mouthLevel = if (realtimePlaying) realtimeMouthLevel else 0f,
            syntheticSpeech = ttsOnly,
            accent = accent,
            danger = colors.danger,
            modifier = Modifier.fillMaxSize(),
          )
        }
        statusText?.let { status ->
          Text(
            text = status,
            color = colors.textMuted,
            fontSize = 12.sp,
            lineHeight = 12.sp,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier =
              Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(bottom = 1.dp),
          )
        }
      }
      VoiceGestureLabel(
        title = stringResource(R.string.tap),
        detail = stringResource(R.string.live),
        accent = colors.voiceAccent,
        onClick = if (liveActionEnabled) toggleLive else null,
        onClickLabel = liveClickLabel,
        modifier =
          Modifier
            .offset(y = voiceControlOffset)
            .weight(1f),
      )
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun VoiceGestureLabel(
  title: String,
  detail: String,
  accent: Color,
  modifier: Modifier = Modifier,
  onClick: (() -> Unit)? = null,
  onDoubleClick: (() -> Unit)? = null,
  onClickLabel: String? = null,
  verticalPadding: androidx.compose.ui.unit.Dp = 10.dp,
) {
  val interactionModifier =
    when {
      onDoubleClick != null ->
        Modifier
          .pointerInput(onDoubleClick) {
            detectTapGestures(onDoubleTap = { onDoubleClick() })
          }.semantics(mergeDescendants = true) {
            role = Role.Button
            semanticsOnClick(label = onClickLabel) {
              onDoubleClick()
              true
            }
          }
      onClick != null ->
        Modifier.clickable(
          role = Role.Button,
          onClickLabel = onClickLabel,
          onClick = onClick,
        )
      else -> Modifier
    }
  Column(
    modifier =
      modifier
        .then(interactionModifier)
        .then(
          if (onClick != null || onDoubleClick != null) {
            Modifier.minimumInteractiveComponentSize()
          } else {
            Modifier
          },
        ).padding(vertical = verticalPadding),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text(
      text = title,
      color = accent,
      fontSize = 12.sp,
      lineHeight = 14.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
    )
    Text(
      text = detail,
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 12.sp,
      lineHeight = 14.sp,
      textAlign = TextAlign.Center,
      maxLines = 1,
    )
  }
}

@Composable
private fun ThreadVoiceMode(
  conversation: List<WearRealtimeTalkEntry>,
  thinking: Boolean,
  realtimeActive: Boolean,
  actionBusy: Boolean,
  inputEnabled: Boolean,
  onType: () -> Unit,
  onRealtimeTalk: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val listState = rememberTransformingLazyColumnState()
  val liveVoiceDescription = stringResource(R.string.talk)
  val liveClickLabel =
    if (realtimeActive) {
      stringResource(R.string.stop_speaking)
    } else {
      stringResource(R.string.speak_to_agent)
    }
  val coroutineScope = rememberCoroutineScope()
  val visibleConversation = conversation.takeLast(VISIBLE_REALTIME_ENTRY_COUNT)
  val contentRevision = wearThreadContentRevision(visibleConversation, thinking)
  val latestAnchorIndex = wearThreadLatestAnchorIndex(visibleConversation.size, thinking)
  var followState by remember { mutableStateOf(WearThreadFollowState()) }

  LaunchedEffect(listState) {
    snapshotFlow {
      WearThreadViewport(
        atLatest = !listState.canScrollForward,
        scrollingBackward = listState.isScrollInProgress && listState.lastScrolledBackward,
      )
    }.collect { viewport ->
      followState =
        nextWearThreadFollowForViewport(
          state = followState,
          atLatest = viewport.atLatest,
          scrollingBackward = viewport.scrollingBackward,
        )
    }
  }
  LaunchedEffect(realtimeActive, contentRevision) {
    val update =
      nextWearThreadFollowForContent(
        state = followState,
        contentRevision = contentRevision,
        realtimeActive = realtimeActive,
      )
    followState = update.state
    if (update.scrollToLatest && latestAnchorIndex >= 0) {
      listState.requestScrollToItem(latestAnchorIndex)
    }
  }

  Box(modifier = Modifier.fillMaxSize()) {
    TransformingLazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .background(colors.canvas),
      state = listState,
      contentPadding = PaddingValues(top = 18.dp, bottom = 52.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
      if (visibleConversation.isEmpty() && !thinking) {
        item {
          Text(
            text = stringResource(R.string.no_live_conversation),
            color = colors.textMuted,
            fontSize = 12.sp,
            lineHeight = 16.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 30.dp, vertical = 20.dp),
          )
        }
      } else {
        visibleConversation.forEach { entry ->
          item(key = entry.id) {
            RealtimeTalkBubble(entry)
          }
        }
        if (thinking) {
          item(key = "realtime-thinking") {
            WearThreadThinking()
          }
        }
        // Follow a trailing anchor: centering a growing bubble can hide its newly streamed tail.
        item(key = "realtime-thread-end") {
          Spacer(modifier = Modifier.height(1.dp))
        }
      }
    }
    if (followState.hasNewContent) {
      NewMessagesAction(
        modifier =
          Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = 44.dp),
      ) {
        followState = wearThreadFollowLatest(followState)
        if (latestAnchorIndex >= 0) {
          coroutineScope.launch {
            listState.animateScrollToItem(latestAnchorIndex)
          }
        }
      }
    }
    Row(
      modifier =
        Modifier
          .align(Alignment.BottomCenter)
          .padding(bottom = 4.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(
        modifier =
          Modifier
            .width(70.dp)
            .minimumInteractiveComponentSize()
            .background(colors.surfaceRaised, RoundedCornerShape(24.dp))
            .border(1.dp, colors.borderStrong, RoundedCornerShape(24.dp))
            .clickable(
              enabled = inputEnabled && !actionBusy && !realtimeActive,
              onClickLabel = stringResource(R.string.type),
              role = Role.Button,
              onClick = onType,
            ),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = stringResource(R.string.type),
          color =
            if (inputEnabled && !actionBusy && !realtimeActive) {
              colors.text
            } else {
              colors.textMuted
            },
          fontSize = 10.sp,
          fontWeight = FontWeight.SemiBold,
        )
      }
      Box(
        modifier =
          Modifier
            .minimumInteractiveComponentSize()
            .background(
              color = if (realtimeActive) colors.voiceAccent else colors.surfaceRaised,
              shape = CircleShape,
            ).border(
              width = 1.dp,
              color = colors.voiceAccent,
              shape = CircleShape,
            ).clickable(
              enabled = realtimeActive || (inputEnabled && !actionBusy),
              onClickLabel = liveClickLabel,
              role = Role.Button,
              onClick = onRealtimeTalk,
            ).semantics {
              contentDescription = liveVoiceDescription
            },
        contentAlignment = Alignment.Center,
      ) {
        MicrophoneGlyph(
          color = if (realtimeActive) colors.onVoiceAccent else colors.text,
          modifier = Modifier.size(18.dp),
        )
      }
    }
  }
}

@Composable
private fun NewMessagesAction(
  modifier: Modifier,
  onClick: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  Box(
    modifier =
      modifier
        .minimumInteractiveComponentSize()
        .background(colors.voiceAccentSoft, RoundedCornerShape(14.dp))
        .border(1.dp, colors.voiceAccent, RoundedCornerShape(14.dp))
        .clickable(
          role = Role.Button,
          onClickLabel = stringResource(R.string.show_new_messages),
          onClick = onClick,
        ).padding(horizontal = 10.dp, vertical = 5.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = stringResource(R.string.new_messages) + " ↓",
      color = colors.voiceAccent,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
    )
  }
}

@Composable
private fun WearThreadThinking() {
  val colors = OpenClawWearTheme.colors
  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(start = 12.dp, end = 28.dp)
        .background(colors.surfaceRaised, RoundedCornerShape(14.dp))
        .border(1.dp, colors.borderStrong, RoundedCornerShape(14.dp))
        .padding(horizontal = 12.dp, vertical = 8.dp),
  ) {
    Text(
      text = stringResource(R.string.thinking) + "…",
      color = colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

internal data class WearThreadContentRevision(
  val entryCount: Int,
  val latestEntryId: String?,
  val latestText: String?,
  val latestStreaming: Boolean,
  val thinking: Boolean,
)

internal data class WearThreadFollowState(
  val contentRevision: WearThreadContentRevision? = null,
  val followingLatest: Boolean = true,
  val hasNewContent: Boolean = false,
)

internal data class WearThreadFollowUpdate(
  val state: WearThreadFollowState,
  val scrollToLatest: Boolean,
)

private data class WearThreadViewport(
  val atLatest: Boolean,
  val scrollingBackward: Boolean,
)

internal fun wearThreadContentRevision(
  conversation: List<WearRealtimeTalkEntry>,
  thinking: Boolean,
): WearThreadContentRevision {
  val latest = conversation.lastOrNull()
  return WearThreadContentRevision(
    entryCount = conversation.size,
    latestEntryId = latest?.id,
    latestText = latest?.text,
    latestStreaming = latest?.streaming == true,
    thinking = thinking,
  )
}

internal fun wearChatContentRevision(
  sessionId: String?,
  messages: List<WearChatMessage>,
  streamingText: String?,
  latestAnchorIndex: Int,
): WearThreadContentRevision =
  WearThreadContentRevision(
    entryCount = messages.size,
    latestEntryId = sessionId,
    latestText =
      buildString {
        append(latestAnchorIndex)
        messages.forEach { message ->
          append('\u0000')
          append(message.id)
          append('\u0001')
          append(message.role)
          append('\u0001')
          append(message.timestamp)
          append('\u0001')
          append(message.text)
        }
        append('\u0000')
        append(streamingText)
      },
    latestStreaming = !streamingText.isNullOrBlank(),
    thinking = false,
  )

internal fun wearChatLatestAnchorIndex(
  visibleMessageCount: Int,
  hasStreaming: Boolean,
  canAbort: Boolean,
): Int {
  if (visibleMessageCount == 0 && !hasStreaming) return -1
  return CHAT_FIXED_ITEM_COUNT +
    visibleMessageCount +
    listOf(canAbort, hasStreaming).count { it }
}

internal fun wearThreadLatestAnchorIndex(
  entryCount: Int,
  thinking: Boolean,
): Int = if (entryCount == 0 && !thinking) -1 else entryCount + if (thinking) 1 else 0

internal fun nextWearThreadFollowForContent(
  state: WearThreadFollowState,
  contentRevision: WearThreadContentRevision,
  realtimeActive: Boolean = true,
): WearThreadFollowUpdate {
  if (!realtimeActive) {
    return WearThreadFollowUpdate(
      state = WearThreadFollowState(),
      scrollToLatest = false,
    )
  }
  if (state.contentRevision == contentRevision) {
    return WearThreadFollowUpdate(state = state, scrollToLatest = false)
  }
  return WearThreadFollowUpdate(
    state =
      state.copy(
        contentRevision = contentRevision,
        hasNewContent = !state.followingLatest,
      ),
    scrollToLatest = state.followingLatest,
  )
}

internal fun nextWearThreadFollowForViewport(
  state: WearThreadFollowState,
  atLatest: Boolean,
  scrollingBackward: Boolean,
): WearThreadFollowState =
  when {
    atLatest -> state.copy(followingLatest = true, hasNewContent = false)
    scrollingBackward -> state.copy(followingLatest = false)
    else -> state
  }

internal fun wearThreadFollowLatest(state: WearThreadFollowState): WearThreadFollowState = state.copy(followingLatest = true, hasNewContent = false)

@Composable
private fun MicrophoneGlyph(
  color: Color,
  modifier: Modifier = Modifier,
) {
  Canvas(modifier = modifier) {
    val strokeWidth = size.minDimension * 0.085f
    val stroke =
      Stroke(
        width = strokeWidth,
        cap = StrokeCap.Round,
      )
    drawRoundRect(
      color = color,
      topLeft = Offset(size.width * 0.33f, size.height * 0.08f),
      size = Size(size.width * 0.34f, size.height * 0.52f),
      cornerRadius = CornerRadius(size.width * 0.17f),
      style = stroke,
    )
    drawArc(
      color = color,
      startAngle = 0f,
      sweepAngle = 180f,
      useCenter = false,
      topLeft = Offset(size.width * 0.22f, size.height * 0.26f),
      size = Size(size.width * 0.56f, size.height * 0.5f),
      style = stroke,
    )
    drawLine(
      color = color,
      start = Offset(size.width * 0.5f, size.height * 0.76f),
      end = Offset(size.width * 0.5f, size.height * 0.9f),
      strokeWidth = strokeWidth,
      cap = StrokeCap.Round,
    )
    drawLine(
      color = color,
      start = Offset(size.width * 0.34f, size.height * 0.9f),
      end = Offset(size.width * 0.66f, size.height * 0.9f),
      strokeWidth = strokeWidth,
      cap = StrokeCap.Round,
    )
  }
}

private fun realtimeVoiceButtonState(
  realtimeTalk: WearRealtimeTalkSnapshot,
  ttsOnly: Boolean,
  realtimeCapturing: Boolean,
  realtimePlaying: Boolean,
  realtimePlaybackFailed: Boolean,
  realtimeThinkingOverride: Boolean,
): RealtimeVoiceButtonState =
  when {
    realtimePlaybackFailed || realtimeTalk.status == WearRealtimeTalkStatus.ERROR ->
      RealtimeVoiceButtonState.ERROR
    realtimeThinkingOverride ->
      RealtimeVoiceButtonState.THINKING
    realtimePlaying || realtimeTalk.speaking || ttsOnly ->
      RealtimeVoiceButtonState.SPEAKING
    realtimeTalk.status == WearRealtimeTalkStatus.THINKING ->
      RealtimeVoiceButtonState.THINKING
    realtimeCapturing ||
      realtimeTalk.listening ||
      realtimeTalk.status == WearRealtimeTalkStatus.LISTENING ->
      RealtimeVoiceButtonState.LISTENING
    realtimeTalk.status == WearRealtimeTalkStatus.CONNECTING ->
      RealtimeVoiceButtonState.CONNECTING
    else -> RealtimeVoiceButtonState.IDLE
  }

private fun formatVoiceElapsedTime(totalSeconds: Long): String {
  val minutes = totalSeconds / 60L
  val seconds = totalSeconds % 60L
  return "$minutes:${seconds.toString().padStart(2, '0')}"
}

internal enum class RealtimeVoiceButtonState {
  IDLE,
  CONNECTING,
  LISTENING,
  THINKING,
  SPEAKING,
  ERROR,
}

@Composable
private fun RealtimeTalkBubble(entry: WearRealtimeTalkEntry) {
  val colors = OpenClawWearTheme.colors
  val isUser = entry.role == WearRealtimeTalkRole.USER
  val background = if (isUser) colors.surfacePressed else colors.surfaceRaised
  val foreground = colors.text
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(
          start = if (isUser) 28.dp else 12.dp,
          end = if (isUser) 12.dp else 28.dp,
        ).background(background, RoundedCornerShape(14.dp))
        .then(
          Modifier.border(
            width = 1.dp,
            color = colors.borderStrong,
            shape = RoundedCornerShape(14.dp),
          ),
        ).padding(horizontal = 12.dp, vertical = 9.dp),
  ) {
    Text(
      text =
        localizedWearUppercase(
          if (isUser) {
            stringResource(R.string.you)
          } else {
            stringResource(R.string.agent)
          },
        ),
      color = if (isUser) foreground.copy(alpha = 0.72f) else colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
    Text(
      text = entry.text,
      color = foreground,
      fontSize = 13.sp,
      lineHeight = 17.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
    if (entry.streaming) {
      Text(
        text = localizedWearUppercase(stringResource(R.string.live)),
        color = colors.warning,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
      )
    }
  }
}

@Composable
private fun ControlsPage(
  snapshot: WearConversationSnapshot,
  themeMode: WearThemeMode,
  autoSpeak: Boolean,
  notificationsGranted: Boolean,
  gatewayControlSupported: Boolean,
  actionBusy: Boolean,
  onThemeModeChange: (WearThemeMode) -> Unit,
  onAutoSpeakChange: (Boolean) -> Unit,
  onRequestNotifications: () -> Unit,
  onOpenNotificationSettings: () -> Unit,
  onRefresh: () -> Unit,
  onGatewayEnabledChange: (Boolean) -> Unit,
) {
  val gatewayConnected = snapshot.gatewayState == WearGatewayState.CONNECTED

  WearPage(pageLabel = stringResource(R.string.controls)) {
    item {
      ConnectionPanel(snapshot = snapshot)
    }
    snapshot.failure?.let { failure ->
      item { InlineError(text = failureDetail(failure)) }
    }
    item {
      SelectionButton(
        title = stringResource(R.string.gateway),
        detail =
          if (!gatewayControlSupported) {
            stringResource(R.string.update_required)
          } else if (gatewayConnected) {
            stringResource(R.string.on)
          } else {
            stringResource(R.string.off)
          },
        selected = gatewayConnected,
        enabled = gatewayControlSupported && !actionBusy,
        onClick = { onGatewayEnabledChange(!gatewayConnected) },
      )
    }
    item {
      ThemeModeSelector(
        themeMode = themeMode,
        onThemeModeChange = onThemeModeChange,
      )
    }
    item {
      SelectionButton(
        title = stringResource(R.string.reply_alerts),
        detail =
          if (notificationsGranted) {
            stringResource(R.string.on)
          } else {
            stringResource(R.string.enable_alerts)
          },
        selected = notificationsGranted,
        enabled = !notificationsGranted && !actionBusy,
        onClick = onRequestNotifications,
      )
    }
    if (!notificationsGranted) {
      item {
        SecondaryButton(
          label = stringResource(R.string.open_notification_settings),
          enabled = !actionBusy,
          onClick = onOpenNotificationSettings,
        )
      }
    }
    item {
      SelectionButton(
        title = stringResource(R.string.auto_speak),
        detail =
          if (autoSpeak) {
            stringResource(R.string.on)
          } else {
            stringResource(R.string.off)
          },
        selected = autoSpeak,
        enabled = !actionBusy,
        onClick = { onAutoSpeakChange(!autoSpeak) },
      )
    }
    item {
      PhoneBoundaryPanel()
    }
    item {
      SecondaryButton(
        label = stringResource(R.string.refresh),
        enabled = !actionBusy,
        onClick = onRefresh,
      )
    }
  }
}

@Composable
private fun AgentPulsePage(
  snapshot: WearConversationSnapshot,
  onRefresh: () -> Unit,
) {
  val pulse = snapshot.agentPulse
  WearPage(pageLabel = stringResource(R.string.pulse)) {
    when {
      snapshot.gatewayState != WearGatewayState.CONNECTED ->
        item {
          EmptyPanel(
            title = stringResource(R.string.pulse_unavailable),
            detail = stringResource(R.string.gateway_offline_detail),
          )
        }
      !snapshot.agentPulseSupported ->
        item {
          EmptyPanel(
            title = stringResource(R.string.pulse_unavailable),
            detail = stringResource(R.string.update_required_detail),
          )
        }
      pulse == null ->
        item {
          EmptyPanel(
            title =
              if (snapshot.agentPulseLoading) {
                stringResource(R.string.pulse_loading)
              } else {
                stringResource(R.string.pulse_unavailable)
              },
            detail =
              when {
                snapshot.agentPulseLoading -> stringResource(R.string.pulse_loading_detail)
                snapshot.agentPulseFailure != null -> failureDetail(snapshot.agentPulseFailure)
                else -> stringResource(R.string.try_again)
              },
          )
        }
      else -> {
        item { AgentPulseTasksPanel(pulse.tasks) }
        item { AgentPulseSwarmPanel(pulse.swarm) }
        item { AgentPulseApprovalsPanel(pulse.approvals) }
        snapshot.agentPulseFailure?.let { pulseFailure ->
          item { InlineError(text = failureDetail(pulseFailure)) }
        }
      }
    }
    item {
      SecondaryButton(
        label = stringResource(R.string.refresh),
        enabled = !snapshot.agentPulseLoading,
        onClick = onRefresh,
      )
    }
  }
}

@Composable
private fun AgentPulseTasksPanel(tasks: WearAgentPulseTasks) {
  val ready = tasks.state == WearAgentPulseTaskState.Ready
  Panel {
    AgentPulsePanelHeader(
      title = stringResource(R.string.pulse_tasks),
      status =
        if (ready) {
          stringResource(R.string.pulse_ready)
        } else {
          stringResource(R.string.pulse_unavailable)
        },
      statusColor =
        if (ready) {
          OpenClawWearTheme.colors.success
        } else {
          OpenClawWearTheme.colors.danger
        },
    )
    if (ready) {
      AgentPulseMetricRow(stringResource(R.string.pulse_queued), tasks.queued)
      AgentPulseMetricRow(stringResource(R.string.pulse_running), tasks.running)
      AgentPulseMetricRow(stringResource(R.string.pulse_completed), tasks.completed)
      AgentPulseMetricRow(stringResource(R.string.pulse_failed), tasks.failed)
      AgentPulseDetail(text = stringResource(R.string.pulse_task_snapshot_bounded))
      if (tasks.activeAtLimit == true) {
        AgentPulseDetail(
          text = stringResource(R.string.pulse_active_at_limit),
          color = OpenClawWearTheme.colors.warning,
        )
      }
      if (tasks.recentAtLimit == true) {
        AgentPulseDetail(
          text = stringResource(R.string.pulse_recent_at_limit),
          color = OpenClawWearTheme.colors.warning,
        )
      }
    }
  }
}

@Composable
private fun AgentPulseSwarmPanel(swarm: WearAgentPulseSwarm) {
  val colors = OpenClawWearTheme.colors
  val status =
    when (swarm.state) {
      WearAgentPulseSwarmState.Active -> stringResource(R.string.pulse_swarm_active)
      WearAgentPulseSwarmState.Idle -> stringResource(R.string.pulse_swarm_idle)
      WearAgentPulseSwarmState.Unavailable -> stringResource(R.string.pulse_unavailable)
    }
  val statusColor =
    when (swarm.state) {
      WearAgentPulseSwarmState.Active -> colors.warning
      WearAgentPulseSwarmState.Idle -> colors.success
      WearAgentPulseSwarmState.Unavailable -> colors.danger
    }
  Panel {
    AgentPulsePanelHeader(
      title = stringResource(R.string.pulse_swarm),
      status = status,
      statusColor = statusColor,
    )
    if (swarm.state == WearAgentPulseSwarmState.Active) {
      AgentPulseMetricRow(stringResource(R.string.pulse_groups), swarm.groups)
      AgentPulseMetricRow(stringResource(R.string.pulse_running), swarm.running)
      AgentPulseMetricRow(stringResource(R.string.pulse_done), swarm.done)
      AgentPulseMetricRow(stringResource(R.string.pulse_failed), swarm.failed)
      swarm.phases.forEachIndexed { index, phase ->
        Spacer(modifier = Modifier.height(6.dp))
        Text(
          text = stringResource(R.string.pulse_phase, index + 1),
          color = colors.text,
          fontSize = 11.sp,
          fontWeight = FontWeight.SemiBold,
        )
        Text(
          text =
            stringResource(
              R.string.pulse_phase_counts,
              phase.queued,
              phase.running,
              phase.done,
              phase.failed,
              phase.hidden,
            ),
          color = colors.textMuted,
          fontSize = 10.sp,
          lineHeight = 14.sp,
        )
      }
      if (swarm.morePhases == true) {
        AgentPulseDetail(text = stringResource(R.string.pulse_more_phases))
      }
    }
  }
}

@Composable
private fun AgentPulseApprovalsPanel(approvals: WearAgentPulseApprovals) {
  val colors = OpenClawWearTheme.colors
  val status =
    when (approvals.state) {
      WearAgentPulseApprovalsState.Ready -> stringResource(R.string.pulse_ready)
      WearAgentPulseApprovalsState.Refreshing -> stringResource(R.string.pulse_refreshing)
      WearAgentPulseApprovalsState.Unavailable -> stringResource(R.string.pulse_unavailable)
    }
  val statusColor =
    when (approvals.state) {
      WearAgentPulseApprovalsState.Ready -> colors.success
      WearAgentPulseApprovalsState.Refreshing -> colors.warning
      WearAgentPulseApprovalsState.Unavailable -> colors.danger
    }
  Panel {
    AgentPulsePanelHeader(
      title = stringResource(R.string.pulse_attention),
      status = status,
      statusColor = statusColor,
    )
    if (approvals.state == WearAgentPulseApprovalsState.Ready) {
      AgentPulseMetricRow(
        label = stringResource(R.string.pulse_pending_requests),
        value = approvals.pending,
      )
    }
  }
}

@Composable
private fun AgentPulsePanelHeader(
  title: String,
  status: String,
  statusColor: Color,
) {
  Text(
    text = title,
    color = OpenClawWearTheme.colors.text,
    fontSize = 15.sp,
    fontWeight = FontWeight.SemiBold,
    modifier = Modifier.fillMaxWidth(),
  )
  Text(
    text = stringResource(R.string.pulse_status, status),
    color = statusColor,
    fontSize = 11.sp,
    fontWeight = FontWeight.SemiBold,
    modifier = Modifier.fillMaxWidth(),
  )
  Spacer(modifier = Modifier.height(6.dp))
}

@Composable
private fun AgentPulseMetricRow(
  label: String,
  value: Int?,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = label,
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 11.sp,
      modifier = Modifier.weight(1f),
    )
    Text(
      text = value?.toString() ?: stringResource(R.string.pulse_unknown),
      color = OpenClawWearTheme.colors.text,
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

@Composable
private fun AgentPulseDetail(
  text: String,
  color: Color = OpenClawWearTheme.colors.textMuted,
) {
  Spacer(modifier = Modifier.height(4.dp))
  Text(
    text = text,
    color = color,
    fontSize = 10.sp,
    lineHeight = 14.sp,
    modifier = Modifier.fillMaxWidth(),
  )
}

@Composable
private fun ConnectionStateScreen(
  loading: Boolean,
  failure: WearConversationFailure?,
  onRefresh: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val listState = rememberTransformingLazyColumnState()
  ScreenScaffold(scrollState = listState) { contentPadding ->
    TransformingLazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .background(colors.canvas),
      state = listState,
      contentPadding = contentPadding,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        OpenClawHeader(pageLabel = stringResource(R.string.chat))
      }
      item {
        EmptyPanel(
          title =
            if (loading) {
              stringResource(R.string.checking_phone)
            } else {
              failureTitle(failure)
            },
          detail =
            if (loading) {
              stringResource(R.string.reading_conversation)
            } else {
              failureDetail(failure)
            },
        )
      }
      item {
        SecondaryButton(
          label = stringResource(R.string.retry),
          enabled = !loading,
          onClick = onRefresh,
        )
      }
    }
  }
}

@Composable
private fun WearPage(
  pageLabel: String,
  listState: androidx.wear.compose.foundation.lazy.TransformingLazyColumnState? = null,
  content: androidx.wear.compose.foundation.lazy.TransformingLazyColumnScope.() -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val resolvedListState = listState ?: rememberTransformingLazyColumnState()
  ScreenScaffold(scrollState = resolvedListState) { contentPadding ->
    TransformingLazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .background(colors.canvas),
      state = resolvedListState,
      contentPadding = contentPadding,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        OpenClawHeader(pageLabel = pageLabel)
      }
      content()
    }
  }
}

@Composable
private fun OpenClawHeader(pageLabel: String) {
  val colors = OpenClawWearTheme.colors
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 18.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      text = localizedWearUppercase(stringResource(R.string.app_name)),
      color = colors.text,
      fontSize = 16.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.4.sp,
      textAlign = TextAlign.Center,
      maxLines = 1,
    )
    Text(
      text = localizedWearUppercase(pageLabel),
      color = colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      letterSpacing = 1.4.sp,
      textAlign = TextAlign.Center,
    )
  }
}

@Composable
private fun ConversationContextPicker(
  snapshot: WearConversationSnapshot,
  actionBusy: Boolean,
  onOpenContextPicker: () -> Unit,
) {
  val session = snapshot.sessions.firstOrNull(WearSessionSummary::selected) ?: snapshot.sessions.firstOrNull()
  val agent = snapshot.agents.firstOrNull(WearAgentSummary::selected) ?: snapshot.agents.firstOrNull()
  val model = snapshot.models.firstOrNull(WearModelSummary::selected)
  val agentName =
    listOfNotNull(
      agent?.emoji?.takeIf(String::isNotBlank),
      agent?.name ?: stringResource(R.string.agent),
    ).joinToString(" ")
  val modelName = model?.name ?: snapshot.selectedModelRef ?: stringResource(R.string.model)
  ContextPickerOption(
    title =
      stringResource(
        R.string.context_label_value,
        stringResource(R.string.session),
        session?.title ?: stringResource(R.string.current_session),
      ),
    detail =
      stringResource(
        R.string.context_label_value,
        stringResource(R.string.agent),
        agentName,
      ),
    status =
      stringResource(
        R.string.context_label_value,
        stringResource(R.string.model),
        modelName,
      ),
    selected = true,
    enabled = !actionBusy,
    onClick = onOpenContextPicker,
    modifier = Modifier.padding(horizontal = 12.dp),
  )
}

internal enum class WearContextPicker {
  Agent,
  Session,
  Model,
}

internal fun wearContextPickerAfterClose(picker: WearContextPicker): WearContextPicker? =
  when (picker) {
    WearContextPicker.Agent, WearContextPicker.Model -> WearContextPicker.Session
    WearContextPicker.Session -> null
  }

@Composable
private fun ContextPickerOverlay(
  picker: WearContextPicker,
  snapshot: WearConversationSnapshot,
  actionBusy: Boolean,
  onDismiss: () -> Unit,
  onOpenAgentPicker: () -> Unit,
  onOpenModelPicker: () -> Unit,
  onSelectAgent: (String) -> Unit,
  onSelectSession: (String) -> Unit,
  onSelectModel: (String) -> Unit,
  onSearchSessions: () -> Unit,
  onLoadMoreSessionSearch: () -> Unit,
  onSearchModels: () -> Unit,
) {
  BackHandler(onBack = onDismiss)
  val pageLabel =
    when (picker) {
      WearContextPicker.Agent -> stringResource(R.string.agent)
      WearContextPicker.Session -> stringResource(R.string.session)
      WearContextPicker.Model -> stringResource(R.string.model)
    }
  WearPage(pageLabel = pageLabel) {
    item {
      SecondaryButton(
        label = stringResource(R.string.close),
        enabled = true,
        onClick = onDismiss,
      )
    }
    if (picker == WearContextPicker.Session) {
      item {
        val agent = snapshot.agents.firstOrNull(WearAgentSummary::selected) ?: snapshot.agents.firstOrNull()
        val model = snapshot.models.firstOrNull(WearModelSummary::selected)
        Panel {
          ContextPickerRow(
            label = stringResource(R.string.agent),
            value =
              listOfNotNull(
                agent?.emoji?.takeIf(String::isNotBlank),
                agent?.name ?: stringResource(R.string.agent),
              ).joinToString(" "),
            onClick = onOpenAgentPicker.takeIf { snapshot.agentControlsSupported && !actionBusy },
          )
          ContextPickerDivider()
          ContextPickerRow(
            label = stringResource(R.string.model),
            value = model?.name ?: snapshot.selectedModelRef ?: stringResource(R.string.model),
            onClick = onOpenModelPicker.takeIf { snapshot.modelControlsSupported && !actionBusy },
          )
        }
      }
      if (snapshot.sessionSearchSupported) {
        item {
          SecondaryButton(
            label = stringResource(R.string.search_sessions),
            enabled = !actionBusy,
            onClick = onSearchSessions,
          )
        }
        snapshot.sessionSearchQuery?.let { query ->
          item { PickerQueryLabel(query = query) }
        }
      }
    }
    if (picker == WearContextPicker.Model && snapshot.modelSearchSupported) {
      item {
        SecondaryButton(
          label = stringResource(R.string.search_models),
          enabled = !actionBusy,
          onClick = onSearchModels,
        )
      }
      snapshot.modelSearchQuery?.let { query ->
        item { PickerQueryLabel(query = query) }
      }
    }
    when (picker) {
      WearContextPicker.Agent ->
        snapshot.agents.forEach { agent ->
          item(key = "agent:${agent.id}") {
            ContextPickerOption(
              title = listOfNotNull(agent.emoji?.takeIf(String::isNotBlank), agent.name).joinToString(" "),
              detail = agent.id,
              status = null,
              selected = agent.selected,
              enabled = !actionBusy,
              onClick = { onSelectAgent(agent.id) },
            )
          }
        }
      WearContextPicker.Session -> {
        val sessions =
          if (snapshot.sessionSearchQuery == null) snapshot.sessions else snapshot.sessionSearchResults
        if (sessions.isEmpty()) {
          item { PickerEmptyResult() }
        }
        sessions.forEach { session ->
          item(key = "session:${session.id}") {
            val status =
              listOfNotNull(
                stringResource(R.string.active_on_phone).takeIf { session.activeOnPhone },
                stringResource(R.string.open_on_watch).takeIf { session.openOnWatch },
              ).joinToString(" / ").takeIf(String::isNotEmpty)
            ContextPickerOption(
              title = session.title ?: stringResource(R.string.current_session),
              detail = null,
              status = status,
              selected = session.openOnWatch,
              enabled = !actionBusy,
              onClick = { onSelectSession(session.id) },
            )
          }
        }
        if (
          snapshot.sessionSearchSupported &&
          snapshot.sessionSearchQuery != null &&
          snapshot.sessionSearchHasMore
        ) {
          item {
            SecondaryButton(
              label = stringResource(R.string.load_more),
              enabled = !actionBusy,
              onClick = onLoadMoreSessionSearch,
            )
          }
        }
      }
      WearContextPicker.Model -> {
        val models =
          if (snapshot.modelSearchQuery == null) snapshot.models else snapshot.modelSearchResults
        if (models.isEmpty()) {
          item { PickerEmptyResult() }
        }
        models.forEach { model ->
          item(key = "model:${model.ref}") {
            ContextPickerOption(
              title = model.name,
              detail = model.ref,
              status = null,
              selected = model.selected,
              enabled = !actionBusy,
              onClick = { onSelectModel(model.ref) },
            )
          }
        }
      }
    }
  }
}

@Composable
private fun PickerQueryLabel(query: String) {
  Text(
    text = query,
    color = OpenClawWearTheme.colors.textMuted,
    fontSize = 11.sp,
    maxLines = 1,
    overflow = TextOverflow.Ellipsis,
  )
}

@Composable
private fun PickerEmptyResult() {
  Text(
    text = stringResource(R.string.no_matches),
    color = OpenClawWearTheme.colors.textMuted,
    fontSize = 12.sp,
    textAlign = TextAlign.Center,
  )
}

@Composable
private fun ContextPickerOption(
  title: String,
  detail: String?,
  status: String?,
  selected: Boolean,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = OpenClawWearTheme.colors
  Column(
    modifier =
      modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .then(
          Modifier.border(
            width = 1.dp,
            color = if (selected) colors.primary else colors.border,
            shape = RoundedCornerShape(14.dp),
          ),
        ).padding(horizontal = 12.dp, vertical = 9.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      text = title,
      color = if (enabled) colors.text else colors.textMuted,
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
    detail?.takeIf(String::isNotBlank)?.let {
      Text(
        text = it,
        color = colors.textMuted,
        fontSize = 9.sp,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    status?.let {
      Text(
        text = it,
        color = colors.primary,
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        textAlign = TextAlign.Center,
      )
    }
  }
}

@Composable
private fun ContextPickerRow(
  label: String,
  value: String,
  onClick: (() -> Unit)?,
) {
  val colors = OpenClawWearTheme.colors
  val enabled = onClick != null
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .clickable(
          enabled = enabled,
          role = Role.Button,
          onClick = { onClick?.invoke() },
        ).padding(vertical = 7.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      text = localizedWearUppercase(label),
      color = colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
      maxLines = 1,
    )
    Text(
      text = value,
      color = if (enabled) colors.text else colors.textMuted,
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun ContextPickerDivider() {
  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .height(1.dp)
        .background(OpenClawWearTheme.colors.borderStrong.copy(alpha = 0.45f)),
  )
}

@Composable
private fun ConversationStatus(
  interaction: WearInteractionState,
  speaking: Boolean,
  gatewayConnected: Boolean,
) {
  val colors = OpenClawWearTheme.colors
  val (label, color) =
    when {
      speaking -> stringResource(R.string.speaking) to colors.success
      interaction == WearInteractionState.LISTENING ->
        stringResource(R.string.listening) to colors.danger
      interaction == WearInteractionState.TYPING ->
        stringResource(R.string.typing) to colors.warning
      interaction == WearInteractionState.SENDING ->
        stringResource(R.string.sending) to colors.warning
      interaction == WearInteractionState.AGENT_WORKING ->
        stringResource(R.string.agent_working) to colors.warning
      interaction == WearInteractionState.ERROR ->
        stringResource(R.string.error) to colors.danger
      gatewayConnected -> stringResource(R.string.ready) to colors.success
      else -> stringResource(R.string.gateway_offline) to colors.danger
    }
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .background(colors.surface, RoundedCornerShape(12.dp))
        .border(1.dp, colors.borderStrong, RoundedCornerShape(12.dp))
        .padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier
          .size(8.dp)
          .background(color, CircleShape),
    )
    Spacer(modifier = Modifier.size(7.dp))
    Text(
      text = label,
      color = colors.text,
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

@Composable
private fun MessageBubble(message: WearChatMessage) {
  val colors = OpenClawWearTheme.colors
  val isUser = message.chatRole == WearChatRole.USER
  val background =
    when (message.chatRole) {
      WearChatRole.USER -> colors.surfacePressed
      WearChatRole.ASSISTANT -> colors.surfaceRaised
      WearChatRole.SYSTEM -> colors.surface
    }
  val foreground = colors.text
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(
          start = if (isUser) 28.dp else 12.dp,
          end = if (isUser) 12.dp else 28.dp,
        ).background(background, RoundedCornerShape(14.dp))
        .then(
          Modifier.border(
            width = 1.dp,
            color = colors.borderStrong,
            shape = RoundedCornerShape(14.dp),
          ),
        ).padding(horizontal = 12.dp, vertical = 9.dp),
  ) {
    Text(
      text =
        localizedWearUppercase(
          when (message.chatRole) {
            WearChatRole.USER -> stringResource(R.string.you)
            WearChatRole.ASSISTANT -> stringResource(R.string.agent)
            WearChatRole.SYSTEM -> stringResource(R.string.system)
          },
        ),
      color = if (isUser) foreground.copy(alpha = 0.72f) else colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
    Text(
      text = message.text,
      color = foreground,
      fontSize = 13.sp,
      lineHeight = 17.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun StreamingBubble(text: String) {
  val colors = OpenClawWearTheme.colors
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .background(colors.surfaceRaised, RoundedCornerShape(14.dp))
        .border(1.dp, colors.warning, RoundedCornerShape(14.dp))
        .padding(horizontal = 12.dp, vertical = 9.dp),
  ) {
    Text(
      text = localizedWearUppercase(stringResource(R.string.agent_working)),
      color = colors.warning,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
    Text(
      text = text,
      color = colors.text,
      fontSize = 13.sp,
      lineHeight = 17.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun EmptyConversation() {
  EmptyPanel(
    title = stringResource(R.string.start_conversation),
    detail = stringResource(R.string.start_conversation_detail),
  )
}

@Composable
private fun ConnectionPanel(snapshot: WearConversationSnapshot) {
  val connected = snapshot.gatewayState == WearGatewayState.CONNECTED
  val colors = OpenClawWearTheme.colors
  Panel {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        modifier =
          Modifier
            .size(8.dp)
            .background(
              if (connected) colors.success else colors.danger,
              CircleShape,
            ),
      )
      Spacer(modifier = Modifier.size(7.dp))
      Text(
        text = localizedWearUppercase(stringResource(R.string.connection)),
        color = colors.textMuted,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.8.sp,
      )
    }
    Spacer(modifier = Modifier.height(5.dp))
    Text(
      text =
        if (connected) {
          stringResource(R.string.gateway_connected)
        } else {
          stringResource(R.string.gateway_offline)
        },
      color = colors.text,
      fontSize = 17.sp,
      fontWeight = FontWeight.SemiBold,
    )
    Text(
      text = stringResource(R.string.phone_ready),
      color = colors.textMuted,
      fontSize = 12.sp,
    )
  }
}

@Composable
private fun PhoneBoundaryPanel() {
  Panel {
    Text(
      text = localizedWearUppercase(stringResource(R.string.security_boundary)),
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
    Spacer(modifier = Modifier.height(5.dp))
    Text(
      text = stringResource(R.string.phone_controlled),
      color = OpenClawWearTheme.colors.text,
      fontSize = 17.sp,
      fontWeight = FontWeight.SemiBold,
    )
    Text(
      text = stringResource(R.string.phone_controlled_detail),
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 12.sp,
      lineHeight = 16.sp,
    )
  }
}

@Composable
private fun ThemeModeSelector(
  themeMode: WearThemeMode,
  onThemeModeChange: (WearThemeMode) -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val shape = RoundedCornerShape(12.dp)
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp),
  ) {
    Text(
      text = localizedWearUppercase(stringResource(R.string.appearance)),
      color = colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      letterSpacing = 1.sp,
      modifier = Modifier.padding(start = 4.dp, bottom = 4.dp),
    )
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .background(colors.surface, shape)
          .border(width = 1.dp, color = colors.borderStrong, shape = shape)
          .padding(3.dp),
    ) {
      ThemeModeOption(
        label = stringResource(R.string.theme_dark),
        selected = themeMode == WearThemeMode.Dark,
        colors = colors,
        onClick = { onThemeModeChange(WearThemeMode.Dark) },
        modifier = Modifier.weight(1f),
      )
      ThemeModeOption(
        label = stringResource(R.string.theme_light),
        selected = themeMode == WearThemeMode.Light,
        colors = colors,
        onClick = { onThemeModeChange(WearThemeMode.Light) },
        modifier = Modifier.weight(1f),
      )
    }
  }
}

@Composable
private fun ThemeModeOption(
  label: String,
  selected: Boolean,
  colors: WearColors,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Box(
    modifier =
      modifier
        .minimumInteractiveComponentSize()
        .background(
          color = if (selected) colors.primary else Color.Transparent,
          shape = RoundedCornerShape(9.dp),
        ).selectable(
          selected = selected,
          onClick = onClick,
          role = Role.RadioButton,
        ),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      color = if (selected) colors.primaryText else colors.textMuted,
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      modifier = Modifier.padding(horizontal = 8.dp),
    )
  }
}

@Composable
private fun SelectionButton(
  title: String,
  detail: String,
  selected: Boolean,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  Button(
    onClick = onClick,
    enabled = enabled,
    colors =
      ButtonDefaults.buttonColors(
        containerColor = if (selected) colors.primary else colors.surfaceRaised,
        contentColor = if (selected) colors.primaryText else colors.text,
        disabledContainerColor =
          if (selected) colors.primary else colors.surface,
        disabledContentColor =
          if (selected) colors.primaryText else colors.textMuted,
      ),
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .border(
          width = 1.dp,
          color =
            when {
              selected -> colors.primary
              enabled -> colors.borderStrong
              else -> colors.border
            },
          shape = RoundedCornerShape(26.dp),
        ),
    label = {
      Column(modifier = Modifier.fillMaxWidth()) {
        Text(
          text = title,
          fontSize = 14.sp,
          fontWeight = FontWeight.SemiBold,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = detail,
          fontSize = 10.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    },
  )
}

@Composable
private fun ActionButton(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = OpenClawWearTheme.colors
  Button(
    onClick = onClick,
    enabled = enabled,
    colors =
      ButtonDefaults.buttonColors(
        containerColor = colors.primary,
        contentColor = colors.primaryText,
        disabledContainerColor = colors.surface,
        disabledContentColor = colors.textMuted,
      ),
    modifier = modifier,
    label = {
      Text(
        text = label,
        modifier = Modifier.fillMaxWidth(),
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
      )
    },
  )
}

@Composable
private fun SecondaryButton(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  Button(
    onClick = onClick,
    enabled = enabled,
    colors =
      ButtonDefaults.buttonColors(
        containerColor = colors.surfaceRaised,
        contentColor = colors.text,
        disabledContainerColor = colors.surface,
        disabledContentColor = colors.textMuted,
      ),
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .border(
          width = 1.dp,
          color = if (enabled) colors.borderStrong else colors.border,
          shape = RoundedCornerShape(26.dp),
        ),
    label = {
      Text(
        text = label,
        modifier = Modifier.fillMaxWidth(),
        textAlign = TextAlign.Center,
      )
    },
  )
}

@Composable
private fun EmptyPanel(
  title: String,
  detail: String,
) {
  Panel {
    Text(
      text = title,
      color = OpenClawWearTheme.colors.text,
      fontSize = 17.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
    Spacer(modifier = Modifier.height(3.dp))
    Text(
      text = detail,
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 12.sp,
      lineHeight = 16.sp,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

@Composable
private fun InlineError(text: String) {
  val colors = OpenClawWearTheme.colors
  Text(
    text = text,
    color = colors.danger,
    fontSize = 12.sp,
    lineHeight = 16.sp,
    textAlign = TextAlign.Center,
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 18.dp),
    maxLines = 4,
    overflow = TextOverflow.Ellipsis,
  )
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
  val colors = OpenClawWearTheme.colors
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .background(colors.surfaceRaised, RoundedCornerShape(12.dp))
        .border(
          width = 1.dp,
          color = colors.borderStrong,
          shape = RoundedCornerShape(12.dp),
        ).padding(horizontal = 14.dp, vertical = 12.dp),
    content = content,
  )
}

@Composable
private fun failureTitle(failure: WearConversationFailure?): String =
  when (failure) {
    WearConversationFailure.PHONE_UNAVAILABLE ->
      stringResource(R.string.phone_unavailable)
    WearConversationFailure.PHONE_NOT_READY ->
      stringResource(R.string.open_phone_app)
    WearConversationFailure.GATEWAY_OFFLINE ->
      stringResource(R.string.gateway_offline)
    WearConversationFailure.NOT_FOUND ->
      stringResource(R.string.selection_not_found)
    WearConversationFailure.ACTION_REJECTED ->
      stringResource(R.string.message_not_sent)
    WearConversationFailure.INCOMPATIBLE ->
      stringResource(R.string.update_required)
    WearConversationFailure.INTERNAL_ERROR,
    null,
    -> stringResource(R.string.something_went_wrong)
  }

@Composable
private fun failureDetail(failure: WearConversationFailure?): String =
  when (failure) {
    WearConversationFailure.PHONE_UNAVAILABLE ->
      stringResource(R.string.phone_unavailable_detail)
    WearConversationFailure.PHONE_NOT_READY ->
      stringResource(R.string.phone_not_ready_detail)
    WearConversationFailure.GATEWAY_OFFLINE ->
      stringResource(R.string.gateway_offline_detail)
    WearConversationFailure.NOT_FOUND ->
      stringResource(R.string.refresh_and_try_again)
    WearConversationFailure.ACTION_REJECTED ->
      stringResource(R.string.try_again)
    WearConversationFailure.INCOMPATIBLE ->
      stringResource(R.string.update_required_detail)
    WearConversationFailure.INTERNAL_ERROR,
    null,
    -> stringResource(R.string.try_again)
  }

private const val CHAT_FIXED_ITEM_COUNT = 2
private const val VISIBLE_MESSAGE_COUNT = 8
private const val VISIBLE_REALTIME_ENTRY_COUNT = 6
