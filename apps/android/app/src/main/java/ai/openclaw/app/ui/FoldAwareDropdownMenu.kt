package ai.openclaw.app.ui

import android.app.Activity
import android.graphics.Rect
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.window.layout.WindowMetricsCalculator
import kotlin.math.roundToInt

internal data class FoldAwareMenuItem(
  val id: String,
  val label: String,
  val onClick: () -> Unit,
  val icon: ImageVector? = null,
  val enabled: Boolean = true,
  val interactionSource: MutableInteractionSource? = null,
)

/** Activity-hosted, non-nested menu. The surrounding Box is its stationary anchor. */
@Composable
internal fun FoldAwareDropdownMenu(
  expanded: Boolean,
  onDismissRequest: () -> Unit,
  items: List<FoldAwareMenuItem>,
) {
  val activity = LocalActivity.current
  val host = LocalView.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val density = LocalDensity.current
  val direction = LocalLayoutDirection.current
  val owner = remember { AnchoredMenuOwner() }
  rememberWindowDisplayFeatureState(owner::publishFeatures)

  DisposableEffect(activity, host, lifecycle) {
    owner.attach(activity, host, lifecycle)
    val roots = listOfNotNull(activity?.window?.decorView, host).distinct()
    val listener =
      ViewTreeObserver.OnPreDrawListener {
        owner.refresh()
        true
      }
    roots.forEach { it.viewTreeObserver.addOnPreDrawListener(listener) }
    onDispose {
      roots.forEach { if (it.viewTreeObserver.isAlive) it.viewTreeObserver.removeOnPreDrawListener(listener) }
      owner.detach()
    }
  }
  SideEffect { owner.update(expanded, items, onDismissRequest, density, direction) }
  Layout(
    content = {},
    modifier = Modifier.onGloballyPositioned { owner.publishAnchor(it.parentLayoutCoordinates) },
  ) { _, _ -> layout(0, 0) {} }

  val opening = owner.opening
  if (opening != null) {
    Popup(
      popupPositionProvider = opening,
      onDismissRequest = opening.dismiss,
      // Non-editing menus own native focus without becoming IME targets.
      properties =
        PopupProperties(
          flags = WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM,
          inheritSecurePolicy = true,
        ),
    ) {
      val popupView = LocalView.current
      SideEffect { opening.popupRoot = popupView.rootView }
      // Popup's native layout direction is updated after its first composition.
      CompositionLocalProvider(LocalDensity provides density, LocalLayoutDirection provides direction) {
        MenuBody(owner, opening, items)
      }
    }
  }
}

@Composable
private fun MenuBody(
  owner: AnchoredMenuOwner,
  opening: MenuOpening,
  items: List<FoldAwareMenuItem>,
) {
  val density = LocalDensity.current
  val scroll = rememberScrollState()
  val maxHeight = opening.bounds?.height ?: opening.geometry.available.height
  Surface(
    shape = MenuDefaults.shape,
    color = MenuDefaults.containerColor,
    tonalElevation = MenuDefaults.TonalElevation,
    shadowElevation = MenuDefaults.ShadowElevation,
  ) {
    Layout(
      modifier =
        Modifier
          .heightIn(max = with(density) { maxHeight.toDp() })
          .padding(vertical = 8.dp)
          .verticalScroll(scroll),
      content = {
        items.forEach { item ->
          DropdownMenuItem(
            text = {
              Text(item.label, onTextLayout = { opening.textLayouts[item.id] = it })
            },
            leadingIcon = item.icon?.let { icon -> { Icon(icon, contentDescription = null) } },
            enabled = item.enabled,
            interactionSource = item.interactionSource,
            onClick = { owner.accept(opening, item.id) },
          )
        }
      },
    ) { measurables, constraints ->
      val padding = 16.dp.roundToPx()
      val limit = minOf(constraints.maxWidth, opening.geometry.available.width, 280.dp.roundToPx())
      if (opening.terminal || measurables.isEmpty() || limit < 112.dp.roundToPx()) {
        owner.cancel(opening)
        layout(0, 0) {}
      } else {
        val width =
          opening.bounds?.width
            ?: measurables.maxOf { it.maxIntrinsicWidth(Constraints.Infinity) }.coerceIn(112.dp.roundToPx(), limit)
        val rows = measurables.map { it.measure(Constraints.fixedWidth(width)) }
        val bodyHeight = rows.sumOf { it.height }
        val height = opening.bounds?.height ?: minOf(bodyHeight + padding, maxHeight)
        val textLayouts = items.mapNotNull { opening.textLayouts[it.id] }
        val fits =
          width <= limit && height >= rows.maxOf { it.height } + padding &&
            textLayouts.size == items.size && textLayouts.none { it.hasVisualOverflow }
        val rowLayout = MenuRows(rows.map { it.height }, textLayouts.map(::menuTextLayout))
        if (!fits || !owner.admit(opening, IntSize(width, height), rowLayout)) {
          owner.cancel(opening)
          layout(0, 0) {}
        } else {
          layout(width, bodyHeight) {
            var y = 0
            rows.forEach {
              it.place(0, y)
              y += it.height
            }
          }
        }
      }
    }
  }
}

