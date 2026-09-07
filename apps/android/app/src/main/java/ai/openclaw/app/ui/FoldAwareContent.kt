package ai.openclaw.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.recalculateWindowInsets
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.round
import androidx.window.layout.DisplayFeature

@Composable
internal fun FoldAwareContent(
  features: List<DisplayFeature>,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  Layout(
    modifier = modifier.fillMaxSize(),
    content = {
      Box(Modifier.recalculateWindowInsets().clipToBounds()) { content() }
    },
  ) { measurables, constraints ->
    val width = constraints.maxWidth
    val height = constraints.maxHeight
    layout(width, height) {
      // Read the stationary host, not the moving pane. Measuring during placement uses the
      // current window offset even when an ancestor moves without changing our constraints.
      val origin = coordinates?.positionInWindow()?.round() ?: IntOffset.Zero
      val pane = foldSafeRegion(IntRect(origin, IntSize(width, height)), features, layoutDirection)
      measurables
        .single()
        .measure(Constraints.fixed(pane.width, pane.height))
        .place(pane.left - origin.x, pane.top - origin.y)
    }
  }
}
