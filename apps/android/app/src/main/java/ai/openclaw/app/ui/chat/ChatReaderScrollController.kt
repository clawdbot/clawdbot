package ai.openclaw.app.ui.chat

import androidx.compose.foundation.gestures.stopScroll
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

internal enum class ChatScrollFollowTarget {
  ReadAnchor,
  LatestContent,
}

internal data class ChatReaderState(
  val ownerSessionKey: String? = null,
  val initialized: Boolean = false,
  val followTarget: ChatScrollFollowTarget? = null,
  val hasNewerContent: Boolean = false,
  val latestUserMessageId: String? = null,
  val latestUserMessageVersion: String? = null,
  val latestContentVersion: String? = null,
)

internal fun createChatReaderStateSaver(expectedSessionKey: String? = null) =
  listSaver<ChatReaderState, Any>(
    save = { state ->
      listOf(
        state.ownerSessionKey != null,
        state.ownerSessionKey.orEmpty(),
        state.initialized,
        state.followTarget?.name.orEmpty(),
        state.hasNewerContent,
        state.latestUserMessageId != null,
        state.latestUserMessageId.orEmpty(),
        state.latestUserMessageVersion != null,
        state.latestUserMessageVersion.orEmpty(),
        state.latestContentVersion != null,
        state.latestContentVersion.orEmpty(),
      )
    },
    restore = { saved ->
      val restored =
        ChatReaderState(
          ownerSessionKey = (saved[1] as String).takeIf { saved[0] as Boolean },
          initialized = saved[2] as Boolean,
          followTarget =
            (saved[3] as String).takeIf(String::isNotEmpty)?.let(ChatScrollFollowTarget::valueOf),
          hasNewerContent = saved[4] as Boolean,
          latestUserMessageId = (saved[6] as String).takeIf { saved[5] as Boolean },
          latestUserMessageVersion = (saved[8] as String).takeIf { saved[7] as Boolean },
          latestContentVersion = (saved[10] as String).takeIf { saved[9] as Boolean },
        )
      restored.takeIf { expectedSessionKey == null || it.ownerSessionKey == expectedSessionKey }
    },
  )

internal val ChatReaderStateSaver = createChatReaderStateSaver()

internal data class ChatReaderTransition(
  val state: ChatReaderState,
  val scrollIndex: Int? = null,
  val animated: Boolean = false,
)

internal data class ChatReaderScrollController(
  val listState: LazyListState,
  val showJumpToLatest: Boolean,
  val jumpToLatest: () -> Unit,
  val navigation: ChatReaderNavigation,
  val nestedScrollConnection: NestedScrollConnection,
)

private data class ChatReaderViewport(
  val scrolling: Boolean,
  val index: Int,
  val offset: Int,
  val placementRevision: Int,
  val layout: LazyListLayoutInfo,
  val canScroll: Boolean,
  val navigating: Boolean,
)

internal class ChatReaderNavigation(
  private val scope: CoroutineScope,
  private val listState: LazyListState? = null,
  private val pauseFollowing: () -> Unit = {},
) {
  val anchors = ChatReaderAnchors(listState)

  private data class Request(
    val job: Job,
    val automatic: Boolean,
  )

  private var active by mutableStateOf<Request?>(null)
  val isNavigating: Boolean get() = active != null

  fun launch(
    owner: CoroutineScope,
    automatic: Boolean = false,
    action: suspend () -> Unit,
  ): Job =
    owner.launch(start = CoroutineStart.UNDISPATCHED) {
      // Admit in the coroutine before suspension: cancelled row/session callbacks
      // return a cancelled job without retiring current work or skipping its cleanup.
      ensureActive()
      scope.ensureActive()
      if (!automatic) {
        anchors.invalidate()
        pauseFollowing()
      }
      retire()
      val request = coroutineContext.job
      active = Request(request, automatic)
      try {
        listState?.stopScroll()
        action()
      } finally {
        if (active?.job === request) active = null
      }
    }

  fun pause() {
    launch(scope) {}
  }

  fun cancel(request: Job) {
    if (active?.job === request) pause() else request.cancel()
  }

  fun cancelAutomatic() {
    active?.takeIf { it.automatic }?.job?.cancel()
  }

  fun retire() {
    active?.job?.cancel()
    active = null
  }

  fun viewportHeight(contentHeight: Int): Int = minOf(contentHeight, listState?.layoutInfo?.viewportSize?.height ?: contentHeight)
}

