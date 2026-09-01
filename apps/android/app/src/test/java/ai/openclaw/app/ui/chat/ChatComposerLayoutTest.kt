package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
class ChatComposerLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private var originalRuntime: NodeRuntime? = null
  private val viewModelStore = ViewModelStore()
  private var originalAnimatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    prefs = SecurePrefs(app, app.getSharedPreferences("chat-composer-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
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
  }

  @Test
  fun slashSuggestionsKeepEditorAndStopVisibleAndLastSuggestionReachable() {
    showChat()
    val editor = composeRule.onNode(hasSetTextAction())
    editor.performTextReplacement("/")
    editor.assertTextEquals("/")

    assertEditorAndStopVisible()
    val lastSuggestion = composeRule.onNodeWithText("/loop").performScrollTo().assertIsDisplayed()
    assertEditorAndStopVisible()
    lastSuggestion.performClick()
    editor.assertTextEquals("/loop ")
    assertEditorAndStopVisible()
  }

  @Test
  fun normalTextAndShortSuggestionListsKeepComposerVisible() {
    showChat()
    val editor = composeRule.onNode(hasSetTextAction())
    listOf("hello", "/help", "/unknown").forEach { input ->
      editor.performTextReplacement(input)
      editor.assertTextEquals(input)
      assertEditorAndStopVisible()
    }
  }

  private fun showChat() {
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    viewModelStore.put("chat", viewModel)
    viewModel.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    composeRule.setContent {
      ClawDesignTheme {
        // A portrait phone's remaining content viewport after its IME opens.
        Box(Modifier.size(width = 360.dp, height = 400.dp).clipToBounds().testTag("chat-viewport")) {
          ChatScreen(
            viewModel = viewModel,
            talkActive = false,
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
    composeRule.waitUntil { viewModel.chatCommands.value.size == 6 }
  }

  private fun assertEditorAndStopVisible() {
    val viewport = composeRule.onNodeWithTag("chat-viewport").getUnclippedBoundsInRoot()
    val editorNode = composeRule.onNode(hasSetTextAction())
    val stopNode = composeRule.onNodeWithContentDescription("Stop")
    val editor = editorNode.getUnclippedBoundsInRoot()
    val stop = stopNode.getUnclippedBoundsInRoot()
    assertTrue("Editor must retain a visible line: $editor inside $viewport", editor.bottom > editor.top)
    assertTrue("Stop must retain its touch target: $stop inside $viewport", stop.bottom - stop.top >= 48.dp)
    for (bounds in listOf(editor, stop)) {
      assertTrue("Composer control must stay below the viewport top", bounds.top >= viewport.top)
      assertTrue("Composer control must stay above the viewport bottom", bounds.bottom <= viewport.bottom)
    }
    editorNode.assertIsDisplayed()
    stopNode.assertIsDisplayed().assertHasClickAction()
  }

  private fun setApplicationRuntime(value: NodeRuntime?) {
    NodeApp::class.java
      .getDeclaredField("runtimeInstance")
      .apply { isAccessible = true }
      .set(app, value)
  }
}
