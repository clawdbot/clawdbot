package ai.openclaw.app.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.provider.Settings
import android.view.View
import androidx.activity.ComponentDialog
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.window.layout.DisplayFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowInfoTrackerDecorator
import androidx.window.layout.WindowLayoutInfo
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import org.robolectric.util.ReflectionHelpers

@OptIn(ExperimentalMaterial3Api::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FoldAwareSheetTest {
  @get:Rule val composeRule = createComposeRule()
  private val features = MutableStateFlow(WindowLayoutInfo(emptyList()))
  private lateinit var state: FoldAwareSheetState
  private lateinit var sheetState: SheetState
  private lateinit var activity: Activity
  private lateinit var activityView: View
  private var unsafe = 0
  private var actions = 0
  private var contentHeight by mutableStateOf(144.dp)
  private var direction = LayoutDirection.Ltr

  @Before
  @SuppressLint("RestrictedApi")
  fun installTracker() {
    WindowInfoTracker.overrideDecorator(
      object : WindowInfoTrackerDecorator {
        override fun decorate(tracker: WindowInfoTracker): WindowInfoTracker =
          object : WindowInfoTracker by tracker {
            override fun windowLayoutInfo(activity: Activity): Flow<WindowLayoutInfo> = features
          }
      },
    )
    Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  @SuppressLint("RestrictedApi")
  fun resetTracker() = WindowInfoTracker.reset()

  @Test
  fun realSurfaceUsesPhysicalPanesAndImeAlternativeWithoutChangingNativeOwner() {
    show()
    val dialog = dialog()
    val nativeState = sheetState
    val cases =
      listOf(
        emptyList<DisplayFeature>() to Rect(0, 0, 1000, 1000),
        listOf(testFold(Rect(490, 0, 510, 1000))) to Rect(0, 0, 490, 1000),
        listOf(testFold(Rect(200, 0, 220, 1000))) to Rect(220, 0, 1000, 1000),
        listOf(testFold(Rect(0, 200, 1000, 220))) to Rect(0, 220, 1000, 1000),
      )
    for ((next, expected) in cases) {
      emit(next)
      assertSurfaceInside(expected)
      composeRule.onNodeWithText("Select").assertIsDisplayed().performClick()
      assertSame(dialog, dialog())
      assertSame(nativeState, sheetState)
    }
    keyboard(800)
    assertSurfaceInside(Rect(0, 0, 1000, 200))
    keyboard(0)
    // A still-usable top plane stays selected when the IME goes away.
    assertSurfaceInside(Rect(0, 0, 1000, 200))
    assertEquals(4, actions)
    assertEquals(0, unsafe)
  }

  @Test
  fun terminalOmissionCannotRedrawOnRecoveryOrChildRemeasure() {
    show()
    val dialog = dialog()
    val nativeState = sheetState
    assertSurfaceInside(Rect(0, 0, 1000, 1000))
    emit(listOf(testFold(Rect(0, 0, 1000, 1000))))
    assertTrue(state.revoked)
    assertEquals(1, unsafe)
    assertEquals(null, surfacePixels())
    emit(emptyList())
    composeRule.runOnIdle { contentHeight = 200.dp }
    composeRule.waitForIdle()
    assertEquals(null, surfacePixels())
    assertSame(dialog, dialog())
    assertSame(nativeState, sheetState)
    assertTrue(dialog.isShowing)
    assertEquals(0, actions)
  }

  @Test
  fun actionTimeSamplingRejectsDetachedActivityWithoutWaitingForPredraw() {
    show()
    assertTrue(composeRule.runOnIdle { state.refresh() })
    composeRule.runOnUiThread {
      // Native attachment loss is a raw owner fact, not a supplied geometry answer.
      val info = ReflectionHelpers.getField<Any>(activityView, "mAttachInfo")
      try {
        ReflectionHelpers.setField(activityView, "mAttachInfo", null)
        assertFalse(state.refresh())
      } finally {
        ReflectionHelpers.setField(activityView, "mAttachInfo", info)
      }
      assertTrue(state.revoked)
      assertFalse(state.refresh())
    }
    assertEquals(1, unsafe)
  }

  @Test
  fun independentWindowOriginsTranslateExactlyOnce() {
    show()
    emit(listOf(testFold(Rect(200, 0, 220, 1000))))
    composeRule.runOnIdle {
      val info = ReflectionHelpers.getField<Any>(activityView, "mAttachInfo")
      ReflectionHelpers.setField(info, "mWindowLeft", 100)
      activityView.viewTreeObserver.dispatchOnPreDraw()
    }
    composeRule.waitForIdle()
    assertSurfaceInside(Rect(320, 0, 1000, 1000))
    assertEquals(0, unsafe)
  }

  @Test
  fun rtlOpeningChoosesTheLogicalStartPlaneForAnEqualBookSplit() {
    direction = LayoutDirection.Rtl
    features.value = WindowLayoutInfo(listOf(testFold(Rect(490, 0, 510, 1000))))
    show()
    assertSurfaceInside(Rect(510, 0, 1000, 1000))
    composeRule.onNodeWithText("Select").assertIsDisplayed().performClick()
    assertEquals(1, actions)
  }

  private fun show() {
    composeRule.setContent {
      activity = requireNotNull(LocalActivity.current)
      activityView = LocalView.current
      val lifecycle = LocalLifecycleOwner.current.lifecycle
      val geometry = remember { FoldAwareSheetState(activity, activityView, lifecycle) { unsafe++ } }
      val publication = rememberWindowDisplayFeatureState(geometry::publishFeatures)
      val native = rememberModalBottomSheetState(skipPartiallyExpanded = true)
      SideEffect {
        state = geometry
        sheetState = native
      }
      if (publication.value.ready) {
        CompositionLocalProvider(LocalLayoutDirection provides direction) {
          ModalBottomSheet(
            modifier = Modifier.foldAwareSheet(geometry),
            sheetState = native,
            containerColor = Color(SURFACE),
            onDismissRequest = { if (geometry.refresh()) actions++ },
          ) {
            Column(Modifier.fillMaxWidth().height(contentHeight)) {
              TextButton(onClick = { if (geometry.refresh()) actions++ }) { Text("Select") }
            }
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun emit(next: List<DisplayFeature>) {
    composeRule.runOnIdle { features.value = WindowLayoutInfo(next) }
    composeRule.waitForIdle()
  }

  private fun keyboard(bottom: Int) {
    composeRule.runOnIdle {
      ViewCompat.dispatchApplyWindowInsets(
        checkNotNull(dialog().window).decorView,
        WindowInsetsCompat
          .Builder()
          .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, bottom))
          .setVisible(WindowInsetsCompat.Type.ime(), bottom > 0)
          .build(),
      )
    }
    composeRule.waitForIdle()
  }

  private fun dialog() = checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog

  private fun surfacePixels(): Rect? =
    composeRule.runOnIdle {
      val root = checkNotNull(dialog().window).decorView
      val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
      try {
        root.draw(Canvas(bitmap))
        var left = bitmap.width
        var top = bitmap.height
        var right = 0
        var bottom = 0
        for (y in 0 until bitmap.height) {
          for (x in 0 until bitmap.width) {
            if (bitmap.getPixel(x, y) == SURFACE) {
              left = minOf(left, x)
              top = minOf(top, y)
              right = maxOf(right, x + 1)
              bottom = maxOf(bottom, y + 1)
            }
          }
        }
        if (right > left && bottom > top) Rect(left, top, right, bottom) else null
      } finally {
        bitmap.recycle()
      }
    }

  private fun assertSurfaceInside(expected: Rect) {
    val actual = checkNotNull(surfacePixels()) { "The actual Material Surface must render" }
    assertTrue("Surface $actual must fit physical pane $expected", expected.contains(actual))
    assertTrue("Material's natural Surface must not stretch to fill the host", actual.height() < 300)
    assertTrue("Material's width cap must remain in effect", actual.width() <= 640)
  }

  private companion object {
    const val SURFACE = 0xFFFF00AA.toInt()
  }
}
