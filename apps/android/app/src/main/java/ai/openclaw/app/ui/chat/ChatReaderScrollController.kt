package ai.openclaw.app.ui.chat

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
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
)

@Composable
internal fun rememberChatReaderScrollController(
  sessionKey: String,
  timeline: ChatTimeline,
  historyLoading: Boolean,
): ChatReaderScrollController {
  val listState = rememberLazyListState()
  val scope = rememberCoroutineScope()
  val targetTolerancePx = with(LocalDensity.current) { 24.dp.roundToPx() }
  val currentTimeline by rememberUpdatedState(timeline)
  val readerStateSaver = remember(sessionKey) { createChatReaderStateSaver(sessionKey) }
  var readerState by
    rememberSaveable(sessionKey, stateSaver = readerStateSaver) {
      mutableStateOf(ChatReaderState(ownerSessionKey = sessionKey))
    }
  var isApplyingScroll by remember(sessionKey) { mutableStateOf(false) }
  var isUserScrolling by remember(sessionKey) { mutableStateOf(false) }

  suspend fun applyTransition(transition: ChatReaderTransition) {
    readerState = transition.state
    val index = transition.scrollIndex ?: return
    isApplyingScroll = true
    try {
      if (transition.animated) {
        listState.animateScrollToItem(index)
      } else {
        listState.scrollToItem(index)
      }
    } finally {
      isApplyingScroll = false
    }
  }

  LaunchedEffect(sessionKey, timeline, historyLoading) {
    val transition =
      if (readerState.initialized) {
        readerState.onTimelineChanged(timeline, historyLoading)
      } else {
        initialChatReaderTransition(timeline, ownerSessionKey = sessionKey)
      }
    applyTransition(transition)
  }

  LaunchedEffect(sessionKey) {
    snapshotFlow {
      Triple(
        listState.isScrollInProgress,
        listState.firstVisibleItemIndex,
        listState.firstVisibleItemScrollOffset,
      )
    }.collect { (scrolling, index, offset) ->
      if (!readerState.initialized || isApplyingScroll) return@collect
      if (scrolling) {
        isUserScrolling = true
        readerState = readerState.copy(followTarget = null)
      } else if (isUserScrolling) {
        isUserScrolling = false
        readerState = readerState.onViewportChanged(index, offset, currentTimeline, targetTolerancePx)
      }
    }
  }

  return ChatReaderScrollController(
    listState = listState,
    showJumpToLatest = readerState.hasNewerContent && timeline.items.isNotEmpty(),
    jumpToLatest = {
      scope.launch {
        applyTransition(readerState.jumpToLatest(currentTimeline))
      }
    },
  )
}

internal fun initialChatReaderTransition(
  timeline: ChatTimeline,
  ownerSessionKey: String? = null,
): ChatReaderTransition {
  val initialIndex = timeline.readAnchorIndex ?: timeline.latestContentIndex
  val followTarget = timeline.followTargetForIndex(initialIndex)
  return ChatReaderTransition(
    state =
      ChatReaderState(
        ownerSessionKey = ownerSessionKey,
        initialized = initialIndex != null,
        followTarget = followTarget,
        hasNewerContent =
          followTarget == ChatScrollFollowTarget.ReadAnchor && initialIndex != timeline.latestContentIndex,
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

private fun ChatTimeline.followTargetForIndex(index: Int?): ChatScrollFollowTarget? {
  if (index == null) return null
  return when {
    latestUserMessageId != null && index == readAnchorIndex -> ChatScrollFollowTarget.ReadAnchor
    index == latestContentIndex -> ChatScrollFollowTarget.LatestContent
    else -> null
  }
}

private fun isAtTarget(
  index: Int,
  offset: Int,
  target: Int?,
  tolerancePx: Int,
): Boolean = target != null && index == target && offset <= tolerancePx
