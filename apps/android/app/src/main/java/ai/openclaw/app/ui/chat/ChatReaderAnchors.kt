package ai.openclaw.app.ui.chat

import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.LocalPinnableContainer
import androidx.compose.ui.layout.PinnableContainer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.IntSize
import kotlin.math.roundToInt

internal class ChatReaderAnchors(
  private val listState: LazyListState?,
) {
  internal class Row(
    val owner: ChatReaderAnchors,
    val key: Any,
    val container: PinnableContainer?,
  ) {
    val points = mutableSetOf<ChatReaderAnchor>()
  }

  private class Reading(
    val point: ChatReaderAnchor,
    val coordinates: LayoutCoordinates,
    val local: Offset,
    var text: String?,
    val character: Int?,
    val preferredY: Float,
    var viewportSize: IntSize,
    var extentHeight: Float,
  ) {
    var targetY = preferredY
    var awaitingPlacement: Int? = null
    var pins: List<PinnableContainer.PinnedHandle> = emptyList()
  }

  private val rows = mutableMapOf<Any, Row>()
  private var viewport: LayoutCoordinates? = null
  private var reading: Reading? = null
  var revision by mutableIntStateOf(0)
    private set
  val layoutInfo: LazyListLayoutInfo? get() = listState?.layoutInfo

  fun invalidate() {
    clearReading()
    // A same-position explicit pause may finish without another layout. Re-arm
    // observation at the settled point before the next content measurement.
    revision++
  }

  fun clearReading() {
    val previous = reading
    reading = null
    previous?.pins?.forEach { it.release() }
  }

  fun viewportPlaced(coordinates: LayoutCoordinates) {
    viewport = coordinates
    revision++
  }

  fun placed() {
    revision++
  }

  fun attach(row: Row) {
    rows[row.key] = row
  }

  fun detach(row: Row) {
    if (rows[row.key] === row) rows.remove(row.key)
    if (reading?.point?.row === row) invalidate()
  }

  fun detach(point: ChatReaderAnchor) {
    point.row.points.remove(point)
    if (reading?.point === point) invalidate()
  }

  private fun position(
    value: Reading,
    view: LayoutCoordinates,
  ): Float? {
    val point = value.point
    if (point !in point.row.points || point.coordinates !== value.coordinates || !value.coordinates.isAttached) return null
    val local =
      value.character?.let { character ->
        val layout = point.textLayout ?: return null
        val text = layout.layoutInput.text.text
        if (!text.startsWith(checkNotNull(value.text))) return null
        value.text = text
        layout.getBoundingBox(character)
      } ?: Rect(
        value.local,
        Offset(
          value.coordinates.size.width
            .toFloat(),
          value.coordinates.size.height
            .toFloat(),
        ),
      )
    if (local.isEmpty) return null
    val top = view.localPositionOf(value.coordinates, local.topLeft).y
    val height = view.localPositionOf(value.coordinates, local.bottomRight).y - top
    // Width reflow can move scroll boundaries without changing the glyph's height.
    // Reapply the preferred position on geometry changes, retaining real clamps between them.
    if (value.viewportSize != view.size || value.extentHeight != height) {
      value.targetY = value.preferredY.coerceIn(0f, (view.size.height - height).coerceAtLeast(0f))
      value.viewportSize = view.size
      value.extentHeight = height
    }
    return top
  }

  private fun select(
    row: Row,
    view: LayoutCoordinates,
  ): Reading? =
    row.points
      .mapNotNull { point ->
        if (point.measurement !== layoutInfo) return@mapNotNull null
        val coordinates = point.coordinates?.takeIf { it.isAttached } ?: return@mapNotNull null
        val visible = view.localBoundingBoxOf(coordinates).intersect(Rect(0f, 0f, view.size.width.toFloat(), view.size.height.toFloat()))
        if (visible.width <= 0f || visible.height <= 0f) return@mapNotNull null
        val layout = point.textLayout
        val local = coordinates.localPositionOf(view, visible.topLeft)
        if (layout == null) {
          val bottom = view.localPositionOf(coordinates, Offset(coordinates.size.width.toFloat(), coordinates.size.height.toFloat())).y
          Reading(point, coordinates, local, null, null, visible.top, view.size, bottom - visible.top)
        } else {
          val firstLine = layout.getLineForVerticalPosition(local.y)
          val bottom = coordinates.localPositionOf(view, visible.bottomRight).y
          val lastLine = layout.getLineForVerticalPosition(bottom)
          val text = layout.layoutInput.text.text
          (layout.getLineStart(firstLine) until layout.getLineEnd(lastLine)).firstNotNullOfOrNull { character ->
            if (text[character].isWhitespace()) return@firstNotNullOfOrNull null
            val glyph = layout.getBoundingBox(character)
            val top = view.localPositionOf(coordinates, glyph.topLeft)
            val end = view.localPositionOf(coordinates, glyph.bottomRight)
            if (glyph.width > 0f && glyph.height > 0f && visible.contains(top) && end.x <= visible.right && end.y <= visible.bottom) {
              Reading(point, coordinates, glyph.topLeft, text, character, top.y, view.size, end.y - top.y)
            } else {
              null
            }
          }
        }
      }.minByOrNull { it.targetY }

  private fun acquire(view: LayoutCoordinates) {
    clearReading()
    val visible = layoutInfo?.visibleItemsInfo.orEmpty().sortedBy { it.index }
    for ((index, item) in visible.withIndex()) {
      val row = rows[item.key] ?: continue
      val selected = select(row, view) ?: continue
      // LazyList positions pinned extras consecutively. Keep the intervening rows
      // measured too, so a caption/Thinking gap cannot shorten the reading distance.
      selected.pins = visible.take(index + 1).mapNotNull { rows[it.key]?.container?.pin() }
      reading = selected
      return
    }
  }

  private fun current(): Pair<Reading, Float>? {
    val view = viewport?.takeIf { it.isAttached } ?: return null
    // Resizing reflows the same content; keep its reading point until final placement.
    val previous = reading?.takeIf { rows[it.point.row.key] === it.point.row }
    // layoutInfo can publish before placement. Only the retained point's final
    // callback qualifies its coordinates for that exact measured list layout.
    if (previous != null && previous.point in previous.point.row.points && previous.coordinates.isAttached &&
      previous.point.measurement !== layoutInfo
    ) {
      return null
    }
    val y = previous?.let { position(it, view) }
    if (previous == null || y == null) {
      acquire(view)
      return null
    }
    if (previous.awaitingPlacement?.let { previous.point.placement <= it } == true) return null
    previous.awaitingPlacement = null
    return previous to y
  }

  fun needsCorrection(): Boolean = current()?.let { (point, y) -> (point.targetY - y).roundToInt() != 0 } == true

  fun correct(
    scroll: (Float) -> Float,
  ) {
    val (point, y) = current() ?: return
    val requested = (point.targetY - y).roundToInt().toFloat()
    if (requested == 0f) return
    val placement = point.point.placement
    val consumed = scroll(requested)
    if (reading !== point) return
    // A fast-path scroll can defer placement. Keep the target until that layout,
    // accounting only for a real clamp rather than absorbing coalesced content growth.
    point.targetY -= requested - consumed
    point.awaitingPlacement = placement.takeIf { consumed != 0f }
  }
}

