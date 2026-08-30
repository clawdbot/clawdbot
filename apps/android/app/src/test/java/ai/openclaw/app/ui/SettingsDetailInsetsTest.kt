package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawTextField
import android.view.View
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w700dp-h1000dp-420dpi")
class SettingsDetailInsetsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun keyboardInsetsResizeSettingsWithoutNavigation() = verifyInsets(NavigationSuiteType.None)

  @Test
  fun navigationBarInsetsAreNotAppliedTwice() = verifyInsets(NavigationSuiteType.NavigationBar)

  @Test
  fun navigationRailLeavesBottomInsetsToSettings() = verifyInsets(NavigationSuiteType.NavigationRail)

  private fun verifyInsets(navigationType: NavigationSuiteType) {
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
        NavigationSuiteScaffold(navigationSuiteItems = {}, layoutType = navigationType) {
          Box(Modifier.fillMaxSize().testTag("settings-host")) {
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
      val ancestorBottom = if (navigationType == NavigationSuiteType.NavigationBar) navigationBottom else 0
      val remainingBottom = (maxOf(navigationBottom, imeBottom) - ancestorBottom) / density
      assertEquals(
        "$navigationType must consume the remaining bottom inset (IME=$imeBottom)",
        host.bottom.value - remainingBottom - 6.dp.value,
        viewport.bottom.value,
        1f / density,
      )
      val button = composeRule.onNodeWithText("Save").getUnclippedBoundsInRoot()
      val editor = composeRule.onNodeWithTag("last-field").getUnclippedBoundsInRoot()
      org.junit.Assert.assertTrue("Save must be reachable", button.bottom <= viewport.bottom)
      org.junit.Assert.assertTrue("Last field must be reachable with Save", editor.top >= viewport.top && editor.bottom <= viewport.bottom)
    }
  }
}
