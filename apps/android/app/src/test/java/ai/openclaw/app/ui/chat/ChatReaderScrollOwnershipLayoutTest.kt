package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatReaderPosition
import ai.openclaw.app.chat.ChatReaderPositionBinding
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Reader-owner animation proof; the app's separate code-reading test owns real nested dragging. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-420dpi", application = Application::class)
class ChatReaderScrollOwnershipLayoutTest {
  private val animationScale =
    object : MotionDurationScale {
      override val scaleFactor = 1f
    }

  @get:Rule
  val composeRule = createComposeRule(effectContext = animationScale)

  private lateinit var reader: ChatReaderScrollController
  private var observedScale: Float? = null
  private var bookmark: ChatReaderPosition? = null

  @Test
  fun manualNavigationStopsAnAlreadyMovingAutomaticScroll() {
    verifyManualTakeover(replaceRunningTransition = false)
  }

  @Test
  fun manualNavigationStopsReplacementAfterTheOlderTransitionIsCancelled() {
    verifyManualTakeover(replaceRunningTransition = true)
  }

  @Test
  fun finishingHistoryLoadDoesNotCancelAMovingNewUserTurn() {
    showReader(initialHistoryLoading = true)
    composeRule.waitForIdle()
    click("Read earlier")
    composeRule.waitForIdle()
    val initial = viewport()
    assertTrue("History must begin away from the latest row", initial.index > 0)
    val originalAutoAdvance = composeRule.mainClock.autoAdvance
    composeRule.mainClock.autoAdvance = false
    try {
      click("Append user turn")
      composeRule.mainClock.advanceTimeByFrame()
      drainCurrentWork()
      val newTurnStart = viewport()
      assertTrue("The new turn must start an automatic scroll", newTurnStart.scrolling)
      advanceUntilMoving(newTurnStart, "new user turn before history settles")
      click("Loading: true")
      composeRule.mainClock.advanceTimeByFrame()
      drainCurrentWork()
      composeRule.onNodeWithText("Loading: false").assertIsDisplayed()
      composeRule.mainClock.autoAdvance = true
      composeRule.waitForIdle()
      assertEquals("Finishing history must preserve the in-progress new-turn scroll", ViewportPosition(0, 0), viewport().position)
      composeRule.onNodeWithText("new user").assertIsDisplayed()
      assertFalse(viewport().scrolling)
    } finally {
      composeRule.mainClock.autoAdvance = originalAutoAdvance
      composeRule.waitForIdle()
    }
  }

  @Test
  fun persistedAnchorWaitsForAuthoritativeHistoryAfterPartialCache() {
    val fullHistory = listOf(message("old user", "user", 1)) + (0 until 20).map { message("assistant $it", "assistant", it + 2) }
    val expectedIndex =
      buildChatTimeline(fullHistory, 0, emptyList(), null).items.indexOfFirst { item ->
        (item as? ChatTimelineItem.Message)?.message?.id == "assistant 10"
      }
    composeRule.setContent {
      ClawDesignTheme {
        var messages by remember { mutableStateOf(listOf(fullHistory.last())) }
        var historyResolved by remember { mutableStateOf(false) }
        val timeline = remember(messages) { buildChatTimeline(messages, 0, emptyList(), null) }
        val current =
          rememberChatReaderScrollController(
            gatewayId = "gateway-a",
            ownerAgentId = "main",
            sessionKey = "main",
            sessionId = "session-a",
            timeline = timeline,
            historyLoading = false,
            historyResolved = historyResolved,
            loadPosition = { scope ->
              ChatReaderPositionBinding(scope, ChatReaderPosition("assistant 10", 23))
            },
          )
        SideEffect { reader = current }
        Column {
          TextButton(
            onClick = {
              messages = fullHistory
              historyResolved = true
            },
          ) { Text("Resolve history") }
          LazyColumn(state = current.listState, reverseLayout = true, modifier = Modifier.height(480.dp)) {
            items(timeline.items, key = ::chatTimelineItemKey) { item ->
              Box(Modifier.fillMaxWidth().height(64.dp)) {
                Text(
                  (item as ChatTimelineItem.Message)
                    .message
                    .content
                    .single()
                    .text
                    .orEmpty(),
                )
              }
            }
          }
        }
      }
    }

    composeRule.waitForIdle()
    click("Resolve history")
    composeRule.waitForIdle()

    assertEquals(ViewportPosition(expectedIndex, 23), viewport().position)
  }

