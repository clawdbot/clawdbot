package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color
import android.util.Base64
import android.view.ViewConfiguration
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeWithVelocity
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.config.ConfigurationRegistry
import java.io.ByteArrayOutputStream

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
  private var olderReadingDisposals = 0

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
  fun explicitReadingOfFittingContentDoesNotResumeOnGrowth() = assertExplicitReadingSurvivesFit(heldResize = false)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun fitResizeDuringHeldNavigationIsNotReplayedOnCompletion() = assertExplicitReadingSurvivesFit(heldResize = true)

  private fun assertExplicitReadingSurvivesFit(heldResize: Boolean) {
    var height by mutableStateOf(if (heldResize) 120.dp else 480.dp)
    val release = if (heldResize) CompletableDeferred<Unit>() else null
    showReader(initialStreamingLines = 2, historyAssistantCount = 0, heldReading = release, viewportHeight = { height })
    composeRule.waitForIdle()
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val initialLayout = reader.listState.layoutInfo
    assertEquals("Only the prompt, Thinking and actual streaming row are present", 3, initialLayout.totalItemsCount)
    assertEquals("The starting overflow distinguishes the two intent cases", heldResize, reader.listState.canScrollBackward || reader.listState.canScrollForward)
    try {
      click("Read here")
      composeRule.waitForIdle()
      assertEquals("The fixture action must have the requested lifetime", heldResize, reader.navigation.isNavigating)
      if (heldResize) {
        composeRule.runOnIdle { height = 480.dp }
        composeRule.waitForIdle()
        assertTrue("Explicit navigation stays active through the fitting resize", reader.navigation.isNavigating)
        assertFalse("All history must fit before the action completes", reader.listState.canScrollBackward || reader.listState.canScrollForward)
        assertTrue("The actual measured viewport must grow", reader.listState.layoutInfo.viewportSize.height > initialLayout.viewportSize.height)
        composeRule.runOnIdle { checkNotNull(release).complete(Unit) }
        composeRule.waitForIdle()
      }
      assertFalse(reader.navigation.isNavigating)
      assertFalse(viewport().scrolling)
      assertFalse("The explicitly paused preview remains fully fitting", reader.listState.canScrollBackward || reader.listState.canScrollForward)
      val before = renderedStream()
      val clip = transcript.fetchSemanticsNode().boundsInRoot
      val reading = markerBounds(before, "S001")
      assertTrue("The logical reading glyph starts fully visible", inside(clip, reading))
      assertEquals(streamText(2), before.second.layoutInput.text.text)

      click("Append stream")
      composeRule.waitForIdle()
      val after = renderedStream()
      val afterGlyph = markerBounds(after, "S001")
      val diagnostic = "heldResize=$heldResize viewport=$clip beforeGlyph=$reading afterGlyph=$afterGlyph"
      println("READER_FIT_INTENT $diagnostic")
      assertEquals("Only stream content grows", streamText(26), after.second.layoutInput.text.text)
      assertTrue("Actual text grows past the fitting preview", after.second.size.height > before.second.size.height)
      assertEquals("Content growth must not change viewport geometry", clip, transcript.fetchSemanticsNode().boundsInRoot)
      assertFalse("Reading stops at the oldest-history boundary: $diagnostic", reader.listState.canScrollForward)
      assertTrue("The same logical glyph remains visible: $diagnostic", inside(clip, afterGlyph))
      assertFalse("Growth must not silently resume live following", inside(clip, endingBounds(after)))
      assertTrue(reader.showJumpToLatest)
    } finally {
      release?.complete(Unit)
    }
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun pausedReadingRetainsItsLogicalGlyphAcrossWidthReflow() = assertPausedReadingSurvivesViewportResize(280.dp, 480.dp)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun pausedReadingRetainsItsLogicalGlyphAcrossHeightReduction() = assertPausedReadingSurvivesViewportResize(360.dp, 300.dp)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun widthRoundTripRestoresPreferredGlyphAfterARealScrollClamp() = assertPausedReadingSurvivesViewportResize(360.dp, 480.dp, initialWidth = 180.dp, roundTripAfterClamp = true)

  private fun assertPausedReadingSurvivesViewportResize(
    width: Dp,
    height: Dp,
    initialWidth: Dp = 360.dp,
    roundTripAfterClamp: Boolean = false,
  ) {
    var viewportWidth by mutableStateOf(initialWidth)
    var viewportHeight by mutableStateOf(480.dp)
    showReader(initialStreamingLines = 24, viewportWidth = { viewportWidth }, viewportHeight = { viewportHeight })
    composeRule.waitForIdle()
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val distance = with(composeRule.density) { 80.dp.toPx() }
    transcript.performTouchInput { swipeWithVelocity(center, center + Offset(0f, distance), endVelocity = 0f) }
    composeRule.waitForIdle()
    assertFalse(viewport().scrolling)
    assertFalse(reader.navigation.isNavigating)
    assertTrue("The ordinary drag must pause following before resize", reader.showJumpToLatest)

    val before = renderedStream()
    val beforeClip = transcript.fetchSemanticsNode().boundsInRoot
    val text = before.second.layoutInput.text.text
    val character =
      text.indices.first { index ->
        !text[index].isWhitespace() && inside(beforeClip, before.second.getBoundingBox(index).translate(before.first.positionInRoot))
      }
    val reading = before.second.getBoundingBox(character).translate(before.first.positionInRoot)
    assertTrue("The selected logical glyph must be away from either text boundary", character > 0 && character < text.lastIndex)
    val relativeY = reading.top - beforeClip.top
    val oldLayout = reader.listState.layoutInfo
    val selected = oldLayout.visibleItemsInfo.single { it.index == reader.listState.firstVisibleItemIndex }
    assertEquals("stream", selected.key)
    assertTrue("These cases deliberately preserve an attainable, nonclamped target", relativeY >= 0f && relativeY + reading.height < with(composeRule.density) { height.toPx() })

    // Resize the actual parent constraints without another gesture or content update.
    composeRule.runOnIdle {
      viewportWidth = width
      viewportHeight = height
    }
    composeRule.waitForIdle()
    val afterClip = transcript.fetchSemanticsNode().boundsInRoot
    val after = renderedReaderText("S001 Synthetic", requireVisible = false)
    val glyph = after.second.getBoundingBox(character).translate(after.first.positionInRoot)
    val diagnostic = "logicalOffset=$character beforeViewport=$beforeClip afterViewport=$afterClip beforeGlyph=$reading afterGlyph=$glyph"
    println("READER_RESIZE $diagnostic")
    assertEquals("Viewport width must really change or remain as requested: $diagnostic", with(composeRule.density) { width.toPx() }, afterClip.width, 1f)
    assertEquals("Viewport height must really change or remain as requested: $diagnostic", with(composeRule.density) { height.toPx() }, afterClip.height, 1f)
    assertEquals("Resize must not replace or append content: $diagnostic", text, after.second.layoutInput.text.text)
    assertEquals(oldLayout.totalItemsCount, reader.listState.layoutInfo.totalItemsCount)
    assertFalse(viewport().scrolling)
    assertFalse(reader.navigation.isNavigating)
    if (width < initialWidth) {
      assertTrue("Narrower width must produce genuine text reflow: $diagnostic", after.second.lineCount > before.second.lineCount)
    } else if (width > initialWidth) {
      assertTrue("Widening must shorten the same real paragraph: $diagnostic", after.second.lineCount < before.second.lineCount && after.second.size.height < before.second.size.height)
    } else {
      assertEquals("Height-only resize must not reflow the paragraph", before.second.size, after.second.size)
    }
    if (roundTripAfterClamp) {
      assertTrue("This is a width-only widening within the existing host", width > initialWidth && width <= 360.dp)
      assertEquals("Width alone changes the viewport", beforeClip.height, afterClip.height, 0f)
      assertEquals("The selected glyph height does not trigger the existing geometry reset", reading.height, glyph.height, 0f)
      assertEquals("Reflow retains the same rendered text node", before.first.id, after.first.id)
      assertFalse("Correction reaches the actual latest scroll boundary: $diagnostic", reader.listState.canScrollBackward)
      assertTrue("Older history still overflows, so this is not a full-fit resume: $diagnostic", reader.listState.canScrollForward)
      assertEquals("The boundary is the actual latest item", 0, reader.listState.firstVisibleItemIndex)
      assertEquals("There is no remaining scroll toward latest", 0, reader.listState.firstVisibleItemScrollOffset)
      assertTrue("The preferred target must really be excluded by the scroll boundary: $diagnostic", glyph.top > afterClip.top + relativeY + 1f)
      assertTrue("The same glyph remains visible at the achievable target: $diagnostic", inside(afterClip, glyph))
      assertTrue("Widening reveals the actual ending at that boundary", inside(afterClip, endingBounds(after)))

      composeRule.runOnIdle { viewportWidth = initialWidth }
      composeRule.waitForIdle()
      val restoredClip = transcript.fetchSemanticsNode().boundsInRoot
      val restored = renderedReaderText("S001 Synthetic", requireVisible = false)
      val restoredGlyph = restored.second.getBoundingBox(character).translate(restored.first.positionInRoot)
      val roundTrip = "$diagnostic restoredViewport=$restoredClip restoredGlyph=$restoredGlyph"
      println("READER_WIDTH_ROUND_TRIP $roundTrip")
      assertEquals("The original viewport is restored", beforeClip, restoredClip)
      assertEquals("Width restoration retains identical content", text, restored.second.layoutInput.text.text)
      assertEquals("The original paragraph wrapping returns", before.second.size, restored.second.size)
      assertEquals("The same text node survives the round trip", before.first.id, restored.first.id)
      assertEquals("The glyph height remains unchanged throughout", reading.height, restoredGlyph.height, 0f)
      assertEquals("No timeline membership change explains the result", oldLayout.totalItemsCount, reader.listState.layoutInfo.totalItemsCount)
      assertTrue("The original preferred position has scroll room in both directions: $roundTrip", reader.listState.canScrollBackward && reader.listState.canScrollForward)
      assertFalse(viewport().scrolling)
      assertFalse(reader.navigation.isNavigating)
      assertTrue("The original glyph remains in the viewport: $roundTrip", inside(restoredClip, restoredGlyph))
      assertEquals("Restoring width restores the original preferred reading position: $roundTrip", reading.top, restoredGlyph.top, 1f)
      return
    }
    assertEquals("Resize must preserve the same logical reading point: $diagnostic", afterClip.top + relativeY, glyph.top, 1f)
    assertTrue("The retained reading glyph must remain visible: $diagnostic", inside(afterClip, glyph))
    assertTrue("Resizing is not an explicit return to live following", reader.showJumpToLatest)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun pausedStreamingGrowthPreservesVisibleGlyphsAndJumpResumesFollowing() {
    assertPausedStreamingGrowth(pauseAgain = false)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun explicitPauseAtTheSamePositionStillAnchorsTheNextGrowth() {
    assertPausedStreamingGrowth(pauseAgain = true)
  }

  private fun assertPausedStreamingGrowth(pauseAgain: Boolean) {
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

    if (pauseAgain) click("Read here")
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

    click("Append stream")
    composeRule.waitForIdle()
    val grown = renderedStream()
    assertEquals(streamText(32), grown.second.layoutInput.text.text)
    assertEquals("An unrelated measurement must not retire the retained reading point", reading.top, markerBounds(grown, "S001").top, 1f)
    assertEquals(origin.y, grown.first.positionInRoot.y, 1f)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun deferredPrefixInSelectedMessagePreservesVisibleMetadataGlyphs() {
    assertDeferredSelectedRowGrowth(appendSuffix = false)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun coalescedPrefixAndSuffixPreserveVisibleMetadataGlyphs() {
    assertDeferredSelectedRowGrowth(appendSuffix = true)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun readingInsideDecodedInlineImageSurvivesLaterTextGrowth() = assertDecodedImageReading(shortViewport = false)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun shortViewportKeepsTheSelectedDecodedImageVisible() = assertDecodedImageReading(shortViewport = true)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun shorterViewportKeepsAnAlreadyOversizedImageVisible() = assertDecodedImageReading(shortViewport = true, imageHeight = 1536)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun coupledViewportAndImageResizeKeepsTheSelectedImageVisible() = assertDecodedImageReading(shortViewport = true, imageHeight = 1536, coupledResize = true)

  private fun assertDecodedImageReading(
    shortViewport: Boolean,
    imageHeight: Int = 512,
    coupledResize: Boolean = false,
  ) {
    val bitmap = Bitmap.createBitmap(512, imageHeight, Bitmap.Config.ARGB_8888)
    val base64 =
      try {
        bitmap.setPixel(0, 0, Color.RED)
        bitmap.setPixel(1, 0, Color.BLUE)
        bitmap.setPixel(0, 1, Color.GREEN)
        bitmap.setPixel(1, 1, Color.YELLOW)
        ByteArrayOutputStream().use { bytes ->
          assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes))
          Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
        }
      } finally {
        bitmap.recycle()
      }
    var viewportHeight by mutableStateOf(480.dp)
    var viewportWidth by mutableStateOf(360.dp)
    showReader(initialStreamingLines = 2, inlineImage = base64, viewportWidth = { viewportWidth }, viewportHeight = { viewportHeight })
    composeRule.waitUntil { composeRule.onAllNodesWithContentDescription("image/png").fetchSemanticsNodes().size == 1 }
    val initialImage = composeRule.onNodeWithContentDescription("image/png").fetchSemanticsNode()
    println("READER_IMAGE_ARMING initial=${initialImage.positionInRoot} size=${initialImage.size}")
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val distance = with(composeRule.density) { 160.dp.toPx() }
    transcript.performTouchInput { swipeWithVelocity(center, center + Offset(0f, distance), endVelocity = 0f) }
    composeRule.waitForIdle()
    if (imageHeight > 512) {
      val clip = transcript.fetchSemanticsNode().boundsInRoot
      val desiredTop = clip.top + clip.height * 0.6f
      val slop = ViewConfiguration.get(RuntimeEnvironment.getApplication()).scaledTouchSlop.toFloat()
      // A tall image starts above the viewport. Reach a positive target with ordinary
      // measured drags; four gestures are a setup bound, not a retry of the resize.
      repeat(4) { gesture ->
        val imageTop =
          composeRule
            .onNodeWithContentDescription("image/png")
            .fetchSemanticsNode()
            .positionInRoot.y
        val needed = desiredTop - imageTop
        if (needed > 0f) {
          val travel = minOf(needed + slop, clip.height * 0.65f)
          println("READER_TALL_IMAGE_GESTURE index=$gesture imageTop=$imageTop desiredTop=$desiredTop travel=$travel viewport=$clip")
          transcript.performTouchInput {
            val start = Offset(center.x, (height - travel) / 2f)
            swipeWithVelocity(start, start + Offset(0f, travel), endVelocity = 0f)
          }
          composeRule.waitForIdle()
        }
      }
    }
    val movedImage = composeRule.onNodeWithContentDescription("image/png").fetchSemanticsNode()
    println("READER_IMAGE_ARMING moved=${movedImage.positionInRoot} size=${movedImage.size} viewport=${viewport().position}")
    val image = composeRule.onNodeWithContentDescription("image/png").assertIsDisplayed()
    composeRule.onNode(hasText("S001", substring = true), useUnmergedTree = true).assertIsNotDisplayed()
    assertTrue(reader.showJumpToLatest)
    val before = image.fetchSemanticsNode()
    val origin = before.positionInRoot
    val size = before.size
    if (shortViewport) {
      val beforeClip = transcript.fetchSemanticsNode().boundsInRoot
      val beforeRect = Rect(origin.x, origin.y, origin.x + size.width, origin.y + size.height)
      val reducedWidth = if (coupledResize) 120.dp else 360.dp
      val narrowedPixels = with(composeRule.density) { reducedWidth.toPx() }
      val reducedHeight =
        if (coupledResize) {
          assertTrue("The new width must constrain the intrinsic 512px bitmap", narrowedPixels < 512f)
          val expectedImageHeight = imageHeight * narrowedPixels / 512f
          val matchingViewportHeight = beforeClip.height - size.height + expectedImageHeight
          assertTrue("The derived viewport must have positive height", matchingViewportHeight > 0f)
          with(composeRule.density) { matchingViewportHeight.toDp() }
        } else {
          120.dp
        }
      val reducedPixels = with(composeRule.density) { reducedHeight.toPx() }
      val oldLayout = reader.listState.layoutInfo
      assertEquals("The real decoded image must own the first visible row", "stream", oldLayout.visibleItemsInfo.single { it.index == reader.listState.firstVisibleItemIndex }.key)
      assertTrue("The selected image begins inside the old viewport", beforeRect.top > beforeClip.top && beforeRect.top < beforeClip.bottom)
      assertTrue("Its existing target must be excluded by the short viewport", beforeRect.top - beforeClip.top > reducedPixels)
      assertTrue("There must be actual image area available to show", size.width > 0 && size.height > 0 && reducedPixels > 0)
      if (imageHeight > 512) {
        assertTrue("The actual opaque extent must exceed both viewport heights", size.height > beforeClip.height && size.height > reducedPixels)
        println("READER_SATURATED_RANGE oldRemaining=${beforeClip.height - size.height} newRemaining=${reducedPixels - size.height} originalTarget=${beforeRect.top - beforeClip.top}")
      }
      assertFalse(viewport().scrolling)
      assertFalse(reader.navigation.isNavigating)
      val beforeText =
        renderedReaderText("S001 Synthetic", requireVisible = false)
          .second.layoutInput.text.text
      composeRule.runOnIdle {
        viewportWidth = reducedWidth
        viewportHeight = reducedHeight
      }
      composeRule.waitForIdle()
      val afterClip = transcript.fetchSemanticsNode().boundsInRoot
      val after = image.fetchSemanticsNode()
      val position = after.positionInRoot
      val imageRect = Rect(position.x, position.y, position.x + after.size.width, position.y + after.size.height)
      val visibleWidth = (minOf(imageRect.right, afterClip.right) - maxOf(imageRect.left, afterClip.left)).coerceAtLeast(0f)
      val visibleHeight = (minOf(imageRect.bottom, afterClip.bottom) - maxOf(imageRect.top, afterClip.top)).coerceAtLeast(0f)
      val oldRawSpace = beforeClip.height - size.height
      val newRawSpace = afterClip.height - after.size.height
      val diagnostic = "beforeViewport=$beforeClip afterViewport=$afterClip beforeImage=$beforeRect afterImage=$imageRect visibleWidth=$visibleWidth visibleHeight=$visibleHeight oldRawSpace=$oldRawSpace newRawSpace=$newRawSpace canBackward=${reader.listState.canScrollBackward} canForward=${reader.listState.canScrollForward}"
      println("READER_OPAQUE_RESIZE $diagnostic")
      assertEquals("Actual requested viewport width: $diagnostic", narrowedPixels, afterClip.width, 1f)
      assertEquals("Actual short viewport: $diagnostic", reducedPixels, afterClip.height, 1f)
      if (coupledResize) {
        assertTrue("Both actual heights must change: $diagnostic", afterClip.height < beforeClip.height && after.size.height < size.height)
        assertEquals("Actual image width must be constrained below intrinsic width: $diagnostic", narrowedPixels, after.size.width.toFloat(), 1f)
        assertEquals("The actual signed available space must alias despite the resize: $diagnostic", oldRawSpace, newRawSpace, 0f)
        assertTrue("The image remains taller than the resized viewport: $diagnostic", after.size.height > afterClip.height)
      } else {
        assertEquals("The decoded image must not be replaced or remeasured at another size", size, after.size)
      }
      assertEquals(
        "No stream content changes during resizing",
        beforeText,
        renderedReaderText("S001 Synthetic", requireVisible = false)
          .second.layoutInput.text.text,
      )
      assertEquals("No timeline insertion or session change", oldLayout.totalItemsCount, reader.listState.layoutInfo.totalItemsCount)
      assertFalse(viewport().scrolling)
      assertFalse(reader.navigation.isNavigating)
      assertTrue("The excluded image must be able to move up into the viewport: $diagnostic", reader.listState.canScrollBackward)
      assertTrue("The retained image must intersect the new viewport: $diagnostic", visibleWidth > 0f && visibleHeight > 0f)
      return
    }
    click("Append stream")
    composeRule.waitForIdle()
    val after = image.fetchSemanticsNode()
    assertEquals("The same decoded image must retain its size", size, after.size)
    println("READER_IMAGE before=$origin after=${after.positionInRoot} size=$size")
    assertEquals("Reading inside the actual image must survive a later text suffix", origin.y, after.positionInRoot.y, 1f)
    image.assertIsDisplayed()
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun clampedReadingCorrectionSettlesAndKeepsTheNextTailAnchored() {
    val ready = CompletableDeferred<Unit>()
    showReader(deferredPrefix = ready, removeDeferredSuffix = true)
    composeRule.waitForIdle()
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val distance = with(composeRule.density) { 80.dp.toPx() }
    transcript.performTouchInput { swipeWithVelocity(center, center + Offset(0f, distance), endVelocity = 0f) }
    composeRule.waitForIdle()
    val before = viewport().position
    val row =
      reader.listState.layoutInfo.visibleItemsInfo
        .single { it.index == reader.listState.firstVisibleItemIndex }
    assertEquals("message:assistant 59", row.key)
    assertTrue(before.offset > 0)
    composeRule.runOnIdle { assertTrue(ready.complete(Unit)) }
    composeRule.waitForIdle()
    val current =
      reader.listState.layoutInfo.visibleItemsInfo
        .single { it.index == reader.listState.firstVisibleItemIndex }
    assertTrue("The suffix removal must exceed the available backward scroll", row.size - current.size > before.offset)
    assertEquals(ViewportPosition(0, 0), viewport().position)
    assertFalse(viewport().scrolling)
    assertFalse(reader.navigation.isNavigating)
    val clamped = markerBounds(renderedStream(), "S001")
    click("Append stream")
    composeRule.waitForIdle()
    assertEquals(
      streamText(16),
      renderedStream()
        .second.layoutInput.text.text,
    )
    assertEquals("A clamp must retain its achievable target, not loop or return to following", clamped.top, markerBounds(renderedStream(), "S001").top, 1f)
    assertFalse(reader.navigation.isNavigating)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun replacedSelectedTextDoesNotInheritThePreviousReadingPoint() {
    val ready = CompletableDeferred<Unit>()
    showReader(deferredPrefix = ready, replaceDeferredText = true)
    composeRule.waitForIdle()
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val distance = with(composeRule.density) { 80.dp.toPx() }
    transcript.performTouchInput { swipeWithVelocity(center, center + Offset(0f, distance), endVelocity = 0f) }
    composeRule.waitForIdle()
    assertTrue(reader.showJumpToLatest)
    val before = viewport().position
    val original =
      renderedStream()
        .second.layoutInput.text.text
    composeRule.runOnIdle { assertTrue(ready.complete(Unit)) }
    composeRule.waitForIdle()
    val replacement =
      renderedStream()
        .second.layoutInput.text.text
    assertTrue("The replacement shares the marker but is not an append", replacement.startsWith("S001") && !replacement.startsWith(original))
    assertEquals("An existing render slot must not carry reading authority into replacement content", before, viewport().position)
  }

  private fun assertDeferredSelectedRowGrowth(appendSuffix: Boolean) {
    val prefixReady = CompletableDeferred<Unit>()
    showReader(deferredPrefix = prefixReady, appendDeferredSuffix = appendSuffix)
    composeRule.waitForIdle()
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val dragDistance = with(composeRule.density) { 80.dp.toPx() }
    transcript.performTouchInput {
      swipeWithVelocity(center, center + Offset(0f, dragDistance), endVelocity = 0f)
    }
    composeRule.waitForIdle()
    assertFalse(viewport().scrolling)
    assertTrue("The reader must be manually paused before the deferred child arrives", reader.showJumpToLatest)
    val selected =
      reader.listState.layoutInfo.visibleItemsInfo
        .single { it.index == reader.listState.firstVisibleItemIndex }
    assertEquals("message:assistant 59", selected.key)
    val before = renderedStream()
    val clip = transcript.fetchSemanticsNode().boundsInRoot
    val marker = (1..8).map { "S%03d".format(it) }.first { inside(clip, markerBounds(before, it)) }
    val reading = markerBounds(before, marker)
    val origin = before.first.positionInRoot

    composeRule.runOnIdle { assertTrue(prefixReady.complete(Unit)) }
    composeRule.waitForIdle()
    val current =
      reader.listState.layoutInfo.visibleItemsInfo
        .single { it.index == reader.listState.firstVisibleItemIndex }
    assertEquals("The selected message key must remain stable", selected.key, current.key)
    assertTrue("The same selected row must grow above its metadata", current.size > selected.size)
    val after = renderedStream()
    val beforeText = before.second.layoutInput.text.text
    val afterText = after.second.layoutInput.text.text
    if (appendSuffix) {
      assertTrue("The same completion must append text below the reading point", afterText.length > beforeText.length && afterText.startsWith(beforeText))
    } else {
      assertEquals("The metadata text itself must be unchanged", beforeText, afterText)
    }
    val afterGlyphs = markerBounds(after, marker)
    println("READER_SELECTED_PREFIX marker=$marker before=$reading after=$afterGlyphs origin=$origin next=${after.first.positionInRoot} rowBefore=${selected.size} rowAfter=${current.size}")
    assertEquals("A deferred child above metadata must not move the reading glyphs", reading.top, afterGlyphs.top, 1f)
    assertTrue("The reading glyphs must remain in the same clipped viewport", inside(clip, afterGlyphs))

    click("Append stream")
    composeRule.waitForIdle()
    val later = renderedStream()
    assertTrue(
      "A later suffix must extend the already measured text",
      later.second.layoutInput.text.text
        .startsWith(afterText) && later.second.layoutInput.text.length > afterText.length,
    )
    assertEquals("Prefix completion must retain the anchor for a later tail", reading.top, markerBounds(later, marker).top, 1f)
    assertTrue(inside(clip, markerBounds(later, marker)))
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun captionOnlyFirstRowPreservesOlderReadingOnSmallGrowth() = assertCaptionOnlyFirstRowGrowth(1)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun captionOnlyFirstRowPreservesOlderReadingAcrossLargeGrowth() = assertCaptionOnlyFirstRowGrowth(24)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun captionOnlyFirstRowPreservesOlderReadingAcrossInsertedToolRow() = assertCaptionOnlyFirstRowGrowth(24, insertPendingTool = true)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun captionOnlyFirstRowPreservesCollapsedUserPromptAcrossGrowth() = assertCaptionOnlyFirstRowGrowth(24, collapsedUserPrompt = true)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun shortViewportKeepsOlderReadingGlyphInsideItsNewVisibleRange() = assertCaptionOnlyFirstRowGrowth(0, shortViewport = true)

  private fun assertCaptionOnlyFirstRowGrowth(
    growth: Int,
    insertPendingTool: Boolean = false,
    collapsedUserPrompt: Boolean = false,
    shortViewport: Boolean = false,
  ) {
    var viewportHeight by mutableStateOf(480.dp)
    showReader(initialStreamingLines = 8, captionedStream = true, streamGrowthLines = growth, insertPendingToolOnGrowth = insertPendingTool, collapsedUserPrompt = collapsedUserPrompt, viewportHeight = { viewportHeight })
    composeRule.waitForIdle()
    val transcript = composeRule.onNode(hasScrollToIndexAction()).assertIsDisplayed()
    val clip = transcript.fetchSemanticsNode().boundsInRoot
    val caption =
      composeRule
        .onNodeWithText("OpenClaw · Live", useUnmergedTree = true)
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot
    val slop = ViewConfiguration.get(RuntimeEnvironment.getApplication()).scaledTouchSlop.toFloat()
    val distance = clip.bottom - caption.height / 2f - caption.top + slop
    assertTrue("The measured caption must be reachable by one in-viewport drag", distance > 0f && distance < clip.height)
    transcript.performTouchInput {
      val start = Offset(center.x, (height - distance) / 2f)
      swipeWithVelocity(start, start + Offset(0f, distance), endVelocity = 0f)
    }
    composeRule.waitForIdle()
    assertFalse(viewport().scrolling)
    assertTrue(reader.showJumpToLatest)
    val layout = reader.listState.layoutInfo
    val first = layout.visibleItemsInfo.single { it.index == reader.listState.firstVisibleItemIndex }
    assertEquals("stream", first.key)
    composeRule.onNodeWithText("OpenClaw · Live", useUnmergedTree = true).assertIsDisplayed()
    composeRule.onNode(hasText("S001 Synthetic", substring = true), useUnmergedTree = true).assertIsNotDisplayed()
    assertTrue("The real timeline keeps Thinking between stream and older reply", layout.visibleItemsInfo.any { it.key == "thinking" })
    val olderKey = if (collapsedUserPrompt) "message:old user" else "message:assistant 59"
    val textMarker = if (collapsedUserPrompt) "U001" else "O001 Earlier"
    val older = layout.visibleItemsInfo.single { it.key == olderKey }
    val before = renderedReaderText(textMarker)
    if (collapsedUserPrompt) {
      assertEquals("The actual user renderer must remain collapsed", ChatUserMessageDisclosurePolicy.collapsedPreview(collapsedPromptText()), before.second.layoutInput.text.text)
      assertEquals("Only the original user message and the two transient rows belong to this timeline", 3, layout.totalItemsCount)
    }
    val marker =
      if (collapsedUserPrompt) {
        Regex("U[0-9]{3}").findAll(before.second.layoutInput.text.text).map { it.value }.first { inside(clip, markerBounds(before, it)) }
      } else {
        "O001"
      }
    val reading = markerBounds(before, marker)
    assertTrue("An actual older reading glyph must be visible before growth", inside(clip, reading))
    assertEquals(0, olderReadingDisposals)
    val beforeStreamHeight = renderedReaderText("S001 Synthetic", requireVisible = false).second.size.height

    if (shortViewport) {
      val reducedHeight = 120.dp
      val reducedPixels = with(composeRule.density) { reducedHeight.toPx() }
      assertTrue("The caption gap must put the original reading target below the smaller viewport", reading.top - clip.top > reducedPixels)
      assertTrue("The smaller viewport must still fit a full reading glyph", reading.height < reducedPixels)
      assertFalse(reader.navigation.isNavigating)
      composeRule.runOnIdle { viewportHeight = reducedHeight }
      composeRule.waitForIdle()
      val afterClip = transcript.fetchSemanticsNode().boundsInRoot
      val after = renderedReaderText(textMarker, requireVisible = false)
      val glyph = markerBounds(after, marker)
      val diagnostic = "marker=$marker beforeViewport=$clip afterViewport=$afterClip beforeGlyph=$reading afterGlyph=$glyph disposals=$olderReadingDisposals"
      println("READER_SHORT_VIEWPORT $diagnostic")
      assertEquals("Only height changes: $diagnostic", clip.width, afterClip.width, 1f)
      assertEquals("The actual viewport must become short: $diagnostic", reducedPixels, afterClip.height, 1f)
      assertEquals("Resize must not replace the selected content", before.second.layoutInput.text.text, after.second.layoutInput.text.text)
      assertEquals("Height-only resize must not reflow the selected content", before.second.size, after.second.size)
      assertEquals("Resize must not insert or remove timeline rows", layout.totalItemsCount, reader.listState.layoutInfo.totalItemsCount)
      assertEquals("The selected row must survive resizing: $diagnostic", 0, olderReadingDisposals)
      assertFalse(viewport().scrolling)
      assertFalse(reader.navigation.isNavigating)
      assertTrue("The list must have scroll space in both directions: $diagnostic", reader.listState.canScrollBackward && reader.listState.canScrollForward)
      assertTrue("The same reading glyph must fit inside the new viewport: $diagnostic", inside(afterClip, glyph))
      assertEquals("An excluded lower target should move to the nearest fully visible position: $diagnostic", afterClip.bottom - glyph.height, glyph.top, 1f)
      composeRule.runOnIdle { viewportHeight = 480.dp }
      composeRule.waitForIdle()
      val restoredClip = transcript.fetchSemanticsNode().boundsInRoot
      val restored = renderedReaderText(textMarker)
      val restoredGlyph = markerBounds(restored, marker)
      val roundTrip = "$diagnostic restoredViewport=$restoredClip restoredGlyph=$restoredGlyph"
      println("READER_VIEWPORT_ROUND_TRIP $roundTrip")
      assertEquals("The viewport returns to its original dimensions", clip, restoredClip)
      assertEquals("The round trip preserves the same rendered content", before.second.layoutInput.text.text, restored.second.layoutInput.text.text)
      assertEquals(0, olderReadingDisposals)
      assertTrue("The original reading position remains reachable: $roundTrip", reader.listState.canScrollBackward && reader.listState.canScrollForward)
      assertTrue("The same reading glyph remains visible: $roundTrip", inside(restoredClip, restoredGlyph))
      assertEquals("Restoring available space restores the preferred reading position: $roundTrip", reading.top, restoredGlyph.top, 1f)
      return
    }

    click("Append stream")
    composeRule.waitForIdle()
    val afterLayout = reader.listState.layoutInfo
    val stream = afterLayout.visibleItemsInfo.firstOrNull { it.key == "stream" }
    val afterStreamHeight = renderedReaderText("S001 Synthetic", requireVisible = false).second.size.height
    assertTrue("The actual stream text must be measured at its new height", afterStreamHeight > beforeStreamHeight)
    if (!insertPendingTool) assertTrue("The first stream row must actually grow", checkNotNull(stream).size > first.size)
    println("READER_LEAFLESS_FIRST growth=$growth insertedTool=$insertPendingTool first=${first.key} streamBefore=${first.size} streamAfter=${stream?.size} olderIndex=${older.index} olderVisible=${afterLayout.visibleItemsInfo.any { it.key == older.key }} olderDisposals=$olderReadingDisposals reading=$reading")
    val after = renderedReaderText(textMarker)
    assertEquals("Streaming must not replace the older prompt", before.second.layoutInput.text.text, after.second.layoutInput.text.text)
    val afterGlyphs = markerBounds(after, marker)
    println("READER_LEAFLESS_GLYPH growth=$growth before=$reading after=$afterGlyphs")
    assertEquals("Growth below a visible older leaf must preserve its reading point", reading.top, afterGlyphs.top, 1f)
    assertTrue(inside(clip, afterGlyphs))
    if (insertPendingTool) {
      assertEquals("The actual timeline inserted a row before the reading item", older.index + 1, afterLayout.visibleItemsInfo.single { it.key == older.key }.index)
      click("Jump to latest")
      composeRule.waitForIdle()
      assertEquals(ViewportPosition(0, 0), viewport().position)
      composeRule.onNode(hasText("O001 Earlier", substring = true), useUnmergedTree = true).assertIsNotDisplayed()
      assertTrue("Explicit following must release the retained older row", olderReadingDisposals > 0)
    }
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
    deferredPrefix: CompletableDeferred<Unit>? = null,
    appendDeferredSuffix: Boolean = false,
    replaceDeferredText: Boolean = false,
    removeDeferredSuffix: Boolean = false,
    inlineImage: String? = null,
    captionedStream: Boolean = false,
    streamGrowthLines: Int = 24,
    insertPendingToolOnGrowth: Boolean = false,
    collapsedUserPrompt: Boolean = false,
    viewportWidth: () -> Dp = { 360.dp },
    viewportHeight: () -> Dp = { 480.dp },
    historyAssistantCount: Int = 60,
    heldReading: CompletableDeferred<Unit>? = null,
  ) {
    val initialMessages =
      if (collapsedUserPrompt) {
        listOf(message("old user", "user", 1).copy(content = listOf(ChatMessageContent(type = "text", text = collapsedPromptText()))))
      } else {
        listOf(message("old user", "user", 1)) + (0 until historyAssistantCount).map { message("assistant $it", "assistant", it + 2) }
      }
    composeRule.setContent {
      ClawDesignTheme {
        var messages by remember { mutableStateOf(initialMessages) }
        var historyLoading by remember { mutableStateOf(initialHistoryLoading) }
        var streamingLines by remember { mutableStateOf(initialStreamingLines) }
        var prefixVisible by remember { mutableStateOf(false) }
        var deferredTailLines by remember { mutableStateOf(0) }
        var olderRowGrown by remember { mutableStateOf(false) }
        if (deferredPrefix != null) {
          LaunchedEffect(deferredPrefix) {
            deferredPrefix.await()
            prefixVisible = true
          }
        }
        val scope = rememberCoroutineScope()
        val timeline =
          remember(messages, streamingLines) {
            val stream = streamingLines?.let { lines -> inlineImage?.let { "![](data:image/png;base64,$it)\n\n" }.orEmpty() + streamText(lines) }
            val pending =
              if (insertPendingToolOnGrowth && checkNotNull(streamingLines) > checkNotNull(initialStreamingLines)) {
                listOf(ChatPendingToolCall(toolCallId = "pending", name = "Pending tool", startedAtMs = 0))
              } else {
                emptyList()
              }
            buildChatTimeline(messages, if (streamingLines == null) 0 else 1, pending, stream)
          }
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
                } else if (heldReading != null) {
                  navigation.launch(scope) { heldReading.await() }
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
                if (growEarlierRow && !olderRowGrown) {
                  messages = messages.map { if (it.id == "assistant 59") it.copy(content = listOf(ChatMessageContent(type = "text", text = "assistant 59\nMore context\nStill more context"))) else it }
                  olderRowGrown = true
                } else {
                  streamingLines = checkNotNull(streamingLines) + streamGrowthLines
                }
              }) { Text(if (growEarlierRow && !olderRowGrown) "Grow earlier row" else "Append stream") }
            }
            TextButton(onClick = {
              if (deferredPrefix != null && prefixVisible) deferredTailLines += 8 else historyLoading = !historyLoading
            }) { Text(if (deferredPrefix != null && prefixVisible) "Append stream" else "Loading: $historyLoading") }
            Text("User turns: ${messages.count { it.role == "user" }}")
            LazyColumn(
              state = current.listState,
              reverseLayout = true,
              modifier =
                Modifier
                  .size(width = viewportWidth(), height = viewportHeight())
                  .nestedScroll(current.nestedScrollConnection)
                  .onGloballyPositioned(current.navigation.anchors::viewportPlaced),
            ) {
              items(timeline.items, key = ::chatTimelineItemKey) { item ->
                ChatReaderItem(chatTimelineItemKey(item)) {
                  when (item) {
                    is ChatTimelineItem.StreamingAssistant -> {
                      // Unlike the fixed-height fixture siblings, this is the app's genuinely growing renderer.
                      if (captionedStream) {
                        ReaderFixtureBubble(messageId = null, role = "assistant", live = true, content = listOf(ChatMessageContent(text = item.text)))
                      } else {
                        ChatMarkdown(text = item.text, textColor = ClawTheme.colors.text, isStreaming = true, bodyStyle = ClawTheme.type.body)
                      }
                    }

                    ChatTimelineItem.Thinking -> {
                      Text("Working")
                    }

                    is ChatTimelineItem.PendingTools -> {
                      // Controlled sibling geometry; this test exercises timeline insertion, not tool UI.
                      Box(Modifier.fillMaxWidth().height(120.dp)) { Text(item.toolCalls.single().name) }
                    }

                    is ChatTimelineItem.Message -> {
                      if (collapsedUserPrompt) {
                        DisposableEffect(item.message.id) { onDispose { olderReadingDisposals++ } }
                        ReaderFixtureBubble(messageId = item.message.id, role = "user", live = false, content = item.message.content)
                      } else if (captionedStream && item.message.id == "assistant 59") {
                        DisposableEffect(item.message.id) { onDispose { olderReadingDisposals++ } }
                        ChatMarkdown(text = olderReadingText(), textColor = ClawTheme.colors.text, bodyStyle = ClawTheme.type.body)
                      } else if (deferredPrefix != null && item.message.id == "assistant 59") {
                        Column {
                          // A preview image can arrive above already-rendered metadata without changing the message.
                          if (prefixVisible && !removeDeferredSuffix) Box(Modifier.fillMaxWidth().height(120.dp))
                          ChatMarkdown(
                            text =
                              if (prefixVisible && replaceDeferredText) {
                                streamText(16).replace("ordinary objects", "replacement content")
                              } else {
                                streamText((if (prefixVisible && appendDeferredSuffix) 16 else 8) + deferredTailLines)
                              },
                            textColor = ClawTheme.colors.text,
                            bodyStyle = ClawTheme.type.body,
                          )
                          if (removeDeferredSuffix && !prefixVisible) Box(Modifier.fillMaxWidth().height(120.dp))
                        }
                      } else if (growEarlierRow && item.message.id == "assistant 59") {
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
  }

  private fun collapsedPromptText(): String = (1..16).joinToString("\n") { "U%03d The original user prompt describes ordinary objects and remains available for reading.".format(it) }

  @Composable
  private fun ReaderFixtureBubble(
    messageId: String?,
    role: String,
    live: Boolean,
    content: List<ChatMessageContent>,
  ) {
    ChatBubble(
      messageId = messageId,
      entryId = null,
      role = role,
      live = live,
      content = content,
      timestampMs = null,
      onReplyMessage = {},
      sessionActionsEnabled = false,
      onRewindMessage = {},
      onForkMessage = {},
      speechState = null,
      onToggleListen = { _, _ -> },
      inlineMediaPlaybackBlocked = false,
      inlineWidgetResolverReady = false,
      resolveInlineWidgetResource = { _, _ -> null },
      loadImageArtifact = { null },
      loadMediaArtifact = { _, _, _ -> null },
    )
  }

  private fun streamText(lines: Int): String = (1..lines).joinToString("\n") { "S%03d Synthetic reader text describes ordinary objects without tools or provider execution.".format(it) }

  private fun olderReadingText(): String = (1..8).joinToString("\n") { "O%03d Earlier response stays readable while the later reply grows.".format(it) }

  private fun renderedStream(): Pair<SemanticsNode, TextLayoutResult> = renderedReaderText("S001 Synthetic")

  private fun renderedReaderText(
    marker: String,
    requireVisible: Boolean = true,
  ): Pair<SemanticsNode, TextLayoutResult> {
    val target = composeRule.onNode(hasText(marker, substring = true), useUnmergedTree = true)
    if (requireVisible) target.assertIsDisplayed()
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
