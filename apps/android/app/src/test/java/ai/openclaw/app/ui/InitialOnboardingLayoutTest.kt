package ai.openclaw.app.ui

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
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

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
}