  @Test
  fun reopeningRespectsLiveFollowingManualReadingAndJumpToLatest() {
    showReader(withPersistence = true)
    composeRule.waitForIdle()
    assertNull("Following latest must not save yesterday's last message", bookmark)
    click("Read here")
    composeRule.waitForIdle()
    val pausedAtEdge = requireNotNull(bookmark)
    click("Reopen")
    composeRule.waitForIdle()
    assertEquals("An existing bookmark preserves the pause, even before any new output", pausedAtEdge, bookmark)
    click("Jump to latest")
    composeRule.waitForIdle()
    assertNull(bookmark)
    click("Reopen + output")
    composeRule.waitForIdle()
    assertEquals(ViewportPosition(0, 0), viewport().position)
    composeRule.onNodeWithText("reopened reply 2").assertIsDisplayed()

    click("Read earlier")
    composeRule.waitForIdle()
    val saved = requireNotNull(bookmark)
    val oldViewport = viewport().position
    click("Reopen + output")
    composeRule.waitForIdle()
    assertEquals(saved, bookmark)
    assertEquals(ViewportPosition(oldViewport.index + 1, oldViewport.offset), viewport().position)

    composeRule.mainClock.autoAdvance = false
    try {
      click("Jump to latest")
      composeRule.mainClock.advanceTimeByFrame()
      drainCurrentWork()
      assertNull("The live-edge choice must clear the bookmark before the animation finishes", bookmark)
    } finally {
      composeRule.mainClock.autoAdvance = true
      composeRule.waitForIdle()
    }
    click("Reopen + output")
    composeRule.waitForIdle()
    assertEquals(ViewportPosition(0, 0), viewport().position)
    composeRule.onNodeWithText("reopened reply 4").assertIsDisplayed()
  }

  @Test
  fun manualGestureBeforeBookmarkLoadPreservesViewportAndPersistsWhenBound() {
    verifyPendingRestore(manual = true)
  }

  @Test
  fun delayedBookmarkLoadWithoutInputStillRestoresSavedViewport() {
    verifyPendingRestore(manual = false)
  }

  @Test
  fun manualGestureRetiresDeferredHistoryRestoration() {
    // Controller contract coverage for independently published history readiness. The
    // production regression above has authoritative history and a suspended store read;
    // it does not assume a long-lived partial-cache/known-session-ID startup window.
    verifyPendingRestore(manual = true, deferHistory = true)
  }

  private fun verifyPendingRestore(
    manual: Boolean,
    deferHistory: Boolean = false,
  ) {
    val fullHistory =
      listOf(message("old user", "user", 1)) +
        (0 until 20).map { message("assistant $it", "assistant", it + 2) } +
        message("current user", "user", 30) +
        (20 until 60).map { message("assistant $it", "assistant", it + 40) }
    val fullTimeline = buildChatTimeline(fullHistory, 0, emptyList(), null)
    val savedPosition = ChatReaderPosition("assistant 10", 23)
    val savedIndex = fullTimeline.items.indexOfFirst { (it as? ChatTimelineItem.Message)?.message?.id == savedPosition.messageId }
    val loadEntered = CompletableDeferred<Unit>()
    val releaseLoad = CompletableDeferred<Unit>()
    bookmark = savedPosition
    composeRule.setContent {
      ClawDesignTheme {
        // Keep the current user turn in the cached slice, but not the older bookmark.
        var messages by remember { mutableStateOf(if (deferHistory) fullHistory.takeLast(41) else fullHistory) }
        var historyResolved by remember { mutableStateOf(!deferHistory) }
        val timeline = remember(messages) { buildChatTimeline(messages, 0, emptyList(), null) }
        val current =
          rememberChatReaderScrollController(
            gatewayId = "gateway-a",
            ownerAgentId = "main",
            sessionKey = "main",
            sessionId = "session-a",
            timeline = timeline,
            historyLoading = false,
            historyResolved = historyResolved,
            loadPosition = {
              loadEntered.complete(Unit)
              if (!deferHistory) releaseLoad.await()
              ChatReaderPositionBinding(it, savedPosition)
            },
            savePosition = { _, position -> bookmark = position },
            clearPosition = { bookmark = null },
          )
        SideEffect { reader = current }
        Column {
          TextButton(onClick = {
            messages = fullHistory
            historyResolved = true
            releaseLoad.complete(Unit)
          }) { Text("Finish restore") }
          TextButton(onClick = { messages = messages + message("new assistant", "assistant", 200) }) { Text("Append assistant") }
          TextButton(onClick = { messages = messages + message("new user", "user", 300) }) { Text("Append user") }
          LazyColumn(
            state = current.listState,
            reverseLayout = true,
            modifier =
              Modifier
                .fillMaxWidth()
                .height(480.dp)
                .testTag("pending-reader")
                .nestedScroll(current.nestedScrollConnection),
          ) {
            items(timeline.items, key = ::chatTimelineItemKey) { item ->
              Box(Modifier.fillMaxWidth().height(64.dp)) {
                Text(
                  (item as ChatTimelineItem.Message)
                    .message.content
                    .single()
                    .text
                    .orEmpty(),
                )
              }
            }
          }
        }
      }
    }
    try {
      composeRule.waitForIdle()
      assertTrue("The real load callback must have started", loadEntered.isCompleted)
      assertEquals(ViewportPosition(0, 0), viewport().position)
      if (manual) {
        composeRule.onNodeWithTag("pending-reader").performTouchInput { swipeDown(durationMillis = 800) }
        composeRule.waitForIdle()
      }
      val selected = viewport().position
      if (manual) {
        assertTrue("A real LazyColumn gesture must move the viewport", selected.index > 0 && selected.index < savedIndex)
      }
      if (!deferHistory) assertEquals("No write lease exists before the delayed load completes", savedPosition, bookmark)
      click("Finish restore")
      composeRule.waitForIdle()
      println("READER_PENDING_RESTORE manual=$manual deferredHistory=$deferHistory selected=$selected after=" + viewport().position + " bookmark=$bookmark")
      if (!manual) {
        assertEquals(ViewportPosition(savedIndex, savedPosition.itemOffset), viewport().position)
        assertEquals(savedPosition.messageId, bookmark?.messageId)
        assertEquals(savedPosition.itemOffset, bookmark?.itemOffset)
        return
      }
      assertEquals("Late restoration must not override deliberate reading", selected, viewport().position)
      val selectedMessage = (fullTimeline.items[selected.index] as ChatTimelineItem.Message).message
      assertEquals(selectedMessage.id, bookmark?.messageId)
      assertEquals(selected.offset, bookmark?.itemOffset)

      // Resolving the existing user turn is not new input; assistant output must
      // keep the chosen row, while a genuine new user turn still follows live.
      click("Append assistant")
      composeRule.waitForIdle()
      assertEquals(ViewportPosition(selected.index + 1, selected.offset), viewport().position)
      assertEquals(selectedMessage.id, bookmark?.messageId)
      click("Append user")
      composeRule.waitForIdle()
      assertEquals(ViewportPosition(0, 0), viewport().position)
      composeRule.onNodeWithText("new user").assertIsDisplayed()
      assertNull(bookmark)
    } finally {
      releaseLoad.complete(Unit)
      composeRule.waitForIdle()
    }
  }

