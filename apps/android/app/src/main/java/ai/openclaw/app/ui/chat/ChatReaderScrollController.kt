package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatReaderPosition
import ai.openclaw.app.chat.ChatReaderPositionBinding
import androidx.compose.foundation.gestures.stopScroll
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
  val scrollOffset: Int = 0,
  val animated: Boolean = false,
)

internal data class ChatReaderScrollController(
  val listState: LazyListState,
  val showJumpToLatest: Boolean,
  val jumpToLatest: () -> Unit,
  val onManualNavigation: () -> Unit,
  val nestedScrollConnection: NestedScrollConnection,
)

internal val LocalChatReaderNavigation = staticCompositionLocalOf<() -> Unit> { {} }

@Composable
internal fun rememberChatReaderScrollController(
  sessionKey: String,
  timeline: ChatTimeline,
  historyLoading: Boolean,
  gatewayId: String? = null,
  loadPosition: suspend (String, String) -> ChatReaderPositionBinding? = { _, _ -> null },
  savePosition: suspend (ChatReaderPositionBinding, ChatReaderPosition) -> Unit = { _, _ -> },
): ChatReaderScrollController {
  val listState = rememberLazyListState()
  val scope = rememberCoroutineScope()
  val targetTolerancePx = with(LocalDensity.current) { 24.dp.roundToPx() }
  val currentTimeline by rememberUpdatedState(timeline)
  val currentLoadPosition by rememberUpdatedState(loadPosition)
  val currentSavePosition by rememberUpdatedState(savePosition)
  val readerStateSaver = remember(gatewayId, sessionKey) { createChatReaderStateSaver(sessionKey) }
  var readerState by
    rememberSaveable(gatewayId, sessionKey, stateSaver = readerStateSaver) {
      mutableStateOf(ChatReaderState(ownerSessionKey = sessionKey))
    }
  var applyingScrollCount by remember(gatewayId, sessionKey) { mutableIntStateOf(0) }
  var isUserScrolling by remember(gatewayId, sessionKey) { mutableStateOf(false) }
  var positionBinding by remember(gatewayId, sessionKey) { mutableStateOf<ChatReaderPositionBinding?>(null) }
  var positionLoaded by remember(gatewayId, sessionKey) { mutableStateOf(false) }

  fun pauseFollowing() {
    readerState = readerState.copy(followTarget = null)
    // Stop an older automatic animation at its default priority, never interrupt
    // a newer user drag that has already taken ownership of the scroll state.
    if (applyingScrollCount > 0) scope.launch(start = CoroutineStart.UNDISPATCHED) { listState.stopScroll() }
  }

  val nestedScroll =
    remember(gatewayId, sessionKey) {
      object : NestedScrollConnection {
        override fun onPreScroll(
          available: Offset,
          source: NestedScrollSource,
        ): Offset {
          // A code viewport can consume the whole drag without scrolling the transcript.
          // Its reader intent must still retire follow, without consuming the gesture.
          if (source == NestedScrollSource.UserInput && available.y != 0f) pauseFollowing()
          return Offset.Zero
        }
      }
    }

  suspend fun applyTransition(transition: ChatReaderTransition) {
    val index = transition.scrollIndex
    if (index == null) {
      readerState = transition.state
      return
    }
    // A replacement cancels its predecessor before the predecessor's finally runs.
    // Count active invocations so that cleanup cannot hide the newer animation.
    applyingScrollCount += 1
    readerState = transition.state
    try {
      if (transition.animated) {
        listState.animateScrollToItem(index, transition.scrollOffset)
      } else {
        listState.scrollToItem(index, transition.scrollOffset)
      }
    } finally {
      applyingScrollCount -= 1
    }
  }

  LaunchedEffect(gatewayId, sessionKey) {
    positionBinding =
      gatewayId
        ?.takeIf(String::isNotBlank)
        ?.let { stableGatewayId ->
          runCatching { currentLoadPosition(stableGatewayId, sessionKey) }.getOrNull()
        }
    positionLoaded = true
  }

  // Loading only changes empty-timeline transitions. A populated-history refresh
  // must not cancel a moving scroll after its content version has been recorded.
  LaunchedEffect(sessionKey, timeline, historyLoading && timeline.items.isEmpty(), positionLoaded) {
    if (!positionLoaded) return@LaunchedEffect
    val persistedPosition = positionBinding?.position
    val restoredTransition =
      if (readerState.initialized) null else persistedPosition?.let { restoredChatReaderTransition(timeline, it, sessionKey) }
    if (!readerState.initialized && persistedPosition != null && restoredTransition == null && historyLoading) {
      // Cached history may not contain the durable anchor yet. Wait for the authoritative
      // load before applying the normal fallback and replacing the saved position.
      return@LaunchedEffect
    }
    val transition =
      if (readerState.initialized) {
        readerState.onTimelineChanged(timeline, historyLoading)
      } else {
        restoredTransition ?: initialChatReaderTransition(timeline, ownerSessionKey = sessionKey)
      }
    applyTransition(transition)
  }

  LaunchedEffect(gatewayId, sessionKey, positionBinding) {
    gatewayId?.takeIf(String::isNotBlank) ?: return@LaunchedEffect
    val binding = positionBinding ?: return@LaunchedEffect
    collectChatReaderPositionSaves(
      positions =
        snapshotFlow {
          val position =
            if (positionLoaded && readerState.initialized && applyingScrollCount == 0) {
              currentTimeline.readerPosition(
                index = listState.firstVisibleItemIndex,
                offset = listState.firstVisibleItemScrollOffset,
              )
            } else {
              null
            }
          listState.isScrollInProgress to position
        },
      save = { position -> currentSavePosition(binding, position) },
    )
  }

  LaunchedEffect(gatewayId, sessionKey) {
    snapshotFlow {
      Triple(
        listState.isScrollInProgress,
        listState.firstVisibleItemIndex,
        listState.firstVisibleItemScrollOffset,
      )
    }.collect { (scrolling, index, offset) ->
      if (!readerState.initialized || applyingScrollCount > 0) return@collect
      if (scrolling) {
        isUserScrolling = true
        readerState = readerState.copy(followTarget = null)
      } else if (isUserScrolling) {
        isUserScrolling = false
        readerState = readerState.onViewportChanged(index, offset, currentTimeline, targetTolerancePx)
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
      scope.launch {
        applyTransition(readerState.jumpToLatest(currentTimeline))
      }
    },
    onManualNavigation = ::pauseFollowing,
    nestedScrollConnection = nestedScroll,
  )
}

internal suspend fun collectChatReaderPositionSaves(
  positions: Flow<Pair<Boolean, ChatReaderPosition?>>,
  save: suspend (ChatReaderPosition) -> Unit,
) {
  var pendingPosition: ChatReaderPosition? = null
  try {
    positions.collectLatest { (scrolling, position) ->
      pendingPosition = position
      position ?: return@collectLatest
      if (scrolling) delay(250)
      withContext(NonCancellable) {
        val saved = runCatching { save(position) }.isSuccess
        if (saved && pendingPosition == position) pendingPosition = null
      }
    }
  } finally {
    pendingPosition?.let { position ->
      // Composition disposal must flush the last observed viewport even when it
      // cancels the debounce before the settled save begins.
      withContext(NonCancellable) { runCatching { save(position) } }
    }
  }
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

internal fun restoredChatReaderTransition(
  timeline: ChatTimeline,
  position: ChatReaderPosition,
  ownerSessionKey: String? = null,
): ChatReaderTransition? {
  // Gateway reloads can regenerate display IDs. The stable message version rebinds
  // the same transcript row; removed anchors fall through to the current live-edge policy.
  val restoredIndex =
    timeline.indexOfMessage(position.messageId)
      ?: position.messageVersion?.let(timeline::indexOfMessageVersion)
      ?: return null
  val followsLatest = restoredIndex == timeline.latestContentIndex && position.itemOffset == 0
  return ChatReaderTransition(
    state =
      ChatReaderState(
        ownerSessionKey = ownerSessionKey,
        initialized = true,
        followTarget = ChatScrollFollowTarget.LatestContent.takeIf { followsLatest },
        hasNewerContent = !followsLatest && timeline.latestContentIndex != null,
        latestUserMessageId = timeline.latestUserMessageId,
        latestUserMessageVersion = timeline.latestUserMessageVersion,
        latestContentVersion = timeline.latestContentVersion,
      ),
    scrollIndex = restoredIndex,
    scrollOffset = position.itemOffset,
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
    // iOS reader, #108692/#108693). ReadAnchor remains the session-restore bookmark only;
    // re-pinning the prompt here would hide the reply below the fold behind a jump pill.
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

internal fun ChatTimeline.readerPosition(
  index: Int,
  offset: Int,
): ChatReaderPosition? {
  val message = (items.getOrNull(index) as? ChatTimelineItem.Message)?.message ?: return null
  return ChatReaderPosition(
    messageId = message.id,
    itemOffset = offset,
    messageVersion = stableMessageVersion(message),
  )
}

private fun ChatTimeline.indexOfMessage(id: String): Int? =
  items
    .indexOfFirst { item -> item is ChatTimelineItem.Message && item.message.id == id }
    .takeIf { it >= 0 }

private fun ChatTimeline.indexOfMessageVersion(version: String): Int? =
  items
    .indexOfFirst { item -> item is ChatTimelineItem.Message && stableMessageVersion(item.message) == version }
    .takeIf { it >= 0 }

private fun isAtTarget(
  index: Int,
  offset: Int,
  target: Int?,
  tolerancePx: Int,
): Boolean = target != null && index == target && offset <= tolerancePx