internal class ChatReaderAction(
  private val scope: CoroutineScope,
  private val navigation: ChatReaderNavigation,
) {
  private var request: Job? = null

  fun launch(action: suspend () -> Unit) {
    request = navigation.launch(scope, action = action)
  }

  fun pause() = launch {}

  fun cancel() {
    request?.let(navigation::cancel)
    request = null
  }

  fun viewportHeight(contentHeight: Int): Int = navigation.viewportHeight(contentHeight)
}

internal val LocalChatReaderNavigation = staticCompositionLocalOf<ChatReaderNavigation?> { null }

@Composable
internal fun rememberChatReaderAction(): ChatReaderAction {
  val scope = rememberCoroutineScope()
  val navigation = LocalChatReaderNavigation.current ?: remember(scope) { ChatReaderNavigation(scope) }
  val action = remember(scope, navigation) { ChatReaderAction(scope, navigation) }
  DisposableEffect(action) { onDispose { action.cancel() } }
  return action
}

@Composable
internal fun rememberChatReaderScrollController(
  sessionKey: String,
  timeline: ChatTimeline,
  historyLoading: Boolean,
): ChatReaderScrollController {
  val listState = rememberLazyListState()
  val scope = key(sessionKey) { rememberCoroutineScope() }
  val targetTolerancePx = with(LocalDensity.current) { 24.dp.roundToPx() }
  val currentTimeline by rememberUpdatedState(timeline)
  val readerStateSaver = remember(sessionKey) { createChatReaderStateSaver(sessionKey) }
  var readerState by
    rememberSaveable(sessionKey, stateSaver = readerStateSaver) {
      mutableStateOf(ChatReaderState(ownerSessionKey = sessionKey))
    }
  var isUserScrolling by remember(sessionKey) { mutableStateOf(false) }

  val navigation =
    remember(scope) {
      ChatReaderNavigation(scope, listState) {
        // Explicit reading replaces the gesture; its idle must not restore following.
        // The viewport still hides Jump while the latest content remains visible.
        isUserScrolling = false
        readerState = readerState.copy(followTarget = null, hasNewerContent = true)
      }
    }

  DisposableEffect(navigation) {
    onDispose {
      navigation.retire()
      navigation.anchors.clearReading()
    }
  }
  LaunchedEffect(navigation) {
    listState.interactionSource.interactions.collect { interaction ->
      if (interaction is DragInteraction.Start) navigation.pause()
    }
  }

  val nestedScroll =
    remember(sessionKey) {
      object : NestedScrollConnection {
        override fun onPreScroll(
          available: Offset,
          source: NestedScrollSource,
        ): Offset {
          // A code viewport can consume the whole drag without scrolling the transcript.
          // Its reader intent must still retire follow, without consuming the gesture.
          if (source == NestedScrollSource.UserInput && available.y != 0f) {
            navigation.anchors.invalidate()
            readerState = readerState.copy(followTarget = null)
            // Bring-into-view also emits UserInput; do not cancel its own reveal.
            navigation.cancelAutomatic()
          }
          return Offset.Zero
        }
      }
    }

  suspend fun applyTransition(transition: ChatReaderTransition) =
    coroutineScope {
      readerState = transition.state
      if (transition.state.followTarget != null) navigation.anchors.clearReading()
      val index = transition.scrollIndex ?: return@coroutineScope
      navigation
        .launch(this, automatic = true) {
          if (transition.animated) {
            listState.animateScrollToItem(index)
          } else {
            listState.scrollToItem(index)
          }
        }.join()
    }

  // Loading only changes empty-timeline transitions. A populated-history refresh
  // must not cancel a moving scroll after its content version has been recorded.
  LaunchedEffect(sessionKey, timeline, historyLoading && timeline.items.isEmpty()) {
    val transition =
      if (readerState.initialized) {
        readerState.onTimelineChanged(timeline, historyLoading)
      } else {
        initialChatReaderTransition(timeline, ownerSessionKey = sessionKey)
      }
    applyTransition(transition)
  }

  LaunchedEffect(sessionKey) {
    var previousViewport: ChatReaderViewport? = null
    snapshotFlow {
      ChatReaderViewport(
        listState.isScrollInProgress,
        listState.firstVisibleItemIndex,
        listState.firstVisibleItemScrollOffset,
        navigation.anchors.revision,
        listState.layoutInfo,
        listState.canScrollBackward || listState.canScrollForward,
        navigation.isNavigating,
      )
    }.collect { viewport ->
      // Observe geometry during navigation without replaying its suppressed resize later.
      val previous = previousViewport
      previousViewport = viewport
      if (!readerState.initialized || viewport.navigating) return@collect
      val (scrolling, index, offset) = viewport
      val resizedToFit =
        previous != null && !previous.navigating && !previous.scrolling && previous.canScroll &&
          !viewport.canScroll && viewport.layout.totalItemsCount > 0 &&
          previous.layout.viewportSize != viewport.layout.viewportSize
      if (scrolling) {
        navigation.anchors.clearReading()
        isUserScrolling = true
        readerState = readerState.copy(followTarget = null)
        return@collect
      } else if (isUserScrolling || resizedToFit) {
        isUserScrolling = false
        readerState = readerState.onViewportChanged(index, offset, currentTimeline, targetTolerancePx)
      }
      if (readerState.followTarget != null) {
        navigation.anchors.clearReading()
      } else if (navigation.anchors.needsCorrection()) {
        navigation
          .launch(this, automatic = true) {
            listState.scroll {
              if (readerState.followTarget == null) navigation.anchors.correct(::scrollBy)
            }
          }.join()
      }
    }
  }

  // reverseLayout puts the latest tail at the viewport start. Scrolling within
  // content padding does not hide text; this geometry must not change follow intent.
  val latestContentHidden by
    remember(listState) {
      derivedStateOf {
        val layoutInfo = listState.layoutInfo
        val latestItem = layoutInfo.visibleItemsInfo.firstOrNull { it.index == currentTimeline.latestContentIndex }
        latestItem?.let { it.offset < layoutInfo.viewportStartOffset } ?: listState.canScrollBackward
      }
    }
  return ChatReaderScrollController(
    listState = listState,
    showJumpToLatest = readerState.hasNewerContent && timeline.items.isNotEmpty() && latestContentHidden,
    jumpToLatest = {
      navigation.retire()
      scope.launch(start = CoroutineStart.UNDISPATCHED) {
        applyTransition(readerState.jumpToLatest(currentTimeline))
      }
    },
    navigation = navigation,
    nestedScrollConnection = nestedScroll,
  )
}