  private fun verifyManualTakeover(replaceRunningTransition: Boolean) {
    showReader()
    composeRule.waitForIdle()
    assertEquals("The actual effect context must allow timed animations", 1f, checkNotNull(observedScale), 0f)
    click("Read earlier")
    composeRule.waitForIdle()
    val initial = viewport()
    assertTrue("History must begin away from the latest row", initial.index > 0)
    assertFalse(initial.scrolling)

    val originalAutoAdvance = composeRule.mainClock.autoAdvance
    composeRule.mainClock.autoAdvance = false
    try {
      click("Jump to latest")
      val first = advanceUntilMoving(initial, "first automatic transition")

      if (replaceRunningTransition) {
        click("Append user turn")
        // Deliver the real timeline effect, then drain the older animation's cancellation.
        composeRule.mainClock.advanceTimeByFrame()
        drainCurrentWork()
        composeRule.onNodeWithText("User turns: 2").assertIsDisplayed()
        val replacementStart = viewport()
        assertTrue("The replacement must still be moving before manual takeover", replacementStart.scrolling)
        advanceUntilMoving(replacementStart, "replacement automatic transition")
      } else {
        assertTrue(first.scrolling)
      }

      // This visible fixture control uses the same provided navigation callback as
      // View all and Start/End of code; it does not reach into reader implementation state.
      click("Read here")
      drainCurrentWork()
      val stopped = viewport()
      composeRule.mainClock.advanceTimeBy(200)
      composeRule.waitForIdle()
      val afterFrames = viewport()

      // Cancellation must not poison the reader scope or prevent a later explicit jump.
      composeRule.mainClock.autoAdvance = true
      click("Jump to latest")
      composeRule.waitForIdle()
      assertEquals(ViewportPosition(0, 0), viewport().position)
      composeRule.onNodeWithText(if (replaceRunningTransition) "new user" else "assistant 59").assertIsDisplayed()
      assertEquals("Manual navigation must stop the automatic viewport movement", stopped.position, afterFrames.position)
      assertFalse("No automatic mutation may remain after manual takeover", afterFrames.scrolling)
    } finally {
      composeRule.mainClock.autoAdvance = originalAutoAdvance
      composeRule.waitForIdle()
    }
  }

