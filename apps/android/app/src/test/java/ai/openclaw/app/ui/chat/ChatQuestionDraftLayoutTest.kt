package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.AndroidClientDatabases
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatQuestionStatus
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionRecord
import ai.openclaw.app.gateway.QuestionSecretStore
import ai.openclaw.app.gateway.QuestionSecretStoreExisting
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
class ChatQuestionDraftLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var controller: ChatController
  private lateinit var question: QuestionRecord
  private var originalRuntime: NodeRuntime? = null
  private val viewModelStore = ViewModelStore()
  private var originalAnimatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    originalAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    prefs = SecurePrefs(app, app.getSharedPreferences("chat-question-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    originalRuntime = app.peekRuntime()
    bindNodeRuntimeTestFixture(app, runtime)
    // Construct the real backing stores before testing question interactions, not cold startup.
    drainWithMainLooper {
      ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases").clientStateDatabase()
    }
    controller =
      NodeRuntime::class.java
        .getDeclaredField("chat")
        .apply { isAccessible = true }
        .get(runtime) as ChatController
    @Suppress("UNCHECKED_CAST")
    val request =
      ChatController::class.java
        .getDeclaredField("requestGateway")
        .apply { isAccessible = true }
        .get(controller) as suspend (String, String?) -> String
    question = runBlocking { Json.decodeFromString<QuestionListResult>(request("question.list", "{}")).questions.single() }
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    try {
      viewModelStore.clear()
    } finally {
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        bindNodeRuntimeTestFixture(app, originalRuntime)
        AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
        shadowOf(Looper.getMainLooper()).idle()
      }
    }
  }

  @Test
  fun credentialCardShowsConsentAndKeepsEditedInput() {
    val secret =
      question.questions.first().copy(
        options = emptyList(),
        isSecret = true,
        secretStore = QuestionSecretStore("TASK_TOKEN", "secret", listOf("api.example.test"), "Deploy the approved change"),
        secretStoreExisting = QuestionSecretStoreExisting(1_000, "operator"),
      )
    var prompt by mutableStateOf(ChatQuestionPrompt(question.copy(questions = listOf(secret), agentId = "requester", sessionKey = "agent:requester:main")))
    var submitted: Map<String, List<String>>? = null
    val editorInfo = AtomicReference<EditorInfo>()
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
    composeRule.setContent {
      ClawDesignTheme {
        InterceptPlatformTextInput(interceptor) {
          ChatQuestionCard(
            prompt = prompt,
            onDraftChanged = { _, update -> prompt = prompt.copy(draft = update(prompt.draft)) },
            onSubmit = { _, answers -> submitted = answers },
            onSkip = {},
          )
        }
      }
    }
    composeRule.onNodeWithText("Requested by requester", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("agent:requester:main", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Stores TASK_TOKEN as Protected secret").assertIsDisplayed()
    composeRule.onNodeWithText("Deploy the approved change").assertIsDisplayed()
    composeRule.onNodeWithText("Replaces TASK_TOKEN", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Updated by operator").assertIsDisplayed()
    val hosts = composeRule.onNode(hasSetTextAction() and hasText("Allowed HTTPS hosts"))
    hosts.assertTextContains("api.example.test").performTextReplacement("uploads.example.test, api.example.test")
    hosts.assertTextContains("uploads.example.test, api.example.test")
    val secretInput = composeRule.onNode(hasSetTextAction() and hasText("Secret value"))
    secretInput.performClick()
    composeRule.waitUntil {
      editorInfo.get()?.inputType?.and(InputType.TYPE_MASK_VARIATION) == InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    assertEquals(
      "Secret replies must not request autocorrection",
      0,
      editorInfo.get().inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT,
    )
    secretInput.performTextReplacement("  synthetic-value  ")
    composeRule.onNodeWithText("Submit").performClick()
    assertEquals(mapOf(secret.questionId to listOf("  synthetic-value  ")), submitted)
  }

  @Test
  fun unsentQuestionAnswerSurvivesReadingEarlierMessages() {
    val history = showPendingQuestion()
    val answer = composeRule.onNode(hasSetTextAction() and hasText("Other answer"))
    answer.assertIsDisplayed().performTextReplacement("Mention the keyboard fix")
    answer.assertTextContains("Mention the keyboard fix")
    composeRule.onNodeWithText("Submit").assertIsEnabled()
    composeRule.onNode(hasSetTextAction() and hasText("Other answer").not()).performClick()
    assertQuestionUnchanged()

    val visitedMessages = mutableSetOf<String>()
    repeat(12) {
      history.performTouchInput { swipeDown(durationMillis = 500) }
      composeRule.waitForIdle()
      composeRule.onAllNodes(hasText("Earlier discussion", substring = true)).fetchSemanticsNodes().forEach { node ->
        if (node.boundsInRoot.height > 0f) {
          node.config.getOrNull(SemanticsProperties.Text)?.forEach { visitedMessages += it.text }
        }
      }
      assertQuestionUnchanged()
    }
    assertTrue("Must read more than eight distinct earlier messages: $visitedMessages", visitedMessages.size > 8)
    answer.assertIsNotDisplayed()
    repeat(12) {
      history.performTouchInput { swipeUp(durationMillis = 500) }
      composeRule.waitForIdle()
      assertQuestionUnchanged()
    }
    composeRule.onNodeWithText(question.questions.single().question).assertIsDisplayed()
    answer.assertIsDisplayed().assertTextContains("Mention the keyboard fix")
    composeRule.onNodeWithText("Submit").assertIsEnabled()
  }

  @Test
  fun retiredRenderedSubmitCannotAnswerReloadedQuestion() {
    assertRetiredActionCannotResolveReloadedQuestion("Submit")
  }

  @Test
  fun retiredRenderedSkipCannotCancelReloadedQuestion() {
    assertRetiredActionCannotResolveReloadedQuestion("Skip")
  }

  private fun assertRetiredActionCannotResolveReloadedQuestion(label: String) {
    showPendingQuestion()
    composeRule
      .onNode(hasSetTextAction() and hasText("Other answer"))
      .performTextReplacement("Mention the keyboard fix")
    val action = composeRule.onNode(hasText(label) and hasClickAction())
    action.assertIsDisplayed().assertIsEnabled()
    val retainedClick = checkNotNull(action.fetchSemanticsNode().config[SemanticsActions.OnClick].action)
    lateinit var replacement: ChatQuestionPrompt
    composeRule.runOnIdle {
      controller.onGatewayScopeChanging()
      assertTrue(controller.questions.value.isEmpty())
      controller.applyMainSessionKey(checkNotNull(question.sessionKey))
      controller.handleGatewayEvent("question.requested", Json.encodeToString(question))
      assertQuestionUnchanged()
      replacement = controller.questions.value.single()
      assertTrue(replacement.draft.otherText.isEmpty())
      assertNull(replacement.errorText)
      // Replay the actual rendered action after retirement, before Compose can replace its callback.
      retainedClick()
    }
    composeRule.waitForIdle()
    assertEquals("Retired $label must not claim the reloaded prompt", replacement, controller.questions.value.single())

    composeRule
      .onNode(hasSetTextAction() and hasText("Other answer"))
      .performTextReplacement("Use the current question")
    action.assertIsEnabled().performClick()
    composeRule.waitUntil {
      controller.questions.value
        .single()
        .errorText != null
    }
    assertTrue(
      "The current action must reach the existing Gateway boundary",
      controller.questions.value
        .single()
        .errorText
        .orEmpty()
        .startsWith("Screenshot fixture does not implement gateway method question.resolve"),
    )
  }

  private fun showPendingQuestion(): SemanticsNodeInteraction {
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    viewModelStore.put("chat", viewModel)
    viewModel.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.size(width = 360.dp, height = 800.dp).clipToBounds()) {
          ChatScreen(
            viewModel = viewModel,
            talkActive = false,
            showSidebarButton = true,
            onOpenSidebar = {},
            onToggleTalk = {},
            onOpenDashboard = {},
            onOpenGatewaySettings = {},
          )
        }
      }
    }
    // ViewModel bridge updates need the Android main queue, not just Compose clock advancement.
    composeRule.waitUntil { composeRule.runOnIdle { viewModel.chatMessages.value.size >= 24 } }
    composeRule.waitForIdle()
    assertTrue(viewModel.chatQuestions.value.isEmpty())
    composeRule.onNodeWithText("Draft a short status update for the team.").assertIsDisplayed()
    controller.handleGatewayEvent("question.requested", Json.encodeToString(question))
    composeRule.waitUntil {
      composeRule.runOnIdle {
        viewModel.chatQuestions.value
          .singleOrNull()
          ?.record == question
      }
    }
    val history = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))
    repeat(3) { history.performTouchInput { swipeUp(durationMillis = 500) } }
    return history
  }

  private fun assertQuestionUnchanged() {
    val prompt = controller.questions.value.single()
    assertEquals("Scrolling must not replace or remove the pending question", question, prompt.record)
    assertEquals(ChatQuestionStatus.Pending, prompt.status())
    assertTrue("Fixture must remain within the real pending question lifetime", System.currentTimeMillis() < question.expiresAtMs)
  }
}
