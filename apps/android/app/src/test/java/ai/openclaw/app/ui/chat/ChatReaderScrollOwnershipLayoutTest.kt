package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeWithVelocity
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.currentCoroutineContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.config.ConfigurationRegistry

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

  @Test
  fun manualNavigationStopsAnAlreadyMovingAutomaticScroll() {
    verifyManualTakeover(replaceRunningTransition = false)
  }

  @Test
  fun manualNavigationStopsReplacementAfterTheOlderTransitionIsCancelled() {
    verifyManualTakeover(replaceRunningTransition = true)
  }

  @Test
  fun explicitReadingDuringAFlingDoesNotResumeFollowingAtLatest() {
    showReader(readLatestOnNavigation = true)
    composeRule.waitForIdle()
    click("Read earlier")
    composeRule.waitForIdle()

    fun latestRowVisible(): Boolean {
      val layout = reader.listState.layoutInfo
      val latestRow = layout.visibleItemsInfo.firstOrNull { it.key == "message:assistant 59" }
      return latestRow != null && latestRow.offset >= layout.viewportStartOffset && latestRow.offset + latestRow.size <= layout.viewportEndOffset
    }

    assertEquals(1f, checkNotNull(observedScale), 0f)
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    assertFalse("The reading target must initially be outside the viewport", latestRowVisible())
    val dragDistance = with(composeRule.density) { 48.dp.toPx() }
    val releaseVelocity = with(composeRule.density) { 400.dp.toPx() }
    val originalAutoAdvance = composeRule.mainClock.autoAdvance
    composeRule.mainClock.autoAdvance = false
    try {
      transcript.performTouchInput {
        swipeWithVelocity(center, center - Offset(0f, dragDistance), endVelocity = releaseVelocity)
      }
      val moving = advanceUntilMoving(viewport(), "real-fling-before-reader-navigation")
      assertTrue("Explicit reading must interrupt a moving fling", moving.scrolling)
      assertFalse("The target must still require explicit reading", latestRowVisible())
      click("Read latest")
      composeRule.mainClock.autoAdvance = true
      composeRule.waitForIdle()
      assertFalse(viewport().scrolling)
      assertTrue("Explicit reading must reveal the complete target", latestRowVisible())
      val reading = composeRule.onNodeWithText("assistant 59").assertIsDisplayed().getUnclippedBoundsInRoot()
      click("Append assistant")
      composeRule.waitForIdle()
      assertEquals(62, reader.listState.layoutInfo.totalItemsCount)
      val after = composeRule.onNodeWithText("assistant 59").assertIsDisplayed().getUnclippedBoundsInRoot()
      assertEquals("Explicit reading must survive the previous fling's idle event", reading.top.value, after.top.value, 1f / composeRule.density.density)
      composeRule.onNodeWithText("assistant 60").assertIsNotDisplayed()
      click("Jump to latest")
      composeRule.waitForIdle()
      composeRule.onNodeWithText("assistant 60").assertIsDisplayed()
      click("Append assistant")
      composeRule.waitForIdle()
      composeRule.onNodeWithText("assistant 61").assertIsDisplayed()
    } finally {
      composeRule.mainClock.autoAdvance = originalAutoAdvance
      composeRule.waitForIdle()
    }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun pausedStreamingGrowthPreservesVisibleGlyphsAndJumpResumesFollowing() {
    showReader(initialStreamingLines = 24)
    composeRule.waitForIdle()
    assertEquals(GraphicsMode.Mode.NATIVE, ConfigurationRegistry.get(GraphicsMode.Mode::class.java))
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val dragDistance = with(composeRule.density) { 80.dp.toPx() }
    transcript.performTouchInput {
      swipeWithVelocity(center, center + Offset(0f, dragDistance), endVelocity = 0f)
    }
    composeRule.waitForIdle()
    assertFalse(viewport().scrolling)
    assertTrue("Manual departure must leave newer content below the viewport", reader.showJumpToLatest)

    val before = renderedStream()
    val clip = transcript.fetchSemanticsNode().boundsInRoot
    val marker = (1..24).map { "S%03d".format(it) }.first { inside(clip, markerBounds(before, it)) }
    val reading = markerBounds(before, marker)
    assertTrue(inside(before.first.boundsInRoot, reading))
    assertFalse("The reply's ending must be below the paused viewport", inside(clip, endingBounds(before)))
    val origin = before.first.positionInRoot
    val height = before.second.size.height

    click("Append stream")
    composeRule.waitForIdle()
    val after = renderedStream()
    assertEquals(streamText(48), after.second.layoutInput.text.text)
    assertTrue("The same streaming text layout must actually grow", after.second.size.height > height)
    val afterGlyphs = markerBounds(after, marker)
    println("READER_GROWTH marker=$marker before=$reading after=$afterGlyphs origin=$origin next=${after.first.positionInRoot}")
    assertEquals("Paused growth must preserve the visible glyph's vertical position", reading.top, afterGlyphs.top, 1f)
    assertTrue("The reading glyphs must remain inside the clipped viewport", inside(clip, afterGlyphs))
    assertEquals("The same paragraph origin must stay anchored", origin.y, after.first.positionInRoot.y, 1f)
    assertTrue(reader.showJumpToLatest)

    click("Jump to latest")
    composeRule.waitForIdle()
    assertTrue("An explicit Jump must reveal the new ending", inside(clip, endingBounds(renderedStream())))
    assertFalse(reader.showJumpToLatest)
    click("Append stream")
    composeRule.waitForIdle()
    assertEquals(
      streamText(72),
      renderedStream()
        .second.layoutInput.text.text,
    )
    assertTrue("Growth after Jump must keep following the ending", inside(clip, endingBounds(renderedStream())))
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun streamingGrowthAtLiveEdgeKeepsEndingGlyphsVisible() {
    showReader(initialStreamingLines = 24)
    composeRule.waitForIdle()
    val clip = composeRule.onNode(hasScrollToIndexAction()).fetchSemanticsNode().boundsInRoot
    assertTrue(inside(clip, endingBounds(renderedStream())))
    click("Append stream")
    composeRule.waitForIdle()
    val after = renderedStream()
    assertEquals(streamText(48), after.second.layoutInput.text.text)
    assertTrue("Following must reveal the actual ending after measured growth", inside(clip, endingBounds(after)))
    assertFalse(reader.showJumpToLatest)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun growthOfAnOlderVisibleRowDoesNotMoveTheSelectedStreamingAnchor() {
    showReader(initialStreamingLines = 8, growEarlierRow = true)
    composeRule.waitForIdle()
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val dragDistance = with(composeRule.density) { 80.dp.toPx() }
    transcript.performTouchInput {
      swipeWithVelocity(center, center + Offset(0f, dragDistance), endVelocity = 0f)
    }
    composeRule.waitForIdle()
    assertTrue(reader.showJumpToLatest)
    assertFalse(viewport().scrolling)
    val beforeLayout = reader.listState.layoutInfo
    assertEquals("stream", beforeLayout.visibleItemsInfo.single { it.index == reader.listState.firstVisibleItemIndex }.key)
    val older = beforeLayout.visibleItemsInfo.single { it.key == "message:assistant 59" }
    val before = renderedStream()
    val clip = transcript.fetchSemanticsNode().boundsInRoot
    val reading = markerBounds(before, "S001")
    assertTrue("The selected stream's reading glyphs must be visible before unrelated growth", inside(clip, reading))
    val origin = before.first.positionInRoot

    click("Grow earlier row")
    composeRule.waitForIdle()
    val afterLayout = reader.listState.layoutInfo
    assertTrue("The same-key older row must actually grow", afterLayout.visibleItemsInfo.single { it.key == older.key }.size > older.size)
    val after = renderedStream()
    assertEquals(streamText(8), after.second.layoutInput.text.text)
    assertEquals("The selected stream itself did not change height", before.second.size.height, after.second.size.height)
    val afterGlyphs = markerBounds(after, "S001")
    println("READER_OTHER_ROW_GROWTH before=$reading after=$afterGlyphs origin=$origin next=${after.first.positionInRoot}")
    assertEquals("Growth above the selected row must not move its reading glyphs", reading.top, afterGlyphs.top, 1f)
    assertTrue(inside(clip, afterGlyphs))
    assertEquals(origin.y, after.first.positionInRoot.y, 1f)
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

      // This visible fixture control uses the same provided navigation owner as
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
    readLatestOnNavigation: Boolean = false,
    initialStreamingLines: Int? = null,
    growEarlierRow: Boolean = false,
  ) {
    val initialMessages = listOf(message("old user", "user", 1)) + (0 until 60).map { message("assistant $it", "assistant", it + 2) }
    composeRule.setContent {
      ClawDesignTheme {
        var messages by remember { mutableStateOf(initialMessages) }
        var historyLoading by remember { mutableStateOf(initialHistoryLoading) }
        var streamingLines by remember { mutableStateOf(initialStreamingLines) }
        val scope = rememberCoroutineScope()
        val timeline = remember(messages, streamingLines) { buildChatTimeline(messages, if (streamingLines == null) 0 else 1, emptyList(), streamingLines?.let(::streamText)) }
        val current = rememberChatReaderScrollController("animation-owner", timeline, historyLoading = historyLoading)
        SideEffect { reader = current }
        LaunchedEffect(Unit) { observedScale = currentCoroutineContext()[MotionDurationScale]?.scaleFactor }
        CompositionLocalProvider(LocalChatReaderNavigation provides current.navigation) {
          val navigation = checkNotNull(LocalChatReaderNavigation.current)
          Column(Modifier.size(360.dp, 700.dp).clipToBounds()) {
            Row(horizontalArrangement = Arrangement.SpaceBetween) {
              TextButton(onClick = current.jumpToLatest) { Text("Jump to latest") }
              TextButton(
                onClick = {
                  navigation.launch(scope) { current.listState.scrollToItem(checkNotNull(timeline.readAnchorIndex)) }
                },
              ) { Text("Read earlier") }
              TextButton(onClick = {
                if (readLatestOnNavigation) {
                  navigation.launch(scope) { current.listState.scrollToItem(checkNotNull(timeline.latestContentIndex)) }
                } else {
                  navigation.pause()
                }
              }) { Text(if (readLatestOnNavigation) "Read latest" else "Read here") }
            }
            TextButton(onClick = { messages = initialMessages + message("new user", "user", 1000) }) { Text("Append user turn") }
            if (readLatestOnNavigation) {
              TextButton(onClick = { messages = messages + message("assistant ${messages.count { it.role == "assistant" }}", "assistant", messages.size + 1) }) { Text("Append assistant") }
            }
            if (streamingLines != null) {
              TextButton(onClick = {
                if (growEarlierRow) {
                  messages = messages.map { if (it.id == "assistant 59") it.copy(content = listOf(ChatMessageContent(type = "text", text = "assistant 59\nMore context\nStill more context"))) else it }
                } else {
                  streamingLines = checkNotNull(streamingLines) + 24
                }
              }) { Text(if (growEarlierRow) "Grow earlier row" else "Append stream") }
            }
            TextButton(onClick = { historyLoading = !historyLoading }) { Text("Loading: $historyLoading") }
            Text("User turns: ${messages.count { it.role == "user" }}")
            LazyColumn(
              state = current.listState,
              reverseLayout = true,
              modifier = Modifier.fillMaxWidth().height(480.dp).nestedScroll(current.nestedScrollConnection),
            ) {
              items(timeline.items, key = ::chatTimelineItemKey) { item ->
                when (item) {
                  is ChatTimelineItem.StreamingAssistant -> {
                    // Unlike the fixed-height fixture siblings, this is the app's genuinely growing renderer.
                    ChatMarkdown(text = item.text, textColor = ClawTheme.colors.text, isStreaming = true, bodyStyle = ClawTheme.type.body)
                  }

                  ChatTimelineItem.Thinking -> {
                    Text("Working")
                  }

                  is ChatTimelineItem.Message -> {
                    if (growEarlierRow && item.message.id == "assistant 59") {
                      Text(
                        item.message.content
                          .single()
                          .text
                          .orEmpty(),
                      )
                    } else {
                      Box(Modifier.fillMaxWidth().height(64.dp)) {
                        Text(
                          item.message.content
                            .single()
                            .text
                            .orEmpty(),
                        )
                      }
                    }
                  }

                  else -> {
                    error("Unexpected ownership fixture item: $item")
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private fun streamText(lines: Int): String = (1..lines).joinToString("\n") { "S%03d Synthetic reader text describes ordinary objects without tools or provider execution.".format(it) }

  private fun renderedStream(): Pair<SemanticsNode, TextLayoutResult> {
    val target = composeRule.onNode(hasText("S001 Synthetic", substring = true), useUnmergedTree = true).assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    target.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
    return target.fetchSemanticsNode() to layouts.single()
  }

  private fun markerBounds(
    rendered: Pair<SemanticsNode, TextLayoutResult>,
    marker: String,
  ): Rect {
    val (node, layout) = rendered
    val start =
      layout.layoutInput.text.text
        .indexOf(marker)
    assertTrue("Rendered text must retain $marker", start >= 0)
    val glyphs = marker.indices.map { layout.getBoundingBox(start + it).translate(node.positionInRoot) }
    assertTrue("Glyph geometry must be finite and positive", glyphs.all { it.left.isFinite() && it.top.isFinite() && it.width > 0f && it.height > 0f })
    return Rect(glyphs.minOf { it.left }, glyphs.minOf { it.top }, glyphs.maxOf { it.right }, glyphs.maxOf { it.bottom })
  }

  private fun endingBounds(rendered: Pair<SemanticsNode, TextLayoutResult>): Rect {
    val (node, layout) = rendered
    val glyph = layout.getBoundingBox(layout.layoutInput.text.length - 1).translate(node.positionInRoot)
    assertTrue("The ending glyph needs finite positive geometry", glyph.left.isFinite() && glyph.top.isFinite() && glyph.width > 0f && glyph.height > 0f)
    return glyph
  }

  private fun inside(
    clip: Rect,
    glyph: Rect,
  ): Boolean = clip.contains(glyph.topLeft) && clip.contains(glyph.bottomRight - Offset(0.01f, 0.01f))

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
