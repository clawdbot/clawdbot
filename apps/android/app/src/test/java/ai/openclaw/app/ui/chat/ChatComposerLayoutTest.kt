package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.provider.Settings
import android.view.KeyEvent
import android.view.inspector.WindowInspector
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.UUID

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
    runtime.disconnect()
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
    NativeStringResources.install(app)
  }

  @Test
  fun slashSuggestionsKeepEditorAndStopVisibleAndLastSuggestionReachable() {
    showChat()
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performTextReplacement("/")
    editor.assertTextEquals("/")

    assertComposerControlsVisible()
    val sidebar = composeRule.onNodeWithContentDescription(nativeString("Show Sidebar")).assertIsDisplayed()
    val session = composeRule.onNode(hasText(nativeString("Main")) and hasClickAction()).assertIsDisplayed()
    val lastSuggestion = composeRule.onNodeWithText("/loop").performScrollTo().assertIsDisplayed()
    sidebar.assertIsDisplayed()
    session.assertIsDisplayed()
    assertComposerControlsVisible()
    lastSuggestion.performClick()
    editor.assertTextEquals("/loop ")
    assertComposerControlsVisible()
  }

  @Test
  fun normalTextAndShortSuggestionListsKeepComposerVisible() {
    showChat()
    val editor = composeRule.onNode(hasSetTextAction())
    listOf("hello", "/help", "/unknown").forEach { input ->
      editor.performTextReplacement(input)
      editor.assertTextEquals(input)
      assertComposerControlsVisible()
    }
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
  fun narrowFrenchComposerKeepsAnEmptyDraftCompactWithTalkAndRunControls() {
    val fontScale = mutableStateOf(1.3f)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    showChat(viewportWidth = 320.dp, viewportHeight = 640.dp, fontScale = { fontScale.value }, talkActive = true)
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
    model.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Context \${contextPercent}% used", 12)))

    val priorWindows = composeRule.runOnIdle { WindowInspector.getGlobalWindowViews().toSet() }
    thinking.performClick()
    composeRule.onNodeWithText("Ultra").assertIsDisplayed().assert(hasClickAction().not())
    composeRule.onNodeWithText(nativeString("High")).assertIsDisplayed().assertHasClickAction()
    assertEquals("Opening effort must not move or shrink the draft", editorBounds, editor.getUnclippedBoundsInRoot())
    composeRule.runOnIdle {
      val popup = WindowInspector.getGlobalWindowViews().single { it !in priorWindows }
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE)))
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE)))
    }
    composeRule.onNode(isPopup()).assertDoesNotExist()

    model.performClick()
    composeRule.onNodeWithText(nativeString("Context \${contextPercent}% used", 12)).assertIsDisplayed()
    composeRule.onNodeWithText(nativeString("Default")).assertIsDisplayed().assertHasClickAction()
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
    thinking.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Max")))
    thinking.performClick()
    composeRule.onNode(hasText(nativeString("Max")) and hasClickAction()).assertIsDisplayed().assertIsSelected()
  }

  @Test
  fun narrowComposerKeepsModelNamesOnOneLineWithLargeTextAndContextUsage() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    val fontScale = mutableStateOf(1f)
    showChat(viewportWidth = 320.dp, viewportHeight = 640.dp, fontScale = { fontScale.value }, talkActive = true)
    val requestField = ChatController::class.java.getDeclaredField("requestGateway").apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    val originalRequest = requestField.get(controller) as suspend (String, String?) -> String
    var modelLabel = "GPT-5.6 Sol"
    val request: suspend (String, String?) -> String = { method, params ->
      val response = originalRequest(method, params)
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
      composeRule.onNodeWithContentDescription(nativeString("Model")).assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Context \${contextPercent}% used", 12)))
      val longName = "A very long model display name for a narrow screen"
      listOf(1f, 1.5f).forEach { scale ->
        composeRule.runOnIdle { fontScale.value = scale }
        listOf("Claude Opus 4.6", "GPT-5.6 Sol", "GPT-5.2", longName).forEach { name ->
          composeRule.runOnIdle {
            modelLabel = name
            controller.handleGatewayEvent("chat.metadata.changed", "{}")
          }
          composeRule.waitUntil {
            controller.modelCatalog.value
              .singleOrNull()
              ?.name == name
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

  private fun showChat(
    viewportWidth: Dp = 360.dp,
    viewportHeight: Dp = 400.dp,
    fontScale: () -> Float = { 1f },
    talkActive: Boolean = false,
  ) {
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    viewModelStore.put("chat", viewModel)
    viewModel.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    composeRule.setContent {
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale())) {
        ClawDesignTheme {
          // The default viewport models a portrait phone after its IME opens.
          Box(
            Modifier
              .size(width = viewportWidth, height = viewportHeight)
              .background(ClawTheme.colors.canvas)
              .clipToBounds()
              .testTag("chat-viewport"),
          ) {
            ChatScreen(
              viewModel = viewModel,
              talkActive = talkActive,
              showSidebarButton = true,
              onOpenSidebar = {},
              onToggleTalk = {},
              onOpenSessions = {},
              onOpenDashboard = {},
              onOpenGatewaySettings = {},
            )
          }
        }
      }
    }
    composeRule.waitUntil { viewModel.chatCommands.value.size == 6 }
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
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, thinkingLabel)),
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
