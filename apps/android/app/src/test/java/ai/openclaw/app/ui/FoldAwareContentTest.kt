package ai.openclaw.app.ui

import android.graphics.Rect
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.window.layout.DisplayFeature
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(minSdk = 34, maxSdk = 34, qualifiers = "w1000dp-h1000dp-mdpi")
class FoldAwareContentTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun movingHostAndRtlPlaceOneLiveEditorInPhysicalWindowCoordinates() {
    var folds by mutableStateOf(emptyList<DisplayFeature>())
    var direction by mutableStateOf(LayoutDirection.Ltr)
    var x by mutableStateOf(100.dp)
    var starts = 0
    var disposals = 0
    composeRule.setContent {
      CompositionLocalProvider(LocalLayoutDirection provides direction) {
        Box(Modifier.fillMaxSize(), contentAlignment = AbsoluteAlignment.TopLeft) {
          FoldAwareContent(folds, Modifier.absoluteOffset { IntOffset(x.roundToPx(), 50.dp.roundToPx()) }.size(800.dp, 800.dp)) {
            var draft by remember { mutableStateOf("") }
            DisposableEffect(Unit) {
              starts++
              onDispose { disposals++ }
            }
            Box(Modifier.fillMaxSize().testTag("pane")) {
              BasicTextField(draft, { draft = it }, Modifier.testTag("editor"))
            }
          }
        }
      }
    }
    val pane = composeRule.onNodeWithTag("pane")
    val original = pane.getUnclippedBoundsInRoot()
    composeRule.onNodeWithTag("editor").performTextReplacement("retained draft")
    // Features use window coordinates; this host starts away from the window origin.
    val foldX = original.left.value.toInt() + 390
    val feature = testFold(Rect(foldX, 0, foldX + 20, 2000))
    composeRule.runOnIdle { folds = listOf(feature) }
    assertEquals(DpRect(original.left, original.top, original.left + 390.dp, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.runOnIdle { direction = LayoutDirection.Rtl }
    assertEquals(DpRect(original.left + 410.dp, original.top, original.right, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.runOnIdle { x = 120.dp }
    assertEquals(DpRect(original.left + 410.dp, original.top, original.right + 20.dp, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.runOnIdle { folds = emptyList() }
    assertEquals(DpRect(original.left + 20.dp, original.top, original.right + 20.dp, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.onNodeWithTag("editor").assertTextEquals("retained draft")
    composeRule.runOnIdle {
      assertEquals("Fold changes must not recreate the editor composition", 1, starts)
      assertEquals(0, disposals)
    }
  }
}
