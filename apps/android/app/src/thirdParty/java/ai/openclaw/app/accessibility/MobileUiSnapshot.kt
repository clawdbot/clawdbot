package ai.openclaw.app.accessibility

import android.graphics.Rect

data class MobileUiSnapshot(
  val id: String,
  val capturedAtMs: Long,
  val packageName: String?,
  val windowTitle: String?,
  val nodes: List<MobileUiNode>,
)

data class MobileUiNode(
  val ref: String,
  val parentRef: String?,
  val role: String,
  val text: String?,
  val contentDescription: String?,
  val viewId: String?,
  val boundsInScreen: Rect,
  val clickable: Boolean,
  val editable: Boolean,
  val scrollable: Boolean,
  val enabled: Boolean,
  val focused: Boolean,
  val actions: List<String>,
)