internal fun initialChatReaderTransition(
  timeline: ChatTimeline,
  ownerSessionKey: String? = null,
): ChatReaderTransition {
  val initialIndex = timeline.latestContentIndex
  return ChatReaderTransition(
    state =
      ChatReaderState(
        ownerSessionKey = ownerSessionKey,
        initialized = initialIndex != null,
        followTarget = initialIndex?.let { ChatScrollFollowTarget.LatestContent },
        latestUserMessageId = timeline.latestUserMessageId,
        latestUserMessageVersion = timeline.latestUserMessageVersion,
        latestContentVersion = timeline.latestContentVersion,
      ),
    scrollIndex = initialIndex,
  )
}

internal fun ChatReaderState.onTimelineChanged(
  timeline: ChatTimeline,
  historyLoading: Boolean = false,
): ChatReaderTransition {
  if (timeline.items.isEmpty()) {
    return ChatReaderTransition(
      state = if (historyLoading) this else ChatReaderState(ownerSessionKey = ownerSessionKey),
    )
  }
  if (timeline.latestContentVersion == latestContentVersion) {
    return ChatReaderTransition(state = this)
  }
  val previousUserStillPresent =
    if (latestUserMessageVersion == null) {
      latestUserMessageId == null
    } else {
      latestUserMessageId?.let(timeline::containsMessage) == true ||
        timeline.containsUserMessageVersion(latestUserMessageVersion)
    }
  if (!previousUserStillPresent) {
    return ChatReaderTransition(
      state =
        copy(
          followTarget = null,
          hasNewerContent = false,
          latestUserMessageId = timeline.latestUserMessageId,
          latestUserMessageVersion = timeline.latestUserMessageVersion,
          latestContentVersion = timeline.latestContentVersion,
        ),
    )
  }
  val hasNewUserTurn =
    timeline.latestUserMessageVersion != null && timeline.latestUserMessageVersion != latestUserMessageVersion
  if (hasNewUserTurn) {
    // A live turn follows the bottom so the reply streams into view (parity with the
    // iOS reader, #108692/#108693). Re-pinning the prompt here would hide the reply
    // below the fold behind a jump pill.
    return ChatReaderTransition(
      state =
        copy(
          followTarget = ChatScrollFollowTarget.LatestContent,
          hasNewerContent = false,
          latestUserMessageId = timeline.latestUserMessageId,
          latestUserMessageVersion = timeline.latestUserMessageVersion,
          latestContentVersion = timeline.latestContentVersion,
        ),
      scrollIndex = timeline.latestContentIndex ?: timeline.readAnchorIndex,
      animated = true,
    )
  }

  val target = followTarget
  if (target == null) {
    return ChatReaderTransition(
      state =
        copy(
          hasNewerContent = true,
          latestUserMessageId = timeline.latestUserMessageId,
          latestUserMessageVersion = timeline.latestUserMessageVersion,
          latestContentVersion = timeline.latestContentVersion,
        ),
    )
  }

  val targetIndex = timeline.indexForFollowTarget(target)
  return ChatReaderTransition(
    state =
      copy(
        hasNewerContent = target == ChatScrollFollowTarget.ReadAnchor && targetIndex != timeline.latestContentIndex,
        latestUserMessageId = timeline.latestUserMessageId,
        latestUserMessageVersion = timeline.latestUserMessageVersion,
        latestContentVersion = timeline.latestContentVersion,
      ),
    scrollIndex = targetIndex,
  )
}

