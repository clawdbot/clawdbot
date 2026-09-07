package ai.openclaw.app.ui

import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature

internal data class TabletopPaneBounds(
  val upper: IntRect,
  val lower: IntRect,
)

internal data class FoldContentBounds(
  val book: BookPaneBounds?,
  val tabletop: TabletopPaneBounds?,
  val sidebarBand: IntRect?,
)

/** Physical window rectangles; certify both planes against the complete feature set. */
internal fun tabletopPaneBounds(
  host: IntRect,
  features: List<DisplayFeature>,
  direction: LayoutDirection,
): TabletopPaneBounds? {
  val separator =
    features.filterIsInstance<FoldingFeature>().singleOrNull {
      (it.isSeparating || it.occlusionType == FoldingFeature.OcclusionType.FULL) &&
        it.orientation == FoldingFeature.Orientation.HORIZONTAL &&
        it.bounds.top > host.top && it.bounds.bottom < host.bottom &&
        it.bounds.left <= host.left && it.bounds.right >= host.right
    } ?: return null
  val upper = host.copy(bottom = separator.bounds.top)
  val lower = host.copy(top = separator.bounds.bottom)
  if (foldSafeRegion(upper, features, direction) != upper || foldSafeRegion(lower, features, direction) != lower) return null
  return TabletopPaneBounds(upper, lower)
}
