package ai.openclaw.app.ui.popup

import ai.openclaw.app.NodeApp
import ai.openclaw.app.ui.OpenClawTheme
import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.WindowManager
import androidx.compose.foundation.layout.width
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner

private const val TAG = "PopupOverlayWindow"
private const val CARD_WIDTH_DP = 340
private const val BOTTOM_MARGIN_DP = 32

/**
 * Floating card shown while the screen is unlocked, so overlay-notify popups appear
 * automatically even when the app is fully backgrounded. Full-screen-intent
 * (PopupOverlayActivity) only auto-launches while the device is locked — see
 * SystemHandler.resolvePopupDeliveryMode for the branch that picks between the two.
 * Requires the SYSTEM_ALERT_WINDOW special-access grant (Settings.canDrawOverlays).
 */
internal class PopupOverlayWindow(
  private val app: NodeApp,
) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var attached: AttachedView? = null

  fun show(
    title: String,
    subtitle: String?,
    body: String,
    timestampMillis: Long,
  ) {
    runOnMain { showOnMain(title, subtitle, body, timestampMillis) }
  }

  fun dismiss() {
    runOnMain { removeAttached() }
  }

  private fun showOnMain(
    title: String,
    subtitle: String?,
    body: String,
    timestampMillis: Long,
  ) {
    // A new popup replaces a still-visible one; the shared speaker (NodeApp.popupSpeechSpeaker)
    // correctly interrupts that popup's speech the same way.
    removeAttached()

    try {
      // WindowManager (and anything measuring views, like ComposeView's own init) requires a
      // "visual" context on API 30+ — the plain Application context throws
      // IllegalAccessException ("non-visual Context") here, so a dedicated window context is
      // created per popup rather than reusing NodeApp's own getSystemService. The Application
      // context itself has no associated display, so the no-Display overload of
      // createWindowContext throws UnsupportedOperationException; the default display must be
      // passed explicitly. The whole thing is one try/catch: any of these platform calls
      // failing is an expected race (permission revoked, display/process teardown) the caller
      // already has a fallback notification for, not a reason to crash the process.
      val display = app.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
      val windowContext =
        app.createWindowContext(display, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
      val windowManager = windowContext.getSystemService(WindowManager::class.java)

      val owner = PopupWindowLifecycleOwner().apply { attach() }
      val composeView =
        ComposeView(windowContext).apply {
          setViewTreeLifecycleOwner(owner)
          setViewTreeSavedStateRegistryOwner(owner)
          setViewTreeViewModelStoreOwner(owner)
          setContent {
            OpenClawTheme {
              PopupOverlayContent(
                title = title,
                subtitle = subtitle,
                body = body,
                timestampMillis = timestampMillis,
                cardColorArgb = app.prefs.popupCardColor.value,
                opacity = app.prefs.popupOpacity.value,
                cornerRadiusDp = app.prefs.popupCardCornerRadiusDp.value,
                autoDismissSeconds = app.prefs.popupAutoDismissSeconds.value,
                cardWidthModifier = androidx.compose.ui.Modifier.width(CARD_WIDTH_DP.dp),
                showScrimBackdrop = false,
                enableBackHandler = false,
                speaker = app.popupSpeechSpeaker,
                onDismiss = { dismiss() },
              )
            }
          }
        }

      windowManager.addView(composeView, buildLayoutParams(windowContext))
      attached = AttachedView(composeView, owner, windowManager)
    } catch (err: Exception) {
      Log.w(TAG, "failed to show overlay window: ${err.message}")
    }
  }

  private fun removeAttached() {
    val current = attached ?: return
    attached = null
    try {
      current.windowManager.removeView(current.view)
    } catch (err: Exception) {
      Log.w(TAG, "failed to remove overlay window: ${err.message}")
    }
    current.owner.destroy()
  }

  private fun buildLayoutParams(windowContext: Context): WindowManager.LayoutParams =
    WindowManager.LayoutParams(
      // WRAP_CONTENT, not MATCH_PARENT: FLAG_NOT_TOUCH_MODAL only passes touches through
      // outside the window's own bounds, so a full-width window would silently swallow taps
      // across the whole screen even where the card isn't visible.
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
      y = (BOTTOM_MARGIN_DP * windowContext.resources.displayMetrics.density).toInt()
    }

  private fun runOnMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      action()
    } else {
      mainHandler.post(action)
    }
  }

  private class AttachedView(
    val view: ComposeView,
    val owner: PopupWindowLifecycleOwner,
    val windowManager: WindowManager,
  )
}

/**
 * Minimal Lifecycle/SavedState/ViewModelStore owner so Compose can be hosted in a raw
 * WindowManager-attached view outside an Activity, which provides this wiring for free.
 */
private class PopupWindowLifecycleOwner : LifecycleOwner, SavedStateRegistryOwner, ViewModelStoreOwner {
  private val lifecycleRegistry = LifecycleRegistry(this)
  private val savedStateController = SavedStateRegistryController.create(this)

  override val lifecycle: Lifecycle get() = lifecycleRegistry
  override val savedStateRegistry: SavedStateRegistry get() = savedStateController.savedStateRegistry
  override val viewModelStore = ViewModelStore()

  fun attach() {
    savedStateController.performRestore(null)
    lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
    lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START)
    lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
  }

  fun destroy() {
    lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
    viewModelStore.clear()
  }
}
