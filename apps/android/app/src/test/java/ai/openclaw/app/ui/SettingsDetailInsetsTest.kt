package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.appearanceAccentPalette
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawTextField
import android.content.Context
import android.view.View
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w700dp-h1000dp-420dpi")
class SettingsDetailInsetsTest {
  @get:Rule
  val composeRule = createComposeRule()

  // Mirrors the bottom inset SettingsDetailFrame reserves below its scroll viewport.
  private val settingsFrameBottomPadding = 4.dp

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
}
