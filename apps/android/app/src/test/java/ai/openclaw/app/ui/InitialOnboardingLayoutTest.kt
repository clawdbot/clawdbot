package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.R
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.MascotMood
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
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
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import com.google.mlkit.common.internal.MlKitInitProvider
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

private const val OnboardingViewportTag = "initial-onboarding-viewport"

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h720dp-420dpi")
class InitialOnboardingLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Before
  fun disableMascotAnimations() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @Test
  fun gatewayCredentialsAndSetupCodeAreMasked() {
    val app = ApplicationProvider.getApplicationContext<NodeApp>()
    val prefs = SecurePrefs(app, app.getSharedPreferences("onboarding-input-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    try {
      Robolectric.buildContentProvider(MlKitInitProvider::class.java).create()
      val viewModel = MainViewModel(app, prefs, SavedStateHandle())
      models.put("onboarding", viewModel)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      setContent(fontScale = 1f, viewportHeight = 720.dp) { OnboardingFlow(viewModel) }

      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("Set up manually").performClick()
      assertInputPresentation("Host", "127.0.0.1", secret = false, scroll = true)
      assertInputPresentation("18789", "18790", secret = false, scroll = true)
      assertInputPresentation("Paste token", "synthetic-token", secret = true, scroll = true)
      assertInputPresentation("Password optional", "synthetic-password", secret = true, scroll = true)
      composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToIndex(0)
      composeRule.onNodeWithContentDescription("Back").performClick()
      composeRule.onNodeWithText("Scan QR or setup code").performClick()
      composeRule.onNodeWithText("Enter setup code").performClick()
      assertInputPresentation("Paste setup code", "synthetic-setup-code", secret = true)
    } finally {
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }

  @Test
  fun defaultFontKeepsWelcomeContentAndActionVisible() {
    var connectClicked = false
    setContent(fontScale = 1f, viewportHeight = 720.dp) {
      WelcomeScreen(mascotMood = MascotMood.Idle, onConnect = { connectClicked = true })
    }

    composeRule.onNodeWithText("Security notice").assertIsDisplayed()
    composeRule.onNodeWithText("Continue").assertIsDisplayed().performClick()
    assertTrue(connectClicked)
  }

  @Test
  fun largeFontKeepsWelcomeActionFixedWhileContentScrolls() {
    var connectClicked = false
    setContent(fontScale = 1.3f, viewportHeight = 480.dp) {
      WelcomeScreen(mascotMood = MascotMood.Idle, onConnect = { connectClicked = true })
    }

    val viewport = composeRule.onNodeWithTag(OnboardingViewportTag)
    val content = composeRule.onNodeWithText("Security notice")
    val action = composeRule.onNodeWithText("Continue").assertIsDisplayed()
    val scrollable = composeRule.onNode(hasScrollAction()).assertExists()
    val viewportBounds = viewport.getUnclippedBoundsInRoot()
    val contentBeforeScroll = content.getUnclippedBoundsInRoot()
    val actionBeforeScroll = action.getUnclippedBoundsInRoot()
    assertFullyInside(actionBeforeScroll, viewportBounds, "Welcome action")

    scrollable.performTouchInput { swipeUp() }
    composeRule.waitForIdle()

    val contentAfterScroll = content.getUnclippedBoundsInRoot()
    val actionAfterScroll = action.getUnclippedBoundsInRoot()
    assertTrue("Welcome content should move upward after a swipe", contentAfterScroll.top < contentBeforeScroll.top)
    assertEquals("Welcome action should remain fixed while content scrolls", actionBeforeScroll, actionAfterScroll)
    assertFullyInside(actionAfterScroll, viewportBounds, "Welcome action")

    content.performScrollTo().assertIsDisplayed()
    composeRule.waitForIdle()

    val actionAfterContentReached = action.getUnclippedBoundsInRoot()
    assertEquals("Welcome action should remain fixed when content is reached", actionBeforeScroll, actionAfterContentReached)
    assertFullyInside(actionAfterContentReached, viewportBounds, "Welcome action")
    action.assertIsDisplayed().performClick()
    assertTrue(connectClicked)
  }

  @Test
  fun defaultFontKeepsGatewayContentAndActionsVisible() {
    var manualSetupClicked = false
    setContent(fontScale = 1f, viewportHeight = 720.dp) {
      GatewaySetupScreen(
        nearbyGateway = null,
        onBack = {},
        onSetupCode = {},
        onManualSetup = { manualSetupClicked = true },
      )
    }

    composeRule.onNodeWithText("Android setup guide").assertIsDisplayed()
    composeRule.onNodeWithText("Scan QR or setup code").assertIsDisplayed()
    composeRule.onNodeWithText("Set up manually").assertIsDisplayed().performClick()
    assertTrue(manualSetupClicked)
  }

  @Test
  fun largeFontKeepsGatewayActionsFixedWhileContentScrolls() {
    var setupCodeClicked = false
    setContent(fontScale = 1.3f, viewportHeight = 480.dp) {
      GatewaySetupScreen(
        nearbyGateway = null,
        onBack = {},
        onSetupCode = { setupCodeClicked = true },
        onManualSetup = {},
      )
    }

    val viewport = composeRule.onNodeWithTag(OnboardingViewportTag)
    val content = composeRule.onNodeWithText("Android setup guide")
    val primaryAction = composeRule.onNodeWithText("Scan QR or setup code").assertIsDisplayed()
    val secondaryAction = composeRule.onNodeWithText("Set up manually").assertIsDisplayed()
    val scrollable = composeRule.onNode(hasScrollAction()).assertExists()
    val viewportBounds = viewport.getUnclippedBoundsInRoot()
    val contentBeforeScroll = content.getUnclippedBoundsInRoot()
    val primaryActionBeforeScroll = primaryAction.getUnclippedBoundsInRoot()
    val secondaryActionBeforeScroll = secondaryAction.getUnclippedBoundsInRoot()
    assertFullyInside(primaryActionBeforeScroll, viewportBounds, "Gateway primary action")
    assertFullyInside(secondaryActionBeforeScroll, viewportBounds, "Gateway secondary action")

    scrollable.performTouchInput { swipeUp() }
    composeRule.waitForIdle()

    val contentAfterScroll = content.getUnclippedBoundsInRoot()
    val primaryActionAfterScroll = primaryAction.getUnclippedBoundsInRoot()
    val secondaryActionAfterScroll = secondaryAction.getUnclippedBoundsInRoot()
    assertTrue("Gateway content should move upward after a swipe", contentAfterScroll.top < contentBeforeScroll.top)
    assertEquals("Gateway primary action should remain fixed while content scrolls", primaryActionBeforeScroll, primaryActionAfterScroll)
    assertEquals("Gateway secondary action should remain fixed while content scrolls", secondaryActionBeforeScroll, secondaryActionAfterScroll)
    assertFullyInside(primaryActionAfterScroll, viewportBounds, "Gateway primary action")
    assertFullyInside(secondaryActionAfterScroll, viewportBounds, "Gateway secondary action")

    content.performScrollTo().assertIsDisplayed()
    composeRule.waitForIdle()

    val primaryActionAfterContentReached = primaryAction.getUnclippedBoundsInRoot()
    val secondaryActionAfterContentReached = secondaryAction.getUnclippedBoundsInRoot()
    assertEquals("Gateway primary action should remain fixed when content is reached", primaryActionBeforeScroll, primaryActionAfterContentReached)
    assertEquals("Gateway secondary action should remain fixed when content is reached", secondaryActionBeforeScroll, secondaryActionAfterContentReached)
    assertFullyInside(primaryActionAfterContentReached, viewportBounds, "Gateway primary action")
    assertFullyInside(secondaryActionAfterContentReached, viewportBounds, "Gateway secondary action")
    primaryAction.assertIsDisplayed().performClick()
    assertTrue(setupCodeClicked)
  }

  @Test
  fun capturedGatewayTrustKeepsPinSystemTrustAndDeclineActionsDistinct() {
    val accepted = mutableListOf<String?>()
    var systemTrustCount = 0
    var declineCount = 0
    composeRule.setContent {
      ClawDesignTheme {
        GatewayTrustDialog(
          prompt =
            gatewayTrustPrompt.copy(
              fingerprintSha256 = "ab".repeat(32),
              previousFingerprintSha256 = "cd".repeat(32),
              systemTrustAvailable = true,
            ),
          confirmLabel = stringResource(R.string.trust_and_continue),
          cancelLabel = stringResource(R.string.cancel),
          onAccept = { accepted.add(it) },
          onUseSystemTrust = { systemTrustCount++ },
          onDecline = { declineCount++ },
        )
      }
    }

    composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
    composeRule.onNodeWithText("Old SHA-256:", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Trust and continue").assertIsEnabled().performClick()
    composeRule.onNodeWithText("Use system trust").performClick()
    composeRule.onNodeWithText("Cancel").performClick()
    assertEquals(listOf<String?>(null), accepted)
    assertEquals(1, systemTrustCount)
    assertEquals(1, declineCount)
  }

  private val gatewayTrustPrompt =
    NodeRuntime.GatewayTrustPrompt(
      endpoint = GatewayEndpoint(stableId = "test-gateway", name = "Test gateway", host = "gateway.test", port = 443),
      fingerprintSha256 = null,
      auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null),
      probeFailure = GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT,
    )

  private fun setContent(
    fontScale: Float,
    viewportHeight: Dp,
    content: @Composable () -> Unit,
  ) {
    composeRule.setContent {
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale)) {
        ClawDesignTheme {
          Box(
            modifier =
              Modifier
                .size(width = 360.dp, height = viewportHeight)
                .clipToBounds()
                .testTag(OnboardingViewportTag),
          ) {
            content()
          }
        }
      }
    }
  }

  private fun assertFullyInside(
    child: DpRect,
    parent: DpRect,
    label: String,
  ) {
    assertTrue("$label should stay inside the viewport's left edge", child.left >= parent.left)
    assertTrue("$label should stay inside the viewport's top edge", child.top >= parent.top)
    assertTrue("$label should stay inside the viewport's right edge", child.right <= parent.right)
    assertTrue("$label should stay inside the viewport's bottom edge", child.bottom <= parent.bottom)
  }

  private fun assertInputPresentation(
    initialText: String,
    value: String,
    secret: Boolean,
    scroll: Boolean = false,
  ) {
    val input = composeRule.onNode(hasSetTextAction() and hasText(initialText))
    if (scroll) input.performScrollTo()
    input.performClick().performTextReplacement(value)
    val focusedInput = composeRule.onNode(hasSetTextAction() and isFocused())
    val layouts = mutableListOf<TextLayoutResult>()
    focusedInput.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      "$initialText must use the expected visible input presentation",
      if (secret) "\u2022".repeat(value.length) else value,
      layouts
        .single()
        .layoutInput.text.text,
    )
    focusedInput.assert(
      if (secret) SemanticsMatcher.keyIsDefined(SemanticsProperties.Password) else SemanticsMatcher.keyNotDefined(SemanticsProperties.Password),
    )
  }
}
