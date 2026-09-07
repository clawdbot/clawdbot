package ai.openclaw.app.ui

import android.app.Activity
import android.view.View
import android.view.ViewTreeObserver
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.window.layout.WindowMetricsCalculator

internal data class OverlayWindowGeometry(
  val activityExtent: IntRect,
  val activityToOverlay: IntOffset,
)

internal fun sampleOverlayWindowGeometry(
  activity: Activity?,
  activityView: View,
  overlayView: View,
): OverlayWindowGeometry? {
  val displayId = activityView.display?.displayId
  return if (activity != null && activityView.isAttachedToWindow && overlayView.isAttachedToWindow &&
    displayId != null && displayId == overlayView.display?.displayId
  ) {
    val extent = WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(activity).bounds
    OverlayWindowGeometry(
      IntRect(0, 0, extent.width(), extent.height()),
      activityView.windowScreenOrigin() - overlayView.windowScreenOrigin(),
    )
  } else {
    null
  }
}

@Composable
internal fun rememberOverlayWindowGeometry(
  activity: Activity?,
  activityView: View,
  overlayView: View,
  onPublication: ((OverlayWindowGeometry?) -> Unit)? = null,
): OverlayWindowGeometry? {
  var geometry by remember(activity, activityView, overlayView) { mutableStateOf<OverlayWindowGeometry?>(null) }
  val deliver by rememberUpdatedState(onPublication)
  DisposableEffect(activity, activityView, overlayView) {
    fun sample() {
      val next = sampleOverlayWindowGeometry(activity, activityView, overlayView)
      deliver?.invoke(next)
      geometry = next
    }
    // Both windows can move independently without changing Compose constraints.
    val observer =
      ViewTreeObserver.OnPreDrawListener {
        sample()
        true
      }
    val activityObserver = activityView.viewTreeObserver
    val overlayObserver = overlayView.viewTreeObserver
    activityObserver.addOnPreDrawListener(observer)
    overlayObserver.addOnPreDrawListener(observer)
    val attachment =
      object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) = sample()

        override fun onViewDetachedFromWindow(view: View) {
          deliver?.invoke(null)
        }
      }
    // The dialog retains its original initial/pre-draw behavior. Terminal sheets additionally
    // need direct detach delivery, before disposal or conflatable composition can run.
    if (onPublication != null) {
      activityView.addOnAttachStateChangeListener(attachment)
      overlayView.addOnAttachStateChangeListener(attachment)
    }
    sample()
    onDispose {
      if (activityObserver.isAlive) activityObserver.removeOnPreDrawListener(observer)
      if (overlayObserver.isAlive) overlayObserver.removeOnPreDrawListener(observer)
      activityView.removeOnAttachStateChangeListener(attachment)
      overlayView.removeOnAttachStateChangeListener(attachment)
      deliver?.invoke(null)
    }
  }
  return geometry
}

internal fun View.windowScreenOrigin(): IntOffset {
  val screen = IntArray(2).also(::getLocationOnScreen)
  val window = IntArray(2).also(::getLocationInWindow)
  return IntOffset(screen[0] - window[0], screen[1] - window[1])
}