private data class MenuTextLine(
  val start: Int,
  val end: Int,
  val left: Float,
  val right: Float,
  val bottom: Float,
)

private data class MenuTextLayout(
  val style: TextStyle,
  val size: IntSize,
  val lines: List<MenuTextLine>,
)

private data class MenuRows(
  val heights: List<Int>,
  val text: List<MenuTextLayout>,
) {
  fun hasSameLayout(other: MenuRows): Boolean =
    heights == other.heights && text.size == other.text.size &&
      text.zip(other.text).all { (before, after) ->
        before.size == after.size && before.lines == after.lines &&
          before.style.hasSameLayoutAffectingAttributes(after.style)
      }
}

private fun menuTextLayout(result: TextLayoutResult): MenuTextLayout =
  MenuTextLayout(
    result.layoutInput.style,
    result.size,
    (0 until result.lineCount).map { line ->
      MenuTextLine(result.getLineStart(line), result.getLineEnd(line), result.getLineLeft(line), result.getLineRight(line), result.getLineBottom(line))
    },
  )

private data class MenuGeometry(
  val anchor: IntRect,
  val available: IntRect,
  val origin: IntOffset,
  val token: IBinder,
  val display: Int,
)

private class MenuOpening(
  val owner: AnchoredMenuOwner,
  val geometry: MenuGeometry,
  val items: List<Triple<String, String, ImageVector?>>,
) : PopupPositionProvider {
  var terminal = false
  var notified = false
  var bounds: IntRect? = null
  var rowLayout: MenuRows? = null
  val textLayouts = mutableMapOf<String, TextLayoutResult>()
  var popupRoot: View? = null
  val dismiss: () -> Unit = { owner.cancel(this) }

  override fun calculatePosition(
    anchorBounds: IntRect,
    windowSize: IntSize,
    layoutDirection: LayoutDirection,
    popupContentSize: IntSize,
  ): IntOffset {
    owner.refresh()
    val admitted = bounds
    if (anchorBounds != geometry.anchor || admitted?.size != popupContentSize) owner.cancel(this)
    return admitted?.topLeft ?: geometry.available.topLeft
  }
}

private class AnchoredMenuOwner {
  var opening by mutableStateOf<MenuOpening?>(null)
    private set
  private val handler = Handler(Looper.getMainLooper())
  private var activity: Activity? = null
  private var host: View? = null
  private var lifecycle: Lifecycle? = null
  private var anchor: LayoutCoordinates? = null
  private var features = WindowDisplayFeatureSnapshot()
  private var expanded = false
  private var items = emptyList<FoldAwareMenuItem>()
  private var dismiss: () -> Unit = {}
  private var density: Density = Density(1f)
  private var direction = LayoutDirection.Ltr

  fun attach(
    activity: Activity?,
    host: View,
    lifecycle: Lifecycle,
  ) {
    this.activity = activity
    this.host = host
    this.lifecycle = lifecycle
  }

  fun detach() {
    opening?.let(::cancel)
    activity = null
    host = null
    anchor = null
    features = WindowDisplayFeatureSnapshot()
  }

  fun publishFeatures(publication: WindowDisplayFeatureSnapshot) {
    features = publication
    refresh()
  }

  fun publishAnchor(coordinates: LayoutCoordinates?) {
    anchor = coordinates
    refresh()
  }

  fun update(
    expanded: Boolean,
    items: List<FoldAwareMenuItem>,
    dismiss: () -> Unit,
    density: Density,
    direction: LayoutDirection,
  ) {
    val rising = expanded && !this.expanded
    this.dismiss = dismiss
    this.items = items
    if (!expanded || this.density != density || this.direction != direction) opening?.let(::cancel)
    this.expanded = expanded
    this.density = density
    this.direction = direction
    refresh()
    if (rising && opening == null) {
      val geometry = geometry()
      if (geometry == null || geometry.available.width < with(density) { 112.dp.roundToPx() } ||
        geometry.available.height < with(density) { 64.dp.roundToPx() } || items.isEmpty()
      ) {
        handler.post { if (this.expanded && opening == null) this.dismiss() }
      } else {
        opening = MenuOpening(this, geometry, itemLayout())
      }
    }
  }

  fun refresh() {
    val current = opening ?: return
    if (!valid(current, geometry())) cancel(current)
  }

  private fun itemLayout() = items.map { Triple(it.id, it.label, it.icon) }

  private fun valid(
    current: MenuOpening,
    next: MenuGeometry?,
  ): Boolean =
    opening === current && !current.terminal && expanded && next != null &&
      next.anchor == current.geometry.anchor && next.origin == current.geometry.origin &&
      next.token == current.geometry.token && next.display == current.geometry.display &&
      next.available.contains(current.bounds ?: current.geometry.available) && itemLayout() == current.items

