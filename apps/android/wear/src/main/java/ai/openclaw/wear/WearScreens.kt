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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.HorizontalPagerScaffold
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val PAGE_COUNT = 3
private const val CHAT_PAGE = 0
private const val VOICE_PAGE = 1
private const val CONTROLS_PAGE = 2
private const val VOICE_MODE_COUNT = 2
private const val VOICE_HOME_MODE = 0
private const val VOICE_THREAD_MODE = 1

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
  onTalk: () -> Unit,
  onType: () -> Unit,
  onRealtimeTalk: () -> Unit,
  onAbort: () -> Unit,
  onSelectAgent: (String) -> Unit,
  onSelectSession: (String) -> Unit,
  onSelectModel: (String) -> Unit,
  onRefresh: () -> Unit,
  onGatewayEnabledChange: (Boolean) -> Unit,
  onThemeModeChange: (WearThemeMode) -> Unit,
  onAutoSpeakChange: (Boolean) -> Unit,
  onRequestNotifications: () -> Unit,
  onOpenNotificationSettings: () -> Unit,
  onSpeakLatest: () -> Unit,
  onStopSpeaking: () -> Unit,
) {
  if (snapshot == null) {
    ConnectionStateScreen(
      loading = loading,
      failure = failure,
      onRefresh = onRefresh,
    )
    return
  }

  val colors = OpenClawWearTheme.colors
  val pagerState = rememberPagerState(pageCount = { PAGE_COUNT })
  val voicePagerState = rememberPagerState(pageCount = { VOICE_MODE_COUNT })
  val pagerScope = rememberCoroutineScope()
  val realtimeActive = snapshot.realtimeTalk.active || realtimeCapturing
  var showVoiceSwipeHint by remember { mutableStateOf(true) }
  var realtimeStartedAtMillis by remember { mutableLongStateOf(0L) }
  var realtimeElapsedSeconds by remember { mutableLongStateOf(0L) }
  LaunchedEffect(pagerState.currentPage, showVoiceSwipeHint) {
    if (pagerState.currentPage == VOICE_PAGE && showVoiceSwipeHint) {
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
  BackHandler(enabled = pagerState.currentPage == VOICE_PAGE) {
    pagerScope.launch {
      pagerState.animateScrollToPage(CHAT_PAGE)
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
        pagerState.currentPage != VOICE_PAGE ||
          voicePagerState.currentPage == VOICE_HOME_MODE ||
          voicePagerState.currentPage == VOICE_THREAD_MODE,
    ) { page ->
      when (page) {
        CHAT_PAGE ->
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
            onSpeakLatest = onSpeakLatest,
            onStopSpeaking = onStopSpeaking,
          )
        CONTROLS_PAGE ->
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
        else ->
          VoicePage(
            voicePagerState = voicePagerState,
            showSwipeHint = showVoiceSwipeHint && pagerState.currentPage == VOICE_PAGE,
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
      }
    }
  }
}

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
  onSpeakLatest: () -> Unit,
  onStopSpeaking: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  WearPage(pageLabel = stringResource(R.string.chat)) {
    item {
      ConversationIdentity(
        snapshot = snapshot,
        actionBusy = actionBusy,
        onSelectAgent = onSelectAgent,
        onSelectSession = onSelectSession,
        onSelectModel = onSelectModel,
      )
    }
    item {
      ConversationStatus(
        interaction = interaction,
        speaking = speaking,
        gatewayConnected = snapshot.gatewayState == WearGatewayState.CONNECTED,
      )
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
    if (canAbort) {
      item {
        SecondaryButton(
          label = stringResource(R.string.abort_run),
          enabled = true,
          onClick = onAbort,
        )
      }
    }
    if (snapshot.messages.isEmpty() && snapshot.streamingAssistantText.isNullOrBlank()) {
      item {
        EmptyConversation()
      }
    } else {
      snapshot.messages
        .takeLast(VISIBLE_MESSAGE_COUNT)
        .forEach { message ->
          item(key = message.id ?: "${message.role}:${message.timestamp}:${message.text.hashCode()}") {
            MessageBubble(message = message)
          }
        }
      snapshot.streamingAssistantText
        ?.takeIf(String::isNotBlank)
        ?.let { streaming ->
          item {
            StreamingBubble(text = streaming)
          }
        }
    }
    if (snapshot.messages.any { message -> message.chatRole == WearChatRole.ASSISTANT }) {
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
    snapshot.errorText
      ?.takeIf(String::isNotBlank)
      ?.let { error ->
        item {
          InlineError(text = error)
        }
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
        fontSize = 9.sp,
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
  val dictateEnabled = inputEnabled && !actionBusy && !speaking && !realtimeActive && !dictatePreview
  val liveEnabled =
    (realtimeActive || ttsOnly || (inputEnabled && !actionBusy)) && !dictatePreview
  val startDictate: () -> Unit = {
    if (dictateEnabled) {
      coroutineScope.launch {
        dictatePreview = true
        delay(300L)
        dictatePreview = false
        onTalk()
      }
    }
  }
  val toggleLive: () -> Unit = {
    if (liveEnabled) {
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
  Box(
    modifier =
      Modifier
        .fillMaxSize()
        .padding(horizontal = 14.dp),
  ) {
    Row(
      modifier =
        Modifier
          .align(Alignment.Center)
          .fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      VoiceGestureLabel(
        title = stringResource(R.string.hold),
        detail = stringResource(R.string.dictate),
        accent = colors.voiceAccent,
        onClick = if (dictateEnabled) startDictate else null,
        modifier =
          Modifier
            .weight(1f),
      )
      Box(
        modifier =
          Modifier
            .width(92.dp)
            .height(134.dp),
      ) {
        VoiceGestureLabel(
          title = stringResource(R.string.double_tap),
          detail = stringResource(R.string.thread),
          accent = colors.voiceAccent,
          verticalPadding = 0.dp,
          modifier =
            Modifier
              .align(Alignment.TopCenter)
              .offset(y = (-4).dp)
              .fillMaxWidth(),
        )
        Box(
          modifier =
            Modifier
              .align(Alignment.Center)
              .size(92.dp)
              .combinedClickable(
                enabled = !dictatePreview,
                role = Role.Button,
                onClick = toggleLive,
                onDoubleClick = onOpenThread,
                onLongClick = startDictate,
              ),
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
            fontSize = 9.sp,
            lineHeight = 10.sp,
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
        onClick = if (liveEnabled) toggleLive else null,
        modifier =
          Modifier
            .offset(x = (-6).dp)
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
  verticalPadding: androidx.compose.ui.unit.Dp = 10.dp,
) {
  val interactionModifier =
    if (onClick != null || onDoubleClick != null) {
      Modifier.combinedClickable(
        role = Role.Button,
        onClick = { onClick?.invoke() },
        onDoubleClick = onDoubleClick,
      )
    } else {
      Modifier
    }
  Column(
    modifier =
      modifier
        .then(interactionModifier)
        .padding(vertical = verticalPadding),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      text = title,
      color = accent,
      fontSize = 10.sp,
      lineHeight = 10.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
    )
    Text(
      text = detail,
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 9.sp,
      lineHeight = 9.sp,
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
            fontSize = 11.sp,
            lineHeight = 14.sp,
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
      Box(
        modifier =
          Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = 44.dp)
            .background(colors.voiceAccentSoft, RoundedCornerShape(14.dp))
            .border(1.dp, colors.voiceAccent, RoundedCornerShape(14.dp))
            .clickable(role = Role.Button) {
              followState = wearThreadFollowLatest(followState)
              if (latestAnchorIndex >= 0) {
                coroutineScope.launch {
                  listState.animateScrollToItem(latestAnchorIndex)
                }
              }
            }.padding(horizontal = 10.dp, vertical = 5.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = "${stringResource(R.string.new_messages)} ↓",
          color = colors.voiceAccent,
          fontSize = 9.sp,
          fontWeight = FontWeight.Bold,
        )
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
            .height(34.dp)
            .background(colors.surfaceRaised, RoundedCornerShape(17.dp))
            .border(1.dp, colors.borderStrong, RoundedCornerShape(17.dp))
            .clickable(
              enabled = inputEnabled && !actionBusy && !realtimeActive,
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
            .size(36.dp)
            .background(
              color = if (realtimeActive) colors.voiceAccent else colors.surfaceRaised,
              shape = CircleShape,
            ).border(
              width = 1.dp,
              color = colors.voiceAccent,
              shape = CircleShape,
            ).clickable(
              enabled = realtimeActive || (inputEnabled && !actionBusy),
              role = Role.Button,
              onClick = onRealtimeTalk,
            ),
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
      text = "${stringResource(R.string.thinking)}…",
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
        if (isUser) {
          stringResource(R.string.you)
        } else {
          stringResource(R.string.agent)
        }.uppercase(),
      color = if (isUser) foreground.copy(alpha = 0.72f) else colors.textMuted,
      fontSize = 9.sp,
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
        text = stringResource(R.string.live).uppercase(),
        color = colors.warning,
        fontSize = 9.sp,
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
    snapshot.errorText?.takeIf(String::isNotBlank)?.let { error ->
      item { InlineError(text = error) }
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
  content: androidx.wear.compose.foundation.lazy.TransformingLazyColumnScope.() -> Unit,
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
      text = stringResource(R.string.app_name).uppercase(),
      color = colors.text,
      fontSize = 16.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.4.sp,
      textAlign = TextAlign.Center,
      maxLines = 1,
    )
    Text(
      text = pageLabel.uppercase(),
      color = colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      letterSpacing = 1.4.sp,
      textAlign = TextAlign.Center,
    )
  }
}

@Composable
private fun ConversationIdentity(
  snapshot: WearConversationSnapshot,
  actionBusy: Boolean,
  onSelectAgent: (String) -> Unit,
  onSelectSession: (String) -> Unit,
  onSelectModel: (String) -> Unit,
) {
  val agentIndex = snapshot.agents.indexOfFirst(WearAgentSummary::selected)
  val sessionIndex = snapshot.sessions.indexOfFirst(WearSessionSummary::selected)
  val modelIndex = snapshot.models.indexOfFirst(WearModelSummary::selected)
  val agent = snapshot.agents.getOrNull(agentIndex) ?: snapshot.agents.firstOrNull()
  val session = snapshot.sessions.getOrNull(sessionIndex) ?: snapshot.sessions.firstOrNull()
  val model = snapshot.models.getOrNull(modelIndex)
  Panel {
    ContextPickerRow(
      label = stringResource(R.string.agent),
      value =
        listOfNotNull(
          agent?.emoji?.takeIf(String::isNotBlank),
          agent?.name ?: stringResource(R.string.agent),
        ).joinToString(" "),
      previous =
        snapshot.agents
          .getOrNull(agentIndex - 1)
          ?.takeIf { snapshot.agentControlsSupported && !actionBusy }
          ?.let { previous -> ({ onSelectAgent(previous.id) }) },
      next =
        snapshot.agents
          .getOrNull(if (agentIndex < 0) 0 else agentIndex + 1)
          ?.takeIf { snapshot.agentControlsSupported && !actionBusy }
          ?.let { next -> ({ onSelectAgent(next.id) }) },
    )
    ContextPickerRow(
      label = stringResource(R.string.session),
      value = session?.title ?: stringResource(R.string.current_session),
      previous =
        snapshot.sessions
          .getOrNull(sessionIndex - 1)
          ?.takeIf { !actionBusy }
          ?.let { previous -> ({ onSelectSession(previous.id) }) },
      next =
        snapshot.sessions
          .getOrNull(if (sessionIndex < 0) 0 else sessionIndex + 1)
          ?.takeIf { !actionBusy }
          ?.let { next -> ({ onSelectSession(next.id) }) },
    )
    ContextPickerRow(
      label = stringResource(R.string.model),
      value = model?.name ?: snapshot.selectedModelRef ?: stringResource(R.string.model),
      previous =
        snapshot.models
          .getOrNull(modelIndex - 1)
          ?.takeIf { snapshot.modelControlsSupported && !actionBusy }
          ?.let { previous -> ({ onSelectModel(previous.ref) }) },
      next =
        snapshot.models
          .getOrNull(if (modelIndex < 0) 0 else modelIndex + 1)
          ?.takeIf { snapshot.modelControlsSupported && !actionBusy }
          ?.let { next -> ({ onSelectModel(next.ref) }) },
    )
  }
}

@Composable
private fun ContextPickerRow(
  label: String,
  value: String,
  previous: (() -> Unit)?,
  next: (() -> Unit)?,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    PickerChevron(
      glyph = "‹",
      contentDescription = stringResource(R.string.previous_item, label),
      onClick = previous,
    )
    Column(
      modifier = Modifier.weight(1f),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(
        text = label.uppercase(),
        color = OpenClawWearTheme.colors.textMuted,
        fontSize = 8.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.8.sp,
        maxLines = 1,
      )
      Text(
        text = value,
        color = OpenClawWearTheme.colors.text,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    PickerChevron(
      glyph = "›",
      contentDescription = stringResource(R.string.next_item, label),
      onClick = next,
    )
  }
}

@Composable
private fun PickerChevron(
  glyph: String,
  contentDescription: String,
  onClick: (() -> Unit)?,
) {
  val colors = OpenClawWearTheme.colors
  val enabled = onClick != null
  Box(
    modifier =
      Modifier
        .width(32.dp)
        .height(30.dp)
        .semantics { this.contentDescription = contentDescription }
        .clickable(
          enabled = enabled,
          role = Role.Button,
          onClick = { onClick?.invoke() },
        ),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = glyph,
      color = if (enabled) colors.primary else colors.textMuted.copy(alpha = 0.42f),
      fontSize = 24.sp,
      lineHeight = 24.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
    )
  }
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
        when (message.chatRole) {
          WearChatRole.USER -> stringResource(R.string.you)
          WearChatRole.ASSISTANT -> stringResource(R.string.agent)
          WearChatRole.SYSTEM -> stringResource(R.string.system)
        }.uppercase(),
      color = if (isUser) foreground.copy(alpha = 0.72f) else colors.textMuted,
      fontSize = 9.sp,
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
      text = stringResource(R.string.agent_working).uppercase(),
      color = colors.warning,
      fontSize = 9.sp,
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
        text = stringResource(R.string.connection).uppercase(),
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
      text = stringResource(R.string.security_boundary).uppercase(),
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
      text = stringResource(R.string.appearance).uppercase(),
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
        .height(40.dp)
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
private fun CompactVoiceButton(
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
        containerColor = colors.surfaceRaised,
        contentColor = colors.text,
        disabledContainerColor = colors.surface,
        disabledContentColor = colors.textMuted,
      ),
    modifier =
      modifier.border(
        width = 1.dp,
        color = if (enabled) colors.borderStrong else colors.border,
        shape = RoundedCornerShape(24.dp),
      ),
    label = {
      Text(
        text = label,
        modifier = Modifier.fillMaxWidth(),
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        maxLines = 1,
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
    fontSize = 11.sp,
    lineHeight = 14.sp,
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

private const val VISIBLE_MESSAGE_COUNT = 8
private const val VISIBLE_REALTIME_ENTRY_COUNT = 6
