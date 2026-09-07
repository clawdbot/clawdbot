package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.recalculateWindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.round
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy

@Composable
internal fun FoldAwareDialog(
  onDismissRequest: () -> Unit,
  title: String,
  dismissOnBackPress: Boolean = true,
  dismissOnClickOutside: Boolean = true,
  securePolicy: SecureFlagPolicy = SecureFlagPolicy.Inherit,
  content: @Composable () -> Unit,
) {
  val activity = LocalActivity.current
  val activityView = LocalView.current
  val features = rememberWindowDisplayFeatures()
  var promptBounds by remember { mutableStateOf(Rect.Zero) }
  val dismiss by rememberUpdatedState(onDismissRequest)
  val outsideEnabled by rememberUpdatedState(dismissOnClickOutside)

  Dialog(
    onDismissRequest = onDismissRequest,
    properties =
      DialogProperties(
        dismissOnBackPress = dismissOnBackPress,
        // The native content is full-window. Only the measured prompt is "inside".
        dismissOnClickOutside = false,
        securePolicy = securePolicy,
        usePlatformDefaultWidth = false,
        decorFitsSystemWindows = false,
      ),
  ) {
    val geometry = rememberOverlayWindowGeometry(activity, activityView, LocalView.current)
    Layout(
      modifier =
        Modifier.fillMaxSize().pointerInput(Unit) {
          awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val initialBounds = promptBounds
            if (!initialBounds.contains(down.position)) {
              down.consume()
              var tap = !initialBounds.isEmpty
              do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (event.changes.size != 1 || promptBounds != initialBounds) tap = false
                for (change in event.changes) {
                  if (change.isConsumed || initialBounds.contains(change.position) ||
                    (change.position - down.position).getDistance() > viewConfiguration.touchSlop
                  ) {
                    tap = false
                  }
                  change.consume()
                }
                if (event.changes.all { !it.pressed } && tap &&
                  event.changes.single().changedToUpIgnoreConsumed() && outsideEnabled
                ) {
                  dismiss()
                }
              } while (event.changes.any { it.pressed })
            }
          }
        },
      content = {
        Box(
          Modifier
            .recalculateWindowInsets()
            .clipToBounds()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(24.dp),
          contentAlignment = Alignment.Center,
        ) {
          Box(
            Modifier
              .widthIn(max = 560.dp)
              .fillMaxWidth()
              .onGloballyPositioned { promptBounds = it.boundsInRoot() }
              .semantics { paneTitle = title },
          ) {
            content()
          }
        }
      },
    ) { measurables, constraints ->
      val width = constraints.maxWidth
      val height = constraints.maxHeight
      layout(width, height) {
        // Select in the full Activity window before clipping for this dialog or its IME.
        // Sample the stationary host, then place physically: RTL only breaks pane ties.
        val origin = coordinates?.positionInWindow()?.round() ?: IntOffset.Zero
        val pane =
          geometry?.let {
            foldSafeRegion(it.activityExtent, features, layoutDirection).translate(it.activityToOverlay - origin)
          } ?: IntRect.Zero
        val left = pane.left.coerceIn(0, width)
        val top = pane.top.coerceIn(0, height)
        val right = pane.right.coerceIn(left, width)
        val bottom = pane.bottom.coerceIn(top, height)
        measurables.single().measure(Constraints.fixed(right - left, bottom - top)).place(left, top)
      }
    }
  }
}

@Composable
internal fun FoldAwarePrompt(
  onDismissRequest: () -> Unit,
  title: String,
  containerColor: Color = ClawTheme.colors.surfaceRaised,
  text: @Composable () -> Unit,
  actions: @Composable () -> Unit,
) {
  FoldAwareDialog(onDismissRequest = onDismissRequest, title = title) {
    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(ClawTheme.radii.sheet),
      color = containerColor,
      contentColor = ClawTheme.colors.text,
    ) {
      // Scroll the entire unweighted prompt, including every action, within the safe viewport.
      Column(
        modifier = Modifier.verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        Text(title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
        text()
        FlowRow(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          actions()
        }
      }
    }
  }
}