  private fun advanceUntilMoving(
    before: Viewport,
    label: String,
  ): Viewport {
    composeRule.mainClock.advanceTimeUntil(timeoutMillis = 1_000) {
      reader.listState.isScrollInProgress &&
        ViewportPosition(reader.listState.firstVisibleItemIndex, reader.listState.firstVisibleItemScrollOffset) != before.position
    }
    composeRule.waitForIdle()
    val moving = viewport()
    assertTrue("$label must have observable animation frames, not an instant jump", moving.scrolling && moving.index > 0)
    assertTrue("$label must actually move", before.position != moving.position)
    println("READER_SCROLL phase=$label clock=${composeRule.mainClock.currentTime} before=${before.position} after=${moving.position} scale=$observedScale")
    return moving
  }

  private fun drainCurrentWork() {
    composeRule.mainClock.advanceTimeBy(0, ignoreFrameDuration = true)
    composeRule.waitForIdle()
  }

  private fun viewport(): Viewport =
    composeRule.runOnUiThread {
      Viewport(
        position = ViewportPosition(reader.listState.firstVisibleItemIndex, reader.listState.firstVisibleItemScrollOffset),
        scrolling = reader.listState.isScrollInProgress,
      )
    }

  private fun click(label: String) {
    composeRule
      .onNodeWithText(label)
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
  }

  private fun showReader(
    initialHistoryLoading: Boolean = false,
    withPersistence: Boolean = false,
  ) {
    val initialMessages = listOf(message("old user", "user", 1)) + (0 until 60).map { message("assistant $it", "assistant", it + 2) }
    composeRule.setContent {
      ClawDesignTheme {
        var messages by remember { mutableStateOf(initialMessages) }
        var historyLoading by remember { mutableStateOf(initialHistoryLoading) }
        val scope = rememberCoroutineScope()
        val timeline = remember(messages) { buildChatTimeline(messages, 0, emptyList(), null) }
        var reopenGeneration by remember { mutableStateOf(0) }
        val current =
          key(reopenGeneration) {
            rememberChatReaderScrollController(
              "animation-owner",
              timeline,
              historyLoading = historyLoading,
              historyResolved = true,
              gatewayId = "gateway-a".takeIf { withPersistence },
              ownerAgentId = "main",
              sessionId = "session-a",
              loadPosition = { ChatReaderPositionBinding(it, bookmark) },
              savePosition = { _, position -> bookmark = position },
              clearPosition = { bookmark = null },
            )
          }
        SideEffect { reader = current }
        LaunchedEffect(Unit) { observedScale = currentCoroutineContext()[MotionDurationScale]?.scaleFactor }
        CompositionLocalProvider(LocalChatReaderNavigation provides current.onManualNavigation) {
          val manualNavigation = LocalChatReaderNavigation.current
          Column(Modifier.size(360.dp, 700.dp).clipToBounds()) {
            Row(horizontalArrangement = Arrangement.SpaceBetween) {
              TextButton(onClick = current.jumpToLatest) { Text("Jump to latest") }
              TextButton(
                onClick = {
                  current.onManualNavigation()
                  scope.launch { current.listState.scrollToItem(checkNotNull(timeline.readAnchorIndex)) }
                },
              ) { Text("Read earlier") }
              TextButton(onClick = manualNavigation) { Text("Read here") }
            }
            TextButton(onClick = { messages = initialMessages + message("new user", "user", 1000) }) { Text("Append user turn") }
            if (withPersistence) {
              Row {
                TextButton(onClick = { reopenGeneration += 1 }) { Text("Reopen") }
                TextButton(onClick = {
                  reopenGeneration += 1
                  messages = messages + message("reopened reply $reopenGeneration", "assistant", 1000 + reopenGeneration)
                }) { Text("Reopen + output") }
              }
            } else {
              TextButton(onClick = { historyLoading = !historyLoading }) { Text("Loading: $historyLoading") }
            }
            Text("User turns: ${messages.count { it.role == "user" }}")
            LazyColumn(
              state = current.listState,
              reverseLayout = true,
              modifier = Modifier.fillMaxWidth().height(480.dp).nestedScroll(current.nestedScrollConnection),
            ) {
              items(timeline.items, key = ::chatTimelineItemKey) { item ->
                val message = (item as ChatTimelineItem.Message).message
                Box(Modifier.fillMaxWidth().height(64.dp)) {
                  Text(
                    message.content
                      .single()
                      .text
                      .orEmpty(),
                  )
                }
              }
            }
          }
        }
      }
    }
  }

  private fun message(
    text: String,
    role: String,
    timestamp: Int,
  ) = ChatMessage(
    id = text,
    role = role,
    content = listOf(ChatMessageContent(type = "text", text = text)),
    timestampMs = timestamp.toLong(),
  )

  private data class ViewportPosition(
    val index: Int,
    val offset: Int,
  )

  private data class Viewport(
    val position: ViewportPosition,
    val scrolling: Boolean,
  ) {
    val index: Int get() = position.index
  }
}
