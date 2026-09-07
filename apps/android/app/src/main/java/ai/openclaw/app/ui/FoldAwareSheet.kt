package ai.openclaw.app.ui

import android.app.Activity
import android.os.IBinder
import android.view.View
import androidx.compose.foundation.layout.recalculateWindowInsets
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.LayoutModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.invalidatePlacement
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.round
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle

/** Geometry for one terminal opening, never reused by a replacement native sheet. */
internal class FoldAwareSheetState(
  val activity: Activity?,
  val activityView: View,
  private val lifecycle: Lifecycle,
  private val onUnsafe: () -> Unit,
) {
  var revoked = false
    private set
  private var features = WindowDisplayFeatureSnapshot()
  private var destination: View? = null
  private var token: IBinder? = null
  private var display: Int? = null
  private var nativeEstablished = false
  private var host: LayoutCoordinates? = null
  private var hostSize = IntSize.Zero
  private var direction = LayoutDirection.Ltr
  private var selectedPane: IntRect? = null
  private var resolvedPane: IntRect? = null
  private var placedPane: IntRect? = null
  private var publishedMapping: OverlayWindowGeometry? = null
  var invalidate: () -> Unit = {}

  fun revoke() {
    if (revoked) return
    revoked = true
    invalidate()
  }

  private fun reject() {
    if (revoked) return
    revoke()
    onUnsafe()
  }

  fun publishFeatures(next: WindowDisplayFeatureSnapshot) {
    features = next
    refresh()
    invalidate()
  }

  fun canOpen(): Boolean {
    val mapping = sampleOverlayWindowGeometry(activity, activityView, activityView) ?: return false
    return features.ready && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
      foldSafeRegions(mapping.activityExtent, features.features).any { it.width > 0 && it.height > 0 }
  }

  fun bind(view: View) {
    if (destination != null && destination !== view) reject()
    if (!revoked) destination = view
  }

  fun publishMapping(mapping: OverlayWindowGeometry?) {
    if (mapping == null && nativeEstablished) reject()
    refresh()
    if (publishedMapping != mapping || resolvedPane != placedPane) invalidate()
    publishedMapping = mapping
  }

  fun detach() = reject()

  fun refresh(): Boolean {
    if (revoked) return false
    if (!canOpen()) {
      reject()
      return false
    }
    val view = destination ?: return false
    val mapping = sampleOverlayWindowGeometry(activity, activityView, view)
    if (mapping == null) {
      if (nativeEstablished) reject()
      return false
    }
    if (!nativeEstablished) {
      token = view.windowToken ?: return false
      display = view.display?.displayId ?: return false
      nativeEstablished = true
    } else if (view.windowToken != token || view.display?.displayId != display) {
      reject()
      return false
    }
    val coordinates = host ?: return false
    if (!coordinates.isAttached) {
      reject()
      return false
    }
    val origin = coordinates.positionInWindow().round()
    var available = IntRect(origin, hostSize)
    // The Material host is already IME-adjusted. Intersect with current native facts so an
    // input arriving before its next measure cannot borrow the previous keyboard viewport.
    val ime = ViewCompat.getRootWindowInsets(view)?.getInsets(WindowInsetsCompat.Type.ime())
    if (ime != null) {
      available =
        available.intersect(
          IntRect(ime.left, ime.top, view.rootView.width - ime.right, view.rootView.height - ime.bottom),
        )
    }
    val candidates =
      foldSafeRegions(mapping.activityExtent, features.features)
        .filter { pane ->
          val intersection = pane.translate(mapping.activityToOverlay).intersect(available)
          intersection.width > 0 && intersection.height > 0
        }
    val pane =
      selectedPane?.takeIf { it in candidates }
        ?: candidates.minWithOrNull(
          compareByDescending<IntRect> { it.width.toLong() * it.height }
            .thenBy { it.top }
            .thenBy { if (direction == LayoutDirection.Ltr) it.left else -it.right },
        )
    if (pane == null) {
      reject()
      return false
    }
    selectedPane = pane
    resolvedPane = pane.translate(mapping.activityToOverlay).intersect(available).translate(-origin)
    return placedPane == resolvedPane
  }

  fun place(
    coordinates: LayoutCoordinates?,
    size: IntSize,
    direction: LayoutDirection,
  ): IntRect? {
    if (revoked) return null
    if (coordinates == null) {
      if (host != null) reject()
      return null
    }
    host = coordinates
    hostSize = size
    this.direction = direction
    refresh()
    if (revoked || !nativeEstablished) return null
    placedPane = resolvedPane
    return placedPane?.takeIf { it.width > 0 && it.height > 0 }
  }
}

/** Material materializes this modifier inside its native window, not at the Activity call site. */
@Composable
internal fun Modifier.foldAwareSheet(state: FoldAwareSheetState): Modifier {
  // Capture the caller's direction. A newly created native dialog initially reports LTR.
  val direction = LocalLayoutDirection.current
  return composed {
    val destination = LocalView.current
    DisposableEffect(state, destination) {
      state.bind(destination)
      onDispose { state.detach() }
    }
    rememberOverlayWindowGeometry(state.activity, state.activityView, destination, state::publishMapping)
    this
      .then(SheetHostElement(state, direction))
      .clipToBounds()
      .recalculateWindowInsets()
      .layout { measurable, constraints ->
        val surface = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
        layout(constraints.maxWidth, constraints.maxHeight) {
          surface.place((constraints.maxWidth - surface.width) / 2, 0)
        }
      }
  }
}

private data class SheetHostElement(
  val state: FoldAwareSheetState,
  val direction: LayoutDirection,
) : ModifierNodeElement<SheetHostNode>() {
  override fun create() = SheetHostNode(state, direction)

  override fun update(node: SheetHostNode) {
    check(node.state === state)
    node.direction = direction
  }

  override fun InspectorInfo.inspectableProperties() {
    name = "foldAwareSheet"
  }
}

private class SheetHostNode(
  val state: FoldAwareSheetState,
  var direction: LayoutDirection,
) : Modifier.Node(),
  LayoutModifierNode,
  DrawModifierNode {
  override fun onAttach() {
    state.invalidate = {
      if (isAttached) {
        invalidatePlacement()
        invalidateDraw()
      }
    }
  }

  override fun onDetach() {
    state.invalidate = {}
    state.detach()
  }

  override fun MeasureScope.measure(
    measurable: Measurable,
    constraints: Constraints,
  ): MeasureResult {
    val size = IntSize(constraints.maxWidth, constraints.maxHeight)
    return layout(size.width, size.height) {
      val pane = state.place(coordinates, size, direction)
      if (pane != null && !state.revoked) {
        measurable.measure(Constraints.fixed(pane.width, pane.height)).place(pane.left, pane.top)
      }
    }
  }

  override fun ContentDrawScope.draw() {
    if (state.refresh()) drawContent()
  }
}
