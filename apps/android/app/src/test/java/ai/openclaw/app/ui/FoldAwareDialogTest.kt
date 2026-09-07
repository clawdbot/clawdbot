package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.ComponentDialog
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.window.layout.DisplayFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowInfoTrackerDecorator
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetrics
import androidx.window.layout.WindowMetricsCalculator
import androidx.window.layout.WindowMetricsCalculatorDecorator
import com.google.mlkit.common.internal.MlKitInitProvider
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowDialog
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.io.FileNotFoundException
import java.util.Base64
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(minSdk = 34, maxSdk = 34, qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FoldAwareDialogTest {
  @get:Rule val composeRule = createComposeRule()

  private val layouts = MutableStateFlow(WindowLayoutInfo(emptyList()))
  private lateinit var activity: Activity
  private lateinit var activityView: View
  private var direction by mutableStateOf(LayoutDirection.Ltr)
  private var fontScale by mutableStateOf(1f)
  private val callbacks = mutableListOf<String>()
  private var underlyingClicks = 0

  @Before
  @SuppressLint("RestrictedApi")
  fun installWindowTracker() {
    WindowInfoTracker.overrideDecorator(
      object : WindowInfoTrackerDecorator {
        override fun decorate(tracker: WindowInfoTracker): WindowInfoTracker =
          object : WindowInfoTracker by tracker {
            override fun windowLayoutInfo(activity: Activity): Flow<WindowLayoutInfo> = layouts
          }
      },
    )
    Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  @SuppressLint("RestrictedApi")
  fun resetWindowTracker() {
    WindowInfoTracker.reset()
    WindowMetricsCalculator.reset()
  }

  @Test
  fun trustActionInSeparateWindowAvoidsTheActivityFold() {
    setContent { TrustPrompt() }
    val dialog = latestDialog()
    assertNotSame(activity.window, dialog.window)
    val action = composeRule.onNodeWithText("Trust and continue").assertIsDisplayed()
    capture("trust-flat")
    val before = screenBounds(action, dialogView(dialog))
    val activityOrigin = windowOrigin(activityView)
    val extent = WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(activity).bounds
    val foldX = before.centerX() - activityOrigin[0]
    val hinge = Rect(foldX - 10, 0, foldX + 10, extent.height())
    val screenHinge = Rect(hinge).apply { offset(activityOrigin[0], activityOrigin[1]) }
    assertTrue("The original trust action must cross the emitted fold", Rect.intersects(before, screenHinge))

    emit(listOf(testFold(hinge)))
    capture("trust-fold")

    val underlying = screenBounds(composeRule.onNodeWithText("Underlying activity"), activityView)
    assertFalse("The Activity fixture must already avoid the hinge", Rect.intersects(underlying, screenHinge))
    val after = screenBounds(action.assertIsDisplayed(), dialogView(dialog))
    assertTrue("The separate-window control must have real geometry", after.width() > 0 && after.height() > 0)
    assertFalse("Trust action overlaps Activity fold: action=$after fold=$screenHinge", Rect.intersects(after, screenHinge))
  }

  @Test
  @SuppressLint("RestrictedApi")
  fun fullActivityPaneSelectionUsesPhysicalCoordinatesAndEverySeparator() {
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
    setContent { TrustPrompt() }
    val dialog = latestDialog()
    val window = dialog.window
    val flat = screenBounds(prompt(), dialogView(dialog))
    val cases =
      listOf(
        emptyList<DisplayFeature>() to Rect(0, 0, 1000, 1000),
        listOf(testFold(Rect(490, 0, 510, 1000))) to Rect(0, 0, 490, 1000),
        listOf(testFold(Rect(0, 490, 1000, 510))) to Rect(0, 0, 1000, 490),
        listOf(testFold(Rect(200, 0, 220, 1000))) to Rect(220, 0, 1000, 1000),
        listOf(testFold(Rect(0, 200, 1000, 220))) to Rect(0, 220, 1000, 1000),
        listOf(testFold(Rect(500, 0, 500, 1000))) to Rect(0, 0, 500, 1000),
        listOf(testFold(Rect(0, 500, 1000, 500))) to Rect(0, 0, 1000, 500),
        listOf(testFold(Rect(1100, 0, 1120, 1000))) to Rect(0, 0, 1000, 1000),
        listOf(testFold(Rect(500, 0, 500, 1000), separating = false)) to Rect(0, 0, 1000, 1000),
        listOf(
          testFold(Rect(400, 0, 420, 1000)),
          testFold(Rect(650, 0, 670, 1000)),
          testFold(Rect(800, 0, 820, 1000)),
        ) to Rect(0, 0, 400, 1000),
      )
    for ((features, pane) in cases) {
      emit(features)
      assertInside(screenBounds(prompt(), dialogView(dialog)), pane)
      if (pane == Rect(0, 0, 1000, 1000)) assertEquals(flat, screenBounds(prompt(), dialogView(dialog)))
      assertSame(window, latestDialog().window)
    }

    composeRule.runOnIdle { direction = LayoutDirection.Rtl }
    emit(listOf(testFold(Rect(490, 0, 510, 1000))))
    assertInside(screenBounds(prompt(), dialogView(dialog)), Rect(510, 0, 1000, 1000))

    // Exercise independent native-window origins and a nonzero stationary Compose host origin.
    // These are Android AttachInfo coordinates, not an injected production geometry function.
    for ((activityX, dialogX) in listOf(120 to 40, 180 to 70)) {
      composeRule.runOnIdle {
        setWindowOrigin(activityView, activityX, 90)
        checkNotNull(dialog.window).attributes =
          checkNotNull(dialog.window).attributes.apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = dialogX
            y = 30
          }
        dialogView(dialog).translationX = 17f
        dialogView(dialog).translationY = 11f
        activityView.viewTreeObserver.dispatchOnPreDraw()
        dialogView(dialog).viewTreeObserver.dispatchOnPreDraw()
      }
      composeRule.waitForIdle()
      assertEquals(listOf(activityX, 90), windowOrigin(activityView).toList())
      assertEquals(listOf(dialogX, 30), windowOrigin(dialogView(dialog)).toList())
      assertInside(screenBounds(prompt(), dialogView(dialog)), Rect(510 + activityX, 90, 1000 + activityX, 1090))
      assertSame(window, latestDialog().window)
    }
    assertTrue(callbacks.isEmpty())
  }

  @Test
  fun manualDraftFocusAndWindowSurvivePostureAndDeliveredDialogInsetsIncludingZeroHeight() {
    fontScale = 1.5f
    setContent {
      TrustPrompt(
        trustPrompt.copy(
          fingerprintSha256 = null,
          probeFailure = GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT,
          systemTrustAvailable = true,
        ),
      )
    }
    val dialog = latestDialog()
    val textLayouts = mutableListOf<TextLayoutResult>()
    composeRule.onNodeWithText("Trust this gateway?").performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
      assertTrue(it(textLayouts))
    }
    assertEquals(
      1.5f,
      textLayouts
        .single()
        .layoutInput.density.fontScale,
      0f,
    )
    val window = dialog.window
    val input = composeRule.onNode(hasSetTextAction())
    input.performScrollTo().performClick().performTextReplacement("ab".repeat(12))
    val editorId = input.fetchSemanticsNode().id
    val postures =
      listOf(
        emptyList(),
        listOf(testFold(Rect(490, 0, 510, 1000))),
        listOf(testFold(Rect(0, 200, 1000, 220))),
        emptyList(),
      )
    for (features in postures) {
      emit(features)
      for (ime in listOf(0, 320, 900, 0)) {
        keyboard(dialog, ime)
        assertSame(dialog, latestDialog())
        assertSame(window, latestDialog().window)
        input.assertTextContains("ab".repeat(12)).assertIsFocused()
        assertEquals(editorId, input.fetchSemanticsNode().id)
        assertEquals(1, ShadowDialog.getShownDialogs().count { it.isShowing })
        assertTrue("Fold/IME changes must never answer the prompt", callbacks.isEmpty())
        val viewport = screenBounds(composeRule.onNode(hasScrollAction()), dialogView(dialog))
        if (features == postures[2] && ime == 900) {
          assertEquals("Keep the selected bottom pane, even when the IME covers it completely", 0, viewport.height())
        } else {
          composeRule.onNodeWithText("Trust and continue").performScrollTo().assertIsDisplayed()
          val action = screenBounds(composeRule.onNodeWithText("Trust and continue"), dialogView(dialog))
          assertTrue("The action must remain above the dialog's keyboard/navigation inset: $action", action.bottom <= 1000 - maxOf(ime, 24))
        }
      }
    }
    input.performScrollTo().assertIsDisplayed().assertIsFocused()
    assertTrue(callbacks.isEmpty())
  }

  @Test
  fun changedCertificateAndAllThreeActionsAreReachableByScrollingAtLargeFont() {
    fontScale = 2f
    setContent {
      TrustPrompt(trustPrompt.copy(previousFingerprintSha256 = "cd".repeat(32), systemTrustAvailable = true))
    }
    val dialog = latestDialog()
    val textLayouts = mutableListOf<TextLayoutResult>()
    composeRule.onNodeWithText("Trust this gateway?").performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
      assertTrue(it(textLayouts))
    }
    assertEquals(
      2f,
      textLayouts
        .single()
        .layoutInput.density.fontScale,
      0f,
    )
    emit(listOf(testFold(Rect(490, 0, 510, 1000)), testFold(Rect(0, 490, 1000, 510))))
    val scroll = composeRule.onNode(hasScrollAction())
    val message = composeRule.onNodeWithText("Old SHA-256:", substring = true)
    composeRule.onNodeWithText("Trust this gateway?").performScrollTo().assertIsDisplayed()
    val before = message.getUnclippedBoundsInRoot()
    scroll.performTouchInput { swipeUp() }
    assertTrue("A real swipe must move the certificate content", message.getUnclippedBoundsInRoot().top < before.top)
    for (label in listOf("Use system trust", "Cancel", "Trust and continue")) {
      val action = composeRule.onNodeWithText(label).performScrollTo().assertIsDisplayed()
      assertInside(screenBounds(action, dialogView(dialog)), Rect(0, 0, 490, 490))
      action.performClick()
    }
    assertEquals(listOf("system", "decline", "accept:null"), callbacks)
    composeRule.onNodeWithText("Trust this gateway?").performScrollTo().assertIsDisplayed()
  }

  @Test
  fun nativeModalHonorsBackOutsideFlagsCancellationDraggingAndInteriorScroll() {
    var backEnabled by mutableStateOf(false)
    var outsideEnabled by mutableStateOf(false)
    setContent {
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      FoldAwareDialog(
        title = "Modal prompt",
        onDismissRequest = { callbacks.add("dismiss") },
        dismissOnBackPress = backEnabled,
        dismissOnClickOutside = outsideEnabled,
      ) {
        Surface(Modifier.fillMaxWidth().height(280.dp)) {
          Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp)) {
            repeat(30) { Text("Prompt line $it") }
          }
        }
      }
    }
    emit(listOf(testFold(Rect(490, 0, 510, 1000))))
    val dialog = latestDialog()
    val flags = checkNotNull(dialog.window).attributes.flags
    assertEquals(0, flags and (WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE))
    assertTrue(flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    assertEquals(WindowManager.LayoutParams.MATCH_PARENT, dialog.window?.attributes?.width)
    assertEquals(WindowManager.LayoutParams.MATCH_PARENT, dialog.window?.attributes?.height)
    composeRule.runOnIdle { dialog.onBackPressedDispatcher.onBackPressed() }
    gesture(dialog, 750f to 100f)
    gesture(dialog, 250f to 10f)
    assertTrue(callbacks.isEmpty())

    composeRule.runOnIdle { outsideEnabled = true }
    gesture(dialog, 750f to 100f, cancel = true)
    gesture(dialog, 750f to 100f, end = 850f to 200f)
    val bounds = screenBounds(prompt("Modal prompt"), dialogView(dialog))
    gesture(dialog, (bounds.left + 4f) to (bounds.top + 4f))
    gesture(dialog, bounds.exactCenterX() to bounds.exactCenterY(), end = 750f to 100f)
    composeRule.onNodeWithText("Prompt line 0").performScrollTo()
    val firstLine = composeRule.onNodeWithText("Prompt line 0").getUnclippedBoundsInRoot()
    composeRule.onNode(hasScrollAction()).performTouchInput { swipeUp() }
    assertTrue(composeRule.onNodeWithText("Prompt line 0").getUnclippedBoundsInRoot().top < firstLine.top)
    assertTrue(callbacks.isEmpty())
    assertEquals(0, underlyingClicks)

    gesture(dialog, 750f to 100f)
    assertEquals(listOf("dismiss"), callbacks)
    composeRule.runOnIdle { backEnabled = true }
    composeRule.runOnIdle { dialog.onBackPressedDispatcher.onBackPressed() }
    assertEquals(listOf("dismiss", "dismiss"), callbacks)
    assertEquals(0, underlyingClicks)
    assertSame(dialog, latestDialog())
  }

  @Test
  fun activityAndDensityReplacementReleaseTheirOldNativeWindowsWithoutCallbacks() {
    val first = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val second = Robolectric.buildActivity(ComponentActivity::class.java).setup()

    fun show(owner: ComponentActivity) {
      owner.setContent {
        CompositionLocalProvider(LocalDensity provides Density(1f, fontScale)) {
          ClawDesignTheme { TrustPrompt() }
        }
      }
    }
    try {
      composeRule.runOnUiThread { show(first.get()) }
      composeRule.waitForIdle()
      val original = latestDialog()
      composeRule.runOnIdle { fontScale = 1.5f }
      composeRule.waitForIdle()
      val densityReplacement = latestDialog()
      assertNotSame(original, densityReplacement)
      assertFalse(original.isShowing)
      assertTrue(densityReplacement.isShowing)
      composeRule.runOnIdle { first.pause().stop().destroy() }
      assertFalse(densityReplacement.isShowing)
      composeRule.runOnUiThread { show(second.get()) }
      composeRule.waitForIdle()
      assertNotSame(densityReplacement.window, latestDialog().window)
      assertEquals(1, ShadowDialog.getShownDialogs().count { it.isShowing })
      assertTrue(callbacks.isEmpty())
    } finally {
      composeRule.runOnUiThread {
        if (!first.get().isDestroyed) first.pause().stop().destroy()
        second.pause().stop().destroy()
      }
    }
  }

  @Test
  @Config(shadows = [UnreadableGalleryImage::class])
  fun scanErrorKeepsIllustrationMessageAndChoicesReachableWithoutLeavingThePane() {
    fontScale = 2f
    withModel { model, _ ->
      Robolectric.buildContentProvider(MlKitInitProvider::class.java).create()
      setContent { OnboardingFlow(model) }
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("Scan QR or setup code").performClick()
      composeRule.onNodeWithText("Choose from gallery").performClick()

      fun returnUnreadableImage() {
        val uri = Uri.parse("content://ai.openclaw.fixture/missing-image")
        val request = checkNotNull(shadowOf(activity).nextStartedActivityForResult)
        assertEquals(Intent.ACTION_GET_CONTENT, request.intent.action)
        composeRule.runOnIdle {
          assertTrue(
            (activity as ComponentActivity).activityResultRegistry.dispatchResult(
              request.requestCode,
              Activity.RESULT_OK,
              Intent().setData(uri),
            ),
          )
        }
        composeRule.waitForIdle()
      }
      returnUnreadableImage()
      inDialog("QR code not accepted").assertExists()
      val first = latestDialog()
      emit(listOf(testFold(Rect(490, 0, 510, 1000)), testFold(Rect(0, 490, 1000, 510))))
      composeRule.onNodeWithText("QR code not accepted").performScrollTo().assertIsDisplayed()
      capture("scan-error-title")
      for (label in listOf("Choose another image", "Enter setup code")) {
        val action = inDialog(label).performScrollTo().assertIsDisplayed()
        assertInside(screenBounds(action, dialogView(first)), Rect(0, 0, 490, 490))
      }
      capture("scan-error-actions")
      inDialog("Choose another image").performScrollTo().performClick()
      composeRule.waitForIdle()
      assertFalse(first.isShowing)
      returnUnreadableImage()
      val second = latestDialog()
      assertNotSame(first, second)
      inDialog("Enter setup code").performScrollTo().performClick()
      composeRule.waitForIdle()
      assertFalse(second.isShowing)
      composeRule.onNode(hasSetTextAction() and hasText("Paste setup code")).assertIsDisplayed()
      assertNull("Choosing another image must launch the picker only once", shadowOf(activity).nextStartedActivityForResult)
    }
  }

  // Robolectric's default MediaStore shadow always returns a bitmap, even for missing files.
  @Implements(MediaStore.Images.Media::class)
  class UnreadableGalleryImage {
    companion object {
      @JvmStatic
      @Implementation
      @Suppress("UNUSED_PARAMETER")
      fun getBitmap(
        resolver: ContentResolver,
        uri: Uri,
      ): Bitmap {
        check(uri.authority == "ai.openclaw.fixture")
        throw FileNotFoundException("Synthetic unreadable image")
      }
    }
  }

  @Test
  fun settingsConfirmationsScrollLongNamesAndKeepCancellationLocal() {
    fontScale = 2f
    withModel { model, prefs ->
      val name = "A long synthetic gateway name ".repeat(12).trim()
      val endpoint = GatewayEndpoint.manual("gateway.test", 443, true)
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, name, "gateway.test", 443),
      )
      setContent { SettingsDetailScreen(model, SettingsRoute.Gateway, onBack = {}) }
      composeRule.onNodeWithText("Forget").performScrollTo().performClick()
      inDialog("Forget gateway?").assertExists()
      val dialog = latestDialog()
      emit(listOf(testFold(Rect(490, 0, 510, 1000)), testFold(Rect(0, 490, 1000, 510))))
      inDialog("Forget gateway?").performScrollTo().assertIsDisplayed()
      composeRule.onNode(hasText(name, substring = true) and hasAnyAncestor(isDialog())).assertExists()
      for (label in listOf("Cancel", "Forget")) {
        val action = inDialog(label).performScrollTo().assertIsDisplayed()
        assertInside(screenBounds(action, dialogView(dialog)), Rect(0, 0, 490, 490))
      }
      inDialog("Cancel").performScrollTo().performClick()
      composeRule.waitForIdle()
      assertFalse(dialog.isShowing)
      assertEquals(
        name,
        prefs.gatewayRegistry.entries.value
          .single()
          .name,
      )

      emit(emptyList())
      val setupCode = Base64.getEncoder().encodeToString("""{"url":"wss://gateway.test","bootstrapToken":"synthetic-bootstrap"}""".toByteArray())
      composeRule.onNode(hasSetTextAction() and hasText("Setup code")).performScrollTo().performTextReplacement(setupCode)
      composeRule.onNodeWithText("Connect").performScrollTo().performClick()
      val replace = latestDialog()
      emit(listOf(testFold(Rect(0, 490, 1000, 510))))
      for (label in listOf("Replace gateway setup?", "Cancel", "Replace setup")) {
        val item = inDialog(label).performScrollTo().assertIsDisplayed()
        assertInside(screenBounds(item, dialogView(replace)), Rect(0, 0, 1000, 490))
      }
      inDialog("Cancel").performScrollTo().performClick()
      composeRule.waitForIdle()
      assertFalse(replace.isShowing)
      assertEquals(
        name,
        prefs.gatewayRegistry.entries.value
          .single()
          .name,
      )
      assertTrue(prefs.loadGatewayCredentials(endpoint.stableId).bootstrapToken.isNullOrEmpty())
    }
  }

  private fun withModel(verify: (MainViewModel, SecurePrefs) -> Unit) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("dialog-fold-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    try {
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("dialog-fold", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      verify(model, prefs)
    } finally {
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }

  private fun inDialog(text: String): SemanticsNodeInteraction = composeRule.onNode(hasText(text) and hasAnyAncestor(isDialog()))

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_FOLD_PROOF_DIR") ?: return
    val image = composeRule.onNode(isDialog()).captureToImage().asAndroidBitmap()
    File(directory, "$name.png").outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }

  private fun setContent(content: @Composable () -> Unit) {
    RuntimeEnvironment.setFontScale(fontScale)
    composeRule.setContent {
      activity = requireNotNull(LocalActivity.current)
      activityView = LocalView.current
      CompositionLocalProvider(
        LocalLayoutDirection provides direction,
      ) {
        ClawDesignTheme {
          FoldAwareContent(rememberWindowDisplayFeatures()) {
            TextButton(onClick = { underlyingClicks++ }, modifier = Modifier.fillMaxWidth()) { Text("Underlying activity") }
            content()
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  @Composable
  private fun TrustPrompt(value: NodeRuntime.GatewayTrustPrompt = trustPrompt) {
    GatewayTrustDialog(
      prompt = value,
      confirmLabel = "Trust and continue",
      cancelLabel = "Cancel",
      onAccept = { callbacks.add("accept:$it") },
      onUseSystemTrust = { callbacks.add("system") },
      onDecline = { callbacks.add("decline") },
    )
  }

  private fun prompt(title: String = "Trust this gateway?"): SemanticsNodeInteraction = composeRule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, title), useUnmergedTree = true)

  private fun assertInside(
    child: Rect,
    pane: Rect,
  ) {
    assertTrue("Prompt/control must have positive size: $child", child.width() > 0 && child.height() > 0)
    assertTrue("Prompt/control $child must fit the selected physical pane $pane", pane.contains(child))
  }

  private fun setWindowOrigin(
    view: View,
    x: Int,
    y: Int,
  ) {
    val attachInfo = ReflectionHelpers.getField<Any>(view, "mAttachInfo")
    ReflectionHelpers.setField(attachInfo, "mWindowLeft", x)
    ReflectionHelpers.setField(attachInfo, "mWindowTop", y)
  }

  private fun keyboard(
    dialog: ComponentDialog,
    bottom: Int,
  ) {
    composeRule.runOnIdle {
      ViewCompat.dispatchApplyWindowInsets(
        checkNotNull(dialog.window).decorView,
        WindowInsetsCompat
          .Builder()
          .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, 24))
          .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, bottom))
          .setVisible(WindowInsetsCompat.Type.ime(), bottom > 0)
          .build(),
      )
    }
    composeRule.waitForIdle()
  }

  private fun gesture(
    dialog: ComponentDialog,
    start: Pair<Float, Float>,
    end: Pair<Float, Float> = start,
    cancel: Boolean = false,
  ) {
    composeRule.runOnIdle {
      val time = SystemClock.uptimeMillis()

      fun send(
        action: Int,
        point: Pair<Float, Float>,
        elapsed: Long,
      ) {
        val event = MotionEvent.obtain(time, time + elapsed, action, point.first, point.second, 0)
        try {
          dialog.dispatchTouchEvent(event)
        } finally {
          event.recycle()
        }
      }
      send(MotionEvent.ACTION_DOWN, start, 0)
      if (end != start) send(MotionEvent.ACTION_MOVE, end, 30)
      send(if (cancel) MotionEvent.ACTION_CANCEL else MotionEvent.ACTION_UP, end, 60)
    }
    composeRule.waitForIdle()
  }

  private fun emit(features: List<DisplayFeature>) {
    composeRule.runOnIdle { layouts.value = WindowLayoutInfo(features) }
    composeRule.waitForIdle()
  }

  private fun latestDialog(): ComponentDialog {
    composeRule.waitForIdle()
    return checkNotNull(ShadowDialog.getLatestDialog()) as ComponentDialog
  }

  private fun dialogView(dialog: ComponentDialog): View {
    fun find(view: View): View? {
      if (view.parent is DialogWindowProvider) return view
      if (view is ViewGroup) {
        for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
      }
      return null
    }
    return checkNotNull(find(checkNotNull(dialog.window).decorView))
  }

  private fun windowOrigin(view: View): IntArray {
    val screen = IntArray(2).also(view::getLocationOnScreen)
    val window = IntArray(2).also(view::getLocationInWindow)
    return intArrayOf(screen[0] - window[0], screen[1] - window[1])
  }

  private fun screenBounds(
    node: SemanticsNodeInteraction,
    view: View,
  ): Rect {
    val bounds = node.getUnclippedBoundsInRoot()
    val origin = IntArray(2).also(view::getLocationOnScreen)
    val density = composeRule.density.density
    return Rect(
      (bounds.left.value * density).toInt() + origin[0],
      (bounds.top.value * density).toInt() + origin[1],
      (bounds.right.value * density).toInt() + origin[0],
      (bounds.bottom.value * density).toInt() + origin[1],
    )
  }

  private val trustPrompt =
    NodeRuntime.GatewayTrustPrompt(
      endpoint = GatewayEndpoint(stableId = "test-gateway", name = "Test gateway", host = "gateway.test", port = 443),
      fingerprintSha256 = "ab".repeat(32),
      auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null),
    )
}
