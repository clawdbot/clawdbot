package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.appearanceAccentPalette
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayMethod
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawTextField
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.InputType
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeProvider
import android.view.inputmethod.EditorInfo
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowAccessibilityNodeInfo
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(minSdk = 34, maxSdk = 34, qualifiers = "w700dp-h1000dp-420dpi")
class SettingsDetailInsetsTest {
  @get:Rule
  val composeRule = createComposeRule()

  // Mirrors the bottom inset SettingsDetailFrame reserves below its scroll viewport.
  private val settingsFrameBottomPadding = 4.dp

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun gatewayCredentialsAreMaskedWhileHostAndPortRemainOrdinary() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("gateway-input-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualHost("127.0.0.1")
    prefs.setManualPort(18789)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    try {
      val viewModel = MainViewModel(app, prefs, SavedStateHandle())
      models.put("gateway", viewModel)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      composeRule.setContent {
        ClawDesignTheme {
          SettingsDetailScreen(viewModel, SettingsRoute.Gateway, onBack = {})
        }
      }

      assertGatewayInputPresentation("127.0.0.1", "192.168.0.25", secret = false)
      assertGatewayInputPresentation("18789", "18790", secret = false)
      assertGatewayInputPresentation("Setup code", "synthetic-setup-code", secret = true)
      assertGatewayInputPresentation("Token", "synthetic-token", secret = true)
      assertGatewayInputPresentation("Bootstrap", "synthetic-bootstrap", secret = true)
      assertGatewayInputPresentation("Password", "synthetic-password", secret = true)
    } finally {
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  // Virtual accessibility nodes need real Region clipping, which legacy graphics does not implement.
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun systemAgentAccessibilityReadsTheReplyBeforeItsQuestion() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val manager = requireNotNull(app.getSystemService(AccessibilityManager::class.java))
    val shadowManager = shadowOf(manager)
    val previousEnabled = manager.isEnabled
    val previousServices = manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).toList()
    val expected =
      listOf(
        "Ready to help with setup.",
        "NEXT STEP",
        "Choose the next setup step.",
      )
    try {
      shadowManager.setEnabledAccessibilityServiceList(
        listOf(AccessibilityServiceInfo().apply { feedbackType = AccessibilityServiceInfo.FEEDBACK_SPOKEN }),
      )
      shadowManager.setEnabled(true)
      withSystemAgentConversation(listOf({ systemAgentReply(expected.first(), question = true) })) {
        awaitReply(expected.first())
        expected.forEach { composeRule.onNodeWithText(it).assertIsDisplayed() }
        val greetingId = composeRule.onNodeWithText(expected.first()).fetchSemanticsNode().id
        composeRule.runOnIdle {
          val provider = requireNotNull(view.accessibilityNodeProvider)
          val bootstrap = requireNotNull(provider.createAccessibilityNodeInfo(AccessibilityNodeProvider.HOST_VIEW_ID))
          try {
            // App-process queries preserve virtual links that Robolectric's ordinary node shadow drops.
            // Recreate the first node after enabling real framework storage.
            bootstrap.setQueryFromAppProcessEnabled(view, true)
            val first = requireNotNull(provider.createAccessibilityNodeInfo(greetingId))
            try {
              first.setQueryFromAppProcessEnabled(view, true)
              val actual = generateSequence(first) { it.traversalBefore }.take(expected.size).map { it.text?.toString() }.toList()
              assertEquals("Android traversal must read the reply before its question", expected, actual)
            } finally {
              first.setQueryFromAppProcessEnabled(view, false)
            }
          } finally {
            bootstrap.setQueryFromAppProcessEnabled(view, false)
          }
        }
      }
    } finally {
      shadowManager.setEnabledAccessibilityServiceList(previousServices)
      shadowManager.setEnabled(previousEnabled)
      ShadowAccessibilityNodeInfo.resetObtainedInstances()
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentComposerUpdatesPasswordSemanticsAcrossSensitiveReplies() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val clipboard = requireNotNull(app.getSystemService(ClipboardManager::class.java))
    val previousClip = clipboard.primaryClip
    val replies = listOf("Ordinary reply ready", "Enter the synthetic credential", "Ordinary reply restored")
    val editorInfo = AtomicReference<EditorInfo?>()
    val interceptor =
      PlatformTextInputInterceptor { request, _ ->
        val info = EditorInfo()
        val connection = request.createInputConnection(info)
        editorInfo.set(info)
        try {
          awaitCancellation()
        } finally {
          connection.closeConnection()
        }
      }
    try {
      withSystemAgentConversation(
        replies = replies.mapIndexed { index, text -> { systemAgentReply(text, sensitive = index == 1) } },
        wrapContent = { content -> InterceptPlatformTextInput(interceptor) { content() } },
      ) {
        // SetText disappears while disabled; EditableText still identifies the real composer.
        val input = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.EditableText), useUnmergedTree = true)
        val send = composeRule.onNodeWithText("Send")

        fun awaitReply(index: Int) {
          composeRule.waitUntil(timeoutMillis = 5_000) {
            val state = runtime.systemAgentChatState.value
            state.messages.lastOrNull()?.text == replies[index] && !state.sending && state.expectsSensitiveReply == (index == 1)
          }
          composeRule.onNodeWithText(replies[index]).assertIsDisplayed()
        }

        fun sendAndReleaseReply(
          expectedMessage: String,
          replyIndex: Int,
        ) {
          sendPrepared(expectedMessage, replyIndex)
          input.assertIsNotEnabled()
          send.assertIsNotEnabled()
          assertEquals("", runtime.systemAgentChatState.value.input)
          composeRule.runOnIdle { editorInfo.set(null) }
          releaseReplies[replyIndex].countDown()
        }

        fun assertInputPresentation(
          value: String,
          secret: Boolean,
        ) {
          composeRule.waitUntil(timeoutMillis = 5_000) { editorInfo.get() != null }
          val info = requireNotNull(editorInfo.get())
          assertEquals(
            InputType.TYPE_CLASS_TEXT or if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else 0,
            info.inputType and (InputType.TYPE_MASK_CLASS or InputType.TYPE_MASK_VARIATION),
          )
          assertEquals(!secret, info.inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT != 0)
          val layouts = mutableListOf<TextLayoutResult>()
          input.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
          assertEquals(
            if (secret) "\u2022".repeat(value.length) else value,
            layouts
              .single()
              .layoutInput.text.text,
          )
        }

        awaitReply(0)
        val sessionId = runtime.systemAgentChatState.value.sessionId
        input.assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Password))
        input.performClick().performTextReplacement("  ordinary request  ")
        sendAndReleaseReply("ordinary request", 1)

