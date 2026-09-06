package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.R
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.ChatCacheScope
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatThinkingLevelOption
import ai.openclaw.app.chat.questionsForSession
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.speech.SpeechRecognizer
import android.view.KeyEvent
import android.view.inspector.WindowInspector
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
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
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowSpeechRecognizer
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatComposerLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var controller: ChatController
  private var originalRuntime: NodeRuntime? = null
  private val viewModelStore = ViewModelStore()
  private var originalAnimatorScale: String? = null
  private var renderedCanvasColor = Color.Unspecified

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    prefs = SecurePrefs(app, app.getSharedPreferences("chat-composer-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    controller =
      NodeRuntime::class.java
        .getDeclaredField("chat")
        .apply { isAccessible = true }
        .get(runtime) as ChatController
    originalRuntime = app.peekRuntime()
    setApplicationRuntime(runtime)
    originalAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    viewModelStore.clear()
    setApplicationRuntime(originalRuntime)
    closeNodeRuntimeTestFixture(runtime)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
    NativeStringResources.install(app)
  }

  @Test
  fun shortLoadedHistoryDoesNotOfferJumpWhenBothRowsFit() {
    withReaderHistory(assistantCount = 1) {
      assertReaderMessageVisible("You", "Reader prompt")
      assertReaderMessageVisible("OpenClaw", "Reader answer 1")
      val range = readerTranscript().fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      assertEquals("The short transcript starts at its latest edge", 0f, range.value(), 0f)
      assertEquals("The complete short transcript fits without scrolling", 0f, range.maxValue(), 0f)
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()
    }
  }

  @Test
  fun overflowingLoadedHistoryStartsAtLatestAndManualReadingOffersJump() {
    withReaderHistory(assistantCount = 24) {
      val transcript = readerTranscript()
      val before = transcript.getUnclippedBoundsInRoot()
      val initialRange = transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      assertEquals("The overflowing transcript must start at the latest reply", 0f, initialRange.value(), 0f)
      assertTrue("The sibling remains overflowing at the latest edge", initialRange.maxValue() > 0f)
      assertReaderMessageVisible("OpenClaw", "Reader answer 24")
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()

      transcript.performTouchInput { swipeDown() }
      composeRule.waitForIdle()
      assertTrue(
        "Manual reading must move above the latest reply",
        transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f,
      )
      assertReaderHeaderControl("Jump to latest")
      readerHeaderControl("Jump to latest").performClick()
      composeRule.waitForIdle()

      assertReaderMessageVisible("OpenClaw", "Reader answer 24")
      val range = transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      assertEquals("Jump reaches the latest edge", 0f, range.value(), 0f)
      assertTrue("The sibling remains overflowing after Jump", range.maxValue() > 0f)
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()
      val after = transcript.getUnclippedBoundsInRoot()
      assertEquals("Using Jump does not change the transcript viewport", before, after)
    }
  }

  @Test
  fun tallLatestRowOffersJumpWhenItsTailIsBelowTheViewport() {
    val head = "Latest reply starts here."
    val tail = "Latest reply ends here."
    val reply = (listOf(head) + List(40) { "Reader paragraph ${it + 1}." } + tail).joinToString("\n\n")
    withReaderHistory(assistantCount = 1, assistantText = { reply }) {
      val transcript = readerTranscript()
      val viewport = transcript.getUnclippedBoundsInRoot()
      val root = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
      assertTrue(
        "Fixture precondition: the transcript viewport must be fully visible: $viewport within $root",
        viewport.left >= root.left && viewport.right <= root.right && viewport.top >= root.top && viewport.bottom <= root.bottom,
      )
      val replyNode = composeRule.onNode(hasContentDescription(nativeString("OpenClaw")) and hasText(tail))
      val atLatest = replyNode.getUnclippedBoundsInRoot()
      assertTrue(
        "Fixture precondition: one actual latest row must exceed the viewport: $atLatest versus $viewport",
        atLatest.bottom - atLatest.top > viewport.bottom - viewport.top,
      )
      val beginning = readerMarkerBounds(head)
      assertTrue(
        "Fixture precondition: the tall reply's beginning must be above the viewport at latest: $beginning versus $viewport",
        beginning.bottom < viewport.top,
      )

      fun assertTailVisible() {
        val ending = readerMarkerBounds(tail)
        assertTrue(
          "The actual ending glyphs must be fully inside the transcript: $ending within $viewport",
          ending.left >= viewport.left && ending.right <= viewport.right && ending.top >= viewport.top && ending.bottom <= viewport.bottom,
        )
      }
      assertTailVisible()
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()

      transcript.performTouchInput { swipeDown(startY = height * 0.25f, endY = height * 0.75f, durationMillis = 1_000) }
      composeRule.waitForIdle()
      val whileReading = replyNode.getUnclippedBoundsInRoot()
      val hiddenEnding = readerMarkerBounds(tail)
      assertTrue(
        "Fixture precondition: the same latest row must still intersect the viewport: $whileReading versus $viewport",
        whileReading.top < viewport.bottom && whileReading.bottom > viewport.top,
      )
      assertTrue(
        "Fixture precondition: the ending must now be below the viewport: $hiddenEnding versus $viewport",
        hiddenEnding.top > viewport.bottom,
      )
      assertReaderHeaderControl("Jump to latest")
      readerHeaderControl("Jump to latest").performClick()
      composeRule.waitForIdle()
      assertTailVisible()
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()
      assertEquals("Reading and Jump keep the same transcript viewport", viewport, transcript.getUnclippedBoundsInRoot())
    }
  }

  @Test
  fun growingViewportHidesJumpWhenTheSameLoadedHistoryFits() {
    val assistantCount = 6
    val viewportHeight = mutableStateOf(400.dp)
    withReaderHistory(assistantCount = assistantCount, viewportHeight = { viewportHeight.value }) {
      val transcript = readerTranscript()
      val before = transcript.getUnclippedBoundsInRoot()
      transcript.performTouchInput { swipeDown() }
      composeRule.waitForIdle()
      assertTrue(
        "The smaller viewport must hide newer replies",
        transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f,
      )
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertIsDisplayed()

      composeRule.runOnIdle { viewportHeight.value = 720.dp }
      composeRule.waitForIdle()

      val after = transcript.getUnclippedBoundsInRoot()
      assertTrue("Resizing grows the actual transcript viewport", after.bottom - after.top > before.bottom - before.top)
      assertReaderMessageVisible("You", "Reader prompt")
      for (index in 1..assistantCount) {
        assertReaderMessageVisible("OpenClaw", "Reader answer $index")
      }
      val range = transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      assertEquals("The resized transcript reaches its latest edge", 0f, range.value(), 0f)
      assertEquals("The same complete history fits after resizing", 0f, range.maxValue(), 0f)
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()
    }
  }

  @Test
  fun readerHeaderKeepsSidebarJumpAndActionsReachableAtLargeFont() {
    var sidebarRequests = 0
    withReaderHistory(
      assistantCount = 24,
      viewportWidth = 320.dp,
      fontScale = { 2f },
      onOpenSidebar = { sidebarRequests += 1 },
    ) {
      val transcript = readerTranscript()
      val before = transcript.getUnclippedBoundsInRoot()
      transcript.performTouchInput { swipeDown() }
      composeRule.waitForIdle()
      assertTrue(
        "Manual reading must move above the latest reply",
        transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f,
      )
      val controls = listOf("Show Sidebar", "Jump to latest", "Chat actions").map(::assertReaderHeaderControl)
      val sidebar = controls.first()
      controls.drop(1).forEach { bounds ->
        assertEquals(
          "Header actions stay on the sidebar's row",
          (sidebar.top.value + sidebar.bottom.value) / 2,
          (bounds.top.value + bounds.bottom.value) / 2,
          1f,
        )
      }
      controls.zipWithNext().forEach { (left, right) ->
        assertTrue("Header touch targets stay disjoint: $left and $right", left.right <= right.left)
      }

      readerHeaderControl("Show Sidebar").performClick()
      composeRule.runOnIdle { assertEquals("The sidebar action remains reachable", 1, sidebarRequests) }
      readerHeaderControl("Jump to latest").performClick()
      composeRule.waitForIdle()
      assertReaderMessageVisible("OpenClaw", "Reader answer 24")
      composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()
      assertEquals("Changing header actions keeps the same transcript viewport", before, transcript.getUnclippedBoundsInRoot())

      readerHeaderControl("Chat actions").performClick()
      composeRule
        .onNode(hasText(nativeString("Refresh chat")) and hasClickAction())
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      composeRule.waitForIdle()
      composeRule.onNode(isPopup()).assertDoesNotExist()
    }
  }

  @Test
  fun nearFittingHistoryRetiresJumpAfterRepeatedViewportChanges() {
    val assistantCount = 6
    val viewportHeight = mutableStateOf(720.dp)
    withReaderHistory(assistantCount = assistantCount, viewportHeight = { viewportHeight.value }) {
      val transcript = readerTranscript()
      val contentSpan = assertReaderHistoryFits(assistantCount)
      val initialMessages = controller.messages.value
      val initialRoot = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
      val initialViewport = transcript.getUnclippedBoundsInRoot()
      val chrome = (initialRoot.bottom - initialRoot.top) - (initialViewport.bottom - initialViewport.top)
      val targetHeight = chrome + contentSpan + 24.dp
      assertTrue(
        "The measured near-fit target must leave room for a smaller starting viewport: $targetHeight",
        targetHeight - 96.dp > chrome && targetHeight < initialRoot.bottom - initialRoot.top,
      )

      repeat(2) { cycle ->
        composeRule.runOnIdle { viewportHeight.value = targetHeight - 96.dp }
        composeRule.waitForIdle()
        val beforeRange = transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        assertTrue("Cycle $cycle starts with actual overflow", beforeRange.maxValue() > 0f)
        val beforeSwipe = beforeRange.value()
        transcript.performTouchInput { swipeDown() }
        composeRule.waitForIdle()
        val afterSwipe = transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        assertTrue(
          "Cycle $cycle gesture must move away from latest: $beforeSwipe to $afterSwipe",
          afterSwipe > beforeSwipe && afterSwipe > 0f,
        )
        composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertIsDisplayed()

        composeRule.runOnIdle { viewportHeight.value = targetHeight }
        composeRule.waitForIdle()
        val root = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
        val calibratedSpare = (root.bottom - root.top) - chrome - contentSpan
        assertTrue(
          "Cycle $cycle must reach the measured near-fit band: $calibratedSpare",
          calibratedSpare > 0.dp && calibratedSpare < 56.dp,
        )
        val measuredSpan = assertReaderHistoryFits(assistantCount)
        val viewport = transcript.getUnclippedBoundsInRoot()
        val actualSpare = (viewport.bottom - viewport.top) - measuredSpan
        assertTrue(
          "Cycle $cycle leaves positive space smaller than the former jump strip: $actualSpare",
          actualSpare > 0.dp && actualSpare < 56.dp,
        )
        assertEquals("Only the viewport changes during cycle $cycle", initialMessages, controller.messages.value)
      }
    }
  }

  @Test
  fun slashSuggestionsKeepEditorAndSendVisibleAndLastSuggestionReachable() {
    showChat()
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performTextReplacement("/")
    editor.assertTextEquals("/")

    assertComposerControlsVisible(primaryAction = "Send")
    val sidebar = composeRule.onNodeWithContentDescription(nativeString("Show Sidebar")).assertIsDisplayed()
    val lastSuggestion = composeRule.onNodeWithText("/loop").performScrollTo().assertIsDisplayed()
    sidebar.assertIsDisplayed()
    assertComposerControlsVisible(primaryAction = "Send")
    lastSuggestion.performClick()
    editor.assertTextEquals("/loop ")
    assertComposerControlsVisible(primaryAction = "Send")
  }

  @Test
  fun activeRunKeepsNewTextSendableAndRestoresStopForAnEmptyDraft() {
    showChat()
    assertTrue("The fixture must have an active run", controller.pendingRunCount.value > 0)
    val editor = composeRule.onNode(hasSetTextAction())
    listOf("hello", "/help", "/unknown").forEach { input ->
      editor.performTextReplacement(input)
      editor.assertTextEquals(input)
      assertComposerControlsVisible(primaryAction = "Send")
      composeRule.onNodeWithContentDescription(nativeString("Send")).assertIsEnabled()
      assertTrue("Typing must not end the active run", controller.pendingRunCount.value > 0)
    }
    editor.performTextReplacement("")
    assertComposerControlsVisible(primaryAction = "Stop")
    composeRule.onNodeWithContentDescription(nativeString("Send")).assertDoesNotExist()
  }

  @Test
  fun physicalEnterPreservesTheDraftDuringTalkWithAnActiveRun() {
    assertPhysicalEnterDuringActiveRun(talkActive = true, expectedSends = 0)
  }

  @Test
  fun physicalEnterSendsTheDraftDuringANonTalkActiveRun() {
    assertPhysicalEnterDuringActiveRun(talkActive = false, expectedSends = 1)
  }

  @Test
  fun settledRunShowsSendForTextAndTalkForAnEmptyDraft() {
    showChat(viewportWidth = 320.dp)
    composeRule.runOnIdle {
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"${AndroidScreenshotFixture.mainSessionKey}","runId":"android-screenshot-active-run","seq":1,"stream":"lifecycle","data":{"phase":"end"}}""",
      )
    }
    assertComposerControlsVisible(primaryAction = "Start Talk")
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performTextReplacement("A short status update")
    assertComposerControlsVisible(primaryAction = "Send")
    composeRule.onNodeWithContentDescription(nativeString("Start Talk")).assertDoesNotExist()
    editor.performTextReplacement("")
    assertComposerControlsVisible(primaryAction = "Start Talk")
    composeRule.onNodeWithContentDescription(nativeString("Send")).assertDoesNotExist()
  }

  @Test
  fun unavailableDictationOffersExplicitVoiceNoteRecoveryWithoutChangingTheDraft() {
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(
        stableId = AndroidScreenshotFixture.gatewayId,
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "Test gateway",
      ),
    )
    prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
    val recognitionAvailable = SpeechRecognizer.isOnDeviceRecognitionAvailable(app)
    ShadowSpeechRecognizer.setIsOnDeviceRecognitionAvailable(false)
    try {
      val viewModel = showChat(viewportWidth = 320.dp)
      composeRule.runOnIdle {
        controller.handleGatewayEvent(
          "agent",
          """{"sessionKey":"${AndroidScreenshotFixture.mainSessionKey}","runId":"android-screenshot-active-run","seq":1,"stream":"lifecycle","data":{"phase":"end"}}""",
        )
      }
      val editor = composeRule.onNode(hasSetTextAction())
      editor.performTextReplacement("Existing draft")
      val dictation =
        composeRule.onNode(
          SemanticsMatcher("dictation control") { node ->
            node.config.getOrNull(SemanticsActions.OnClick)?.label == nativeString("Dictation")
          },
        )
      dictation.performClick()

      composeRule.onNodeWithText(nativeString("On-device speech recognition is unavailable.")).assertIsDisplayed()
      composeRule.onNodeWithText("Microphone permission is required to record a voice note.").assertDoesNotExist()
      composeRule.onNodeWithContentDescription(nativeString("Cancel voice note")).assertDoesNotExist()
      dictation.assertIsDisplayed()
      editor.assertTextEquals("Existing draft")

      val recovery = composeRule.onNodeWithText(nativeString("Record voice note")).assertIsDisplayed().assertHasClickAction()
      recovery.performClick()

      composeRule.onNodeWithText("Microphone permission is required to record a voice note.").assertIsDisplayed()
      composeRule.onNodeWithText(nativeString("On-device speech recognition is unavailable.")).assertDoesNotExist()
      composeRule.onNodeWithText(nativeString("Record voice note")).assertDoesNotExist()
      editor.assertTextEquals("Existing draft")

      composeRule.runOnIdle { viewModel.forgetGateway(AndroidScreenshotFixture.gatewayId) }
      composeRule.waitUntil {
        viewModel.activeGatewayStableId.value == null &&
          prefs.gatewayRegistry.entries.value
            .isEmpty()
      }
      assertTrue("Forgetting the last gateway leaves Chat accessible", viewModel.onboardingCompleted.value)
      editor.performTextReplacement("Draft after forgetting")
      dictation.performClick()
      composeRule.onNodeWithText(nativeString("On-device speech recognition is unavailable.")).assertIsDisplayed()
      composeRule.onNodeWithText(nativeString("Record voice note")).assertDoesNotExist()
      dictation.assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnLongClick))
      editor.assertTextEquals("Draft after forgetting")
    } finally {
      ShadowSpeechRecognizer.setIsOnDeviceRecognitionAvailable(recognitionAvailable)
    }
  }

  @Test
  fun narrowFrenchComposerKeepsAnEmptyDraftCompactWithTalkAndRunControls() {
    val fontScale = mutableStateOf(1.3f)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    showChat(viewportWidth = 320.dp, viewportHeight = { 640.dp }, fontScale = { fontScale.value }, talkActive = true)
    val editor = composeRule.onNode(hasSetTextAction())
    val failures = mutableListOf<String>()
    val measurements = mutableListOf<String>()

    listOf(1.3f, 1.5f, 2f).forEach { scale ->
      composeRule.runOnIdle { fontScale.value = scale }
      editor.performTextReplacement("")
      composeRule.onNodeWithText(nativeString("Message OpenClaw"), useUnmergedTree = true).assertIsDisplayed()
      val blank = editor.getUnclippedBoundsInRoot()
      assertComposerControlsVisible(talkActive = true)
      composeRule.onNodeWithText("GPT-5.2", useUnmergedTree = true).assertIsDisplayed()

      editor.performTextReplacement("Bonjour OpenClaw")
      editor.assertTextEquals("Bonjour OpenClaw")
      val typed = editor.getUnclippedBoundsInRoot()
      val layouts = mutableListOf<TextLayoutResult>()
      editor.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
      val layout = layouts.single()
      val lineHeight = with(composeRule.density) { (layout.getLineBottom(0) - layout.getLineTop(0)).toDp() }
      val maximumBlankHeight = maxOf(48.dp, lineHeight * 2) + 1.dp
      measurements += "fontScale=$scale: blank=$blank, typed=$typed, greetingLines=${layout.lineCount}, blankHeightLimit=$maximumBlankHeight"
      if (blank.bottom - blank.top > maximumBlankHeight) {
        failures += "fontScale=$scale: an empty localized hint must not consume more than two text lines or a touch target"
      }
      if (layout.lineCount > 2) {
        failures += "fontScale=$scale: a short greeting must stay readable instead of wrapping into a narrow column"
      }
      assertComposerControlsVisible(talkActive = true)
    }
    assertTrue((failures + measurements).joinToString("\n"), failures.isEmpty())
  }

  @Test
  fun narrowFrenchMultilineDraftKeepsTalkAndRunControlsVisibleWithKeyboardOpen() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    showChat(viewportWidth = 320.dp, fontScale = { 1.5f }, talkActive = true)
    val editor = composeRule.onNode(hasSetTextAction())
    val draft = "Un\ndeux\ntrois\nquatre\ncinq\nsix"
    editor.performTextReplacement(draft)
    editor.assertTextEquals(draft)
    assertComposerControlsVisible(talkActive = true)
  }

  @Test
  fun multilineDraftGrowsThroughSixLinesAndStopsGrowingAtTheSeventh() {
    showChat(viewportWidth = 360.dp, viewportHeight = { 640.dp })
    val editor = composeRule.onNode(hasSetTextAction())
    val heights =
      (1..7).map { lineCount ->
        val draft = (1..lineCount).joinToString("\n") { line -> "Line $line" }
        editor.performTextReplacement(draft)
        editor.assertTextEquals(draft)
        editor.getUnclippedBoundsInRoot().let { bounds -> bounds.bottom - bounds.top }
      }

    heights.take(6).zipWithNext().forEachIndexed { index, (current, next) ->
      assertTrue("The editor must grow from ${index + 1} to ${index + 2} visible lines", next > current)
    }
    assertEquals("The seventh line must scroll inside the six-line editor", heights[5], heights[6])
    assertComposerControlsVisible(primaryAction = "Send")
  }

  @Test
  fun modelSheetKeepsChatVisibleAndDetailsOptional() {
    showChat(viewportHeight = { 640.dp })
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    val window = composeRule.onNode(isDialog()).getUnclippedBoundsInRoot()
    val sheet = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.PaneTitle)).getUnclippedBoundsInRoot()
    assertTrue("Model sheet must leave chat visible: sheet=$sheet window=$window", sheet.bottom - sheet.top <= (window.bottom - window.top) * 0.6f)
    composeRule.onNodeWithText(nativeString("Latest model call")).assertDoesNotExist()
    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed().assertHasClickAction()
  }

  @Test
  @Config(qualifiers = "w320dp-h533dp-240dpi")
  fun modelSheetScrollsWithinSmallWindowWithLargeText() {
    verifyConstrainedModelSheet(320.dp, 500.dp, 1.5f)
  }

  @Test
  @Config(qualifiers = "w640dp-h320dp-240dpi")
  fun modelSheetScrollsWithinLandscapeWindow() {
    verifyConstrainedModelSheet(640.dp, 300.dp, 1f)
  }

  private fun verifyConstrainedModelSheet(
    width: Dp,
    height: Dp,
    fontScale: Float,
  ) {
    showChat(viewportWidth = width, viewportHeight = { height }, fontScale = { fontScale })
    updatePermissions(null, pending = false)
    val editor = composeRule.onNode(hasSetTextAction())
    val draftBounds = editor.getUnclippedBoundsInRoot()
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    val window = composeRule.onNode(isDialog()).getUnclippedBoundsInRoot()
    val sheet = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.PaneTitle)).getUnclippedBoundsInRoot()
    assertTrue("Small window must actually constrain the dialog: $window", window.bottom - window.top < 600.dp)
    assertTrue("Sheet stays compact: $sheet in $window", sheet.bottom - sheet.top <= (window.bottom - window.top) * 0.6f)
    assertTrue("Sheet stays bottom anchored: $sheet in $window", kotlin.math.abs((sheet.bottom - window.bottom).value) < 1f)
    composeRule.onNodeWithText(nativeString("Latest model call")).assertDoesNotExist()
    val details = composeRule.onNode(hasText(nativeString("Details")) and hasClickAction())
    details.performScrollTo().performClick()
    listOf("2.1k", "160", "76.5k", "\$0.0015").forEach { value ->
      composeRule.onNodeWithText(value).performScrollTo().assertIsDisplayed()
    }
    details.performScrollTo().performClick()
    val sheetList = composeRule.onNode(hasAnyAncestor(isDialog()) and SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))
    sheetList.performScrollToNode(hasText(nativeString("Permissions")) and hasClickAction())
    composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).assertIsEnabled().performClick()
    val permissionSheet = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.PaneTitle)).getUnclippedBoundsInRoot()
    assertTrue("Permission page stays compact", permissionSheet.bottom - permissionSheet.top <= (window.bottom - window.top) * 0.6f)
    sheetList.performScrollToNode(hasText(nativeString("Full access")) and hasClickAction())
    composeRule.onNode(hasText(nativeString("Full access")) and hasClickAction()).assertIsDisplayed()
    sheetList.performScrollToNode(hasText(nativeString("Back")) and hasClickAction())
    composeRule.onNodeWithText(nativeString("Back")).performClick()
    sheetList.performScrollToNode(hasText(nativeString("Default model")))
    composeRule
      .onNodeWithText(nativeString("Default model"))
      .assertIsDisplayed()
      .assertHasClickAction()
      .performClick()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    assertEquals("Sheet interactions preserve draft bounds", draftBounds, editor.getUnclippedBoundsInRoot())
  }

  @Test
  fun modelSheetPressureHasAccessibleThresholdAndRecoveryLabels() {
    showChat(viewportHeight = { 640.dp }, fontScale = { 1.5f })
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    for ((percent, label) in listOf(74 to null, 75 to "Warning", 89 to "Warning", 90 to "Critical", 40 to null)) {
      composeRule.runOnIdle {
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"session":{"key":"${controller.sessionKey.value}","totalTokens":${percent * 1000},"totalTokensFresh":true,"contextTokens":100000}}""",
        )
      }
      for (candidate in listOf("Warning", "Critical")) {
        val node = composeRule.onNodeWithText(nativeString(candidate))
        if (candidate == label) node.assertIsDisplayed() else node.assertDoesNotExist()
      }
    }
  }

  @Test
  fun compactPickersExposeFullSettingsWithoutExpandingTheComposer() {
    showChat(viewportWidth = 320.dp, fontScale = { 1.5f }, talkActive = true)
    composeRule.runOnIdle {
      controller.handleGatewayEvent(
        "sessions.changed",
        """
        {"reason":"patch","session":{
          "key":"${AndroidScreenshotFixture.mainSessionKey}",
          "thinkingLevel":"ultra",
          "thinkingLevels":[{"id":"off","label":"off"},{"id":"high","label":"high"}],
          "totalTokens":24000,"totalTokensFresh":true,"contextTokens":200000
        }}
        """.trimIndent(),
      )
    }
    val editor = composeRule.onNode(hasSetTextAction())
    val editorBounds = editor.getUnclippedBoundsInRoot()
    val model = composeRule.onNodeWithContentDescription(nativeString("Model"))
    val thinking = composeRule.onNodeWithContentDescription(nativeString("Thinking"))
    assertComposerControlsVisible(talkActive = true, thinkingLabel = "Ultra")
    model.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Context: \$detail", "24k / 200k · 12%")))

    thinking.performClick()
    composeRule.onNode(isDialog()).assertIsDisplayed()
    composeRule.onNode(isPopup()).assertDoesNotExist()
    composeRule.onNodeWithText(nativeString("Effort")).assertIsDisplayed()
    composeRule.onNodeWithText("Ultra").assertIsDisplayed().assert(hasClickAction().not())
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)).assertDoesNotExist()
    listOf(nativeString("Off"), nativeString("High")).forEach { label ->
      composeRule
        .onNode(hasText(label) and hasClickAction())
        .assertIsDisplayed()
        .assertIsEnabled()
        .assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
    }
    composeRule.onNodeWithText(nativeString("Faster responses, higher usage of limits.")).assertIsDisplayed()
    assertEquals("Opening effort must not move or shrink the draft", editorBounds, editor.getUnclippedBoundsInRoot())
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { dismiss -> assertTrue(dismiss()) }
    composeRule.onNode(isDialog()).assertDoesNotExist()

    model.performClick()
    composeRule.onNodeWithText(nativeString("Context window")).assertIsDisplayed()
    composeRule.onNodeWithText("24k / 200k · 12%").assertIsDisplayed()
    composeRule
      .onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo))
      .assert(
        SemanticsMatcher("has 12 percent context progress") { node ->
          node.config.getOrNull(SemanticsProperties.ProgressBarRangeInfo)?.current == 0.12f
        },
      )
    composeRule.onNodeWithText(nativeString("Latest run")).assertIsDisplayed()
    composeRule.onAllNodesWithText(nativeString("Non-cached input")).assertCountEquals(1)
    composeRule.onNodeWithText(nativeString("Latest model call")).assertDoesNotExist()
    val details = composeRule.onNode(hasText(nativeString("Details")) and hasClickAction())
    details.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
    details.performClick()
    details.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
    listOf(nativeString("Non-cached input excludes cache reads."), nativeString("Latest model call"), "2.1k", "160", "76.5k", nativeString("Cache read cost"), "\$0.0015").forEach { label ->
      composeRule.onNodeWithText(label).performScrollTo().assertIsDisplayed()
    }
    details.performScrollTo().performClick()
    details.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
    composeRule.onNodeWithText(nativeString("Latest model call")).assertDoesNotExist()
    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed().assertHasClickAction()
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { dismiss -> assertTrue(dismiss()) }
    composeRule.onNode(isDialog()).assertDoesNotExist()
    assertEquals("Dismissing model selection must preserve the draft", editorBounds, editor.getUnclippedBoundsInRoot())
    assertComposerControlsVisible(talkActive = true, thinkingLabel = "Ultra")

    composeRule.runOnIdle {
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"patch","session":{"key":"${AndroidScreenshotFixture.mainSessionKey}","thinkingLevel":"max","thinkingLevels":[{"id":"max","label":"max"}]}}""",
      )
    }
    thinking.assert(
      SemanticsMatcher.expectValue(
        SemanticsProperties.StateDescription,
        nativeString(
          "\$selectedLabel, \$fastModeLabel: \$fastModeState",
          nativeString("Max"),
          nativeString("Fast mode"),
          nativeString("Off"),
        ),
      ),
    )
    thinking.performClick()
    composeRule.onNode(hasText(nativeString("Max")) and hasClickAction()).assertIsDisplayed().assertIsSelected()
  }

  @Test
  fun effortSliderPreviewsAndCommitsEveryAdvertisedLevel() {
    val options =
      listOf(
        ChatThinkingLevelOption(id = "off", label = "Off"),
        ChatThinkingLevelOption(id = "low", label = "Low"),
        ChatThinkingLevelOption(id = "medium", label = "Medium"),
        ChatThinkingLevelOption(id = "high", label = "High"),
        ChatThinkingLevelOption(id = "xhigh", label = "Extra high"),
      )
    var committedId: String? = null
    val selectedId = mutableStateOf("off")
    composeRule.setContent {
      ClawDesignTheme {
        ChatEffortSliderControl(
          options = options,
          selectedId = selectedId.value,
          enabled = true,
          onSelect = { id ->
            committedId = id
            selectedId.value = id
          },
        )
      }
    }
    val slider = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo))
    slider.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, options.first().label))
    composeRule.onNodeWithText(options.first().label).assertIsDisplayed().assert(hasClickAction().not())

    options.drop(1).forEachIndexed { offset, option ->
      val index = offset + 1
      slider.performSemanticsAction(SemanticsActions.SetProgress) { setProgress -> assertTrue(setProgress(index.toFloat())) }
      slider.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, option.label))
      composeRule.onNodeWithText(option.label).assertIsDisplayed().assert(hasClickAction().not())
      composeRule.runOnIdle { assertEquals(option.id, committedId) }
    }
  }

  @Test
  fun effortSliderRestoresTheAuthoritativeLevelWhenACommitIsRejected() {
    val options =
      listOf(
        ChatThinkingLevelOption(id = "off", label = "Off"),
        ChatThinkingLevelOption(id = "low", label = "Low"),
        ChatThinkingLevelOption(id = "high", label = "High"),
      )
    var attemptedId: String? = null
    composeRule.setContent {
      ClawDesignTheme {
        ChatEffortSliderControl(
          options = options,
          selectedId = "off",
          enabled = true,
          onSelect = { id -> attemptedId = id },
        )
      }
    }
    val slider = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo))

    slider.performSemanticsAction(SemanticsActions.SetProgress) { setProgress -> assertTrue(setProgress(2f)) }

    composeRule.runOnIdle { assertEquals("high", attemptedId) }
    slider.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Off"))
    composeRule.onNodeWithText("Off").assertIsDisplayed()
  }

  @Test
  fun binaryEffortOptionsAreIndividuallyAccessible() {
    val selectedId = mutableStateOf("off")
    val options = listOf(ChatThinkingLevelOption("off", "Off"), ChatThinkingLevelOption("high", "High"))
    composeRule.setContent {
      ClawDesignTheme {
        ChatEffortSliderControl(options, selectedId.value, true) { selectedId.value = it }
      }
    }

    composeRule.onNode(hasText("High") and hasClickAction()).assertIsEnabled().performClick()
    composeRule.runOnIdle { assertEquals("high", selectedId.value) }
    composeRule.onNode(hasText("High") and hasClickAction()).assertIsSelected()
    composeRule.onNode(hasText("Off") and hasClickAction()).performClick()
    composeRule.runOnIdle { assertEquals("off", selectedId.value) }
    composeRule.onNode(hasText("Off") and hasClickAction()).assertIsSelected()
  }

  @Test
  fun unknownEffortCanSelectTheFirstAdvertisedOption() {
    val selectedId = mutableStateOf("future-effort")
    val options =
      listOf(
        ChatThinkingLevelOption("off", "Off"),
        ChatThinkingLevelOption("low", "Low"),
        ChatThinkingLevelOption("high", "High"),
      )
    composeRule.setContent {
      ClawDesignTheme {
        ChatEffortSliderControl(options, selectedId.value, true) { selectedId.value = it }
      }
    }

    composeRule.onNode(hasText("Off") and hasClickAction()).assertIsEnabled().performClick()
    composeRule.runOnIdle { assertEquals("off", selectedId.value) }
  }

  @Test
  fun singleEffortOptionDoesNotClaimAnUnknownSelection() {
    composeRule.setContent {
      ClawDesignTheme {
        ChatEffortSliderControl(
          options = listOf(ChatThinkingLevelOption(id = "high", label = "High")),
          selectedId = "future-effort",
          enabled = true,
          onSelect = {},
        )
      }
    }

    composeRule
      .onNode(hasText("High") and hasClickAction())
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
    composeRule.onNodeWithContentDescription(nativeString("Selected")).assertDoesNotExist()
  }

  @Test
  fun fastModeBadgeBelongsToTheGaugeGeometry() {
    showChat(viewportWidth = 360.dp, viewportHeight = { 640.dp })
    composeRule.runOnIdle {
      controller.handleGatewayEvent(
        "sessions.changed",
        """
        {"reason":"patch","session":{
          "key":"${AndroidScreenshotFixture.mainSessionKey}",
          "thinkingLevel":"high",
          "thinkingLevels":[{"id":"off","label":"off"},{"id":"high","label":"high"}],
          "fastMode":true,"effectiveFastMode":true
        }}
        """.trimIndent(),
      )
    }

    composeRule.onNodeWithContentDescription(nativeString("Thinking")).assertIsDisplayed()
    val gauge = composeRule.onNodeWithTag("chat-thinking-gauge", useUnmergedTree = true).getUnclippedBoundsInRoot()
    val badge = composeRule.onNodeWithTag("chat-fast-mode-badge", useUnmergedTree = true).getUnclippedBoundsInRoot()
    val badgeCenterX = (badge.left.value + badge.right.value) / 2f
    val badgeCenterY = (badge.top.value + badge.bottom.value) / 2f
    val gaugeCenterX = (gauge.left.value + gauge.right.value) / 2f
    val gaugeCenterY = (gauge.top.value + gauge.bottom.value) / 2f

    assertTrue("The Fast mode badge center must stay inside the gauge: $badge in $gauge", badgeCenterX in gauge.left.value..gauge.right.value)
    assertTrue("The Fast mode badge center must stay inside the gauge: $badge in $gauge", badgeCenterY in gauge.top.value..gauge.bottom.value)
    assertFalse(
      "The Fast mode badge must not cover the needle hub: $badge over $gauge",
      gaugeCenterX in badge.left.value..badge.right.value && gaugeCenterY in badge.top.value..badge.bottom.value,
    )
  }

  @Test
  fun effortSheetScrollsFastModeIntoViewOnAConstrainedViewport() {
    showChat(viewportWidth = 320.dp, viewportHeight = { 320.dp }, fontScale = { 2f })
    composeRule.runOnIdle {
      controller.handleGatewayEvent(
        "sessions.changed",
        """
        {"reason":"patch","session":{
          "key":"${AndroidScreenshotFixture.mainSessionKey}",
          "thinkingLevel":"high",
          "thinkingLevels":[{"id":"off","label":"off"},{"id":"low","label":"low"},{"id":"high","label":"high"}]
        }}
        """.trimIndent(),
      )
    }

    composeRule.onNodeWithContentDescription(nativeString("Thinking")).performClick()
    composeRule
      .onNodeWithText(nativeString("Faster responses, higher usage of limits."))
      .performScrollTo()
      .assertIsDisplayed()
    composeRule.onNodeWithContentDescription(nativeString("Fast mode")).assertIsDisplayed()
  }

  @Test
  fun modelSheetSeparatesPermissionActionStatusAndDefaultModel() {
    val fontScale = mutableStateOf(1f)
    showChat(viewportWidth = 360.dp, viewportHeight = { 640.dp }, fontScale = { fontScale.value })

    fun sheetBackOwner() =
      checkNotNull(
        WindowInspector
          .getGlobalWindowViews()
          .asReversed()
          .firstNotNullOfOrNull { it.findViewTreeOnBackPressedDispatcherOwner() },
      )

    updatePermissions(null, pending = false)
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()

    composeRule
      .onNodeWithText(nativeString("Policy default"), useUnmergedTree = true)
      .assertTextEquals(nativeString("Policy default"))
      .assert(hasClickAction().not())
      .assert(hasAnyAncestor(hasClickAction()).not())
    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed().assertHasClickAction()

    composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).performClick()
    composeRule.onNode(isPopup()).assertDoesNotExist()
    composeRule.onNodeWithText(nativeString("Back")).assert(hasAnyAncestor(isDialog()))
    val initialOwner = composeRule.runOnIdle { sheetBackOwner() }
    composeRule.runOnIdle { fontScale.value = 1.2f }
    composeRule.waitForIdle()
    composeRule.runOnIdle {
      val recreatedOwner = sheetBackOwner()
      assertTrue("The dialog must actually be recreated", initialOwner !== recreatedOwner)
      recreatedOwner.onBackPressedDispatcher.onBackPressed()
    }
    composeRule.onNodeWithText(nativeString("Back")).assertDoesNotExist()
    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed()
    composeRule.runOnIdle { sheetBackOwner().onBackPressedDispatcher.onBackPressed() }
    composeRule.onNode(isDialog()).assertDoesNotExist()

    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).performClick()
    composeRule.onNode(hasText(nativeString("Policy default")) and hasClickAction()).performClick()

    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed().performClick()
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  @Test
  fun lockedModelPickerExplainsNativeOwnershipAndKeepsOtherControlsAvailable() {
    showChat(viewportWidth = 320.dp, viewportHeight = { 640.dp })
    val sessionKey = controller.sessionKey.value
    val model = composeRule.onNodeWithContentDescription(nativeString("Model"))
    val defaultModel = hasText(nativeString("Default model")) and hasClickAction()

    for ((runtimeId, label) in listOf("codex" to nativeString("Native Codex model"), "other" to nativeString("Locked session model"))) {
      composeRule.runOnIdle {
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","sessionId":"native-model-session","modelSelectionLocked":true,"agentRuntime":{"id":"$runtimeId","source":"session"}}}""",
        )
      }
      model.assertTextEquals(label).assertIsEnabled().performClick()
      composeRule.onNodeWithText(nativeString("Model selection is locked for this session.")).assertIsDisplayed()
      composeRule.onNode(defaultModel).assertDoesNotExist()
      composeRule.onNode(hasText("GPT-5.2") and hasClickAction()).assertDoesNotExist()
      composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).assertIsEnabled()
      composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { dismiss -> assertTrue(dismiss()) }
      composeRule.onNodeWithContentDescription(nativeString("Thinking")).assertIsEnabled()

      composeRule.runOnIdle {
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","thinkingLevel":"high"}}""",
        )
      }
      model.assertTextEquals(label)
    }

    composeRule.runOnIdle {
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","modelSelectionLocked":false}}""",
      )
    }
    model.assertTextEquals("GPT-5.2").performClick()
    composeRule.onNode(defaultModel).assertIsEnabled()
  }

  @Test
  fun lockedParentDisablesNewChatInWorktreeUntilUnlocked() {
    showChat(viewportHeight = { 640.dp })
    val sessionKey = controller.sessionKey.value
    composeRule.runOnIdle {
      @Suppress("UNCHECKED_CAST")
      val agents =
        NodeRuntime::class.java
          .getDeclaredField("_gatewayAgents")
          .apply { isAccessible = true }
          .get(runtime) as MutableStateFlow<List<GatewayAgentSummary>>
      agents.value = agents.value.map { it.copy(workspaceGit = true) }
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"$sessionKey","runId":"android-screenshot-active-run","seq":1,"stream":"lifecycle","data":{"phase":"end"}}""",
      )
    }
    composeRule.onNodeWithContentDescription(nativeString("Chat actions")).performClick()
    val newChat = composeRule.onNodeWithText(app.getString(R.string.new_chat_in_worktree))
    newChat.assertIsDisplayed().assertIsEnabled()

    for (locked in listOf(true, false)) {
      composeRule.runOnIdle {
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","modelSelectionLocked":$locked}}""",
        )
      }
      if (locked) newChat.assertIsNotEnabled() else newChat.assertIsEnabled()
    }
  }

  @Test
  fun narrowComposerKeepsModelNamesOnOneLineWithLargeTextAndContextUsage() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    val fontScale = mutableStateOf(1f)
    showChat(viewportWidth = 320.dp, viewportHeight = { 640.dp }, fontScale = { fontScale.value }, talkActive = true)
    val requestField = ChatController::class.java.getDeclaredField("requestGatewayForGateway").apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    val originalRequest = requestField.get(controller) as suspend (String, String, String?) -> String
    var modelLabel = "GPT-5.6 Sol"
    val request: suspend (String, String, String?) -> String = { gatewayId, method, params ->
      val response = originalRequest(gatewayId, method, params)
      if (method == "chat.metadata") {
        val metadata = Json.parseToJsonElement(response).jsonObject
        val models =
          metadata.getValue("models").jsonArray.map { model ->
            JsonObject(model.jsonObject + ("name" to JsonPrimitive(modelLabel)))
          }
        JsonObject(metadata + ("models" to JsonArray(models))).toString()
      } else {
        response
      }
    }
    requestField.set(controller, request)
    try {
      composeRule.runOnIdle {
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"reason":"patch","session":{"key":"${AndroidScreenshotFixture.mainSessionKey}","totalTokens":24000,"totalTokensFresh":true,"contextTokens":200000}}""",
        )
      }
      composeRule.onNodeWithContentDescription(nativeString("Model")).assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Context: \$detail", "24k / 200k · 12%")))
      val longName = "A very long model display name for a narrow screen"
      listOf(1f, 1.5f).forEach { scale ->
        composeRule.runOnIdle { fontScale.value = scale }
        listOf("Claude Opus 4.6", "GPT-5.6 Sol", "GPT-5.2", longName).forEach { name ->
          composeRule.runOnIdle {
            modelLabel = name
            controller.handleGatewayEvent("chat.metadata.changed", "{}")
          }
          // Catalog publication can precede ViewModel collection and the picker rendering.
          composeRule.waitUntil {
            composeRule
              .onAllNodes(hasContentDescription(nativeString("Model")) and hasText(name))
              .fetchSemanticsNodes()
              .size == 1
          }
          assertComposerControlsVisible(talkActive = true, modelLabel = name)
          val label = composeRule.onNodeWithText(name, useUnmergedTree = true).assertIsDisplayed()
          val layouts = mutableListOf<TextLayoutResult>()
          label.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
          val layout = layouts.single()
          assertEquals("Model labels must stay on one line: $name", 1, layout.lineCount)
          assertTrue("The model label must not be clipped vertically", layout.multiParagraph.height <= layout.size.height)
          if (name == longName) {
            assertTrue("Long model names must show an ellipsis", layout.isLineEllipsized(0))
          } else if (scale == 1f || name == "GPT-5.2") {
            assertTrue("Common model names must remain readable at $scale: $name", !layout.isLineEllipsized(0))
          }
        }
      }
    } finally {
      requestField.set(controller, originalRequest)
    }
  }

  @Test
  fun textDraftKeepsDisabledSendWhileAnotherAdmissionIsPending() {
    assertDraftKeepsDisabledSendWhileAdmissionIsPending(text = "Still writing the next message")
  }

  @Test
  fun attachmentOnlyDraftKeepsDisabledSendWhileAnotherAdmissionIsPending() {
    assertDraftKeepsDisabledSendWhileAdmissionIsPending(
      attachment = PendingAttachment(id = "note", fileName = "note.txt", mimeType = "text/plain", base64 = "SGVsbG8="),
    )
  }

  @Test
  fun longProgressPlanKeepsEditorAndStopVisibleAndLastStepReachable() {
    showChat()
    val steps = List(20) { index -> "Step ${index + 1}: verify the Android chat behavior and document the result." }
    showProgressCard(steps)

    assertComposerControlsVisible()
    if (composeRule.onAllNodesWithContentDescription("Expand progress card").fetchSemanticsNodes().isNotEmpty()) {
      composeRule.onNodeWithContentDescription("Expand progress card").performClick()
    }
    assertComposerControlsVisible()
    composeRule.onNodeWithText(steps.last()).performScrollTo().assertIsDisplayed()
    assertComposerControlsVisible()
  }

  @Test
  fun progressCardDocksBehindIndependentComposerAndExpandsUpward() {
    showChat()
    showProgressCard(listOf("Inspect the Android layout", "Implement the attached panel", "Verify the result"))

    val card = composeRule.onNodeWithTag("chat-progress-card")
    val composer = composeRule.onNodeWithTag("chat-composer-surface")
    val editor = composeRule.onNode(hasSetTextAction())
    val collapsedCard = card.getUnclippedBoundsInRoot()
    val composerBefore = composer.getUnclippedBoundsInRoot()
    val editorBefore = editor.getUnclippedBoundsInRoot()
    composeRule.onNodeWithContentDescription(nativeString("Expand progress card")).performClick()

    val expandedCard = card.getUnclippedBoundsInRoot()
    val composerAfter = composer.getUnclippedBoundsInRoot()
    val editorAfter = editor.getUnclippedBoundsInRoot()
    val expectedUnderlap = 18.dp
    assertTrue(
      "The collapsed progress card must start above the independent composer surface",
      collapsedCard.top < composerBefore.top,
    )
    assertEquals(
      "The progress card must underlap the composer by the shared dock depth",
      expectedUnderlap.value,
      (collapsedCard.bottom - composerBefore.top).value,
      0.5f,
    )
    assertEquals("Expanding progress must not move the composer top", composerBefore.top.value, composerAfter.top.value, 0.5f)
    assertEquals("Expanding progress must not move the composer bottom", composerBefore.bottom.value, composerAfter.bottom.value, 0.5f)
    assertEquals("Expanding progress must not move the editor top", editorBefore.top.value, editorAfter.top.value, 0.5f)
    assertEquals("Expanding progress must not move the editor bottom", editorBefore.bottom.value, editorAfter.bottom.value, 0.5f)
    assertEquals(
      "The attached progress edge must stay docked while its body expands upward",
      collapsedCard.bottom.value,
      expandedCard.bottom.value,
      0.5f,
    )
    assertTrue("The progress surface must expand upward", expandedCard.top < collapsedCard.top)
    assertComposerControlsVisible()
  }

  @Test
  fun progressCardRendersProgressMarkupAsANativeBar() {
    showChat()
    showProgressCard(
      steps = emptyList(),
      markdown =
        """
        [Test is running][status]

        <progress aria-label="Test progress" value="2" max="5"></progress>
        40%

        [status]: https://example.com/status
        """.trimIndent(),
    )

    composeRule.onNodeWithContentDescription(nativeString("Expand progress card")).performClick()

    val progress =
      composeRule
        .onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo))
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .config[SemanticsProperties.ProgressBarRangeInfo]
    assertEquals(0.4f, progress.current, 0.001f)
    val statusText =
      composeRule
        .onNodeWithText("Test is running")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .config[SemanticsProperties.Text]
        .single()
    val statusLink = statusText.getLinkAnnotations(0, statusText.length).single().item as LinkAnnotation.Url
    assertEquals("https://example.com/status", statusLink.url)
    composeRule.onNodeWithText("40%").assertIsDisplayed()
    composeRule
      .onNodeWithText("<progress aria-label=\"Test progress\" value=\"2\" max=\"5\"></progress>")
      .assertDoesNotExist()
  }

  @Test
  fun progressCardKeepsWarningAfterDisclosure() {
    showChat()
    showProgressCard(
      steps = emptyList(),
      markdown =
        """
        <progress value='2' max='5'></progress>

        <details>
        <summary>Logs</summary>
        body
        </details>Do not ship: tests are failing on Linux
        """.trimIndent(),
    )
    composeRule.onNodeWithContentDescription(nativeString("Expand progress card")).performClick()

    composeRule.onNodeWithText("Do not ship: tests are failing on Linux").assertIsDisplayed()
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)).assertIsDisplayed()
  }

  @Test
  fun progressCardRendersAdjacentBarsWithoutLeakingMarkup() {
    showChat()
    showProgressCard(
      steps = emptyList(),
      markdown =
        """
        <progress aria-label='First' value='2' max='5'></progress>
        <progress aria-label='Second' value='3' max='5'></progress>
        Both checks are running
        """.trimIndent(),
    )
    composeRule.onNodeWithContentDescription(nativeString("Expand progress card")).performClick()

    composeRule.onNodeWithContentDescription("First").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Second").assertIsDisplayed()
    composeRule.onNodeWithText("Both checks are running").assertIsDisplayed()
    composeRule.onNodeWithText("<progress", substring = true).assertDoesNotExist()
  }

  @Test
  fun progressCardStaysUndecoratedWhileRecordingVoiceNote() {
    val permission = Manifest.permission.RECORD_AUDIO
    val permissionWasGranted = app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    shadowOf(app).grantPermissions(permission)
    val lifecycleOwner =
      object : LifecycleOwner {
        override val lifecycle = LifecycleRegistry(this).apply { currentState = Lifecycle.State.RESUMED }
      }
    try {
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(
          stableId = AndroidScreenshotFixture.gatewayId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = "Test gateway",
        ),
      )
      prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
      val viewModel = showChat()
      composeRule.runOnIdle {
        viewModel.attachRuntimeUi(lifecycleOwner, app.permissionRequester)
        controller.handleGatewayEvent(
          "agent",
          """{"sessionKey":"${AndroidScreenshotFixture.mainSessionKey}","runId":"android-screenshot-active-run","seq":1,"stream":"lifecycle","data":{"phase":"end"}}""",
        )
      }
      showProgressCard(listOf("Keep voice-note progress independent"))
      composeRule
        .onNode(
          SemanticsMatcher("voice-note long press") { node ->
            node.config.getOrNull(SemanticsActions.OnLongClick)?.label == nativeString("Record voice note")
          },
        ).performSemanticsAction(SemanticsActions.OnLongClick) { action -> action() }
      composeRule.onNodeWithContentDescription(nativeString("Cancel voice note")).assertIsDisplayed()

      val pixels = composeRule.onNodeWithTag("chat-progress-card").captureToImage().toPixelMap()
      assertEquals(
        "Standalone voice-note progress must not paint the attached-surface border",
        renderedCanvasColor.toArgb(),
        pixels[pixels.width / 2, 0].toArgb(),
      )
    } finally {
      if (!permissionWasGranted) shadowOf(app).denyPermissions(permission)
    }
  }

  @Test
  fun pendingPermissionsStayVisibleInTheModelSheetUntilApplied() {
    showChat(viewportWidth = 320.dp, viewportHeight = { 640.dp })
    updatePermissions("guarded", pending = false)
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    val permissions = composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction())
    permissions.assertIsEnabled().performClick()
    composeRule.onNodeWithText(nativeString("Back")).assert(hasAnyAncestor(isDialog()))

    updatePermissions("read-only", pending = true)
    composeRule.onNodeWithText(nativeString("Back")).assertDoesNotExist()
    permissions.assertIsNotEnabled()
    composeRule.onNodeWithText(nativeString("Applying permissions…"), useUnmergedTree = true).assertIsDisplayed()

    updatePermissions("read-only", pending = false)
    permissions.assertIsEnabled()
    composeRule.onNodeWithText(nativeString("Read only"), useUnmergedTree = true).assertIsDisplayed()
  }

  @Test
  fun fullPermissionsRequireAdminEvenWhenOtherModesAreSelectable() {
    showChat(viewportWidth = 320.dp, viewportHeight = { 640.dp })
    updatePermissions("guarded", pending = false)
    composeRule.runOnIdle {
      @Suppress("UNCHECKED_CAST")
      val scopes =
        NodeRuntime::class.java
          .getDeclaredField("_operatorScopes")
          .apply { isAccessible = true }
          .get(runtime) as MutableStateFlow<List<String>>
      scopes.value = listOf("operator.read", "operator.write")
    }
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).assertIsEnabled().performClick()
    composeRule.onNode(hasText(nativeString("Guarded")) and SemanticsMatcher.expectValue(SemanticsProperties.Selected, true)).assertIsEnabled().assertIsSelected()
    composeRule
      .onNode(hasText(nativeString("Full access")) and hasClickAction())
      .performScrollTo()
      .assertIsDisplayed()
      .assertIsNotEnabled()
    composeRule.onNodeWithText(nativeString("Full access requires operator.admin access."), useUnmergedTree = true).assertIsDisplayed()
  }

  @Test
  fun olderGatewayKeepsModelSelectionButExplainsUnavailablePermissions() {
    showChat(viewportWidth = 320.dp, viewportHeight = { 640.dp })
    updatePermissions("guarded", pending = false)
    composeRule.runOnIdle {
      ChatController::class.java
        .getDeclaredField("gatewayAdvertisesCapability")
        .apply { isAccessible = true }
        .set(controller, { _: String -> false })
      NodeRuntime::class.java
        .getDeclaredMethod("replaceGatewayCapabilities", Set::class.java)
        .apply { isAccessible = true }
        .invoke(runtime, emptySet<String>())
    }
    composeRule.onNodeWithContentDescription(nativeString("Model")).assertIsEnabled().performClick()
    composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).assertIsNotEnabled()
    composeRule.onNodeWithText(nativeString("Update the Gateway to change session permissions.")).assertIsDisplayed()
    composeRule.onNode(hasText(nativeString("Default model")) and hasClickAction()).assertIsEnabled()
  }

  private fun updatePermissions(
    mode: String?,
    pending: Boolean,
  ) {
    composeRule.runOnIdle {
      val sessionKey = controller.sessionKey.value
      val sessionId =
        controller.sessions.value
          .firstOrNull { it.key == sessionKey }
          ?.sessionId ?: "permission-layout-session"
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"patch","session":{"key":"$sessionKey","sessionId":"$sessionId","agentId":"main","permissionMode":${mode?.let { "\"$it\"" } ?: "null"},"permissionModePending":$pending}}""",
      )
    }
  }

  private fun showProgressCard(
    steps: List<String>,
    markdown: String? = null,
  ) {
    val response =
      buildJsonObject {
        put(
          "card",
          buildJsonObject {
            put("sessionKey", JsonPrimitive(controller.sessionKey.value))
            put("revision", JsonPrimitive(1))
            put("updatedAt", JsonPrimitive(System.currentTimeMillis()))
            markdown?.let { put("markdown", JsonPrimitive(it)) }
            put(
              "steps",
              buildJsonArray {
                steps.forEachIndexed { index, step ->
                  add(
                    buildJsonObject {
                      put("step", JsonPrimitive(step))
                      put("status", JsonPrimitive(if (index == 0) "in_progress" else "pending"))
                    },
                  )
                }
              },
            )
          },
        )
      }.toString()
    val leaseField = ChatController::class.java.getDeclaredField("captureRequestLease").apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    val captureLease = leaseField.get(controller) as (ChatCacheScope?) -> GatewaySession.RequestLease?
    val progressLease: (ChatCacheScope?) -> GatewaySession.RequestLease? = { gatewayScope ->
      captureLease(gatewayScope)?.let { lease ->
        GatewaySession.RequestLease(
          endpointStableId = lease.endpointStableId,
          isCurrentImpl = lease::isCurrent,
          commitIfCurrentImpl = lease::commitIfCurrent,
        ) { method, params, timeoutMs, withEnqueue ->
          if (method == "progressCard.get") {
            withEnqueue {}
            response
          } else {
            lease.request(method, params, timeoutMs, withEnqueue)
          }
        }
      }
    }
    composeRule.runOnIdle {
      leaseField.set(controller, progressLease)
      controller.handleGatewayEvent(
        "progressCard.changed",
        """{"sessionKey":"${controller.sessionKey.value}","revision":1}""",
      )
    }
    composeRule.waitUntil {
      controller.progressCard.value
        ?.steps
        ?.size == steps.size
    }
  }

  private fun assertPhysicalEnterDuringActiveRun(
    talkActive: Boolean,
    expectedSends: Int,
  ) {
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(
        stableId = AndroidScreenshotFixture.gatewayId,
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "Test gateway",
      ),
    )
    prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
    val viewModel = showChat(talkActive = talkActive)
    val owner = viewModel.captureChatShareOwner()
    assertTrue("The fixture must have an active run", controller.pendingRunCount.value > 0)
    assertTrue("The composer must have a routable controller owner", controller.isCurrentComposerOwner(owner))
    val sent = ConcurrentLinkedQueue<JsonObject>()
    val requestField = ChatController::class.java.getDeclaredField("requestGatewayForGateway").apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    val originalRequest = requestField.get(controller) as suspend (String, String, String?) -> String
    val request: suspend (String, String, String?) -> String = { gatewayId, method, params ->
      if (method == "chat.send") {
        val payload = Json.parseToJsonElement(requireNotNull(params)).jsonObject
        sent.add(payload)
        buildJsonObject {
          put("runId", payload.getValue("idempotencyKey"))
          put("status", JsonPrimitive("started"))
        }.toString()
      } else {
        originalRequest(gatewayId, method, params)
      }
    }
    try {
      requestField.set(controller, request)
      val draft = "Physical follow-up"
      val editor = composeRule.onNode(hasSetTextAction())
      editor.performClick()
      editor.performTextReplacement(draft)
      assertComposerControlsVisible(talkActive = talkActive, primaryAction = if (talkActive) "Stop" else "Send")
      if (!talkActive) composeRule.onNodeWithContentDescription(nativeString("Send")).assertIsEnabled()
      composeRule.runOnIdle {
        val root = WindowInspector.getGlobalWindowViews().single { it.hasFocus() }
        assertTrue("The focused editor must consume Enter down", root.dispatchKeyEventPreIme(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)))
        assertTrue("The focused editor must consume Enter up", root.dispatchKeyEventPreIme(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER)))
      }
      composeRule.waitUntil(timeoutMillis = 5_000) {
        composeRule.runOnIdle { owner !in viewModel.chatComposerState.sendStates.value }
      }
      assertEquals(List(expectedSends) { JsonPrimitive(draft) }, sent.map { it["message"] })
      editor.assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString(if (expectedSends == 0) draft else "")))
    } finally {
      requestField.set(controller, originalRequest)
    }
  }

  private fun assertDraftKeepsDisabledSendWhileAdmissionIsPending(
    text: String = "",
    attachment: PendingAttachment? = null,
  ) {
    val viewModel = showChat()
    val owner = viewModel.captureChatShareOwner()
    composeRule.runOnIdle {
      assertTrue("The prior run must remain active", controller.pendingRunCount.value > 0)
      viewModel.chatComposerState.addAttachments(owner, listOfNotNull(attachment))
    }
    val editor = composeRule.onNode(hasSetTextAction())
    if (text.isNotEmpty()) editor.performTextReplacement(text)
    composeRule.onNodeWithContentDescription("Send").assertIsDisplayed().assertIsEnabled()

    val admissionId = composeRule.runOnIdle { requireNotNull(viewModel.chatComposerState.tryBeginTrackedSend(owner)) }
    try {
      composeRule.onNodeWithContentDescription("Send").assertIsDisplayed().assertIsNotEnabled()
      composeRule.onNodeWithContentDescription("Start Talk").assertDoesNotExist()
    } finally {
      composeRule.runOnIdle { viewModel.chatComposerState.finishTrackedSend(admissionId) }
    }

    composeRule.onNodeWithContentDescription("Send").assertIsDisplayed().assertIsEnabled()
    if (text.isNotEmpty()) editor.assertTextEquals(text)
    attachment?.let { composeRule.onNodeWithText(it.fileName).assertIsDisplayed() }
  }

  private fun withReaderHistory(
    assistantCount: Int,
    assistantText: (Int) -> String = { "Reader answer ${it + 1}" },
    viewportHeight: () -> Dp = { 640.dp },
    viewportWidth: Dp = 360.dp,
    fontScale: () -> Float = { 1f },
    onOpenSidebar: () -> Unit = {},
    assertions: () -> Unit,
  ) {
    val sessionKey = "agent:main:reader-history"
    val texts = listOf("Reader prompt") + List(assistantCount, assistantText)
    val history =
      buildJsonObject {
        put("sessionId", JsonPrimitive("reader-history"))
        put(
          "messages",
          buildJsonArray {
            texts.forEachIndexed { index, text ->
              add(
                buildJsonObject {
                  put("role", JsonPrimitive(if (index == 0) "user" else "assistant"))
                  put("content", JsonPrimitive(text))
                },
              )
            }
          },
        )
      }.toString()
    val requestField = ChatController::class.java.getDeclaredField("requestGatewayForGateway").apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    val originalRequest = requestField.get(controller) as suspend (String, String, String?) -> String
    val request: suspend (String, String, String?) -> String = { gatewayId, method, params ->
      when (method) {
        "chat.history" -> history
        "question.list" -> """{"questions":[]}"""
        "progressCard.get" -> """{"card":null}"""
        else -> originalRequest(gatewayId, method, params)
      }
    }
    try {
      requestField.set(controller, request)
      // A new selection fences the constructor's earlier screenshot-history load.
      composeRule.runOnUiThread { controller.load(sessionKey, ownerAgentId = "main") }
      val model =
        showChat(
          viewportWidth = viewportWidth,
          viewportHeight = viewportHeight,
          fontScale = fontScale,
          expectedMessageCount = texts.size,
          onOpenSidebar = onOpenSidebar,
        )
      composeRule.waitUntil(timeoutMillis = 5_000) {
        composeRule.runOnIdle {
          model.chatSessionKey.value == sessionKey &&
            !model.chatHistoryLoading.value && model.chatHealthOk.value &&
            model.chatMessages.value.map { message -> message.content.mapNotNull { it.text }.joinToString("\n") } == texts &&
            model.pendingRunCount.value == 0 && model.chatStreamingAssistantText.value == null &&
            model.chatPendingToolCalls.value.isEmpty() && model.chatSubagentActivities.value.isEmpty() &&
            model.chatOutboxItems.value.isEmpty() && model.chatProgressCard.value == null &&
            questionsForSession(model.chatQuestions.value, sessionKey, model.mainSessionKey.value, "main").isEmpty()
        }
      }
      composeRule.waitForIdle()
      assertions()
    } finally {
      requestField.set(controller, originalRequest)
    }
  }

  private fun readerMarkerBounds(marker: String): DpRect {
    val target =
      composeRule.onNode(
        hasText(marker) and hasAnyAncestor(hasContentDescription(nativeString("OpenClaw"))),
        useUnmergedTree = true,
      )
    val layouts = mutableListOf<TextLayoutResult>()
    target.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
    val layout = layouts.single()
    assertEquals("The rendered marker must remain intact", marker, layout.layoutInput.text.text)
    val position = target.fetchSemanticsNode().positionInRoot
    val glyphs = marker.indices.filterNot { marker[it].isWhitespace() }.map { layout.getBoundingBox(it).translate(position) }
    assertTrue(
      "Marker glyphs need finite positive geometry: $glyphs",
      glyphs.isNotEmpty() && glyphs.all { it.left.isFinite() && it.top.isFinite() && it.right.isFinite() && it.bottom.isFinite() && it.width > 0 && it.height > 0 },
    )
    return with(composeRule.density) {
      DpRect(glyphs.minOf { it.left }.toDp(), glyphs.minOf { it.top }.toDp(), glyphs.maxOf { it.right }.toDp(), glyphs.maxOf { it.bottom }.toDp())
    }
  }

  private fun readerTranscript() =
    composeRule.onNode(
      SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex) and hasAnyAncestor(hasTestTag("chat-viewport")),
    )

  private fun readerHeaderControl(label: String) =
    composeRule.onNode(
      hasContentDescription(nativeString(label)) and hasClickAction() and hasAnyAncestor(hasTestTag("chat-viewport")),
    )

  private fun assertReaderHeaderControl(label: String): DpRect {
    val bounds = readerHeaderControl(label).assertIsDisplayed().assertIsEnabled().getUnclippedBoundsInRoot()
    val root = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
    val transcript = readerTranscript().getUnclippedBoundsInRoot()
    val retainsTouchTarget =
      with(composeRule.density) {
        (bounds.right - bounds.left).roundToPx() >= 48.dp.roundToPx() &&
          (bounds.bottom - bounds.top).roundToPx() >= 48.dp.roundToPx()
      }
    assertTrue("The full $label target remains at least 48dp: $bounds", retainsTouchTarget)
    assertTrue(
      "The full $label target stays inside the visible root: $bounds within $root",
      bounds.left >= root.left && bounds.right <= root.right && bounds.top >= root.top && bounds.bottom <= root.bottom,
    )
    assertTrue("The $label target stays outside transcript content: $bounds versus $transcript", bounds.bottom <= transcript.top)
    return bounds
  }

  private fun assertReaderHistoryFits(assistantCount: Int): Dp {
    val messages = listOf("You" to "Reader prompt") + (1..assistantCount).map { index -> "OpenClaw" to "Reader answer $index" }
    val rows =
      messages.map { (role, text) ->
        assertReaderMessageVisible(role, text)
        composeRule.onNode(hasContentDescription(nativeString(role)) and hasText(text)).getUnclippedBoundsInRoot()
      }
    val range = readerTranscript().fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
    assertEquals("All loaded rows reach the latest edge", 0f, range.value(), 0f)
    assertEquals("All loaded rows fit without scrolling", 0f, range.maxValue(), 0f)
    composeRule.onNodeWithContentDescription(nativeString("Jump to latest")).assertDoesNotExist()
    return rows.maxOf { it.bottom } - rows.minOf { it.top }
  }

  private fun assertReaderMessageVisible(
    role: String,
    text: String,
  ) {
    val bounds =
      composeRule
        .onNode(hasContentDescription(nativeString(role)) and hasText(text))
        .assertIsDisplayed()
        .getUnclippedBoundsInRoot()
    val viewport = readerTranscript().getUnclippedBoundsInRoot()
    val root = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
    assertTrue(
      "The entire $role row stays inside the visible transcript: $bounds within $viewport / $root",
      bounds.right > bounds.left && bounds.bottom > bounds.top &&
        bounds.left >= maxOf(viewport.left, root.left) && bounds.right <= minOf(viewport.right, root.right) &&
        bounds.top >= maxOf(viewport.top, root.top) && bounds.bottom <= minOf(viewport.bottom, root.bottom),
    )
  }

  private fun showChat(
    viewportWidth: Dp = 360.dp,
    viewportHeight: () -> Dp = { 400.dp },
    fontScale: () -> Float = { 1f },
    talkActive: Boolean = false,
    expectedMessageCount: Int? = null,
    onOpenSidebar: () -> Unit = {},
  ): MainViewModel {
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    viewModelStore.put("chat", viewModel)
    viewModel.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    composeRule.setContent {
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale())) {
        ClawDesignTheme {
          renderedCanvasColor = ClawTheme.colors.canvas
          // The default viewport models a portrait phone after its IME opens.
          Box(
            Modifier
              .size(width = viewportWidth, height = viewportHeight())
              .background(ClawTheme.colors.canvas)
              .clipToBounds()
              .testTag("chat-viewport"),
          ) {
            ChatScreen(
              viewModel = viewModel,
              talkActive = talkActive,
              showSidebarButton = true,
              onOpenSidebar = onOpenSidebar,
              onToggleTalk = {},
              onOpenDashboard = {},
              onOpenGatewaySettings = {},
            )
          }
        }
      }
    }
    composeRule.waitUntil {
      // IO can publish after setContent idles; drain Android Main before reading ViewModel bridges.
      composeRule.runOnIdle {
        viewModel.chatCommands.value.size == 6 && !viewModel.chatHistoryLoading.value &&
          (if (expectedMessageCount == null) viewModel.chatMessages.value.size >= 24 else viewModel.chatMessages.value.size == expectedMessageCount)
      }
    }
    return viewModel
  }

  private fun assertComposerControlsVisible(
    talkActive: Boolean = false,
    thinkingLabel: String = nativeString("Low"),
    modelLabel: String = "GPT-5.2",
    primaryAction: String = "Stop",
  ) {
    val viewport = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
    val editorNode = composeRule.onNode(hasSetTextAction()).assertIsDisplayed()
    val editor = editorNode.getUnclippedBoundsInRoot()
    assertTrue("Editor must retain a visible line: $editor inside $viewport", editor.bottom > editor.top)
    val controls =
      (listOf(primaryAction) + if (talkActive) listOf("End Talk") else emptyList()).map { label ->
        composeRule.onNodeWithContentDescription(nativeString(label)).assertIsDisplayed().assertHasClickAction()
      } +
        listOf(
          composeRule.onNodeWithContentDescription(nativeString("Add attachment")).assertIsDisplayed().assertHasClickAction(),
          composeRule
            .onNodeWithContentDescription(nativeString("Model"))
            .assertIsDisplayed()
            .assertHasClickAction()
            .assertTextEquals(modelLabel),
          composeRule
            .onNodeWithContentDescription(nativeString("Thinking"))
            .assertIsDisplayed()
            .assertHasClickAction()
            .assert(
              SemanticsMatcher.expectValue(
                SemanticsProperties.StateDescription,
                nativeString(
                  "\$selectedLabel, \$fastModeLabel: \$fastModeState",
                  thinkingLabel,
                  nativeString("Fast mode"),
                  nativeString("Off"),
                ),
              ),
            ),
        )
    val controlBounds = controls.map { it.getUnclippedBoundsInRoot() }.toMutableList()
    val primary = controlBounds.first()
    val dictation =
      composeRule.onNode(
        SemanticsMatcher("dictation control") { node ->
          node.config.getOrNull(SemanticsActions.OnClick)?.label == nativeString("Dictation")
        },
      )
    val voice =
      if (talkActive) {
        dictation.assertDoesNotExist()
        controlBounds[1]
      } else {
        dictation.assertIsDisplayed().getUnclippedBoundsInRoot().also { controlBounds += it }
      }
    assertTrue("Voice stays before the primary action", voice.right <= primary.left)
    controlBounds.drop(1).forEach { bounds ->
      assertEquals(
        "Every control, including voice, must share the action row: $bounds versus $primary",
        (primary.top.value + primary.bottom.value) / 2,
        (bounds.top.value + bounds.bottom.value) / 2,
        1f,
      )
    }
    controlBounds.sortedBy { it.left }.zipWithNext().forEach { (left, right) ->
      assertTrue("Adjacent touch targets must not overlap: $left and $right", left.right <= right.left)
    }
    controlBounds.forEach { bounds ->
      val retainsTouchTarget =
        with(composeRule.density) {
          (bounds.right - bounds.left).roundToPx() >= 48.dp.roundToPx() &&
            (bounds.bottom - bounds.top).roundToPx() >= 48.dp.roundToPx()
        }
      assertTrue("Composer controls must retain their touch targets: $bounds inside $viewport", retainsTouchTarget)
    }
    for (bounds in listOf(editor) + controlBounds) {
      assertTrue("Composer control must stay below the viewport top", bounds.top >= viewport.top)
      assertTrue("Composer control must stay above the viewport bottom", bounds.bottom <= viewport.bottom)
      assertTrue("Composer control must stay inside the viewport's left edge", bounds.left >= viewport.left)
      assertTrue("Composer control must stay inside the viewport's right edge", bounds.right <= viewport.right)
    }
  }

  private fun setApplicationRuntime(value: NodeRuntime?) {
    NodeApp::class.java
      .getDeclaredField("runtimeInstance")
      .apply { isAccessible = true }
      .set(app, value)
  }
}
