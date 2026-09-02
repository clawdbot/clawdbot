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
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.InputType
import android.view.View
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
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w700dp-h1000dp-420dpi")
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
  fun systemAgentComposerUpdatesPasswordSemanticsAcrossSensitiveReplies() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("system-agent-input-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    val clipboard = requireNotNull(app.getSystemService(ClipboardManager::class.java))
    val previousClip = clipboard.primaryClip
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val requests = CopyOnWriteArrayList<JsonObject>()
    val replies = listOf("Ordinary reply ready", "Enter the synthetic credential", "Ordinary reply restored")
    val releaseReplies = List(2) { CountDownLatch(1) }
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
      val originalRequester =
        ReflectionHelpers.getField<Lazy<(String, String?) -> String>>(runtime, "screenshotRequester\$delegate").value
      val requester: (String, String?) -> String = { method, params ->
        if (method != GatewayMethod.OpenclawChat.rawValue) {
          originalRequester(method, params)
        } else {
          val requestIndex = requests.size
          requests.add(Json.parseToJsonElement(requireNotNull(params)).jsonObject)
          if (requestIndex > 0) {
            check(releaseReplies[requestIndex - 1].await(10, TimeUnit.SECONDS)) { "Sending frame was not released" }
          }
          buildJsonObject {
            put("reply", replies[requestIndex])
            put("action", "none")
            put("sensitive", requestIndex == 1)
          }.toString()
        }
      }
      ReflectionHelpers.setField(runtime, "screenshotRequester\$delegate", lazyOf(requester))
      val viewModel = MainViewModel(app, prefs, SavedStateHandle())
      models.put("system-agent", viewModel)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      composeRule.setContent {
        ClawDesignTheme {
          InterceptPlatformTextInput(interceptor) {
            SettingsDetailScreen(viewModel, SettingsRoute.SystemAgent, onBack = {})
          }
        }
      }
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
        send.performClick()
        composeRule.waitUntil(timeoutMillis = 5_000) {
          requests.size > replyIndex && runtime.systemAgentChatState.value.sending
        }
        input.assertIsNotEnabled()
        send.assertIsNotEnabled()
        assertEquals("", runtime.systemAgentChatState.value.input)
        assertEquals(expectedMessage, requests[replyIndex]["message"]?.jsonPrimitive?.content)
        composeRule.runOnIdle { editorInfo.set(null) }
        releaseReplies[replyIndex - 1].countDown()
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
    } finally {
      // Release blocking fixture replies before runtime cleanup joins its IO scope.
      releaseReplies.forEach { it.countDown() }
      try {
        models.clear()
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          if (previousClip == null) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(previousClip)
        }
      }
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
