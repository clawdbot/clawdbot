package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawDesignTheme
import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Rect
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.interaction.Interaction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowInfoTrackerDecorator
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetrics
import androidx.window.layout.WindowMetricsCalculator
import androidx.window.layout.WindowMetricsCalculatorDecorator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
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
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowViewRootImpl
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FoldAwareDropdownMenuTest {
  @get:Rule val composeRule = createComposeRule()
  private val publisher = FeaturePublisher()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val interactionSource = MutableInteractionSource()
  private val interactions = mutableListOf<Interaction>()
  private val actions = mutableListOf<String>()
  private var dismissals = 0
  private var expanded by mutableStateOf(false)
  private var mounted by mutableStateOf(true)
  private var enabled by mutableStateOf(true)
  private var x by mutableStateOf(350.dp)
  private var y by mutableStateOf(80.dp)
  private var direction by mutableStateOf(LayoutDirection.Ltr)
  private var fontScale by mutableStateOf(1f)
  private var labels by mutableStateOf(listOf("Refresh", "Last action"))
  private lateinit var activity: Activity
  private lateinit var host: View
  private lateinit var lifecycle: LifecycleRegistry
  private var animatorScale: String? = null
  private var touchDownTime = 0L

  @Before
  @SuppressLint("RestrictedApi")
  fun setUp() {
    WindowInfoTracker.overrideDecorator(
      object : WindowInfoTrackerDecorator {
        override fun decorate(tracker: WindowInfoTracker): WindowInfoTracker =
          object : WindowInfoTracker by tracker {
            override fun windowLayoutInfo(activity: Activity) = publisher.observe()
          }
      },
    )
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    animatorScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  @SuppressLint("RestrictedApi")
  fun tearDown() {
    scope.cancel()
    WindowInfoTracker.reset()
    WindowMetricsCalculator.reset()
    Settings.Global.putString(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
  }

  @Test
  fun unsafeThenSafeBeforeDisposalRetiresHeldEnterButBenignGrowthAndFreshOpeningWork() {
    publisher.latest = WindowLayoutInfo(listOf(testFold(Rect(490, 0, 510, 800))))
    showMenu()
    open()
    val first = nativePopup()
    val before = screenBounds(first)
    holdKey(first, KeyEvent.KEYCODE_ENTER)
    val press = interactions.filterIsInstance<PressInteraction.Press>().single()
    val deliveries = publisher.deliveries
    onMain {
      publisher.publish(listOf(testFold(Rect(360, 0, 380, 800))))
      publisher.publish(listOf(testFold(Rect(490, 0, 510, 800))))
      assertEquals("Both publications reached the owner before UP", deliveries + 2, publisher.deliveries)
      assertTrue("The original popup must still be attached before UP", first.isAttachedToWindow)
      assertTrue("The original focused row must survive until UP", first.hasFocus())
      assertTrue("The original native window must retain focus before UP", first.hasWindowFocus())
      assertEquals(before, screenBounds(first))
      assertTrue(first.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER)))
      assertTrue("The owner must reject the stale action before deferred removal", actions.isEmpty())
      println("unsafe/safe pre-disposal UP: deliveries=${publisher.deliveries} attached=${first.isAttachedToWindow} focused=${first.hasFocus()} windowFocused=${first.hasWindowFocus()} actions=$actions")
    }
    composeRule.waitForIdle()
    assertEquals(1, dismissals)
    assertFalse(first.isAttachedToWindow)
    assertTrue("UP reached the still-live clickable, not an orphan key path", interactions.any { it is PressInteraction.Release && it.press === press })

    interactions.clear()
    open()
    val second = nativePopup()
    val admitted = screenBounds(second)
    holdKey(second, KeyEvent.KEYCODE_SPACE)
    onMain {
      publisher.publish(emptyList())
      assertTrue(second.isAttachedToWindow && second.hasFocus())
      assertTrue(second.hasWindowFocus())
      assertEquals("Growth must not resize or relocate the admitted menu", admitted, screenBounds(second))
      assertTrue(second.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SPACE)))
      assertEquals(listOf("0"), actions)
    }
    composeRule.waitForIdle()
    open()
    composeRule.onNodeWithText("Refresh").performClick()
    assertEquals(listOf("0", "0"), actions)
    assertEquals("Open/close must not create collectors", 1, publisher.registrations)
  }

  @Test
  fun actualNativeRectanglesFollowTheAnchorPaneForAllFeaturesAndRtl() {
    showMenu()

    data class Case(
      val x: Int,
      val y: Int,
      val rtl: Boolean,
      val features: List<DisplayFeature>,
      val pane: Rect,
    )
    val cases =
      listOf(
        Case(350, 80, false, emptyList(), Rect(0, 0, 1000, 800)),
        Case(350, 80, false, listOf(testFold(Rect(490, 0, 510, 800))), Rect(0, 0, 490, 800)),
        Case(80, 80, false, listOf(testFold(Rect(200, 0, 220, 800))), Rect(0, 0, 200, 800)),
        Case(850, 80, true, listOf(testFold(Rect(700, 0, 700, 800))), Rect(700, 0, 1000, 800)),
        Case(350, 80, false, listOf(testFold(Rect(0, 300, 1000, 320))), Rect(0, 0, 1000, 300)),
        Case(350, 450, true, listOf(testFold(Rect(490, 0, 510, 800)), testFold(Rect(0, 300, 1000, 320))), Rect(0, 320, 490, 800)),
        Case(350, 450, false, listOf(testFold(Rect(0, 300, 1000, 320)), testFold(Rect(490, 0, 510, 800))), Rect(0, 320, 490, 800)),
        Case(350, 400, false, listOf(testFold(Rect(490, 0, 510, 200))), Rect(0, 200, 1000, 800)),
        Case(350, 80, false, listOf(testFold(Rect(490, 0, 510, 800), separating = false, occlusion = FoldingFeature.OcclusionType.FULL)), Rect(0, 0, 490, 800)),
        Case(350, 80, false, listOf(testFold(Rect(490, 0, 490, 800), separating = false)), Rect(0, 0, 1000, 800)),
      )
    for (case in cases) {
      println("Native geometry case: $case")
      composeRule.runOnIdle {
        x = case.x.dp
        y = case.y.dp
        direction = if (case.rtl) LayoutDirection.Rtl else LayoutDirection.Ltr
      }
      onMain { publisher.publish(case.features) }
      open()
      val popup = nativePopup()
      val bounds = screenBounds(popup)
      assertTrue("Native menu $bounds must fit ${case.pane}", case.pane.contains(bounds))
      assertTrue(popup.layoutParams is WindowManager.LayoutParams)
      composeRule.onNodeWithText("Refresh").performClick()
      composeRule.waitForIdle()
      assertFalse(popup.isAttachedToWindow)
    }
    assertEquals(cases.size, actions.size)
  }

  @Test
  fun coldReadinessAndZeroViewportDeclineWithoutReopeningAndDisposalReleasesCollector() {
    publisher.latest = null
    showMenu()
    composeRule.onNodeWithTag("anchor").performClick()
    composeRule.waitForIdle()
    assertTrue(nativePopups().isEmpty())
    assertEquals(1, dismissals)
    onMain { publisher.publish(emptyList()) }
    composeRule.waitForIdle()
    assertTrue("First publication must not reopen a declined request", nativePopups().isEmpty())
    open()
    onMain { publisher.publish(listOf(testFold(Rect(0, 0, 1000, 800)))) }
    composeRule.waitForIdle()
    assertTrue(nativePopups().isEmpty())
    assertEquals(2, dismissals)
    onMain { publisher.publish(emptyList()) }
    composeRule.waitForIdle()
    assertTrue(nativePopups().isEmpty())
    open()
    val popup = nativePopup()
    composeRule.runOnIdle { mounted = false }
    composeRule.waitForIdle()
    assertFalse(popup.isAttachedToWindow)
    assertEquals(0, publisher.active)
    assertTrue(actions.isEmpty())
  }

  @Test
  fun wrappedRowsFitAndScrollWithoutGrowingOnBenignPublication() {
    labels = List(6) { "Wrapped action $it with a complete descriptive label" }
    fontScale = 2f
    x = 80.dp
    publisher.latest = WindowLayoutInfo(listOf(testFold(Rect(230, 0, 250, 800)), testFold(Rect(0, 390, 1000, 410))))
    showMenu()
    open()
    val popup = nativePopup()
    val before = screenBounds(popup)
    assertTrue(before.right <= 230 && before.bottom <= 390)
    labels.forEach { label ->
      val row = composeRule.onNodeWithText(label).performScrollTo().assertIsDisplayed()
      row.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action ->
        val results = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        assertTrue(action(results))
        assertTrue(results.all { !it.hasVisualOverflow && it.lineCount > 1 })
      }
    }
    onMain { publisher.publish(emptyList()) }
    composeRule.waitForIdle()
    assertSame(popup, nativePopup())
    assertEquals(before, screenBounds(popup))
    composeRule.onNodeWithText(labels.last()).performClick()
    assertEquals(listOf("5"), actions)
  }

  @Test
  fun touchReleaseAfterInvalidationIsRejectedWhileCancelDragBlankAndDisabledNeverAct() {
    publisher.latest = WindowLayoutInfo(listOf(testFold(Rect(490, 0, 510, 800))))
    showMenu()
    open()
    var root = nativePopup()
    var point = firstRowPoint()
    composeRule.runOnIdle { touch(root, MotionEvent.ACTION_DOWN, point) }
    composeRule.mainClock.advanceTimeBy(200)
    composeRule.waitForIdle()
    val press = interactions.filterIsInstance<PressInteraction.Press>().single()
    onMain {
      publisher.publish(listOf(testFold(Rect(360, 0, 380, 800))))
      publisher.publish(listOf(testFold(Rect(490, 0, 510, 800))))
      assertTrue(root.isAttachedToWindow)
      touch(root, MotionEvent.ACTION_UP, point)
      assertTrue(actions.isEmpty())
    }
    composeRule.waitForIdle()
    assertTrue(interactions.any { it is PressInteraction.Release && it.press === press })
    assertEquals(1, dismissals)

    open()
    root = nativePopup()
    point = firstRowPoint()
    for (cancel in listOf(true, false)) {
      interactions.clear()
      composeRule.runOnIdle { touch(root, MotionEvent.ACTION_DOWN, point) }
      composeRule.mainClock.advanceTimeBy(200)
      composeRule.waitForIdle()
      val held = interactions.filterIsInstance<PressInteraction.Press>().single()
      composeRule.runOnIdle {
        if (cancel) {
          touch(root, MotionEvent.ACTION_CANCEL, point)
        } else {
          val moved = Offset(point.x, root.height - 10f)
          touch(root, MotionEvent.ACTION_MOVE, moved)
          touch(root, MotionEvent.ACTION_UP, moved)
        }
      }
      composeRule.waitForIdle()
      assertTrue(interactions.any { it is PressInteraction.Cancel && it.press === held })
      assertTrue(actions.isEmpty())
      assertSame(root, nativePopup())
    }
    composeRule.runOnIdle {
      touch(root, MotionEvent.ACTION_DOWN, Offset(2f, 2f))
      touch(root, MotionEvent.ACTION_UP, Offset(2f, 2f))
    }
    composeRule.waitForIdle()
    assertEquals(1, dismissals)
    assertTrue(actions.isEmpty())
    composeRule.runOnIdle {
      touch(root, MotionEvent.ACTION_DOWN, point)
      touch(root, MotionEvent.ACTION_UP, point)
    }
    composeRule.waitForIdle()
    assertEquals(listOf("0"), actions)
    composeRule.runOnIdle { enabled = false }
    open()
    root = nativePopup()
    point = firstRowPoint()
    composeRule.runOnIdle {
      touch(root, MotionEvent.ACTION_DOWN, point)
      touch(root, MotionEvent.ACTION_UP, point)
    }
    composeRule.waitForIdle()
    assertEquals(listOf("0"), actions)
    assertSame(root, nativePopup())
  }

  @Test
  fun nativeWindowKeepsSecureFocusBackAndOutsideDownPolicy() {
    showMenu()
    composeRule.runOnIdle { activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    open()
    var root = nativePopup()
    val params = root.layoutParams as WindowManager.LayoutParams
    assertEquals(0, params.flags and (WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL))
    assertTrue(params.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    assertFalse("Non-editing menu must not become an IME target", WindowManager.LayoutParams.mayUseInputMethod(params.flags))
    composeRule.runOnIdle {
      assertTrue(root.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE)))
      assertTrue(root.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE)))
    }
    composeRule.waitForIdle()
    assertFalse(root.isAttachedToWindow)
    assertEquals(1, dismissals)
    open()
    root = nativePopup()
    composeRule.runOnIdle { touch(root, MotionEvent.ACTION_DOWN, Offset(-1f, -1f)) }
    composeRule.waitForIdle()
    assertFalse("Popup outside policy dismisses on DOWN without needing UP", root.isAttachedToWindow)
    assertEquals(2, dismissals)
    assertTrue(actions.isEmpty())
  }

  @Test
  fun actualWrappedRowFitAndClippedAnchorDeclineAndLayoutChangesTerminate() {
    labels = listOf("A long action that wraps into several measured lines", "Last action")
    fontScale = 2f
    x = 20.dp
    y = 10.dp
    publisher.latest = WindowLayoutInfo(listOf(testFold(Rect(180, 0, 200, 800)), testFold(Rect(0, 90, 1000, 110))))
    showMenu()
    composeRule.onNodeWithTag("anchor").performClick()
    composeRule.waitForIdle()
    assertTrue("Nominal 64dp is not enough for the actual wrapped row", nativePopups().isEmpty())
    assertEquals(1, dismissals)
    onMain { publisher.publish(emptyList()) }
    composeRule.waitForIdle()
    assertTrue(nativePopups().isEmpty())
    open()
    val first = nativePopup()
    composeRule.runOnIdle { labels = labels + "New action" }
    composeRule.waitForIdle()
    assertFalse(first.isAttachedToWindow)
    open()
    val second = nativePopup()
    composeRule.runOnIdle { fontScale = 1.5f }
    composeRule.waitForIdle()
    assertFalse(second.isAttachedToWindow)
    assertTrue(nativePopups().isEmpty())
    composeRule.runOnIdle {
      x = 1100.dp
      expanded = true
    }
    composeRule.waitForIdle()
    assertTrue("A wholly clipped anchor cannot authorize a native menu", nativePopups().isEmpty())
    assertFalse(expanded)
    assertTrue(actions.isEmpty())
  }

  @Test
  fun stoppedLifecycleReleasesWindowAndObserverAndRestartNeedsExplicitOpening() {
    showMenu()
    open()
    val old = nativePopup()
    composeRule.runOnIdle { lifecycle.currentState = Lifecycle.State.CREATED }
    composeRule.waitForIdle()
    assertFalse(old.isAttachedToWindow)
    assertEquals(0, publisher.active)
    composeRule.runOnIdle { lifecycle.currentState = Lifecycle.State.RESUMED }
    composeRule.waitForIdle()
    assertEquals(1, publisher.active)
    assertEquals(2, publisher.registrations)
    assertTrue(nativePopups().isEmpty())
    open()
    composeRule.onNodeWithText("Refresh").performClick()
    assertEquals(listOf("0"), actions)
  }

  @Test
  @SuppressLint("RestrictedApi")
  fun translatedStationaryHostUsesFullActivityExtentAndMovementRetiresHeldInput() {
    WindowMetricsCalculator.overrideDecorator(
      object : WindowMetricsCalculatorDecorator {
        override fun decorate(calculator: WindowMetricsCalculator): WindowMetricsCalculator =
          object : WindowMetricsCalculator by calculator {
            override fun computeCurrentWindowMetrics(activity: Activity): WindowMetrics {
              val metrics = calculator.computeCurrentWindowMetrics(activity)
              return WindowMetrics(Rect(metrics.bounds).apply { offset(300, 180) }, metrics.density)
            }
          }
      },
    )
    publisher.latest = WindowLayoutInfo(listOf(testFold(Rect(490, 0, 510, 800))))
    showMenu()
    composeRule.runOnIdle {
      host.translationX = 17f
      host.translationY = 11f
    }
    open()
    val popup = nativePopup()
    val bounds = screenBounds(popup)
    assertEquals(Rect(271, 131, 407, 243), bounds)
    holdKey(popup, KeyEvent.KEYCODE_ENTER)
    composeRule.runOnIdle {
      // No pre-draw/recomposition: the action gate must read the attached host again.
      host.translationX = 30f
      assertTrue(popup.isAttachedToWindow && popup.hasFocus())
      popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
      assertTrue(actions.isEmpty())
    }
    composeRule.waitForIdle()
    assertFalse(popup.isAttachedToWindow)
  }

  @Test
  fun deliveredNativeNavigationAndImeFactsBoundAdmissionAndRejectLateInput() {
    x = 80.dp
    y = 580.dp
    showMenu()
    composeRule.runOnIdle { deliverInsets(ime = 100) }
    open()
    val popup = nativePopup()
    val bounds = screenBounds(popup)
    assertTrue("The native popup must fit above the delivered IME", bounds.bottom <= 700)
    holdKey(popup, KeyEvent.KEYCODE_ENTER)
    composeRule.runOnIdle {
      deliverInsets(ime = 0)
      host.viewTreeObserver.dispatchOnPreDraw()
      assertTrue(popup.isAttachedToWindow && popup.hasFocus())
      assertEquals("IME disappearance must preserve the admitted rectangle", bounds, screenBounds(popup))
      popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
      assertEquals(listOf("0"), actions)
    }
    composeRule.waitForIdle()
    open()
    val next = nativePopup()
    interactions.clear()
    holdKey(next, KeyEvent.KEYCODE_SPACE)
    composeRule.runOnIdle {
      deliverInsets(ime = 400)
      // An action can arrive before the next pre-draw publication.
      assertTrue(next.isAttachedToWindow && next.hasFocus())
      next.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SPACE))
      assertEquals(listOf("0"), actions)
    }
    composeRule.waitForIdle()
    assertFalse(next.isAttachedToWindow)
  }

  private fun showMenu() {
    composeRule.setContent {
      val currentActivity = requireNotNull(LocalActivity.current)
      val currentHost = LocalView.current
      val currentDensity = LocalDensity.current
      val currentLifecycle = LocalLifecycleOwner.current.lifecycle
      SideEffect {
        activity = currentActivity
        host = currentHost
        lifecycle = currentLifecycle as LifecycleRegistry
      }
      LaunchedEffect(interactionSource) {
        interactionSource.interactions.collect { interactions.add(it) }
      }
      CompositionLocalProvider(
        LocalLayoutDirection provides direction,
        LocalDensity provides Density(currentDensity.density, fontScale),
      ) {
        ClawDesignTheme {
          Box(Modifier.fillMaxSize(), contentAlignment = AbsoluteAlignment.TopLeft) {
            if (mounted) {
              Box(Modifier.absoluteOffset(x, y).size(40.dp)) {
                TextButton(onClick = { expanded = true }, modifier = Modifier.testTag("anchor")) { Text("Open") }
                FoldAwareDropdownMenu(
                  expanded = expanded,
                  onDismissRequest = {
                    dismissals++
                    expanded = false
                  },
                  items =
                    labels.mapIndexed { index, label ->
                      FoldAwareMenuItem(
                        id = index.toString(),
                        label = label,
                        icon = Icons.Default.Refresh,
                        enabled = enabled,
                        interactionSource = if (index == 0) interactionSource else null,
                        onClick = { actions.add(index.toString()) },
                      )
                    },
                )
              }
            }
          }
        }
      }
    }
    composeRule.waitForIdle()
    assertEquals(1, publisher.active)
  }

  private fun open() {
    composeRule.onNodeWithTag("anchor").performClick()
    composeRule.waitForIdle()
    println("Opening: expanded=$expanded dismissals=$dismissals anchor=${composeRule.onNodeWithTag("anchor").getUnclippedBoundsInRoot()} native=${nativePopups().map(::screenBounds)}")
    composeRule.onNodeWithText(labels.first()).assertIsDisplayed()
    assertEquals(1, nativePopups().size)
  }

  private fun holdKey(
    root: View,
    key: Int,
  ) {
    composeRule.runOnIdle {
      // Robolectric does not automatically transfer native focus to an added Popup.
      deliverWindowFocus(activity.window.decorView, false)
      deliverWindowFocus(root, true)
      root.requestFocusFromTouch()
      assertFalse("The native keyboard fixture must leave touch mode", root.isInTouchMode)
    }
    composeRule.waitForIdle()
    composeRule.onNodeWithText(labels.first()).performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
    composeRule.onNodeWithText(labels.first()).assertIsFocused()
    composeRule.runOnIdle {
      assertTrue(root.hasFocus())
      assertTrue("Native focus must be delivered before DOWN", root.hasWindowFocus())
      assertTrue(root.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key)))
    }
    composeRule.waitForIdle()
    assertEquals(1, interactions.filterIsInstance<PressInteraction.Press>().size)
  }

  private fun deliverWindowFocus(
    view: View,
    focused: Boolean,
  ) {
    val attachInfo = ReflectionHelpers.getField<Any>(view, "mAttachInfo")
    val root = ReflectionHelpers.getField<Any>(attachInfo, "mViewRootImpl")
    Shadow.extract<ShadowViewRootImpl>(root).callWindowFocusChanged(focused)
  }

  private fun firstRowPoint(): Offset =
    composeRule
      .onNodeWithText(labels.first())
      .fetchSemanticsNode()
      .boundsInRoot.center

  private fun touch(
    root: View,
    action: Int,
    point: Offset,
  ) {
    if (action == MotionEvent.ACTION_DOWN) touchDownTime = SystemClock.uptimeMillis()
    val event = MotionEvent.obtain(touchDownTime, SystemClock.uptimeMillis(), action, point.x, point.y, 0)
    try {
      root.dispatchTouchEvent(event)
    } finally {
      event.recycle()
    }
  }

  private fun deliverInsets(ime: Int) {
    val insets =
      WindowInsetsCompat
        .Builder()
        .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, 24))
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, ime))
        .setVisible(WindowInsetsCompat.Type.ime(), ime > 0)
        .build()
    // Robolectric dispatch does not populate ViewRootImpl's native last-delivered cache.
    val attachInfo = ReflectionHelpers.getField<Any>(host, "mAttachInfo")
    val root = ReflectionHelpers.getField<Any>(attachInfo, "mViewRootImpl")
    ReflectionHelpers.setField(root, "mLastWindowInsets", insets.toWindowInsets())
    ViewCompat.dispatchApplyWindowInsets(activity.window.decorView, insets)
    assertEquals(ime, ViewCompat.getRootWindowInsets(host)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom)
    assertEquals(24, ViewCompat.getRootWindowInsets(host)?.getInsets(WindowInsetsCompat.Type.navigationBars())?.bottom)
  }

  private fun onMain(block: suspend () -> Unit) {
    lateinit var result: Deferred<Unit>
    composeRule.runOnUiThread { result = scope.async { block() } }
    composeRule.waitUntil { result.isCompleted }
    runBlocking { result.await() }
  }

  private fun nativePopups(): List<View> =
    WindowInspector.getGlobalWindowViews().filter {
      it.isAttachedToWindow && (it.layoutParams as? WindowManager.LayoutParams)?.type == WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL
    }

  private fun nativePopup(): View = nativePopups().single()

  private fun screenBounds(view: View): Rect {
    val position = IntArray(2).also(view::getLocationOnScreen)
    return Rect(position[0], position[1], position[0] + view.width, position[1] + view.height)
  }

  private class FeaturePublisher {
    private data class Publication(
      val layout: WindowLayoutInfo,
      val delivered: CompletableDeferred<Unit> = CompletableDeferred(),
    )

    private val subscribers = mutableSetOf<Channel<Publication>>()
    var latest: WindowLayoutInfo? = WindowLayoutInfo(emptyList())
    var registrations = 0
    var deliveries = 0
    val active get() = subscribers.size

    fun observe(): Flow<WindowLayoutInfo> =
      flow {
        val channel = Channel<Publication>(Channel.UNLIMITED)
        subscribers.add(channel)
        registrations++
        try {
          latest?.let { emit(it) }
          for (publication in channel) {
            emit(publication.layout)
            deliveries++
            publication.delivered.complete(Unit)
          }
        } finally {
          subscribers.remove(channel)
          channel.close()
        }
      }

    suspend fun publish(features: List<DisplayFeature>) {
      val layout = WindowLayoutInfo(features)
      latest = layout
      val publications = subscribers.map { channel -> Publication(layout).also { channel.send(it) } }
      publications.forEach { it.delivered.await() }
    }
  }
}