  fun admit(
    current: MenuOpening,
    size: IntSize,
    rows: MenuRows,
  ): Boolean {
    if (!valid(current, geometry())) return false
    if (current.bounds == null) {
      val available = current.geometry.available
      val anchor = current.geometry.anchor
      val start = if (direction == LayoutDirection.Ltr) anchor.left else anchor.right - size.width
      val end = if (direction == LayoutDirection.Ltr) anchor.right - size.width else anchor.left
      val x =
        listOf(start, end).firstOrNull { it >= available.left && it + size.width <= available.right }
          ?: start.coerceIn(available.left, available.right - size.width)
      val y =
        listOf(anchor.bottom, anchor.top - size.height).firstOrNull { it >= available.top && it + size.height <= available.bottom }
          ?: anchor.bottom.coerceIn(available.top, available.bottom - size.height)
      current.bounds = IntRect(IntOffset(x, y), size)
      current.rowLayout = rows
    }
    return current.bounds?.size == size && current.rowLayout?.hasSameLayout(rows) == true
  }

  fun cancel(current: MenuOpening) {
    if (current.terminal) return
    // A publication latches immediately; neither a later safe fact nor deferred removal can rearm it.
    current.terminal = true
    handler.post { close(current) }
  }

  private fun close(current: MenuOpening) {
    if (opening !== current || current.notified) return
    current.notified = true
    opening = null
    if (expanded) dismiss()
  }

  fun accept(
    current: MenuOpening,
    id: String,
  ) {
    val geometry = geometry()
    val item = items.singleOrNull { it.id == id }
    val root = current.popupRoot
    val expected = current.bounds?.translate(current.geometry.origin)
    if (!valid(current, geometry) || item?.enabled != true || root?.isAttachedToWindow != true ||
      expected == null || root.screenBounds() != expected
    ) {
      cancel(current)
      return
    }
    current.terminal = true
    close(current)
    item.onClick()
  }

  private fun geometry(): MenuGeometry? {
    val activity = activity ?: return null
    val host = host ?: return null
    val decor = activity.window.decorView
    val anchor = anchor?.takeIf { it.isAttached } ?: return null
    if (!features.ready || lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) != true ||
      !decor.isAttachedToWindow || !host.isAttachedToWindow || decor.display?.displayId != host.display?.displayId
    ) {
      return null
    }
    val token = host.windowToken ?: return null
    val display = host.display?.displayId ?: return null
    val origin = host.windowOrigin()
    val activityOffset = decor.windowOrigin() - origin
    val metrics = WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(activity).bounds
    val full = IntRect(0, 0, metrics.width(), metrics.height())
    val position = anchor.positionInWindow()
    val actualAnchor = IntRect(IntOffset(position.x.roundToInt(), position.y.roundToInt()), anchor.size)
    val visible = anchor.boundsInWindow()
    if (visible.isEmpty) return null
    val pane =
      foldSafeRegions(full, features.features)
        .map { it.translate(activityOffset) }
        .filter { it.contains(actualAnchor) }
        .minWithOrNull(
          compareByDescending<IntRect> { it.width.toLong() * it.height }
            .thenBy { it.top }
            .thenBy { if (direction == LayoutDirection.Ltr) it.left else -it.right },
        ) ?: return null
    val frame = Rect().also(host::getWindowVisibleDisplayFrame)
    val hostPosition = IntArray(2).also(host::getLocationInWindow)
    val hostBounds = IntRect(hostPosition[0], hostPosition[1], hostPosition[0] + host.width, hostPosition[1] + host.height)
    val window = full.translate(activityOffset)
    val insets =
      ViewCompat.getRootWindowInsets(host)?.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
      )
    val safe =
      IntRect(
        window.left + (insets?.left ?: 0),
        window.top + (insets?.top ?: 0),
        window.right - (insets?.right ?: 0),
        window.bottom - (insets?.bottom ?: 0),
      )
    val available =
      pane
        .intersect(hostBounds)
        .intersect(safe)
        .intersect(IntRect(frame.left - origin.x, frame.top - origin.y, frame.right - origin.x, frame.bottom - origin.y))
    if (available.width <= 0 || available.height <= 0 ||
      visible.right <= available.left || visible.left >= available.right || visible.bottom <= available.top || visible.top >= available.bottom
    ) {
      return null
    }
    return MenuGeometry(actualAnchor, available, origin, token, display)
  }
}

private fun IntRect.contains(other: IntRect): Boolean = other.width > 0 && other.height > 0 && other.left >= left && other.top >= top && other.right <= right && other.bottom <= bottom

private fun View.windowOrigin(): IntOffset {
  val screen = IntArray(2).also(::getLocationOnScreen)
  val window = IntArray(2).also(::getLocationInWindow)
  return IntOffset(screen[0] - window[0], screen[1] - window[1])
}

private fun View.screenBounds(): IntRect {
  val screen = IntArray(2).also(::getLocationOnScreen)
  return IntRect(screen[0], screen[1], screen[0] + width, screen[1] + height)
}
