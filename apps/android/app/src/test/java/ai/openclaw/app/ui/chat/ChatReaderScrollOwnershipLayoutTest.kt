package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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

  private fun verifyManualTakeover(replaceRunningTransition: Boolean) {
    showReader()
    composeRule.waitForIdle()
    assertEquals("The actual effect context must allow timed animations", 1f, checkNotNull(observedScale), 0f)
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

  private fun showReader() {
    val initialMessages = listOf(message("old user", "user", 1)) + (0 until 60).map { message("assistant $it", "assistant", it + 2) }
    composeRule.setContent {
      ClawDesignTheme {
        var messages by remember { mutableStateOf(initialMessages) }
        val timeline = remember(messages) { buildChatTimeline(messages, 0, emptyList(), null) }
        val current = rememberChatReaderScrollController("animation-owner", timeline, historyLoading = false)
        SideEffect { reader = current }
        LaunchedEffect(Unit) { observedScale = currentCoroutineContext()[MotionDurationScale]?.scaleFactor }
        CompositionLocalProvider(LocalChatReaderNavigation provides current.onManualNavigation) {
          val manualNavigation = LocalChatReaderNavigation.current
          Column(Modifier.size(360.dp, 700.dp).clipToBounds()) {
            Row(horizontalArrangement = Arrangement.SpaceBetween) {
              TextButton(onClick = current.jumpToLatest) { Text("Jump to latest") }
              TextButton(onClick = manualNavigation) { Text("Read here") }
            }
            TextButton(onClick = { messages = initialMessages + message("new user", "user", 1000) }) { Text("Append user turn") }
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
