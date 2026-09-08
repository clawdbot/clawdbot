package ai.openclaw.app.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker

@Composable
internal fun rememberWindowDisplayFeatures(): List<DisplayFeature> {
  val activity = LocalActivity.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  var features by remember(activity) { mutableStateOf(emptyList<DisplayFeature>()) }
  LaunchedEffect(activity, lifecycle) {
    if (activity != null) {
      // The flow belongs to this Activity, never to a retained ViewModel or application.
      lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect {
          features = it.displayFeatures
        }
      }
    }
  }
  return features
}

/** The largest hinge-free rectangle, in physical window coordinates. */
internal fun foldSafeRegion(
  host: IntRect,
  features: List<DisplayFeature>,
  direction: LayoutDirection,
): IntRect {
  var regions = listOf(host)
  for (feature in features.filterIsInstance<FoldingFeature>()) {
    if (!feature.isSeparating && feature.occlusionType != FoldingFeature.OcclusionType.FULL) continue
    val bounds = feature.bounds
    regions =
      regions
        .flatMap { region ->
          // Strict comparisons keep zero-thickness interior folds, but exclude boundary-only contact.
          if (bounds.left >= region.right || bounds.right <= region.left ||
            bounds.top >= region.bottom || bounds.bottom <= region.top
          ) {
            listOf(region)
          } else {
            // Keep every candidate until all separators are applied. Choosing early can discard
            // the eventual largest pane. Overlapping candidates also preserve space around fold ends.
            buildList {
              if (bounds.left > region.left) add(region.copy(right = bounds.left))
              if (bounds.right < region.right) add(region.copy(left = bounds.right))
              if (bounds.top > region.top) add(region.copy(bottom = bounds.top))
              if (bounds.bottom < region.bottom) add(region.copy(top = bounds.bottom))
            }
          }
        }.distinct()
  }
  return regions.minWithOrNull(
    compareByDescending<IntRect> { it.width.toLong() * it.height }
      .thenBy { it.top }
      .thenBy { if (direction == LayoutDirection.Ltr) it.left else -it.right },
  ) ?: IntRect(host.left, host.top, host.left, host.top)
}
