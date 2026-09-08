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
import ai.openclaw.app.ui.FoldAwareContent
import ai.openclaw.app.ui.TabletopPaneBounds
import ai.openclaw.app.ui.UnifiedChatShellScreen
import ai.openclaw.app.ui.WindowDisplayFeatureSnapshot
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.testFold
import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Rect
import android.os.SystemClock
import android.provider.Settings
import android.speech.SpeechRecognizer
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inspector.WindowInspector
import androidx.activity.ComponentDialog
import androidx.activity.compose.LocalActivity
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
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
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.StateRestorationTester
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
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.graphics.Insets
import androidx.core.os.LocaleListCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.window.layout.DisplayFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowInfoTrackerDecorator
import androidx.window.layout.WindowLayoutInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
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
import org.junit.Assert.assertNotSame
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
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowSpeechRecognizer
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.ceil
import kotlin.math.roundToInt

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
  private lateinit var chatActivity: Activity
  private lateinit var insetView: View
  private var observedBottomInsets: Pair<Int, Int>? = null
  private lateinit var renderedDensity: Density
  private val sheetFeatures = SheetFeatures()

  @Before
  @SuppressLint("RestrictedApi")
  fun setUp() {
    WindowInfoTracker.overrideDecorator(
      object : WindowInfoTrackerDecorator {
        override fun decorate(tracker: WindowInfoTracker): WindowInfoTracker =
          object : WindowInfoTracker by tracker {
            override fun windowLayoutInfo(activity: Activity): Flow<WindowLayoutInfo> = sheetFeatures
          }
      },
    )
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
  @SuppressLint("RestrictedApi")
  fun tearDown() {
    viewModelStore.clear()
    setApplicationRuntime(originalRuntime)
    closeNodeRuntimeTestFixture(runtime)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
    NativeStringResources.install(app)
    WindowInfoTracker.reset()
  }

  @Test
  @Config(qualifiers = "w1000dp-h1000dp-hdpi")
  fun tabletopEnforcesPixelFloorsAndUsesTranslatedPostInsetBoundsOnce() {
    val width = mutableStateOf(320.dp)
    val height = mutableStateOf(720.dp)
    val scale = mutableStateOf(1f)
    val offset = mutableStateOf(IntOffset(40, 60))
    val direction = mutableStateOf(LayoutDirection.Ltr)
    val folds = mutableStateOf(emptyList<DisplayFeature>())
    showChat(
      viewportHeight = { height.value },
      fontScale = { scale.value },
      useChatShell = true,
      currentViewportWidth = { width.value },
      displayFeatures = { folds.value },
      viewportOffset = { offset.value },
      layoutDirection = { direction.value },
    )
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performClick().performTextReplacement("Pixel floor draft")
    val editorId = editor.fetchSemanticsNode().id

    fun insets(
      top: Int,
      visibleBottom: Int,
    ) {
      composeRule.runOnIdle {
        ViewCompat.dispatchApplyWindowInsets(
          insetView,
          WindowInsetsCompat
            .Builder()
            .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, top, 0, 0))
            .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, insetView.height - visibleBottom))
            .setVisible(WindowInsetsCompat.Type.ime(), visibleBottom < insetView.height)
            .build(),
        )
      }
      composeRule.waitForIdle()
    }
    insets(0, insetView.height)
    val initialViewport = chatWindowBounds(composeRule.onNodeWithTag("chat-viewport"))
    assertTrue("The translated fixture must fit inside a stationary full window: $initialViewport, ${insetView.width}x${insetView.height}", initialViewport.right <= insetView.width && initialViewport.bottom <= insetView.height)
    for (font in listOf(1f, 2f)) {
      composeRule.runOnIdle {
        scale.value = font
        folds.value = emptyList()
        height.value = 720.dp
      }
      composeRule.waitForIdle()
      val density = renderedDensity
      val touch = with(density) { 48.dp.roundToPx() }
      val pad = with(density) { 10.dp.roundToPx() }
      val gap = with(density) { 8.dp.roundToPx() }
      val fullLayouts = mutableListOf<TextLayoutResult>()
      editor.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(fullLayouts)) }
      val fullLineHeight = ceil(fullLayouts.single().getLineBottom(0) - fullLayouts.single().getLineTop(0)).toInt()
      val textInput = fullLayouts.single().layoutInput
      val measurer = TextMeasurer(textInput.fontFamilyResolver, density, textInput.layoutDirection)
      // Use the real font metrics, including nonlinear scaling and the font's minimum line box.
      val projectLine = measurer.measure("Project", style = textInput.style.copy(fontSize = 11.sp, lineHeight = 13.sp, fontWeight = FontWeight.Normal)).size.height
      val titleLine = measurer.measure("Chat", style = textInput.style.copy(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)).size.height
      val readerLine = measurer.measure("Reader", style = textInput.style.copy(fontSize = 14.sp, lineHeight = 19.sp)).size.height
      val readerFloor = maxOf(touch, readerLine)
      val upperFloor = maxOf(touch, projectLine + titleLine) + readerFloor + touch + pad * 2 + gap * 2
      val lowerFloor =
        maxOf(touch, with(density) { maxOf(fullLineHeight, ceil(22.sp.toPx()).toInt()) + 8.dp.roundToPx() + 4.dp.roundToPx() }) +
          touch + with(density) { 4.dp.roundToPx() * 2 } + pad * 2
      val widthFloor = with(density) { 320.dp.roundToPx() }
      for ((upper, lower, paneWidth) in listOf(
        Triple(upperFloor, lowerFloor, widthFloor),
        Triple(upperFloor - 1, lowerFloor, widthFloor),
        Triple(upperFloor, lowerFloor - 1, widthFloor),
        Triple(upperFloor, lowerFloor, widthFloor - 1),
        Triple(upperFloor, lowerFloor, widthFloor),
      )) {
        val top = offset.value.y + with(density) { 8.dp.roundToPx() }
        val hinge = Rect(offset.value.x, top + upper, offset.value.x + paneWidth, top + upper + 20)
        composeRule.runOnIdle {
          width.value = with(density) { paneWidth.toDp() }
          height.value = with(density) { (8.dp.roundToPx() + upper + 20 + lower).toDp() }
          folds.value = listOf(testFold(hinge))
        }
        editor.assertIsFocused().assertTextEquals("Pixel floor draft")
        assertEquals(editorId, editor.fetchSemanticsNode().id)
        val bounds = chatWindowBounds(editor)
        val fits = upper >= upperFloor && lower >= lowerFloor && paneWidth >= widthFloor
        if (fits) {
          assertTrue("Equality must allocate the lower plane: font=$font editor=$bounds hinge=$hinge floors=$upperFloor,$lowerFloor", bounds.top >= hinge.bottom)
          assertTrue(chatWindowBounds(readerHeaderControl("Show Sidebar")).bottom <= hinge.top)
          assertTrue("Reserve a real reader band", chatWindowBounds(readerTranscript()).height >= readerFloor)
          assertComposerControlsVisible(primaryAction = "Send")
          val layouts = mutableListOf<TextLayoutResult>()
          editor.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
          val line = layouts.single()
          assertTrue(
            "The complete real text line fits at the exact floor: font=$font density=$density editor=$bounds textSize=${line.size} line=${line.getLineTop(0)}..${line.getLineBottom(0)} lower=$lowerFloor touch=$touch",
            bounds.height >= ceil(line.getLineBottom(0) - line.getLineTop(0)).toInt(),
          )
          val caret = line.getCursorRect(editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange].end)
          assertTrue("The complete caret fits at equality: $caret in $bounds", caret.top >= 0 && caret.bottom <= bounds.height && caret.left >= 0 && caret.right <= bounds.width)
          val send = chatWindowBounds(composeRule.onNodeWithContentDescription(nativeString("Send")))
          assertTrue("The full target fits at equality", send.height >= touch && send.top >= hinge.bottom && send.bottom <= offset.value.y + with(density) { height.value.roundToPx() })
        } else {
          assertTrue("One physical pixel below a floor must use the larger safe upper pane", bounds.bottom <= hinge.top)
        }
      }
    }

    // Independent window-coordinate receipt: the content host moves, while bars/IME stay fixed.
    composeRule.runOnIdle {
      scale.value = 1f
      width.value = with(renderedDensity) { 900.toDp() }
      height.value = with(renderedDensity) { 800.toDp() }
      folds.value = listOf(testFold(Rect(0, 430, insetView.width, 450)))
    }
    insets(100, 700)
    var bounds = chatWindowBounds(editor)
    assertTrue("Do not subtract the IME twice: $bounds", bounds.top >= 450 && bounds.bottom <= 700)
    for (rtl in listOf(LayoutDirection.Rtl, LayoutDirection.Ltr)) {
      composeRule.runOnIdle {
        offset.value = IntOffset(60, 80)
        direction.value = rtl
      }
      bounds = chatWindowBounds(editor)
      assertTrue("Ancestor movement must use this frame's physical origin: $bounds", bounds.left >= 60 && bounds.right <= 960 && bounds.top >= 450 && bounds.bottom <= 700)
      editor.assertIsFocused()
      assertEquals(editorId, editor.fetchSemanticsNode().id)
    }
    insets(100, 470)
    assertTrue("A keyboard leaving no useful lower plane uses the safe upper pane", chatWindowBounds(editor).bottom <= 430)
    editor.assertIsFocused().assertTextEquals("Pixel floor draft")
    insets(100, 700)
    assertTrue(chatWindowBounds(editor).top >= 450)
    composeRule.runOnIdle {
      controller.handleGatewayEvent(
        "chat",
        buildJsonObject {
          put("sessionKey", JsonPrimitive(controller.sessionKey.value))
          put("runId", JsonPrimitive("android-screenshot-active-run"))
          put("state", JsonPrimitive("error"))
          put("errorMessage", JsonPrimitive(List(40) { "Recoverable tabletop status line ${it + 1}" }.joinToString("\n")))
        }.toString(),
      )
    }
    composeRule.onAllNodesWithText(nativeString("Chat needs attention")).assertCountEquals(1)
    val status = composeRule.onNode(hasScrollAction() and hasAnyDescendant(hasText(nativeString("Chat needs attention"))))
    val statusBounds = chatWindowBounds(status)
    assertTrue("Long status must stay in its bounded upper remainder", statusBounds.bottom <= 430 && statusBounds.height > 0)
    assertTrue("Status cannot consume the reader floor", chatWindowBounds(readerTranscript()).height >= with(renderedDensity) { 48.dp.roundToPx() })
    status.performTouchInput { swipeUp() }
    assertTrue(chatWindowBounds(editor).top >= 450)
  }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun tabletopKeepsReadingCompositionAndDetailsThroughImeFallback() {
    val folds = mutableStateOf(emptyList<DisplayFeature>())
    withReaderHistory(
      assistantCount = 24,
      viewportWidth = 720.dp,
      viewportHeight = { 720.dp },
      useChatShell = true,
      displayFeatures = { folds.value },
    ) { model ->
      val editor = composeRule.onNode(hasSetTextAction())
      editor.performClick().performTextReplacement("original tail")
      editor.performSemanticsAction(SemanticsActions.SetSelection) { assertTrue(it(0, 8, false)) }
      val editorId = editor.fetchSemanticsNode().id
      val connection = composeRule.runOnIdle { checkNotNull(insetView.onCreateInputConnection(EditorInfo())) }
      composeRule.runOnIdle { connection.setComposingText("fold", 1) }
      editor.assertTextEquals("fold tail")
      val transcript = readerTranscript()
      val readerId = transcript.fetchSemanticsNode().id
      transcript.performTouchInput { swipeDown() }
      assertTrue(transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f)
      composeRule.runOnIdle { folds.value = listOf(testFold(Rect(0, 540, insetView.width, 560))) }
      editor.assertIsFocused()
      composeRule.runOnIdle { connection.setComposingText("kept", 1) }
      editor.assertTextEquals("kept tail")
      assertEquals("The live composing range must survive placement, not append a new word", TextRange(4), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
      composeRule.runOnIdle { connection.finishComposingText() }
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      assertEquals(readerId, transcript.fetchSemanticsNode().id)
      assertTrue("Posture must not jump the reading viewport to latest", transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f)
      readerHeaderControl("Jump to latest").assertIsDisplayed()
      assertTrue(chatWindowBounds(readerHeaderControl("Show Sidebar")).bottom <= 540)
      composeRule.onNodeWithContentDescription(nativeString("Details")).performClick()
      val details = composeRule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, nativeString("Details")))
      assertTrue(chatWindowBounds(details).top >= 560)
      composeRule.runOnIdle { folds.value = listOf(testFold(Rect(0, 300, insetView.width, 320))) }
      details.assertIsDisplayed()
      composeRule.onAllNodesWithContentDescription(nativeString("Jump to latest")).assertCountEquals(1)
      val owner = model.captureChatShareOwner()
      composeRule.runOnIdle {
        connection.commitText("hidden", 1)
        dispatchHardwareKey(insetView, KeyEvent.KEYCODE_ENTER)
      }
      composeRule.runOnIdle {
        assertEquals("Details keeps the same hidden-input guard after relocation", "kept tail", model.chatComposerState.textDrafts[owner])
        assertFalse(owner in model.chatComposerState.sendStates.value)
      }
      composeRule.runOnIdle { folds.value = listOf(testFold(Rect(0, 540, insetView.width, 560))) }
      applyChatImeInsets()
      assertTrue("Open Details must move into the truthful safe fallback", chatWindowBounds(details).bottom <= 540)
      composeRule.onNodeWithContentDescription(nativeString("Close")).performClick()
      editor.assertIsEnabled().assertTextEquals("kept tail")
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      composeRule.runOnIdle {
        ViewCompat.dispatchApplyWindowInsets(insetView, WindowInsetsCompat.Builder().build())
        folds.value = emptyList()
      }
      editor.performClick()
      composeRule.runOnIdle { dispatchHardwareKey(insetView, KeyEvent.KEYCODE_X) }
      editor.assertTextEquals("kept tailx")
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      assertEquals(readerId, transcript.fetchSemanticsNode().id)
      readerHeaderControl("Jump to latest").assertIsDisplayed().performClick()
      assertEquals(0f, transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(), 0f)
      assertReaderMessageVisible("OpenClaw", "Reader answer 24")
    }
  }

  private fun chatWindowBounds(node: SemanticsNodeInteraction): IntRect {
    val bounds = node.getUnclippedBoundsInRoot()
    val origin = IntArray(2).also(insetView::getLocationInWindow)
    return with(composeRule.density) {
      IntRect(
        bounds.left.roundToPx() + origin[0],
        bounds.top.roundToPx() + origin[1],
        bounds.right.roundToPx() + origin[0],
        bounds.bottom.roundToPx() + origin[1],
      )
    }
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
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun compactDetailsJumpsToRefreshedLatestAndRetiresTheAction() {
    val height = mutableStateOf(720.dp)
    val additionalMessages = MutableStateFlow<List<String>>(emptyList())
    withReaderHistory(
      assistantCount = 24,
      viewportWidth = 720.dp,
      viewportHeight = { height.value },
      useChatShell = true,
      additionalAssistantMessages = { additionalMessages.value },
    ) { model ->
      val editor = composeRule.onNode(hasSetTextAction())
      editor.performTextReplacement("Reader draft")
      val editorId = editor.fetchSemanticsNode().id
      val transcript = readerTranscript()
      val readerId = transcript.fetchSemanticsNode().id
      transcript.performTouchInput { swipeDown() }
      composeRule.waitForIdle()
      assertTrue(
        "Manual reading must move away from latest before opening Details",
        transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f,
      )
      assertReaderHeaderControl("Jump to latest")
      applyChatImeInsets()
      composeRule.runOnIdle { height.value = 440.dp }
      composeRule.onNodeWithContentDescription(nativeString("Details")).assertIsDisplayed().performClick()
      readerHeaderControl("Jump to latest").assertIsDisplayed().assertIsEnabled()

      val detailsPane = SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, nativeString("Details"))
      val compactViewport = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
      composeRule.runOnIdle { height.value = 720.dp }
      composeRule.waitForIdle()
      val grownViewport = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
      assertTrue(
        "The same viewport must grow while Details remains open",
        grownViewport.bottom - grownViewport.top > compactViewport.bottom - compactViewport.top,
      )
      composeRule.onNode(detailsPane).assertIsDisplayed()
      for (label in listOf("Show Sidebar", "Chat actions", "Jump to latest")) {
        val control = hasContentDescription(nativeString(label)) and hasClickAction() and hasAnyAncestor(hasTestTag("chat-viewport"))
        composeRule.onAllNodes(control).assertCountEquals(1)
        composeRule
          .onNode(control)
          .assertIsDisplayed()
          .assertIsEnabled()
          .assert(hasAnyAncestor(detailsPane))
      }
      assertEquals("Growth must retain the same reader", readerId, transcript.fetchSemanticsNode().id)

      val newest = "Reader newest after refresh"
      composeRule.runOnIdle { additionalMessages.value = listOf(newest) }
      readerHeaderControl("Chat actions").performClick()
      composeRule.onNode(hasText(nativeString("Refresh chat")) and hasClickAction()).performClick()
      composeRule.waitUntil {
        composeRule.runOnIdle {
          !model.chatHistoryLoading.value &&
            model.chatMessages.value
              .last()
              .content
              .any { it.text == newest }
        }
      }
      composeRule.onNode(detailsPane).assertIsDisplayed()
      composeRule.onNodeWithContentDescription(nativeString("Close")).assertIsDisplayed()
      readerHeaderControl("Jump to latest").assertIsDisplayed().performClick()
      composeRule.waitForIdle()

      composeRule.onNodeWithText(nativeString("Details")).assertDoesNotExist()
      editor.assertIsEnabled().assertTextEquals("Reader draft")
      assertEquals("Jump must retain the same editor", editorId, editor.fetchSemanticsNode().id)
      assertEquals("Refresh and Jump must retain the same reader", readerId, transcript.fetchSemanticsNode().id)
      for (label in listOf("Show Sidebar", "Chat actions")) {
        val control = hasContentDescription(nativeString(label)) and hasClickAction() and hasAnyAncestor(hasTestTag("chat-viewport"))
        composeRule.onAllNodes(control).assertCountEquals(1)
        assertReaderHeaderControl(label)
      }
      assertReaderMessageVisible("OpenClaw", newest)
      assertEquals(
        "Jump reaches the refreshed latest edge",
        0f,
        transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(),
        0f,
      )
      composeRule.runOnIdle { height.value = 440.dp }
      composeRule.onNodeWithContentDescription(nativeString("Details")).performClick()
      readerHeaderControl("Jump to latest").assertDoesNotExist()
      composeRule.onNodeWithContentDescription(nativeString("Close")).performClick()
    }
  }

  @Test
  fun expandingTheOnlyLoadedUserPromptOffersJumpWithoutPriorScrolling() {
    val head = "The original user prompt starts here."
    val tail = "The original user prompt ends here."
    val prompt = (listOf(head) + List(40) { "Original user paragraph ${it + 1}." } + tail).joinToString("\n\n")
    withReaderHistory(assistantCount = 0, userText = prompt) { model ->
      val transcript = readerTranscript()
      val viewport = transcript.getUnclippedBoundsInRoot()
      val range = transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      assertEquals("The unchanged loaded prompt starts at the live edge", 0f, range.value(), 0f)
      readerHeaderControl("Jump to latest").assertDoesNotExist()
      val viewAll = composeRule.onNode(hasText(nativeString("View all")) and hasClickAction())
      val button = viewAll.assertIsDisplayed().assertIsEnabled().getUnclippedBoundsInRoot()
      assertTrue(
        "View all must already be wholly visible without any preparatory scroll",
        button.left >= viewport.left && button.right <= viewport.right && button.top >= viewport.top && button.bottom <= viewport.bottom,
      )

      // The disclosure is the first reader action; a preceding drag would hide this premise.
      viewAll.performClick()
      composeRule.waitForIdle()
      assertEquals(1, model.chatMessages.value.size)
      assertEquals(
        prompt,
        model.chatMessages.value
          .single()
          .content
          .mapNotNull { it.text }
          .joinToString("\n"),
      )
      assertEquals(0, model.pendingRunCount.value)
      assertTrue(model.chatStreamingAssistantText.value == null)
      val beginning = readerMarkerBounds(head, speaker = "You")
      val ending = readerMarkerBounds(tail, speaker = "You")
      assertTrue(
        "Actual disclosure must reveal the first prompt glyphs",
        beginning.left >= viewport.left && beginning.right <= viewport.right && beginning.top >= viewport.top && beginning.bottom <= viewport.bottom,
      )
      assertTrue("The expanded prompt's ending must now be below the viewport", ending.top > viewport.bottom)
      assertTrue(
        "BringIntoView must actually move the transcript away from latest",
        transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f,
      )
      assertReaderHeaderControl("Jump to latest")
      readerHeaderControl("Jump to latest").performClick()
      composeRule.waitForIdle()
      val restoredEnding = readerMarkerBounds(tail, speaker = "You")
      assertTrue(
        "The actual header Jump callback must reveal the prompt's ending",
        restoredEnding.left >= viewport.left && restoredEnding.right <= viewport.right && restoredEnding.top >= viewport.top && restoredEnding.bottom <= viewport.bottom,
      )
      assertEquals(0f, transcript.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(), 0f)
      readerHeaderControl("Jump to latest").assertDoesNotExist()
      assertEquals("Disclosure and Jump preserve the transcript viewport", viewport, transcript.getUnclippedBoundsInRoot())
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
  @Config(qualifiers = "w1000dp-h800dp-mdpi")
  @SuppressLint("RestrictedApi")
  fun chatActionsNativeWindowStaysInTheAnchorFoldPane() {
    val fold = testFold(Rect(490, 0, 510, 800))
    WindowInfoTracker.overrideDecorator(
      object : WindowInfoTrackerDecorator {
        override fun decorate(tracker: WindowInfoTracker): WindowInfoTracker =
          object : WindowInfoTracker by tracker {
            override fun windowLayoutInfo(activity: Activity): Flow<WindowLayoutInfo> =
              flow {
                emit(WindowLayoutInfo(listOf(fold)))
                awaitCancellation()
              }
          }
      },
    )
    try {
      showChat(viewportWidth = 490.dp, viewportHeight = { 640.dp })
      composeRule.runOnIdle {
        val published = runBlocking { WindowInfoTracker.getOrCreate(chatActivity).windowLayoutInfo(chatActivity).first() }
        assertEquals(listOf(fold), published.displayFeatures)
      }
      readerHeaderControl("Chat actions").performClick()
      composeRule.onNode(hasText(nativeString("Refresh chat")) and hasClickAction()).assertIsDisplayed()
      composeRule.runOnIdle {
        val roots = WindowInspector.getGlobalWindowViews().filter { it.isAttachedToWindow }
        val popup =
          roots.single { (it.layoutParams as? WindowManager.LayoutParams)?.type == WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL }
        val activityRoot = chatActivity.window.decorView
        assertTrue("The menu must have a separate native owner", popup !== activityRoot)
        assertTrue("Native popup geometry must be nonzero", popup.width > 0 && popup.height > 0)
        val activityScreen = IntArray(2).also(activityRoot::getLocationOnScreen)
        val activityWindow = IntArray(2).also(activityRoot::getLocationInWindow)
        val popupScreen = IntArray(2).also(popup::getLocationOnScreen)
        val bounds = Rect(popupScreen[0], popupScreen[1], popupScreen[0] + popup.width, popupScreen[1] + popup.height)
        val params = popup.layoutParams as WindowManager.LayoutParams
        val originX = activityScreen[0] - activityWindow[0]
        println("Native menu bounds=$bounds requested=(${params.x},${params.y},${params.width},${params.height}) activityOriginX=$originX fold=${fold.bounds}")
        assertEquals("The fixture must model the native sub-panel's horizontal placement", originX + params.x, bounds.left)
        assertTrue(
          "Actual Chat actions native window $bounds must stay left of the Activity fold at ${originX + fold.bounds.left}",
          bounds.left >= originX && bounds.right <= originX + fold.bounds.left,
        )
      }
    } finally {
      WindowInfoTracker.reset()
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
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun compactDetailsSlashSelectionClosesAndCompletesTheSameEditorWithoutSending() {
    val height = mutableStateOf(720.dp)
    val requests = ConcurrentLinkedQueue<String>()
    withReaderHistory(
      assistantCount = 1,
      viewportWidth = 720.dp,
      viewportHeight = { height.value },
      useChatShell = true,
      onRequest = { requests.add(it) },
    ) { model ->
      val editor = composeRule.onNode(hasSetTextAction())
      editor.performClick().performTextReplacement("/")
      val editorId = editor.fetchSemanticsNode().id
      val owner = model.captureChatShareOwner()
      applyChatImeInsets()
      composeRule.runOnIdle { height.value = 360.dp }
      composeRule.onNodeWithContentDescription(nativeString("Details")).assertIsDisplayed().performClick()
      val suggestion = composeRule.onNodeWithText("/loop").performScrollTo()
      composeRule
        .onNode(
          SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange) and
            hasAnyDescendant(hasContentDescription(nativeString("Chat actions"))) and hasAnyDescendant(hasText("/loop")),
        ).performTouchInput { swipeUp() }
      suggestion.assertIsDisplayed().performClick()

      composeRule.onNodeWithText(nativeString("Details")).assertDoesNotExist()
      editor.assertIsDisplayed().assertIsEnabled().assertTextEquals("/loop ")
      assertEquals("Completion must retain the same editor", editorId, editor.fetchSemanticsNode().id)
      composeRule.onNodeWithContentDescription(nativeString("Send")).assertIsDisplayed().assertIsEnabled()
      composeRule.runOnIdle {
        assertEquals("/loop ", model.chatComposerState.textDrafts[owner])
        assertFalse("Selecting a command must not send it", "chat.send" in requests)
        assertFalse("Selecting a command must not begin send admission", owner in model.chatComposerState.sendStates.value)
      }
    }
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
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun shortImeViewportKeepsCompleteDraftLineAndActionsAcrossResize() {
    val width = mutableStateOf(720.dp)
    val height = mutableStateOf(720.dp)
    val fontScale = mutableStateOf(1f)
    showChat(
      viewportHeight = { height.value },
      fontScale = { fontScale.value },
      useChatShell = true,
      currentViewportWidth = { width.value },
    )
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performClick()
    editor.performTextReplacement("Short viewport draft")
    val editorId = editor.fetchSemanticsNode().id
    applyChatImeInsets()

    for (viewportWidth in listOf(720.dp, 320.dp, 360.dp, 720.dp)) {
      composeRule.runOnIdle { width.value = viewportWidth }
      for (scale in listOf(1f, 1.5f, 2f)) {
        composeRule.runOnIdle { fontScale.value = scale }
        for (viewportHeight in listOf(720.dp, 460.dp, 360.dp, 720.dp)) {
          composeRule.runOnIdle { height.value = viewportHeight }
          composeRule.waitForIdle()
          editor.assertTextEquals("Short viewport draft")
          assertEquals("Resizing must retain the same editor", editorId, editor.fetchSemanticsNode().id)
          assertCompleteComposerLineAboveIme()
        }
      }
    }
  }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun shortImeComposerKeepsMultilineSelectionAndAuxiliaryRecoveryThenSends() {
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(
        stableId = AndroidScreenshotFixture.gatewayId,
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "Test gateway",
      ),
    )
    prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
    val height = mutableStateOf(720.dp)
    val viewModel = showChat(viewportWidth = 720.dp, viewportHeight = { height.value }, fontScale = { 1.5f }, useChatShell = true)
    val owner = viewModel.captureChatShareOwner()
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
      composeRule.runOnIdle {
        viewModel.chatComposerState.addAttachments(
          owner,
          listOf(PendingAttachment(id = "draft-note", fileName = "draft-note.txt", mimeType = "text/plain", base64 = "SGVsbG8=")),
        )
        viewModel.chatComposerState.reportAttachmentOmission(owner, 1)
      }
      val steps = List(20) { "Compact viewport progress step ${it + 1}" }
      showProgressCard(steps)
      val editor = composeRule.onNode(hasSetTextAction())
      val draft = "Editable first line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line"
      editor.performClick()
      editor.performTextReplacement(draft)
      editor.performSemanticsAction(SemanticsActions.SetSelection) { action -> assertTrue(action(4, 4, false)) }
      val editorId = editor.fetchSemanticsNode().id
      applyChatImeInsets()
      composeRule.runOnIdle { height.value = 360.dp }
      composeRule.waitForIdle()
      editor.assertTextEquals(draft)
      assertEquals(TextRange(4), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
      assertCompleteComposerLineAboveIme()
      editor.performTextInput(" inserted")
      val edited = draft.substring(0, 4) + " inserted" + draft.substring(4)
      editor.assertTextEquals(edited)
      assertCompleteComposerLineAboveIme()

      composeRule.onNodeWithContentDescription(nativeString("Details")).assertIsDisplayed().performClick()
      for (viewportHeight in listOf(720.dp, 360.dp)) {
        composeRule.runOnIdle { height.value = viewportHeight }
        composeRule.waitForIdle()
        composeRule.onAllNodesWithContentDescription(nativeString("Remove attachment")).assertCountEquals(1)
        val details =
          composeRule
            .onNode(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, nativeString("Details")))
            .assert(hasAnyAncestor(hasTestTag("chat-viewport")))
            .getUnclippedBoundsInRoot()
        val viewport = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
        assertTrue(
          "Details must stay inside the current pane above the IME: $details within $viewport",
          details.left >= viewport.left && details.right <= viewport.right &&
            details.top >= viewport.top && details.bottom <= viewport.bottom - 220.dp,
        )
        composeRule.onNode(isDialog()).assertDoesNotExist()
        val close = composeRule.onNodeWithContentDescription(nativeString("Close")).assertIsDisplayed().getUnclippedBoundsInRoot()
        assertTrue("Close must remain a complete action target", close.bottom - close.top >= 48.dp && close.right - close.left >= 48.dp)
      }
      composeRule.onNodeWithContentDescription(nativeString("Dismiss shared-image warning")).performScrollTo().performClick()
      composeRule.onNodeWithContentDescription(nativeString("Dismiss shared-image warning")).assertDoesNotExist()
      composeRule.onNodeWithContentDescription(nativeString("Remove attachment")).performScrollTo().performClick()
      composeRule.onNodeWithText("draft-note.txt").assertDoesNotExist()
      composeRule.onNodeWithContentDescription(nativeString("Expand progress card")).performScrollTo().performClick()
      composeRule.onNodeWithTag("chat-progress-card").performScrollTo()
      composeRule.onNodeWithText(steps.last()).performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithContentDescription(nativeString("Close")).assertIsDisplayed().performClick()
      editor.assertTextEquals(edited)
      composeRule.onNodeWithContentDescription(nativeString("Details")).performClick()
      composeRule.runOnIdle {
        checkNotNull(insetView.findViewTreeOnBackPressedDispatcherOwner()).onBackPressedDispatcher.onBackPressed()
      }
      composeRule.onNodeWithText(nativeString("Details")).assertDoesNotExist()
      editor.assertTextEquals(edited)
      assertEquals("Disclosing auxiliary content must not replace the editor", editorId, editor.fetchSemanticsNode().id)

      for (viewportHeight in listOf(720.dp, 360.dp)) {
        composeRule.runOnIdle { height.value = viewportHeight }
        composeRule.waitForIdle()
        editor.assertTextEquals(edited)
        assertEquals(TextRange(13), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        assertCompleteComposerLineAboveIme()
      }
      assertTrue("The edited draft must still have a routable owner", controller.isCurrentComposerOwner(owner))
      composeRule.onNodeWithContentDescription(nativeString("Send")).assertIsEnabled().performClick()
      composeRule.waitUntil {
        composeRule.runOnIdle { sent.size == 1 }
      }
      assertEquals(JsonPrimitive(edited), sent.single()["message"])
      editor.assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    } finally {
      requestField.set(controller, originalRequest)
    }
  }

  private fun applyChatImeInsets() {
    val keyboard = with(composeRule.density) { 220.dp.roundToPx() }
    val navigation = with(composeRule.density) { 24.dp.roundToPx() }
    composeRule.runOnIdle {
      ViewCompat.dispatchApplyWindowInsets(
        insetView,
        WindowInsetsCompat
          .Builder()
          .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, navigation))
          .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, keyboard))
          .setVisible(WindowInsetsCompat.Type.ime(), true)
          .build(),
      )
    }
    composeRule.waitForIdle()
    assertEquals("The real shell must receive the IME insets", keyboard to keyboard, observedBottomInsets)
  }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun detailsBlocksPhysicalTypingUntilClosed() =
    assertDetailsBlocksInput { view ->
      { dispatchHardwareKey(view, KeyEvent.KEYCODE_X) }
    }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun detailsBlocksPreImeEnterUntilClosed() =
    assertDetailsBlocksInput { view ->
      { dispatchHardwareKey(view, KeyEvent.KEYCODE_ENTER) }
    }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun detailsBlocksPendingSoftwareImeCommitUntilClosed() =
    assertDetailsBlocksInput { view ->
      val connection = checkNotNull(view.onCreateInputConnection(EditorInfo()))
      val commit: () -> Unit = { connection.commitText("hidden IME input", 1) }
      commit
    }

  private fun dispatchHardwareKey(
    view: View,
    keyCode: Int,
  ) {
    for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
      val event = KeyEvent(action, keyCode)
      if (!view.dispatchKeyEventPreIme(event)) view.dispatchKeyEvent(event)
    }
  }

  private fun assertDetailsBlocksInput(prepareInput: (View) -> () -> Unit) {
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(stableId = AndroidScreenshotFixture.gatewayId, kind = GatewayRegistryEntryKind.MANUAL, name = "Test gateway"),
    )
    prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
    val height = mutableStateOf(720.dp)
    val viewModel = showChat(viewportWidth = 720.dp, viewportHeight = { height.value }, useChatShell = true)
    val owner = viewModel.captureChatShareOwner()
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
      val editor = composeRule.onNode(hasSetTextAction())
      val draft = "Visible draft"
      editor.performClick().performTextReplacement(draft)
      assertEquals(TextRange(draft.length), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
      val editorId = editor.fetchSemanticsNode().id
      applyChatImeInsets()
      for (viewportHeight in listOf(360.dp, 720.dp, 360.dp)) {
        composeRule.runOnIdle { height.value = viewportHeight }
        editor.assertIsFocused().assertTextEquals(draft)
      }
      val attemptInput = composeRule.runOnIdle { prepareInput(insetView) }
      composeRule.onNodeWithContentDescription(nativeString("Details")).performClick()
      composeRule.runOnIdle { attemptInput() }
      composeRule.waitForIdle()
      composeRule.runOnIdle {
        assertEquals("Details must not permit hidden draft edits", draft, viewModel.chatComposerState.textDrafts[owner])
        assertTrue("Details must not send the hidden draft", sent.isEmpty())
        assertFalse("Details must not begin send admission", owner in viewModel.chatComposerState.sendStates.value)
      }
      composeRule.onNodeWithContentDescription(nativeString("Close")).assertIsDisplayed().performClick()
      editor.assertTextEquals(draft)
      assertEquals("Details must retain the same editor", editorId, editor.fetchSemanticsNode().id)
      assertEquals(TextRange(draft.length), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
      editor.performClick()
      composeRule.runOnIdle { dispatchHardwareKey(insetView, KeyEvent.KEYCODE_X) }
      editor.assertTextEquals(draft + "x")
      composeRule.runOnIdle {
        checkNotNull(insetView.onCreateInputConnection(EditorInfo())).commitText(" visible IME input", 1)
      }
      val edited = draft + "x visible IME input"
      editor.assertTextEquals(edited)
      composeRule.runOnIdle { dispatchHardwareKey(insetView, KeyEvent.KEYCODE_ENTER) }
      composeRule.waitUntil { composeRule.runOnIdle { sent.isNotEmpty() } }
      assertEquals(listOf(JsonPrimitive(edited)), sent.map { it["message"] })
      editor.assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    } finally {
      requestField.set(controller, originalRequest)
    }
  }

  private fun assertCompleteComposerLineAboveIme() {
    val editor = composeRule.onNode(hasSetTextAction())
    val layouts = mutableListOf<TextLayoutResult>()
    editor.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
    val layout = layouts.single()
    val lineHeight = with(composeRule.density) { (layout.getLineBottom(0) - layout.getLineTop(0)).toDp() }
    val bounds = editor.getUnclippedBoundsInRoot()
    assertTrue(
      "A complete editable line must fit after IME/resize: $bounds, line=$lineHeight",
      bounds.bottom - bounds.top >= lineHeight,
    )
    assertComposerControlsVisible(primaryAction = "Send")
    val visibleBottom = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot().bottom - 220.dp
    assertTrue("The complete line must remain above the real IME", bounds.bottom <= visibleBottom)
    val send = composeRule.onNodeWithContentDescription(nativeString("Send")).getUnclippedBoundsInRoot()
    assertTrue("The complete action target must remain above the real IME", send.bottom <= visibleBottom)
    val node = editor.fetchSemanticsNode()
    val selection = node.config[SemanticsProperties.TextSelectionRange]
    val caret = layout.getCursorRect(selection.end).translate(node.positionInRoot)
    val caretTop = with(composeRule.density) { caret.top.toDp() }
    val caretBottom = with(composeRule.density) { caret.bottom.toDp() }
    assertTrue("The whole caret must be visible inside the editor: $caret within $bounds", caretTop >= bounds.top && caretBottom <= bounds.bottom)
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
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).performClick()
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
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun modelOpeningRevokesHeldTouchBeforeCoalescedRecoveryAndPreservesDraft() = assertTerminalModelInput(keyboard = false)

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun modelOpeningRevokesHeldEnterBeforeCoalescedRecoveryAndPreservesDraft() = assertTerminalModelInput(keyboard = true)

  private fun assertTerminalModelInput(keyboard: Boolean) {
    showChat(viewportWidth = 720.dp, viewportHeight = { 720.dp })
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performTextReplacement("retained selector draft")
    editor.performSemanticsAction(SemanticsActions.SetSelection) { assertTrue(it(4, 9, false)) }
    val editorId = editor.fetchSemanticsNode().id
    val before = prefs.modelFavorites.value
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    val pin = composeRule.onAllNodesWithContentDescription(nativeString("Pin model"))[0].performScrollTo()
    val bounds = pin.getUnclippedBoundsInRoot()
    val x = (bounds.left.value + bounds.right.value) / 2f
    val y = (bounds.top.value + bounds.bottom.value) / 2f
    val old = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
    if (keyboard) {
      composeRule.runOnIdle { assertTrue(sheetComposeView(old).requestFocusFromTouch()) }
      pin.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
      pin.assertIsFocused()
    }
    val time = SystemClock.uptimeMillis()
    composeRule.mainClock.autoAdvance = false
    composeRule.runOnUiThread {
      if (keyboard) {
        assertTrue(checkNotNull(old.window).decorView.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)))
      } else {
        assertTrue("The real row must consume the original DOWN", sheetTouch(old, MotionEvent.ACTION_DOWN, x, y, time, time))
      }
      val deliveries = sheetFeatures.deliveries
      runBlocking {
        sheetFeatures.publish(listOf(testFold(Rect(0, 0, 800, 800))))
        sheetFeatures.publish(emptyList())
      }
      assertEquals("Both direct producer deliveries precede UP", deliveries + 2, sheetFeatures.deliveries)
      assertTrue("Original UP must reach the still-attached A window", old.isShowing)
      if (keyboard) {
        checkNotNull(old.window).decorView.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
      } else {
        sheetTouch(old, MotionEvent.ACTION_UP, x, y, time, time + 40)
      }
      assertEquals("A's held touch cannot borrow recovered geometry", before, prefs.modelFavorites.value)
    }
    composeRule.mainClock.autoAdvance = true
    composeRule.waitForIdle()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    editor.assertTextEquals("retained selector draft")
    assertEquals(editorId, editor.fetchSemanticsNode().id)
    assertEquals(TextRange(4, 9), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])

    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.waitForIdle()
    val fresh = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
    assertNotSame(old.window, fresh.window)
    val freshPin = composeRule.onAllNodesWithContentDescription(nativeString("Pin model"))[0].performScrollTo()
    freshPin.performTouchInput {
      down(center)
      up()
    }
    composeRule.waitForIdle()
    val after = prefs.modelFavorites.value.toSet()
    assertEquals("A fresh complete touch still toggles exactly one favorite", 1, ((before.toSet() - after) + (after - before.toSet())).size)
  }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun modelOpeningBCannotBeChangedBySavedACommandsOrQueuedRemoval() {
    showChat(viewportWidth = 720.dp, viewportHeight = { 720.dp })
    updatePermissions(null, pending = false)
    val open =
      checkNotNull(
        composeRule
          .onNodeWithContentDescription(nativeString("Model"))
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.waitForIdle()
    val old = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
    val details =
      checkNotNull(
        composeRule
          .onNodeWithText(nativeString("Details"))
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    val permissions =
      checkNotNull(
        composeRule
          .onNode(hasText(nativeString("Permissions")) and hasClickAction())
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    val select =
      checkNotNull(
        composeRule
          .onNodeWithText(nativeString("Default model"))
          .fetchSemanticsNode()
          .config[SemanticsActions.OnClick]
          .action,
      )
    val before = controller.selectedModelRef.value
    composeRule.mainClock.autoAdvance = false
    composeRule.runOnUiThread {
      runBlocking {
        sheetFeatures.publish(listOf(testFold(Rect(0, 0, 800, 800))))
        sheetFeatures.publish(emptyList())
      }
      // Saved callbacks deliberately test origin identity, not pointer routing through an old window.
      assertTrue(open())
      details()
      permissions()
      select()
      old.onBackPressedDispatcher.onBackPressed()
      assertEquals(before, controller.selectedModelRef.value)
    }
    composeRule.mainClock.autoAdvance = true
    composeRule.waitForIdle()
    val fresh = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
    assertNotSame(old.window, fresh.window)
    assertTrue(fresh.isShowing)
    assertFalse(old.isShowing)
    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed()
    composeRule.onNodeWithText(nativeString("Non-cached input excludes cache reads.")).assertDoesNotExist()
    composeRule.onNodeWithText(nativeString("Back")).assertDoesNotExist()
    composeRule.onNode(hasText(nativeString("Permissions")) and hasClickAction()).performClick()
    composeRule.onNodeWithText(nativeString("Back")).assertIsDisplayed().performClick()
    composeRule.runOnIdle { fresh.onBackPressedDispatcher.onBackPressed() }
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  @Test
  fun modelSessionLateRetirementCannotRemoveItsReplacement() {
    val model = showChat()
    val owner =
      ChatModelPickerSessionOwner(chatActivity, chatActivity.window.decorView, (chatActivity as LifecycleOwner).lifecycle) {
        model.isCurrentChatComposerOwner(it)
      }
    lateinit var old: ChatModelPickerSession
    lateinit var fresh: ChatModelPickerSession
    composeRule.runOnUiThread {
      owner.publishFeatures(WindowDisplayFeatureSnapshot(ready = true))
      owner.open(model.captureChatShareOwner(), controller.sessionKey.value)
      old = checkNotNull(owner.visible)
      owner.retire(old)
      owner.open(model.captureChatShareOwner(), controller.sessionKey.value)
      fresh = checkNotNull(owner.visible)
      assertNotSame(old, fresh)
      assertFalse(owner.admit(old))
    }
    composeRule.runOnIdle {
      assertTrue(owner.visible === fresh)
      // Invoke the real production owner, not Material semantics on a detached node.
      owner.retire(old)
      assertFalse(owner.admit(old))
    }
    composeRule.runOnIdle {
      assertTrue(owner.visible === fresh)
      owner.dispose()
    }
  }

  private fun sheetComposeView(dialog: ComponentDialog): View {
    fun find(view: View): View? {
      if (view.parent is DialogWindowProvider) return view
      if (view is ViewGroup) {
        for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
      }
      return null
    }
    return checkNotNull(find(checkNotNull(dialog.window).decorView))
  }

  private fun sheetTouch(
    dialog: ComponentDialog,
    action: Int,
    x: Float,
    y: Float,
    downTime: Long,
    eventTime: Long,
  ): Boolean {
    val event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0)
    try {
      return dialog.dispatchTouchEvent(event)
    } finally {
      event.recycle()
    }
  }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun modelOpeningDoesNotCancelOrRetargetAnAlreadyAdmittedModelEffect() {
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(stableId = AndroidScreenshotFixture.gatewayId, kind = GatewayRegistryEntryKind.MANUAL, name = "Test gateway"),
    )
    prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
    val model = showChat(viewportWidth = 720.dp, viewportHeight = { 720.dp })
    val originalOwner = model.captureChatShareOwner()
    val originalSession = controller.sessionKey.value
    val release = CompletableDeferred<Unit>()
    val admitted = ConcurrentLinkedQueue<Pair<String, JsonObject>>()
    val requestField = ChatController::class.java.getDeclaredField("captureRequestLease").apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    val originalRequest = requestField.get(controller) as (ChatCacheScope?) -> GatewaySession.RequestLease?
    val request: (ChatCacheScope?) -> GatewaySession.RequestLease? = { scope ->
      originalRequest(scope)?.let { lease ->
        GatewaySession.RequestLease(
          endpointStableId = lease.endpointStableId,
          isCurrentImpl = lease::isCurrent,
          commitIfCurrentImpl = lease::commitIfCurrent,
        ) { method, params, timeout, withEnqueue ->
          if (method == "sessions.patch") {
            val payload = Json.parseToJsonElement(checkNotNull(params)).jsonObject
            withEnqueue { admitted.add(lease.endpointStableId to payload) }
            release.await()
            """{"entry":{"key":"$originalSession","modelOverride":null},"resolved":{"modelProvider":"openai","model":"gpt-5.2"}}"""
          } else {
            lease.request(method, params, timeout, withEnqueue)
          }
        }
      }
    }
    try {
      requestField.set(controller, request)
      composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
      composeRule.onNodeWithText(nativeString("Default model")).performClick()
      composeRule.waitUntil { admitted.size == 1 }
      composeRule.onNode(isDialog()).assertDoesNotExist()
      assertFalse(release.isCompleted)
      composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
      composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed()
      composeRule.runOnUiThread {
        runBlocking {
          sheetFeatures.publish(listOf(testFold(Rect(0, 0, 800, 800))))
          sheetFeatures.publish(emptyList())
        }
      }
      composeRule.waitForIdle()
      composeRule.onNode(isDialog()).assertDoesNotExist()
      composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
      composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed()
      val fresh = checkNotNull(ShadowDialog.getLatestDialog())
      composeRule.runOnIdle { release.complete(Unit) }
      composeRule.waitUntil { composeRule.runOnIdle { originalSession !in model.chatPendingSessionSettingsKeys.value } }
      assertTrue("Business completion must not close the new selector", fresh.isShowing)
      assertEquals(1, admitted.size)
      val (gateway, payload) = admitted.single()
      assertEquals(originalOwner.gatewayStableId, gateway)
      assertEquals(JsonPrimitive(originalSession), payload["key"])
      assertEquals(JsonPrimitive(originalOwner.agentId), payload["agentId"])
    } finally {
      release.complete(Unit)
      requestField.set(controller, originalRequest)
    }
  }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun modelBackDuringUnplacedPaneChangeRetiresOpeningAndAllowsReopen() {
    showChat(viewportWidth = 720.dp, viewportHeight = { 720.dp })
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed()
    val old = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
    composeRule.mainClock.autoAdvance = false
    composeRule.runOnUiThread {
      runBlocking { sheetFeatures.publish(listOf(testFold(Rect(390, 0, 410, 800)))) }
      // Both panes are usable, but A's previous placement is no longer authoritative.
      old.onBackPressedDispatcher.onBackPressed()
    }
    composeRule.mainClock.autoAdvance = true
    composeRule.waitForIdle()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.onNodeWithText(nativeString("Default model")).assertIsDisplayed()
    val fresh = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
    assertNotSame(old.window, fresh.window)
    composeRule.runOnIdle { fresh.onBackPressedDispatcher.onBackPressed() }
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  @Test
  @Config(qualifiers = "w800dp-h800dp-mdpi")
  fun modelOpeningWithExistingImeKeepsDraftSelectionAndNativeKeyboardCommands() {
    showChat(viewportWidth = 720.dp, viewportHeight = { 720.dp }, useChatShell = true)
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performClick().performTextReplacement("IME before selector")
    editor.performSemanticsAction(SemanticsActions.SetSelection) { assertTrue(it(3, 6, false)) }
    val editorId = editor.fetchSemanticsNode().id
    applyChatImeInsets()
    composeRule.onNodeWithContentDescription(nativeString("Model")).performClick()
    composeRule.onNodeWithText(nativeString("Default model")).performScrollTo().assertIsDisplayed()
    val dialog = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
    composeRule.runOnIdle {
      ViewCompat.dispatchApplyWindowInsets(
        checkNotNull(dialog.window).decorView,
        WindowInsetsCompat
          .Builder()
          .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 220))
          .setVisible(WindowInsetsCompat.Type.ime(), true)
          .build(),
      )
    }
    val details = composeRule.onNode(hasText(nativeString("Details")) and hasClickAction()).performScrollTo()
    composeRule.runOnIdle { assertTrue(sheetComposeView(dialog).requestFocusFromTouch()) }
    details.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
    details.assertIsFocused()
    composeRule.runOnIdle { dispatchHardwareKey(checkNotNull(dialog.window).decorView, KeyEvent.KEYCODE_SPACE) }
    details.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
    details.performClick()
    details.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
    composeRule.runOnIdle { dialog.onBackPressedDispatcher.onBackPressed() }
    composeRule.onNode(isDialog()).assertDoesNotExist()
    editor.assertTextEquals("IME before selector")
    assertEquals(editorId, editor.fetchSemanticsNode().id)
    assertEquals(TextRange(3, 6), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
  }

  private class SheetFeatures : Flow<WindowLayoutInfo> {
    private val collectors = mutableSetOf<FlowCollector<WindowLayoutInfo>>()
    var deliveries = 0
      private set
    private var latest = WindowLayoutInfo(emptyList())

    override suspend fun collect(collector: FlowCollector<WindowLayoutInfo>) {
      collectors.add(collector)
      try {
        collector.emit(latest)
        awaitCancellation()
      } finally {
        collectors.remove(collector)
      }
    }

    suspend fun publish(features: List<DisplayFeature>) {
      latest = WindowLayoutInfo(features)
      check(collectors.isNotEmpty())
      collectors.toList().forEach { it.emit(latest) }
      deliveries++
    }
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
  fun attachmentMenuDoesNotRestoreWhileDraftAndExplicitReopeningRemainUsable() {
    val restoration = StateRestorationTester(composeRule)
    showChat(viewportHeight = { 640.dp }, restorationTester = restoration)
    composeRule.onNode(hasSetTextAction()).performTextInput("retained menu draft")
    composeRule.onNodeWithContentDescription(nativeString("Add attachment")).performClick()
    composeRule.onNodeWithText(nativeString("Photos")).assertIsDisplayed()
    val old =
      WindowInspector.getGlobalWindowViews().single {
        it.isAttachedToWindow && (it.layoutParams as? WindowManager.LayoutParams)?.type == WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL
      }
    restoration.emulateSavedInstanceStateRestore()
    composeRule.waitForIdle()
    assertFalse(old.isAttachedToWindow)
    composeRule.onNode(isPopup()).assertDoesNotExist()
    composeRule.onNode(hasSetTextAction()).assertTextEquals("retained menu draft")
    composeRule.onNodeWithContentDescription(nativeString("Add attachment")).performClick()
    for (label in listOf("Photos", "Videos", "Files")) {
      composeRule.onNodeWithText(nativeString(label)).assertIsDisplayed()
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
    useChatShell: Boolean = false,
    displayFeatures: (() -> List<DisplayFeature>)? = null,
    additionalAssistantMessages: () -> List<String> = { emptyList() },
    onRequest: (String) -> Unit = {},
    userText: String = "Reader prompt",
    assertions: (MainViewModel) -> Unit,
  ) {
    val sessionKey = "agent:main:reader-history"
    val texts = listOf(userText) + List(assistantCount, assistantText)

    fun history() =
      buildJsonObject {
        put("sessionId", JsonPrimitive("reader-history"))
        put(
          "messages",
          buildJsonArray {
            (texts + additionalAssistantMessages()).forEachIndexed { index, text ->
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
      onRequest(method)
      when (method) {
        "chat.history" -> history()
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
          useChatShell = useChatShell,
          displayFeatures = displayFeatures,
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
      assertions(model)
    } finally {
      requestField.set(controller, originalRequest)
    }
  }

  private fun readerMarkerBounds(
    marker: String,
    speaker: String = "OpenClaw",
  ): DpRect {
    val target =
      composeRule.onNode(
        hasText(marker) and hasAnyAncestor(hasContentDescription(nativeString(speaker))),
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
    useChatShell: Boolean = false,
    currentViewportWidth: () -> Dp = { viewportWidth },
    displayFeatures: (() -> List<DisplayFeature>)? = null,
    viewportOffset: () -> IntOffset = { IntOffset.Zero },
    layoutDirection: () -> LayoutDirection = { LayoutDirection.Ltr },
    restorationTester: StateRestorationTester? = null,
  ): MainViewModel {
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    viewModelStore.put("chat", viewModel)
    viewModel.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    val setContent = restorationTester?.let { it::setContent } ?: composeRule::setContent
    setContent {
      val currentActivity = requireNotNull(LocalActivity.current)
      SideEffect { chatActivity = currentActivity }
      if (useChatShell) {
        val activity = requireNotNull(LocalActivity.current)
        val view = LocalView.current
        val density = LocalDensity.current
        val imeBottom = WindowInsets.ime.getBottom(density)
        val safeBottom = WindowInsets.safeDrawing.getBottom(density)
        LaunchedEffect(activity) { WindowCompat.setDecorFitsSystemWindows(activity.window, false) }
        SideEffect {
          insetView = view
          observedBottomInsets = imeBottom to safeBottom
        }
      }
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale())) {
        CompositionLocalProvider(LocalLayoutDirection provides layoutDirection()) {
          ClawDesignTheme {
            renderedCanvasColor = ClawTheme.colors.canvas
            renderedDensity = LocalDensity.current
            Box(if (displayFeatures != null) Modifier.fillMaxSize() else Modifier, contentAlignment = AbsoluteAlignment.TopLeft) {
              // The default viewport models a portrait phone after its IME opens.
              Box(
                Modifier
                  .absoluteOffset { viewportOffset() }
                  .size(width = currentViewportWidth(), height = viewportHeight())
                  .background(ClawTheme.colors.canvas)
                  .clipToBounds()
                  .testTag("chat-viewport"),
              ) {
                if (useChatShell) {
                  val features = displayFeatures?.invoke().orEmpty()
                  val shell: @Composable (TabletopPaneBounds?) -> Unit = { panes ->
                    UnifiedChatShellScreen(
                      viewModel = viewModel,
                      showSidebarButton = true,
                      onOpenSidebar = onOpenSidebar,
                      onOpenDashboard = {},
                      onOpenGatewaySettings = {},
                      onOpenProvidersModels = {},
                      tabletopPanes = panes,
                      features = features,
                    )
                  }
                  if (displayFeatures != null) {
                    FoldAwareContent(features = features, tabletopEnabled = true) { shell(it.tabletop) }
                  } else {
                    shell(null)
                  }
                } else {
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
    if (composeRule.onAllNodesWithContentDescription(nativeString("Details")).fetchSemanticsNodes().isNotEmpty()) {
      controlBounds += composeRule.onNodeWithContentDescription(nativeString("Details")).assertIsDisplayed().getUnclippedBoundsInRoot()
    }
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