internal fun ChatReaderState.onViewportChanged(
  index: Int,
  offset: Int,
  timeline: ChatTimeline,
  targetTolerancePx: Int,
): ChatReaderState {
  val nextTarget =
    if (isAtTarget(index, offset, timeline.latestContentIndex, targetTolerancePx)) {
      ChatScrollFollowTarget.LatestContent
    } else {
      null
    }
  return copy(
    followTarget = nextTarget,
    hasNewerContent = nextTarget == null && timeline.latestContentIndex != null,
  )
}

internal fun ChatReaderState.jumpToLatest(timeline: ChatTimeline): ChatReaderTransition =
  ChatReaderTransition(
    state = copy(followTarget = ChatScrollFollowTarget.LatestContent, hasNewerContent = false),
    scrollIndex = timeline.latestContentIndex ?: timeline.readAnchorIndex,
    animated = true,
  )

private fun ChatTimeline.indexForFollowTarget(target: ChatScrollFollowTarget): Int? =
  when (target) {
    ChatScrollFollowTarget.ReadAnchor -> readAnchorIndex
    ChatScrollFollowTarget.LatestContent -> latestContentIndex
  }

private fun ChatTimeline.containsMessage(id: String): Boolean =
  items
    .filterIsInstance<ChatTimelineItem.Message>()
    .any { item -> item.message.id == id }

private fun isAtTarget(
  index: Int,
  offset: Int,
  target: Int?,
  tolerancePx: Int,
): Boolean = target != null && index == target && offset <= tolerancePx
