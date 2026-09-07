package ai.openclaw.app.ui

import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Rect
import android.provider.Settings
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.core.view.WindowCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.window.layout.DisplayFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowInfoTrackerDecorator
import androidx.window.layout.WindowLayoutInfo
import com.google.mlkit.common.internal.MlKitInitProvider
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(minSdk = 34, maxSdk = 34, qualifiers = "w1000dp-h1000dp-mdpi")
class RootScreenFoldTest {
  @get:Rule val composeRule = createComposeRule()

  private val layouts = MutableSharedFlow<WindowLayoutInfo>(replay = 1)
  private val activeActivities = mutableSetOf<Activity>()
  private lateinit var view: View
  private lateinit var backDispatcher: OnBackPressedDispatcher

  @Before
  @SuppressLint("RestrictedApi") // Use WindowManager's own decorator boundary, not a production test hook.
  fun installWindowTracker() {
    WindowInfoTracker.overrideDecorator(
      object : WindowInfoTrackerDecorator {
        override fun decorate(tracker: WindowInfoTracker): WindowInfoTracker =
          object : WindowInfoTracker by tracker {
            override fun windowLayoutInfo(activity: Activity): Flow<WindowLayoutInfo> =
              flow {
                check(activeActivities.add(activity))
                try {
                  emitAll(layouts)
                } finally {
                  activeActivities.remove(activity)
                }
              }
          }
      },
    )
    val app = RuntimeEnvironment.getApplication()
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  @SuppressLint("RestrictedApi")
  fun resetWindowTracker() {
    WindowInfoTracker.reset()
  }

  @Test
  fun onboardingActionsAvoidTheHingeAndKeepDraftFocusAndBackNavigation() {
    withRoot(completed = false) {
      // No WindowLayoutInfo emission yet: onboarding must render normally.
      val action = composeRule.onNodeWithText("Continue").assertIsDisplayed()
      val original = windowBounds(action)
      val hinge = Rect(original.centerX() - 10, 0, original.centerX() + 10, view.height)
      assertTrue("The baseline action must cross the future hinge", Rect.intersects(original, hinge))
      emit(listOf(testFold(hinge)))
      assertClearOfHinge(action, hinge)
      action.performClick()
      composeRule.onNodeWithText("Set up manually").performClick()
      val input = composeRule.onNode(hasSetTextAction() and hasText("Host"))
      input.performScrollTo().performClick().performTextReplacement("gateway.test")
      val draft = composeRule.onNode(hasSetTextAction() and hasText("gateway.test"))
      val editorId = draft.fetchSemanticsNode().id
      for (features in listOf(emptyList(), listOf(testFold(hinge)), emptyList())) {
        emit(features)
        draft.assertTextEquals("gateway.test").assertIsFocused()
        assertEquals("Fold changes must keep the live input node", editorId, draft.fetchSemanticsNode().id)
      }
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      composeRule.onNodeWithText("Set up manually").assertIsDisplayed().performClick()
      composeRule.onNode(hasSetTextAction() and hasText("gateway.test")).performScrollTo().assertIsDisplayed()
    }
  }

  @Test
  fun authenticatedSettingsKeepSearchDraftAndReturnRouteAcrossFoldChanges() {
    withRoot(completed = true) {
      composeRule.onNodeWithContentDescription("Search settings").performClick()
      val search = composeRule.onNode(hasSetTextAction())
      search.performClick().performTextReplacement("Appearance")
      val editorId = search.fetchSemanticsNode().id
      val initial = windowBounds(search)
      val hinge = Rect(initial.centerX() - 10, 0, initial.centerX() + 10, view.height)
      for (features in listOf(listOf(testFold(hinge)), emptyList(), listOf(testFold(hinge)))) {
        emit(features)
        search.assertTextEquals("Appearance").assertIsFocused()
        assertEquals(editorId, search.fetchSemanticsNode().id)
        if (features.isNotEmpty()) assertClearOfHinge(search, hinge)
      }
      composeRule.onNodeWithContentDescription("Close search").performClick()
      composeRule.onNodeWithTag("sidebar-open-settings").assertIsDisplayed()
      composeRule.onNodeWithText("Theme family").assertDoesNotExist()
    }
  }

  @Test
  fun activityReplacementCancelsOldCollectionAndWaitsForTheNewLifecycle() {
    val first = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val second = Robolectric.buildActivity(ComponentActivity::class.java).create()
    var activity by mutableStateOf(first.get())
    var observed = emptyList<DisplayFeature>()
    try {
      composeRule.setContent {
        CompositionLocalProvider(LocalActivity provides activity, LocalLifecycleOwner provides activity) {
          val features = rememberWindowDisplayFeatures()
          SideEffect { observed = features }
        }
      }
      composeRule.runOnIdle { assertEquals(setOf(first.get()), activeActivities) }
      val fold = testFold(Rect(490, 0, 510, 1000))
      emit(listOf(fold))
      composeRule.runOnIdle { assertEquals(listOf(fold), observed) }
      composeRule.runOnIdle {
        first.pause().stop()
      }
      composeRule.runOnIdle { assertTrue(activeActivities.isEmpty()) }
      composeRule.runOnIdle { first.start().resume() }
      composeRule.runOnIdle { assertEquals(setOf(first.get()), activeActivities) }
      composeRule.runOnIdle { activity = second.get() }
      composeRule.runOnIdle {
        assertTrue("The stopped replacement must not collect", activeActivities.isEmpty())
        assertTrue("Do not retain old-Activity features while awaiting an emission", observed.isEmpty())
        first.pause().stop().destroy()
        second.start().resume()
      }
      composeRule.runOnIdle { assertEquals(setOf(second.get()), activeActivities) }
      emit(emptyList())
      composeRule.runOnIdle {
        assertTrue(observed.isEmpty())
        second.pause().stop().destroy()
      }
      composeRule.runOnIdle { assertTrue(activeActivities.isEmpty()) }
    } finally {
      if (!first.get().isDestroyed) first.pause().stop().destroy()
      if (!second.get().isDestroyed) second.pause().stop().destroy()
    }
  }

  private fun emit(features: List<DisplayFeature>) {
    composeRule.runOnIdle { assertTrue(layouts.tryEmit(WindowLayoutInfo(features))) }
    composeRule.waitForIdle()
  }

  private fun withRoot(
    completed: Boolean,
    verify: () -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("root-fold-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(completed)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    try {
      if (!completed) Robolectric.buildContentProvider(MlKitInitProvider::class.java).create()
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("root-fold", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      if (completed) model.requestHomeDestination(HomeDestination.Settings)
      composeRule.setContent {
        val activity = requireNotNull(LocalActivity.current)
        view = LocalView.current
        backDispatcher = requireNotNull(LocalOnBackPressedDispatcherOwner.current).onBackPressedDispatcher
        LaunchedEffect(activity) { WindowCompat.setDecorFitsSystemWindows(activity.window, false) }
        RootScreen(model)
      }
      composeRule.waitForIdle()
      val originalRoot = composeRule.onRoot().getUnclippedBoundsInRoot()
      verify()
      assertEquals("Only the pane may move, never the window host", originalRoot, composeRule.onRoot().getUnclippedBoundsInRoot())
    } finally {
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }

  private fun windowBounds(node: SemanticsNodeInteraction): Rect {
    val bounds = node.getUnclippedBoundsInRoot()
    val offset = IntArray(2).also(view::getLocationInWindow)
    val density = view.resources.displayMetrics.density
    return Rect(
      (bounds.left.value * density).toInt() + offset[0],
      (bounds.top.value * density).toInt() + offset[1],
      (bounds.right.value * density).toInt() + offset[0],
      (bounds.bottom.value * density).toInt() + offset[1],
    )
  }

  private fun assertClearOfHinge(
    node: SemanticsNodeInteraction,
    hinge: Rect,
  ) {
    node.assertIsDisplayed()
    val bounds = windowBounds(node)
    assertNotEquals("The witness must have real geometry", 0, bounds.width())
    assertFalse("Interactive content overlaps the separating hinge: content=$bounds hinge=$hinge", Rect.intersects(bounds, hinge))
  }
}