internal class ChatReaderAnchor(
  val row: ChatReaderAnchors.Row,
) {
  var coordinates: LayoutCoordinates? = null
  var textLayout: TextLayoutResult? = null
  val onTextLayout: (TextLayoutResult) -> Unit = { textLayout = it }
  var measurement: LazyListLayoutInfo? = null
  var placement = 0
  val modifier =
    Modifier.onGloballyPositioned {
      coordinates = it
      measurement = row.owner.layoutInfo
      placement++
      row.owner.placed()
    }
}

private val LocalChatReaderRow = staticCompositionLocalOf<ChatReaderAnchors.Row?> { null }

@Composable
internal fun ChatReaderItem(
  key: Any,
  content: @Composable () -> Unit,
) {
  val owner = LocalChatReaderNavigation.current?.anchors
  if (owner == null) {
    content()
    return
  }
  val container = LocalPinnableContainer.current
  val row = remember(owner, key, container) { ChatReaderAnchors.Row(owner, key, container) }
  DisposableEffect(row) {
    owner.attach(row)
    onDispose { owner.detach(row) }
  }
  CompositionLocalProvider(LocalChatReaderRow provides row) {
    content()
  }
}

@Composable
internal fun rememberChatReaderAnchor(identity: Any? = Unit): ChatReaderAnchor? {
  val row = LocalChatReaderRow.current ?: return null
  val point = remember(row, identity) { ChatReaderAnchor(row) }
  DisposableEffect(point) {
    row.points.add(point)
    onDispose { row.owner.detach(point) }
  }
  return point
}
