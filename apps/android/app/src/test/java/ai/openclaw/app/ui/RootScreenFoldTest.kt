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
import androidx.activity.BackEventCompat
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
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.view.WindowCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature
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
  private lateinit var focusManager: FocusManager
  private var direction by mutableStateOf(LayoutDirection.Ltr)

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
      composeRule.onNodeWithTag("sidebar-search-toggle").assertIsDisplayed()
      composeRule.onNodeWithText("Theme family").assertDoesNotExist()
    }
  }

  @Test
  fun bookKeepsChatDraftAndFocusBesideTheSidebarAndReturnsToTheFlatDrawer() {
    withRoot(completed = true, destination = HomeDestination.Chat) {
      val editor = composeRule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("chat-composer-surface")))
      editor.performClick().performTextReplacement("Keep this draft")
      editor.assertIsFocused()
      val editorId = editor.fetchSemanticsNode().id
      val focusedAfterMove = mutableListOf<Boolean>()
      val hinge = Rect(400, 0, 420, view.height)
      emit(listOf(testFold(hinge)))
      val sidebarSearch = composeRule.onNodeWithTag("sidebar-search-toggle").assertIsDisplayed()
      assertTrue(windowBounds(sidebarSearch).right <= hinge.left)
      assertTrue(windowBounds(editor).left >= hinge.right)
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      editor.assertTextEquals("Keep this draft")
      focusedAfterMove += editor.fetchSemanticsNode().config[SemanticsProperties.Focused]
      editor.assertIsFocused()
      composeRule.onRoot().performKeyInput { pressKey(Key.B) }
      editor.assertTextEquals("Keep this draftb")
      composeRule.onNodeWithTag("sidebar-close").assertDoesNotExist()
      emit(emptyList())
      editor.assertTextEquals("Keep this draftb")
      focusedAfterMove += editor.fetchSemanticsNode().config[SemanticsProperties.Focused]
      editor.assertIsFocused()
      composeRule.onRoot().performKeyInput { pressKey(Key.F) }
      editor.assertTextEquals("Keep this draftbf")
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      composeRule.onNodeWithContentDescription("Show Sidebar").performClick()
      composeRule.onNodeWithTag("sidebar-close").assertIsDisplayed()
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      editor.assertIsDisplayed().assertTextEquals("Keep this draftbf")
      assertEquals("Keep editor focus through both reparentings", listOf(true, true), focusedAfterMove)
    }
  }

  @Test
  fun bookKeepsUnsavedProfileSelectionFocusAndTypingAcrossRtlAndFlat() {
    withRoot(completed = true) { model ->
      val savedName = model.displayName.value
      composeRule.onNodeWithContentDescription("Open profile").performClick()
      val editor = composeRule.onNode(hasSetTextAction())
      editor.performClick().performTextReplacement("Unsaved device")
      editor.assertIsFocused()
      editor.performTextInputSelection(TextRange(8, 14))
      val editorId = editor.fetchSemanticsNode().id
      val hinge = Rect(400, 0, 420, view.height)
      emit(listOf(testFold(hinge)))
      editor.assertTextContains("Unsaved device").assertIsFocused()
      assertEquals(TextRange(8, 14), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      assertTrue(windowBounds(editor).left >= hinge.right)
      composeRule.onRoot().performKeyInput { pressKey(Key.B) }
      editor.assertTextContains("Unsaved b")
      composeRule.runOnIdle { direction = LayoutDirection.Rtl }
      editor.assertIsFocused()
      assertEquals(TextRange(9), editor.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      assertTrue(windowBounds(editor).right <= hinge.left)
      composeRule.onRoot().performKeyInput { pressKey(Key.R) }
      editor.assertTextContains("Unsaved br")
      emit(emptyList())
      editor.assertIsFocused()
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      composeRule.onRoot().performKeyInput { pressKey(Key.F) }
      editor.assertTextContains("Unsaved brf")
      composeRule.runOnIdle {
        assertEquals("Layout changes must not save the draft", savedName, model.displayName.value)
        backDispatcher.onBackPressed()
      }
      composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
      composeRule.onNodeWithText("Save Profile").assertDoesNotExist()
    }
  }

  @Test
  fun bookDoesNotStealClearedOrTransferredFocusOrActivateHiddenSidebarInput() {
    withRoot(completed = true, destination = HomeDestination.Chat) {
      val editor = composeRule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("chat-composer-surface")))
      val fold = listOf(testFold(Rect(400, 0, 420, view.height)))
      composeRule.runOnIdle { focusManager.clearFocus() }
      emit(fold)
      editor.assertIsNotFocused()
      emit(emptyList())
      editor.assertIsNotFocused()
      editor.performClick().performTextReplacement("Do not refocus")
      composeRule.runOnIdle { focusManager.clearFocus() }
      emit(fold)
      editor.assertIsNotFocused()
      composeRule.onNodeWithTag("sidebar-search-toggle").performTouchInput { click() }
      val search = composeRule.onNodeWithTag("sidebar-search")
      editor.performClick().assertIsFocused()
      search.performClick().performTextReplacement("current intent")
      search.assertIsFocused()
      editor.assertIsNotFocused()
      composeRule.runOnIdle { direction = LayoutDirection.Rtl }
      search.assertIsFocused()
      editor.assertIsNotFocused()
      emit(emptyList())
      search.assertIsNotDisplayed().assertIsNotFocused()
      editor.assertIsNotFocused()
      emit(fold)
      search.assertIsNotFocused()
      editor.assertIsNotFocused()
      search.performClick().assertIsFocused()
      editor.performClick().assertIsFocused()
      emit(emptyList())
      editor.assertIsFocused()
      search.assertIsNotFocused()
    }
  }

  @Test
  fun bookKeepsSidebarSearchAcrossModalMovesAndUsesOffCenterRtlPlanes() {
    withRoot(completed = true) {
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      composeRule.onNodeWithTag("sidebar-search-toggle").performClick()
      val search = composeRule.onNodeWithTag("sidebar-search")
      search.performClick().performTextReplacement("retained search")
      val editorId = search.fetchSemanticsNode().id
      val focusedAfterMove = mutableListOf<Boolean>()
      val hinge = Rect(400, 0, 420, view.height)
      emit(listOf(testFold(hinge)))
      assertEquals(editorId, search.fetchSemanticsNode().id)
      search.assertTextContains("retained search")
      focusedAfterMove += search.fetchSemanticsNode().config[SemanticsProperties.Focused]
      assertTrue(windowBounds(search).right <= hinge.left)
      composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
      composeRule.runOnIdle { direction = LayoutDirection.Rtl }
      search.assertTextContains("retained search")
      focusedAfterMove += search.fetchSemanticsNode().config[SemanticsProperties.Focused]
      assertEquals(editorId, search.fetchSemanticsNode().id)
      assertTrue(windowBounds(search).left >= hinge.right)
      assertTrue(windowBounds(composeRule.onNodeWithContentDescription("Search settings")).right <= hinge.left)
      emit(emptyList())
      search.assertIsNotDisplayed().assertIsNotFocused()
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      search.assertTextContains("retained search").assertIsDisplayed()
      assertEquals(editorId, search.fetchSemanticsNode().id)
      assertEquals("Keep search focus through the book and RTL transitions", listOf(true, true), focusedAfterMove)
    }
  }

  @Test
  @Config(qualifiers = "w1000dp-h500dp-mdpi")
  fun bookKeepsExpansionScrollSelectionAndSettingsBackRoute() {
    withRoot(completed = true) {
      val hinge = Rect(400, 0, 420, view.height)
      emit(listOf(testFold(hinge)))
      composeRule.onNodeWithText("Recent").performScrollTo().performClick()
      composeRule.onNodeWithText("Android QA").performScrollTo().assertIsDisplayed()
      val sidebarScroll = hasScrollAction() and hasAnyAncestor(hasTestTag("sidebar-permanent") or hasTestTag("sidebar-drawer"))
      val scroll =
        composeRule
          .onNode(sidebarScroll)
          .fetchSemanticsNode()
          .config[SemanticsProperties.VerticalScrollAxisRange]
          .value()
      assertTrue("Exercise a genuinely scrolled sidebar", scroll > 0f)
      emit(emptyList())
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      composeRule.onNodeWithText("Android QA").assertIsDisplayed()
      assertEquals(
        scroll,
        composeRule
          .onNode(sidebarScroll)
          .fetchSemanticsNode()
          .config[SemanticsProperties.VerticalScrollAxisRange]
          .value(),
      )
      emit(listOf(testFold(hinge)))
      assertEquals(
        scroll,
        composeRule
          .onNode(sidebarScroll)
          .fetchSemanticsNode()
          .config[SemanticsProperties.VerticalScrollAxisRange]
          .value(),
      )
      composeRule.onNode(hasText("Home") and hasAnyAncestor(hasTestTag("sidebar-permanent"))).performScrollTo().performClick()
      composeRule.onNodeWithTag("chat-composer-surface").assertIsDisplayed()
      composeRule.onNodeWithTag("sidebar-permanent").assertIsDisplayed()
      composeRule.onNode(hasText("Settings") and hasAnyAncestor(hasTestTag("sidebar-permanent"))).performScrollTo().performClick()
      composeRule
        .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))
        .performScrollToNode(hasText("Appearance"))
      composeRule.onNodeWithText("Appearance").performClick()
      composeRule.onNodeWithText("Theme family").assertIsDisplayed()
      emit(emptyList())
      emit(listOf(testFold(hinge)))
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
      composeRule.onNodeWithText("Theme family").assertDoesNotExist()
      composeRule.onNodeWithTag("sidebar-permanent").assertIsDisplayed()
    }
  }

  @Test
  fun bookModeCancelsOpeningAndClosingDrawerAnimationsWithoutStrandingBack() {
    withRoot(completed = true) {
      val hinge = Rect(400, 0, 420, view.height)
      Settings.Global.putFloat(view.context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
      composeRule.mainClock.autoAdvance = false
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      composeRule.mainClock.advanceTimeBy(32)
      emit(listOf(testFold(hinge)))
      composeRule.mainClock.autoAdvance = true
      composeRule.onNodeWithTag("sidebar-permanent").assertIsDisplayed()
      composeRule.onNodeWithContentDescription("Close navigation menu").assertDoesNotExist()
      composeRule.onNodeWithTag("sidebar-drawer").assertIsNotDisplayed()
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      composeRule.onNodeWithContentDescription("Search settings").assertDoesNotExist()
      emit(emptyList())
      composeRule.onNodeWithTag("sidebar-open-overview").performClick()
      composeRule.onNodeWithTag("sidebar-close").assertIsDisplayed()
      composeRule.onNodeWithContentDescription("Close navigation menu").assertIsDisplayed()
      composeRule.mainClock.autoAdvance = false
      composeRule.onNodeWithTag("sidebar-close").performClick()
      composeRule.mainClock.advanceTimeBy(32)
      emit(listOf(testFold(hinge)))
      composeRule.mainClock.autoAdvance = true
      composeRule.onNodeWithTag("sidebar-permanent").assertIsDisplayed()
      composeRule.onNodeWithTag("sidebar-drawer").assertIsNotDisplayed()
      Settings.Global.putFloat(view.context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      composeRule.onNode(hasText("Home") and hasAnyAncestor(hasTestTag("sidebar-permanent"))).performTouchInput { click() }
      composeRule.onNodeWithTag("chat-composer-surface").assertIsDisplayed()
      emit(emptyList())
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      composeRule.onNodeWithTag("sidebar-open-overview").assertIsDisplayed()
    }
  }

  @Test
  fun bookInterruptsPredictiveDrawerBackWithoutInterceptingPaneTapsOrRouteBack() {
    withRoot(completed = true) {
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      composeRule.onNodeWithTag("sidebar-close").assertIsDisplayed()
      composeRule.onNodeWithContentDescription("Close navigation menu").assertIsDisplayed()
      composeRule.runOnIdle {
        backDispatcher.dispatchOnBackStarted(BackEventCompat(0f, 300f, 0f, BackEventCompat.EDGE_LEFT))
        backDispatcher.dispatchOnBackProgressed(BackEventCompat(80f, 300f, 0.4f, BackEventCompat.EDGE_LEFT))
      }
      emit(listOf(testFold(Rect(400, 0, 420, view.height))))
      composeRule.runOnIdle { backDispatcher.dispatchOnBackCancelled() }
      val inactiveSheet = composeRule.onNodeWithTag("sidebar-drawer").assertIsNotDisplayed()
      assertTrue("The inactive sheet must retain real measured anchors", windowBounds(inactiveSheet).width() > 0)
      composeRule.onNodeWithContentDescription("Close navigation menu").assertDoesNotExist()
      composeRule.onNodeWithContentDescription("Open profile").performTouchInput { click() }
      composeRule.onNodeWithText("Save Profile").assertIsDisplayed()
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
      emit(emptyList())
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      composeRule.onNodeWithTag("sidebar-close").assertIsDisplayed()
      composeRule.runOnIdle {
        backDispatcher.dispatchOnBackStarted(BackEventCompat(0f, 300f, 0f, BackEventCompat.EDGE_LEFT))
        backDispatcher.dispatchOnBackProgressed(BackEventCompat(80f, 300f, 0.4f, BackEventCompat.EDGE_LEFT))
        backDispatcher.onBackPressed()
      }
      composeRule.onNodeWithTag("sidebar-close").assertIsNotDisplayed()
      composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
    }
  }

  @Test
  fun bookUsesSeparatingFlatButKeepsOrdinaryFlatAndUnusablePanesInFallback() {
    withRoot(completed = true) {
      val hinge = Rect(400, 0, 420, view.height)
      emit(listOf(testFold(hinge, state = FoldingFeature.State.FLAT)))
      composeRule.onNodeWithTag("sidebar-permanent").assertIsDisplayed()
      assertEquals(hinge.left, windowBounds(composeRule.onNodeWithTag("sidebar-permanent")).right)
      emit(listOf(testFold(Rect(300, 0, 300, view.height))))
      assertEquals("Use the actual plane even below the modal drawer's maximum width", 300, windowBounds(composeRule.onNodeWithTag("sidebar-permanent")).right)
      emit(listOf(testFold(hinge, separating = false, state = FoldingFeature.State.FLAT)))
      composeRule.onNodeWithTag("sidebar-permanent").assertDoesNotExist()
      composeRule.onNodeWithTag("sidebar-open-settings").assertIsDisplayed()
      for (bounds in listOf(Rect(250, 0, 270, view.height), Rect(690, 0, 710, view.height), Rect(0, 400, view.width, 420))) {
        emit(listOf(testFold(bounds)))
        composeRule.onNodeWithTag("sidebar-permanent").assertDoesNotExist()
        assertClearOfHinge(composeRule.onNodeWithTag("sidebar-open-settings"), bounds)
      }
    }
  }

  @Test
  fun bookTransitionCancelsHeldSidebarDragAndRestoresFlatDrawerGestures() {
    withRoot(completed = true) { model ->
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      val order = model.sidebarPageOrder.value
      composeRule.onNode(hasText("Home") and hasAnyAncestor(hasTestTag("sidebar-drawer"))).performTouchInput {
        down(center)
        advanceEventTime(viewConfiguration.longPressTimeoutMillis + 1L)
        moveBy(Offset(0f, 1f))
      }
      emit(listOf(testFold(Rect(400, 0, 420, view.height))))
      composeRule.onRoot().performTouchInput {
        moveBy(Offset(0f, 130f))
        up()
      }
      composeRule.runOnIdle { assertEquals("A stale drag must not reorder the new host", order, model.sidebarPageOrder.value) }
      emit(emptyList())
      composeRule.onNodeWithTag("sidebar-open-settings").performClick()
      composeRule.onNodeWithTag("sidebar-close").assertIsDisplayed()
      composeRule.onNodeWithTag("sidebar-drawer").performTouchInput { swipeLeft() }
      composeRule.onNodeWithTag("sidebar-close").assertIsNotDisplayed()
      composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
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
    if (!composeRule.mainClock.autoAdvance) composeRule.mainClock.advanceTimeBy(32)
    composeRule.waitForIdle()
  }

  private fun withRoot(
    completed: Boolean,
    destination: HomeDestination = HomeDestination.Settings,
    verify: (MainViewModel) -> Unit,
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
      if (completed) model.requestHomeDestination(destination)
      composeRule.setContent {
        val activity = requireNotNull(LocalActivity.current)
        view = LocalView.current
        focusManager = LocalFocusManager.current
        backDispatcher = requireNotNull(LocalOnBackPressedDispatcherOwner.current).onBackPressedDispatcher
        LaunchedEffect(activity) { WindowCompat.setDecorFitsSystemWindows(activity.window, false) }
        CompositionLocalProvider(LocalLayoutDirection provides direction) {
          RootScreen(model)
        }
      }
      composeRule.waitForIdle()
      val rootId = composeRule.onRoot().fetchSemanticsNode().id
      val host = composeRule.onNode(SemanticsMatcher("original activity content root") { it.id == rootId })
      val originalRoot = host.getUnclippedBoundsInRoot()
      verify(model)
      assertEquals("Only the pane may move, never the window host", originalRoot, host.getUnclippedBoundsInRoot())
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