        awaitReply(1)
        input.assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
        val pasted = "  synthetic café 🔑\t  "
        input.performClick()
        composeRule.runOnIdle { clipboard.setPrimaryClip(ClipData.newPlainText("synthetic credential", pasted)) }
        input.performSemanticsAction(SemanticsActions.PasteText) { assertTrue(it()) }
        composeRule.waitUntil(timeoutMillis = 5_000) { runtime.systemAgentChatState.value.input == pasted }
        assertInputPresentation(pasted, secret = true)
        sendAndReleaseReply(pasted, 2)

        awaitReply(2)
        input.assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Password))
        input.performClick().performTextReplacement("ordinary draft")
        assertInputPresentation("ordinary draft", secret = false)
        assertEquals(listOf(sessionId, sessionId, sessionId), requests.map { it["sessionId"]?.jsonPrimitive?.content })
      }
    } finally {
      if (previousClip == null) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(previousClip)
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentKeepsTheActualReplyEndVisibleAcrossWorkingAndImeChanges() {
    val greeting = (1..80).joinToString("\n") { "Earlier setup detail $it" }
    val reply = (1..80).joinToString("\n") { "New setup detail $it" }
    val plainReply = (1..80).joinToString("\n") { "Plain reply detail $it" }
    withSystemAgentConversation(
      listOf(
        { systemAgentReply(greeting, question = true) },
        { systemAgentReply(reply, question = true) },
        { systemAgentReply(plainReply) },
      ),
    ) {
      awaitReply(greeting)
      // Establish the live edge on either implementation before the response under test.
      scrollToLatestQuestion()
      assertOverflow()

      send("Continue setup", requestIndex = 1)
      assertAtLatest("OpenClaw is working…")
      releaseReplies[1].countDown()
      awaitReply(reply)
      assertOverflow()
      assertAtLatest("Skip for now")
      val message = composeRule.onNodeWithText(reply).getUnclippedBoundsInRoot()
      val question = composeRule.onNodeWithText("NEXT STEP").getUnclippedBoundsInRoot()
      assertTrue("The reply must remain above its question in visual order", message.bottom <= question.top)
      for (bottom in listOf(320, 0)) {
        keyboard(bottom)
        assertAtLatest("Skip for now")
      }

      send("Continue without a question", requestIndex = 2)
      keyboard(320)
      assertAtLatest("OpenClaw is working…")
      keyboard(0)
      releaseReplies[2].countDown()
      awaitReply(plainReply)
      assertOverflow()
      assertLatestBoundary()
      val viewport = history.getUnclippedBoundsInRoot()
      val text = composeRule.onNodeWithText(plainReply).getUnclippedBoundsInRoot()
      assertTrue("A tall ordinary reply must expose its end, not just its first line", text.bottom > viewport.top && text.bottom <= viewport.bottom)
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentKeepsOlderReadingUntilJumpToLatest() {
    val greeting = (1..120).joinToString("\n") { "Reading earlier setup detail $it" }
    val reply = (1..80).joinToString("\n") { "New reply while reading $it" }
    withSystemAgentConversation(
      listOf({ systemAgentReply(greeting, question = true) }, { systemAgentReply(reply, question = true) }),
    ) {
      awaitReply(greeting)
      scrollToLatestQuestion()
      send("Check the next step", requestIndex = 1)
      // Read older, unchanged text after sending retires the previous question card.
      history.performTouchInput { swipeDown(durationMillis = 500) }
      composeRule.waitForIdle()
      assertAwayFromLatest()
      val reading = composeRule.onNodeWithText(greeting)
      reading.assertIsDisplayed()
      val before = reading.getUnclippedBoundsInRoot()
      releaseReplies[1].countDown()
      awaitReply(reply)
      assertEquals("An incoming reply must not move the older message being read", before.bottom.value, reading.getUnclippedBoundsInRoot().bottom.value, 1f)
      composeRule.onNodeWithText("Skip for now").assertIsNotDisplayed()
      composeRule.onNodeWithText("Jump to latest").assertIsDisplayed()
      val bottomOffset = reading.getUnclippedBoundsInRoot().bottom - history.getUnclippedBoundsInRoot().bottom
      for (bottom in listOf(320, 0)) {
        keyboard(bottom)
        assertAwayFromLatest()
        reading.assertIsDisplayed()
        assertEquals(
          "A resize must retain the older message's bottom-relative reading position while content still overflows",
          bottomOffset.value,
          (reading.getUnclippedBoundsInRoot().bottom - history.getUnclippedBoundsInRoot().bottom).value,
          1f,
        )
        composeRule.onNodeWithText("Skip for now").assertIsNotDisplayed()
      }
      composeRule.onNodeWithText("Jump to latest").performClick()
      composeRule.waitForIdle()
      assertAtLatest("Skip for now")
      composeRule.onNodeWithText("Jump to latest").assertDoesNotExist()
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentSendingRetainsTextWithinTheReplyWhoseQuestionRetires() {
    verifySystemAgentQuestionRetirement(readOlderMessage = false)
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentSendingRetainsAnOlderMessageWhenANewerQuestionRetires() {
    verifySystemAgentQuestionRetirement(readOlderMessage = true)
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentSendingRetainsReplyAboveAPartlyVisibleQuestion() {
    verifySystemAgentQuestionRetirement(readOlderMessage = false, partialQuestion = true)
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentReplyRetainsReadingAboveAPartlyVisibleWorkingRow() {
    verifySystemAgentWorkingRowRetirement(jumpToLatest = false)
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentJumpFinishesWhenTheWorkingRowRetires() {
    verifySystemAgentWorkingRowRetirement(jumpToLatest = true)
  }

  private fun verifySystemAgentWorkingRowRetirement(jumpToLatest: Boolean) {
    val greeting = (1..120).joinToString("\n") { "Working-row reading detail $it" }
    val reply = (1..80).joinToString("\n") { "Completed setup detail $it" }
    withSystemAgentConversation(listOf({ systemAgentReply(greeting) }, { systemAgentReply(reply) })) {
      awaitReply(greeting)
      val retainedMessage =
        runtime.systemAgentChatState.value.messages
          .single()
      send("Continue", requestIndex = 1)
      keyboard(0)
      val working = composeRule.onNodeWithText("OpenClaw is working…")
      history.performScrollToNode(hasText("OpenClaw is working…"))
      working.assertIsDisplayed()
      positionAtViewportBottom(working, (history.getUnclippedBoundsInRoot().bottom - working.getUnclippedBoundsInRoot().top).value / 2)
      assertAwayFromLatest()
      val onePixel = 1f / composeRule.density.density
      // Keep all but one pixel visible so the replacement reply also begins at this edge.
      positionAtViewportBottom(working, working.getUnclippedBoundsInRoot().height.value - onePixel)
      assertAwayFromLatest()
      val viewport = history.getUnclippedBoundsInRoot()
      val workingBounds = working.getUnclippedBoundsInRoot()
      val userBounds = composeRule.onNodeWithText("Continue").getUnclippedBoundsInRoot()
      val reading = composeRule.onNodeWithText(greeting)
      reading.assertIsDisplayed()
      val readingBounds = reading.getUnclippedBoundsInRoot()
      val geometry = "reply=$readingBounds, user=$userBounds, working=$workingBounds, viewport=$viewport"
      assertTrue("The greeting must really overflow: $geometry", readingBounds.height > viewport.height * 3f)
      assertTrue(
        "The working row must be partly visible below the immutable user and reply: $geometry",
        readingBounds.top < viewport.top && readingBounds.bottom > viewport.top && readingBounds.bottom < userBounds.top &&
          userBounds.bottom < workingBounds.top && workingBounds.top < viewport.bottom && workingBounds.bottom > viewport.bottom,
      )
      assertEquals("Only one pixel of the working row may extend below the viewport: $geometry", onePixel, (workingBounds.bottom - viewport.bottom).value, onePixel)
      assertTrue("The actual request must remain held before the witness: $geometry", runtime.systemAgentChatState.value.sending && requests.size == 2)
      if (jumpToLatest) {
        val clock = composeRule.mainClock
        val previousAutoAdvance = clock.autoAdvance
        clock.autoAdvance = false
        try {
          composeRule.onNodeWithText("Jump to latest").performClick()
          // Touch injection can advance event time; start the native scroll before freezing.
          // Waiting for visible movement can already expose the stable live-edge key.
          clock.advanceTimeBy(0)
          val frozenTime = clock.currentTime
          assertAwayFromLatest()
          assertEquals("The retiring working anchor must remain in place before reply delivery", workingBounds.top.value, working.getUnclippedBoundsInRoot().top.value, onePixel)

          releaseReplies[1].countDown()
          awaitReply(reply)
          assertEquals("The IO reply must arrive while Jump's animation time is frozen", frozenTime, clock.currentTime)
          clock.advanceTimeByFrame()
          working.assertDoesNotExist()
        } finally {
          clock.autoAdvance = previousAutoAdvance
        }
        composeRule.waitForIdle()
        assertOverflow()
        assertLatestBoundary()
        val latest = composeRule.onNodeWithText(reply).getUnclippedBoundsInRoot()
        val latestViewport = history.getUnclippedBoundsInRoot()
        assertTrue("Jump must expose the completed reply's end", latest.bottom > latestViewport.top && latest.bottom <= latestViewport.bottom)
        composeRule.onNodeWithText("Jump to latest").assertDoesNotExist()
        // A deferred passive repair must not restore the pre-Jump reading position afterward.
        clock.advanceTimeBy(250)
        composeRule.waitForIdle()
        assertLatestBoundary()
        composeRule.onNodeWithText("Jump to latest").assertDoesNotExist()
        return@withSystemAgentConversation
      }
      val before = readLine(reading)
      assertTrue("The witness must be a fully visible text line: $before", before.top >= 0 && before.bottom <= before.viewport.height.value)

      releaseReplies[1].countDown()
      awaitReply(reply)
      composeRule.onNodeWithText("OpenClaw is working…").assertDoesNotExist()
      assertEquals(
        retainedMessage,
        runtime.systemAgentChatState.value.messages
          .first { it.id == retainedMessage.id },
      )
      // Read the new row's actual layout without scrolling; its height alone must exceed the
      // old reply-to-viewport gap, even before counting the retained user and native spacing.
      val incoming = composeRule.onNodeWithText(reply).getUnclippedBoundsInRoot()
      val requiredTail = viewport.bottom - readingBounds.bottom
      assertTrue(
        "The actual incoming prefix must prevent end clamping: incoming=$incoming, requiredTail=$requiredTail, before={$geometry}",
        incoming.height.value > requiredTail.value + onePixel,
      )
      assertReadingPreserved(reading, before, "Working-row retirement and assistant-reply insertion")
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentUsesRoleAlignedReadableBubbleWidths() {
    val greeting = "Long assistant guidance with ordinary wrapping. ".repeat(25)
    val input = "A detailed user reply with ordinary wrapping. ".repeat(10).trim()
    withSystemAgentConversation(listOf({ systemAgentReply(greeting) }, { systemAgentReply("Request accepted") })) {
      awaitReply(greeting)
      val viewport = history.getUnclippedBoundsInRoot()
      val assistant = composeRule.onNodeWithText(greeting).getUnclippedBoundsInRoot()
      assertTrue("Assistant guidance must use most of the available width", assistant.width > viewport.width * 0.75f)
      assertTrue("Assistant guidance must align near the leading edge", assistant.left >= viewport.left && assistant.left - viewport.left <= 24.dp)

      send(input, requestIndex = 1)
      history.performScrollToNode(hasText(input))
      val user = composeRule.onNodeWithText(input).getUnclippedBoundsInRoot()
      assertTrue("User messages must use most of the available width", user.width > viewport.width * 0.7f)
      assertTrue("User messages must align near the trailing edge", user.right <= viewport.right && viewport.right - user.right <= 24.dp)
      assertTrue("Role alignment must not be implemented with half-width wrapping", user.left > assistant.left && user.right > assistant.right)
      releaseReplies[1].countDown()
      awaitReply("Request accepted")
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentResumesFollowingWhenViewportGrowthRevealsTheWholeConversation() {
    val greeting = (1..7).joinToString("\n") { "Setup step $it" }
    val reply = (1..80).joinToString("\n") { "Next setup detail $it" }
    withSystemAgentConversation(
      listOf({ systemAgentReply(greeting, question = true) }, { systemAgentReply(reply, question = true) }),
    ) {
      awaitReply(greeting)
      keyboard(320)
      scrollToLatestQuestion()
      history.performTouchInput { swipeDown(durationMillis = 500) }
      composeRule.waitForIdle()
      assertAwayFromLatest()
      composeRule.onNodeWithText("Skip for now").assertIsNotDisplayed()

      keyboard(0)
      val viewport = history.getUnclippedBoundsInRoot()
      val first = composeRule.onNodeWithText(greeting).getUnclippedBoundsInRoot()
      assertTrue("This control must actually reveal all content after the keyboard closes", first.top >= viewport.top)
      assertAtLatest("Skip for now")
      composeRule.onNodeWithText("Jump to latest").assertDoesNotExist()
      send("Continue now that all history is visible", requestIndex = 1)
      releaseReplies[1].countDown()
      awaitReply(reply)
      assertOverflow()
      assertAtLatest("Skip for now")
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun systemAgentRestartDoesNotRetainThePreviousConversationViewport() {
    val greeting = (1..120).joinToString("\n") { "Old conversation detail $it" }
    val replacement = (1..80).joinToString("\n") { "Replacement conversation detail $it" }
    withSystemAgentConversation(
      listOf(
        { systemAgentReply(greeting, question = true) },
        { error("Synthetic request failure") },
        { systemAgentReply(replacement, question = true) },
      ),
    ) {
      awaitReply(greeting)
      val previousSession = runtime.systemAgentChatState.value.sessionId
      scrollToLatestQuestion()
      send("Exercise restart", requestIndex = 1)
      releaseReplies[1].countDown()
      composeRule.waitUntil(timeoutMillis = 5_000) {
        runtime.systemAgentChatState.value.errorText != null && !runtime.systemAgentChatState.value.sending
      }
      history.performTouchInput { swipeDown(durationMillis = 500) }
      composeRule.waitForIdle()
      assertAwayFromLatest()
      composeRule.onNodeWithText("Restart").performClick()
      composeRule.waitUntil(timeoutMillis = 5_000) { requests.size == 3 && runtime.systemAgentChatState.value.sending }
      assertNotEquals(previousSession, runtime.systemAgentChatState.value.sessionId)
      assertEquals(previousSession, requests[1]["sessionId"]?.jsonPrimitive?.content)
      assertEquals(runtime.systemAgentChatState.value.sessionId, requests[2]["sessionId"]?.jsonPrimitive?.content)
      assertTrue("Restart must request a new greeting, not resend the old input", "message" !in requests[2])
      composeRule.onNodeWithText("Jump to latest").assertDoesNotExist()
      releaseReplies[2].countDown()
      awaitReply(replacement)
      assertAtLatest("Skip for now")
      composeRule.onNodeWithText(greeting).assertDoesNotExist()
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-420dpi")
  fun keyboardInsetsResizeSettingsInCompactSidebarShell() = verifyInsets()

  @Test
  fun keyboardInsetsResizeSettingsInWideSidebarShell() = verifyInsets()

  @Test
  @Config(qualifiers = "w320dp-h800dp-mdpi")
  fun appearanceSwatchesKeepAccessibleTouchTargetsInANarrowWindow() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    val prefs = SecurePrefs(app, app.getSharedPreferences("appearance-layout-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val models = ViewModelStore().apply { put("appearance", viewModel) }
    var density = 1f
    try {
      composeRule.setContent {
        density = LocalDensity.current.density
        ClawDesignTheme {
          Box(Modifier.fillMaxSize().testTag("appearance-host")) {
            SettingsDetailScreen(viewModel, SettingsRoute.Appearance, onBack = {})
          }
        }
      }
      val accents = listOf<Long?>(null) + appearanceAccentPalette
      composeRule
        .onNodeWithContentDescription(appearanceAccentSwatchDescription(accents.last()))
        .performScrollTo()
        .assertIsDisplayed()
      val viewport = composeRule.onNodeWithTag("appearance-host").fetchSemanticsNode().boundsInRoot
      accents.forEach { accent ->
        val swatch = composeRule.onNodeWithContentDescription(appearanceAccentSwatchDescription(accent))
        swatch.assertIsDisplayed()
        val touchBounds = swatch.fetchSemanticsNode().touchBoundsInRoot
        assertTrue("Accent target must remain at least 48dp wide: $touchBounds", touchBounds.width >= 48 * density - 1)
        assertTrue("Accent target must remain at least 48dp high: $touchBounds", touchBounds.height >= 48 * density - 1)
        assertTrue("Accent target must fit the window: $touchBounds", viewport.contains(touchBounds.topLeft) && viewport.contains(touchBounds.bottomRight))
        swatch.performTouchInput { click() }
        swatch.assertIsSelected()
        composeRule.runOnIdle { assertEquals(accent, prefs.appearanceAccentArgb.value) }
      }
    } finally {
      models.clear()
    }
  }

  private fun verifySystemAgentQuestionRetirement(
    readOlderMessage: Boolean,
    partialQuestion: Boolean = false,
  ) {
    val older = (1..120).joinToString("\n") { "Older step $it" }
    val current = (1..120).joinToString("\n") { "Current step $it" }
    val reply = (1..80).joinToString("\n") { "Next step $it" }
    val replies =
      buildList<() -> JsonObject> {
        if (partialQuestion) add { systemAgentReply("Ready to continue") }
        if (readOlderMessage) add { systemAgentReply(older) }
        add { systemAgentReply(current, question = true) }
        add { systemAgentReply(reply, question = true) }
      }
    withSystemAgentConversation(replies) {
      var replacementTail = 0.dp
      var replacementGeometry = ""
      if (partialQuestion) {
        awaitReply("Ready to continue")
        send("Continue", requestIndex = 1)
        val anchor = composeRule.onNodeWithText("Ready to continue")
        val user = composeRule.onNodeWithText("Continue")
        val working = composeRule.onNodeWithText("OpenClaw is working…")
        anchor.assertIsDisplayed()
        user.assertIsDisplayed()
        working.assertIsDisplayed()
        val anchorBounds = anchor.getUnclippedBoundsInRoot()
        val userBounds = user.getUnclippedBoundsInRoot()
        val workingBounds = working.getUnclippedBoundsInRoot()
        val calibrationViewport = history.getUnclippedBoundsInRoot()
        // Match the later reply-bottom reference and include real padding and inter-item gaps.
        // Stopping at the working text excludes the positive trailing live-edge space.
        replacementTail = workingBounds.bottom - anchorBounds.bottom
        replacementGeometry =
          "assistant=$anchorBounds, user=$userBounds, working=$workingBounds, viewport=$calibrationViewport, " +
          "rowHeightSum=${userBounds.height + workingBounds.height}, tail=$replacementTail"
        assertTrue(
          "Calibration must place user and working rows below the preceding reply: $replacementGeometry",
          anchorBounds.bottom <= userBounds.top && userBounds.bottom <= workingBounds.top,
        )
        assertTrue(
          "Calibration must show the whole measured tail: $replacementGeometry",
          anchorBounds.top >= calibrationViewport.top && workingBounds.bottom <= calibrationViewport.bottom,
        )
        releaseReplies[1].countDown()
      }
      if (readOlderMessage) {
        awaitReply(older)
        send("Show the next step", requestIndex = 1)
        releaseReplies[1].countDown()
      }
      awaitReply(current)
      val questionMessage =
        runtime.systemAgentChatState.value.messages
          .last()
      assertTrue("The newest assistant reply must have a live question", questionMessage.question != null)
      val readingText = if (readOlderMessage) older else current
      if (readOlderMessage) {
        val olderMessage =
          runtime.systemAgentChatState.value.messages
            .single { it.text == older }
        assertTrue("The older control must be a different, immutable message", olderMessage.id != questionMessage.id && olderMessage.question == null)
      }

      val draft = "Continue"
      composeRule.onNode(hasSetTextAction()).performClick().performTextReplacement(draft)
      keyboard(0)
      val reading = composeRule.onNodeWithText(readingText)
      if (partialQuestion) {
        history.performScrollToNode(hasText("NEXT STEP"))
        val header = composeRule.onNodeWithText("NEXT STEP")
        header.assertIsDisplayed()
        // Settle the Jump row's viewport resize before the final measured placement.
        positionAtViewportBottom(header, (history.getUnclippedBoundsInRoot().bottom - header.getUnclippedBoundsInRoot().top).value / 2)
        assertAwayFromLatest()
        positionAtViewportBottom(header, header.getUnclippedBoundsInRoot().height.value / 2)
      } else {
        history.performScrollToNode(hasText(readingText))
        val target = reading.getUnclippedBoundsInRoot()
        val viewport = history.getUnclippedBoundsInRoot()
        assertTrue("The fixture must remain much taller than the viewport", target.height > viewport.height * 3f)
        val offscreenAbove = viewport.top - target.top
        val offscreenBelow = target.bottom - viewport.bottom
        // Native lookup can stop at either end of an oversized message.
        // Move into its interior before measuring, without assuming a lazy item index.
        history.performTouchInput {
          val upper = top + (bottom - top) * 0.35f
          val lower = top + (bottom - top) * 0.65f
          if (offscreenAbove > offscreenBelow) {
            swipeDown(startY = upper, endY = lower, durationMillis = 500)
          } else {
            swipeUp(startY = lower, endY = upper, durationMillis = 500)
          }
        }
      }
      composeRule.waitForIdle()
      assertAwayFromLatest()
      reading.assertIsDisplayed()
      val readingBounds = reading.getUnclippedBoundsInRoot()
      val readingViewport = history.getUnclippedBoundsInRoot()
      if (partialQuestion) {
        val header = composeRule.onNodeWithText("NEXT STEP").getUnclippedBoundsInRoot()
        val requiredTail = readingViewport.bottom - readingBounds.bottom
        val geometry =
          "reply=$readingBounds, header=$header, viewport=$readingViewport, requiredTail=$requiredTail, " +
            "replacement={$replacementGeometry}"
        assertTrue("The reply must still overflow the viewport: $geometry", readingBounds.height > readingViewport.height * 3f)
        assertTrue(
          "Only the top of the question may remain visible at the viewport bottom: $geometry",
          header.top > readingViewport.top && header.top < readingViewport.bottom && header.bottom > readingViewport.bottom,
        )
        assertEquals(
          "Leave exactly half the measured header visible: $geometry",
          header.height.value / 2,
          (readingViewport.bottom - header.top).value,
          1f / composeRule.density.density,
        )
        assertTrue(
          "The same reply must remain visible above the retiring question: $geometry",
          readingBounds.top < readingViewport.top && readingBounds.bottom > readingViewport.top && readingBounds.bottom < header.top,
        )
        assertTrue(
          "The measured replacement tail must prevent end clamping: $geometry",
          replacementTail.value > requiredTail.value + 1f / composeRule.density.density,
        )
      } else {
        assertTrue(
          "The selected text must span the viewport, leaving its question and all newer rows below it",
          readingBounds.top < readingViewport.top && readingBounds.bottom > readingViewport.bottom,
        )
        composeRule.onNodeWithText("NEXT STEP").assertIsNotDisplayed()
      }
      composeRule.onNodeWithText("Skip for now").assertIsNotDisplayed()
      val prepared = runtime.systemAgentChatState.value
      assertEquals(draft, prepared.input)
      assertTrue(
        "Reading must be established before Send retires the newest question",
        !prepared.sending && questionMessage.id !in prepared.retiredQuestionIds && questionMessage.id !in prepared.dismissedQuestionIds,
      )

      val before = readLine(reading)
      assertTrue("The witness must be a fully visible text line: $before", before.top >= 0 && before.bottom <= before.viewport.height.value)
      val requestIndex = replies.lastIndex
      // Do not use send(): the draft and reading position must already be settled at admission.
      sendPrepared(draft, requestIndex)
      assertTrue("The real controller must retire the question before the held reply", questionMessage.id in runtime.systemAgentChatState.value.retiredQuestionIds)
      composeRule.onNodeWithText("NEXT STEP").assertDoesNotExist()
      assertReadingPreserved(reading, before, "Question retirement and working-row insertion")

      releaseReplies[requestIndex].countDown()
      awaitReply(reply)
      assertReadingPreserved(reading, before, "The subsequent assistant reply")
    }
  }

  private data class SystemAgentReadingLine(
    val index: Int,
    val text: String,
    val top: Float,
    val bottom: Float,
    val viewport: DpRect,
  )

  private fun systemAgentReply(
    text: String,
    question: Boolean = false,
    sensitive: Boolean? = null,
  ): JsonObject =
    buildJsonObject {
      put("reply", text)
      put("action", "none")
      sensitive?.let { put("sensitive", it) }
      if (question) {
        put(
          "question",
          buildJsonObject {
            put("header", "Next step")
            put("question", "Choose the next setup step.")
            put(
              "options",
              buildJsonArray {
                add(buildJsonObject { put("label", "Continue configuration") })
                add(buildJsonObject { put("label", "Review configuration") })
              },
            )
          },
        )
      }
    }

  private fun withSystemAgentConversation(
    replies: List<() -> JsonObject>,
    wrapContent: @Composable (@Composable () -> Unit) -> Unit = { it() },
    checkConversation: SystemAgentConversationFixture.() -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("system-agent-history-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val fixture = SystemAgentConversationFixture(runtime, List(replies.size) { CountDownLatch(if (it == 0) 0 else 1) })
    try {
      val originalRequester =
        ReflectionHelpers.getField<Lazy<(String, String?) -> String>>(runtime, "screenshotRequester\$delegate").value
      val requester: (String, String?) -> String = { method, params ->
        if (method != GatewayMethod.OpenclawChat.rawValue) {
          originalRequester(method, params)
        } else {
          val index = fixture.requests.size
          fixture.requests.add(Json.parseToJsonElement(requireNotNull(params)).jsonObject)
          check(fixture.releaseReplies[index].await(10, TimeUnit.SECONDS)) { "Conversation response was not released" }
          replies[index]().toString()
        }
      }
      ReflectionHelpers.setField(runtime, "screenshotRequester\$delegate", lazyOf(requester))
      val viewModel = MainViewModel(app, prefs, SavedStateHandle())
      models.put("system-agent", viewModel)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      composeRule.setContent {
        val activity = requireNotNull(LocalActivity.current)
        val view = LocalView.current
        val density = LocalDensity.current
        val imeBottom = WindowInsets.ime.getBottom(density)
        val safeBottom = WindowInsets.safeDrawing.getBottom(density)
        LaunchedEffect(activity) { WindowCompat.setDecorFitsSystemWindows(activity.window, false) }
        SideEffect {
          fixture.view = view
          fixture.observedBottomInsets = imeBottom to safeBottom
        }
        ClawDesignTheme {
          wrapContent {
            SettingsDetailScreen(viewModel, SettingsRoute.SystemAgent, onBack = {})
          }
        }
      }
      fixture.checkConversation()
    } finally {
      // Release blocking fixture replies before runtime cleanup joins its IO scope.
      fixture.releaseReplies.forEach { it.countDown() }
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }

  private inner class SystemAgentConversationFixture(
    val runtime: NodeRuntime,
    val releaseReplies: List<CountDownLatch>,
  ) {
    val requests = CopyOnWriteArrayList<JsonObject>()
    lateinit var view: View
    var observedBottomInsets: Pair<Int, Int>? = null
    val history
      get() = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))

    fun awaitReply(text: String) {
      composeRule.waitUntil(timeoutMillis = 5_000) {
        val completed = runtime.systemAgentChatState.value.let { !it.sending && it.messages.lastOrNull()?.text == text }
        // Publication can precede downstream collection; observe the real composer before geometry.
        // Frozen-clock callers deliberately inspect publication before advancing their next frame.
        if (!completed || !composeRule.mainClock.autoAdvance) return@waitUntil completed
        composeRule
          .onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.EditableText) and isEnabled(), useUnmergedTree = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      composeRule.waitForIdle()
    }

    fun send(
      text: String,
      requestIndex: Int,
    ) {
      composeRule.onNode(hasSetTextAction()).performClick().performTextReplacement(text)
      sendPrepared(text, requestIndex)
    }

    fun sendPrepared(
      expectedMessage: String,
      requestIndex: Int,
    ) {
      composeRule.onNodeWithText("Send").performClick()
      composeRule.waitUntil(timeoutMillis = 5_000) { requests.size > requestIndex && runtime.systemAgentChatState.value.sending }
      assertEquals(expectedMessage, requests[requestIndex]["message"]?.jsonPrimitive?.content)
    }

    fun positionAtViewportBottom(
      node: SemanticsNodeInteraction,
      visibleHeight: Float,
    ) {
      val viewport = history.getUnclippedBoundsInRoot()
      val top = node.getUnclippedBoundsInRoot().top.value
      val delta = (viewport.bottom.value - visibleHeight - top) * composeRule.density.density
      val range = history.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      history.performSemanticsAction(SemanticsActions.ScrollBy) {
        assertTrue(
          "Native positioning rejected delta=$delta, visibleHeight=$visibleHeight, nodeTop=$top, viewport=$viewport, reverse=${range.reverseScrolling}",
          it(0f, if (range.reverseScrolling) delta else -delta),
        )
      }
      composeRule.waitForIdle()
    }

    fun readLine(
      reading: SemanticsNodeInteraction,
      index: Int? = null,
    ): SystemAgentReadingLine {
      val layouts = mutableListOf<TextLayoutResult>()
      reading.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
      val layout = layouts.single()
      val textBounds = reading.getUnclippedBoundsInRoot()
      val currentViewport = history.getUnclippedBoundsInRoot()
      val density = composeRule.density.density
      val middleInText = ((currentViewport.top.value + currentViewport.bottom.value) / 2 - textBounds.top.value) * density
      val line = index ?: layout.getLineForVerticalPosition(middleInText)
      return SystemAgentReadingLine(
        index = line,
        text =
          layout.layoutInput.text.text
            .substring(layout.getLineStart(line), layout.getLineEnd(line))
            .trimEnd(),
        top = textBounds.top.value + layout.getLineTop(line) / density - currentViewport.top.value,
        bottom = textBounds.top.value + layout.getLineBottom(line) / density - currentViewport.top.value,
        viewport = currentViewport,
      )
    }

    fun assertReadingPreserved(
      reading: SemanticsNodeInteraction,
      before: SystemAgentReadingLine,
      phase: String,
    ) {
      composeRule.waitForIdle()
      assertAwayFromLatest()
      reading.assertIsDisplayed()
      val after = readLine(reading, before.index)
      val tolerance = 1f / composeRule.density.density
      assertEquals("$phase must not change the viewport top", before.viewport.top.value, after.viewport.top.value, tolerance)
      assertEquals("$phase must not change the viewport bottom", before.viewport.bottom.value, after.viewport.bottom.value, tolerance)
      assertEquals("$phase must retain the same text line", before.text, after.text)
      assertTrue("$phase must keep the witness visible: before=$before, after=$after", after.top >= 0 && after.bottom <= after.viewport.height.value)
      assertEquals("$phase moved the visible text line: before=$before, after=$after", before.top, after.top, tolerance)
    }

    fun keyboard(bottomDp: Int) {
      val density = view.resources.displayMetrics.density
      val bottom = (bottomDp * density).toInt()
      val navigation = (24 * density).toInt()
      composeRule.runOnIdle {
        ViewCompat.dispatchApplyWindowInsets(
          view,
          WindowInsetsCompat
            .Builder()
            .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, navigation))
            .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, bottom))
            .setVisible(WindowInsetsCompat.Type.ime(), bottom > 0)
            .build(),
        )
      }
      composeRule.waitForIdle()
      composeRule.runOnIdle { assertEquals(bottom to maxOf(navigation, bottom), observedBottomInsets) }
    }

    fun scrollToLatestQuestion() {
      history.performScrollToNode(hasText("Skip for now"))
      // Bringing a button into view can leave the card's bottom padding offscreen.
      history.performTouchInput { swipeUp(durationMillis = 500) }
      composeRule.waitForIdle()
      assertAtLatest("Skip for now")
    }

    fun assertOverflow() {
      val range = history.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      assertTrue("This regression requires real overflowing content even with wider bubbles", range.maxValue() > 0f)
    }

    fun assertAwayFromLatest() {
      assertOverflow()
      val range = history.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      val distance = if (range.reverseScrolling) range.value() else range.maxValue() - range.value()
      assertTrue("The reader must actually leave the live edge: distance=$distance, value=${range.value()}, max=${range.maxValue()}, reverse=${range.reverseScrolling}", distance > 0f)
    }

    fun assertLatestBoundary() {
      val range = history.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      val distance = if (range.reverseScrolling) range.value() else range.maxValue() - range.value()
      assertEquals("The viewport must reach the real end, not just compose the latest message", 0f, distance, 0.0001f)
    }

    fun assertAtLatest(text: String) {
      composeRule.onNodeWithText(text).assertIsDisplayed()
      val viewport = history.getUnclippedBoundsInRoot()
      val item = composeRule.onNodeWithText(text).getUnclippedBoundsInRoot()
      assertTrue("The final action must fit inside the history viewport: $item in $viewport", item.top >= viewport.top && item.bottom <= viewport.bottom)
      assertLatestBoundary()
    }
  }

  private fun verifyInsets() {
    lateinit var view: View
    var observedBottomInsets: Pair<Int, Int>? = null
    composeRule.setContent {
      val activity = requireNotNull(LocalActivity.current)
      val localView = LocalView.current
      val density = LocalDensity.current
      val imeBottom = WindowInsets.ime.getBottom(density)
      val safeBottom = WindowInsets.safeDrawing.getBottom(density)
      LaunchedEffect(activity) { WindowCompat.setDecorFitsSystemWindows(activity.window, false) }
      SideEffect {
        view = localView
        observedBottomInsets = imeBottom to safeBottom
      }
      ClawDesignTheme {
        Box(Modifier.fillMaxSize().testTag("settings-host")) {
          SidebarNavigationShell(
            drawerState = rememberDrawerState(initialValue = DrawerValue.Closed),
            drawerContent = {},
          ) {
            SettingsDetailFrame(title = "Gateway", subtitle = "", icon = Icons.Default.Settings, onBack = {}) {
              repeat(20) { index -> ClawTextField("Field $index", {}, "") }
              ClawTextField("Unsubmitted draft", {}, "Password", modifier = Modifier.testTag("last-field"))
              ClawPrimaryButton(text = "Save", onClick = {})
            }
          }
        }
      }
    }
    composeRule.waitForIdle()
    val density = view.resources.displayMetrics.density
    val navigationBottom = (24 * density).toInt()
    val keyboardBottom = (320 * density).toInt()

    // Deliver platform insets, rather than shrinking a fake viewport that would hide the defect.
    for (imeBottom in listOf(0, keyboardBottom, 0)) {
      composeRule.runOnIdle {
        val insets =
          WindowInsetsCompat
            .Builder()
            .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, navigationBottom))
            .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, imeBottom))
            .setVisible(WindowInsetsCompat.Type.ime(), imeBottom > 0)
            .build()
        ViewCompat.dispatchApplyWindowInsets(view, insets)
      }
      composeRule.waitForIdle()
      composeRule.runOnIdle {
        assertEquals("Compose must observe the delivered insets before geometry is judged", imeBottom to maxOf(navigationBottom, imeBottom), observedBottomInsets)
      }
      composeRule.onNodeWithText("Save").performScrollTo()
      val host = composeRule.onNodeWithTag("settings-host").getUnclippedBoundsInRoot()
      val viewport = composeRule.onNode(hasScrollAction()).getUnclippedBoundsInRoot()
      val remainingBottom = maxOf(navigationBottom, imeBottom) / density
      assertEquals(
        "Sidebar settings must consume the bottom inset once (IME=$imeBottom)",
        host.bottom.value - remainingBottom - settingsFrameBottomPadding.value,
        viewport.bottom.value,
        1f / density,
      )
      val button = composeRule.onNodeWithText("Save").getUnclippedBoundsInRoot()
      val editor = composeRule.onNodeWithTag("last-field").getUnclippedBoundsInRoot()
      org.junit.Assert.assertTrue("Save must be reachable", button.bottom <= viewport.bottom)
      org.junit.Assert.assertTrue("Last field must be reachable with Save", editor.top >= viewport.top && editor.bottom <= viewport.bottom)
    }
  }

  private fun assertGatewayInputPresentation(
    initialText: String,
    value: String,
    secret: Boolean,
  ) {
    composeRule
      .onNode(hasSetTextAction() and hasText(initialText))
      .performScrollTo()
      .performClick()
      .performTextReplacement(value)
    val input = composeRule.onNode(hasSetTextAction() and isFocused())
    val layouts = mutableListOf<TextLayoutResult>()
    input.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      "$initialText must use the expected visible input presentation",
      if (secret) "\u2022".repeat(value.length) else value,
      layouts
        .single()
        .layoutInput.text.text,
    )
    input.assert(
      if (secret) SemanticsMatcher.keyIsDefined(SemanticsProperties.Password) else SemanticsMatcher.keyNotDefined(SemanticsProperties.Password),
    )
  }
}
