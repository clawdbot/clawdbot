package ai.openclaw.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.recalculateWindowInsets
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.SubcomposeLayout
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
  bookPanesEnabled: Boolean = false,
  tabletopEnabled: Boolean = false,
  content: @Composable (FoldContentBounds) -> Unit,
) {
  SubcomposeLayout(
    modifier = modifier.fillMaxSize(),
  ) { constraints ->
    val width = constraints.maxWidth
    val height = constraints.maxHeight
    val density = this
    layout(width, height) {
      // Read the stationary host, not the moving pane. Measuring during placement uses the
      // current window offset even when an ancestor moves without changing our constraints.
      val origin = coordinates?.positionInWindow()?.round() ?: IntOffset.Zero
      val host = IntRect(origin, IntSize(width, height))
      val book = if (bookPanesEnabled) bookPaneBounds(host, features, layoutDirection, density) else null
      val tabletop = if (tabletopEnabled) tabletopPaneBounds(host, features, layoutDirection) else null
      val fallback = foldSafeRegion(host, features, layoutDirection)
      val pane = if (book != null || tabletop != null) host else fallback
      val localBook = book?.let { BookPaneBounds(it.start.translate(-origin), it.end.translate(-origin)) }
      val bounds = FoldContentBounds(localBook, tabletop, fallback.translate(-origin).takeIf { tabletop != null })
      // One subcomposition keeps the screen alive while deciding its mode from current host bounds.
      subcompose(Unit) {
        Box(Modifier.recalculateWindowInsets().clipToBounds()) { content(bounds) }
      }.single()
        .measure(Constraints.fixed(pane.width, pane.height))
        .place(pane.left - origin.x, pane.top - origin.y)
    }
  }
}
