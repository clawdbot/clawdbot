package ai.openclaw.app.accessibility

import android.graphics.Rect
import android.text.InputType
import android.view.accessibility.AccessibilityNodeInfo
import java.util.UUID

internal const val MAX_NODES = 400
internal const val MAX_DEPTH = 40
internal const val MAX_TEXT_PER_NODE = 200

// Bounds AccessibilityNodeInfo acquisition so pathological trees cannot stall the UI thread or spike memory.
internal const val MAX_VISITED_NODES = 4_000

internal data class AccessibilitySnapshotCapture(
  val snapshot: MobileUiSnapshot,
  val nodesByRef: Map<String, AccessibilityNodeInfo>,
)

internal class AccessibilitySnapshotter {
  fun capture(service: OpenClawAccessibilityService): AccessibilitySnapshotCapture {
    val root = service.rootInActiveWindow
    if (root == null) {
      return AccessibilitySnapshotCapture(
        snapshot =
          MobileUiSnapshot(
            id = UUID.randomUUID().toString(),
            capturedAtMs = System.currentTimeMillis(),
            packageName = null,
            windowTitle = null,
            nodes = emptyList(),
          ),
        nodesByRef = emptyMap(),
      )
    }

    val packageName = root.packageName?.toString()
    val windowTitle = root.readWindowTitle()
    val normalized = AccessibilityTreeNormalizer.normalize(AndroidAccessibilityNode(root))
    return AccessibilitySnapshotCapture(
      snapshot =
        MobileUiSnapshot(
          id = UUID.randomUUID().toString(),
          capturedAtMs = System.currentTimeMillis(),
          packageName = packageName,
          windowTitle = windowTitle,
          nodes = normalized.nodes,
        ),
      nodesByRef =
        normalized.retainedNodes.mapValues { (_, node) ->
          (node as AndroidAccessibilityNode).platformNode
        },
    )
  }
}

internal interface AccessibilityNodeAdapter {
  val className: String?
  val text: String?
  val contentDescription: String?
  val viewId: String?
  val boundsInScreen: Rect
  val clickable: Boolean
  val editable: Boolean
  val scrollable: Boolean
  val enabled: Boolean
  val focused: Boolean
  val password: Boolean
  val inputType: Int
  val actionIds: List<Int>
  val childCount: Int

  fun childAt(index: Int): AccessibilityNodeAdapter?

  fun recycle()
}

private class AndroidAccessibilityNode(
  val platformNode: AccessibilityNodeInfo,
) : AccessibilityNodeAdapter {
  override val className: String?
    get() = platformNode.className?.toString()
  override val text: String?
    get() = platformNode.text?.toString()
  override val contentDescription: String?
    get() = platformNode.contentDescription?.toString()
  override val viewId: String?
    get() = platformNode.viewIdResourceName
  override val boundsInScreen: Rect
    get() = Rect().also(platformNode::getBoundsInScreen)
  override val clickable: Boolean
    get() = platformNode.isClickable
  override val editable: Boolean
    get() = platformNode.isEditable
  override val scrollable: Boolean
    get() = platformNode.isScrollable
  override val enabled: Boolean
    get() = platformNode.isEnabled
  override val focused: Boolean
    get() = platformNode.isFocused
  override val password: Boolean
    get() = platformNode.isPassword
  override val inputType: Int
    get() = platformNode.inputType
  override val actionIds: List<Int>
    get() = platformNode.actionList.map(AccessibilityNodeInfo.AccessibilityAction::getId)
  override val childCount: Int
    get() = platformNode.childCount

  override fun childAt(index: Int): AccessibilityNodeAdapter? = platformNode.getChild(index)?.let(::AndroidAccessibilityNode)

  @Suppress("DEPRECATION")
  override fun recycle() = platformNode.recycle()
}

internal data class NormalizedAccessibilityTree(
  val nodes: List<MobileUiNode>,
  val retainedNodes: Map<String, AccessibilityNodeAdapter>,
)

internal object AccessibilityTreeNormalizer {
  private data class PendingNode(
    val node: AccessibilityNodeAdapter,
    val depth: Int,
    val parentRef: String?,
  )

  fun normalize(root: AccessibilityNodeAdapter): NormalizedAccessibilityTree {
    val pending = ArrayDeque<PendingNode>()
    val nodes = mutableListOf<MobileUiNode>()
    val retained = linkedMapOf<String, AccessibilityNodeAdapter>()
    pending.addLast(PendingNode(root, depth = 0, parentRef = null))
    var discoveredNodeCount = 1

    var current: AccessibilityNodeAdapter? = null
    try {
      while (pending.isNotEmpty()) {
        val item = pending.removeLast()
        current = item.node
        if (item.depth > MAX_DEPTH) {
          current.recycle()
          current = null
          continue
        }

        val bounds = current.boundsInScreen
        val rawText = current.text
        val rawDescription = current.contentDescription
        val include =
          (bounds.width() > 0 && bounds.height() > 0) ||
            !rawText.isNullOrEmpty() ||
            !rawDescription.isNullOrEmpty() ||
            current.clickable
        val ref = if (include) "n${nodes.size}" else item.parentRef
        val sensitive = shouldRedactText(current.password, current.editable, current.inputType)

        if (include) {
          nodes +=
            MobileUiNode(
              ref = checkNotNull(ref),
              parentRef = item.parentRef,
              role = stableRole(current.className, current.clickable, current.editable),
              text = normalizeNodeText(rawText, sensitive),
              contentDescription = normalizeNodeText(rawDescription, sensitive),
              viewId = truncateNodeText(current.viewId),
              boundsInScreen = Rect(bounds),
              clickable = current.clickable,
              editable = current.editable,
              scrollable = current.scrollable,
              enabled = current.enabled,
              focused = current.focused,
              actions = stableActionNames(current.actionIds),
            )
        }

        val reachedNodeLimit = nodes.size >= MAX_NODES
        if (!reachedNodeLimit && item.depth < MAX_DEPTH) {
          val remainingTraversalBudget = MAX_VISITED_NODES - discoveredNodeCount
          val childSlotsToInspect = minOf(current.childCount, remainingTraversalBudget)
          for (index in childSlotsToInspect - 1 downTo 0) {
            discoveredNodeCount += 1
            current.childAt(index)?.let { child ->
              pending.addLast(PendingNode(child, depth = item.depth + 1, parentRef = ref))
            }
          }
        }

        if (include) {
          retained[checkNotNull(ref)] = current
        } else {
          current.recycle()
        }
        current = null
        if (reachedNodeLimit) break
      }
    } catch (error: Throwable) {
      current?.recycle()
      retained.values.forEach(AccessibilityNodeAdapter::recycle)
      pending.forEach { it.node.recycle() }
      throw error
    }

    pending.forEach { it.node.recycle() }
    return NormalizedAccessibilityTree(nodes = nodes, retainedNodes = retained)
  }
}

internal fun shouldRedactText(
  isPassword: Boolean,
  isEditable: Boolean,
  inputType: Int,
): Boolean {
  if (isPassword) return true
  if (!isEditable) return false

  val inputClass = inputType and InputType.TYPE_MASK_CLASS
  val variation = inputType and InputType.TYPE_MASK_VARIATION
  return when (inputClass) {
    InputType.TYPE_CLASS_TEXT ->
      variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
    InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
    else -> false
  }
}

internal fun normalizeNodeText(
  text: String?,
  sensitive: Boolean,
): String? = if (sensitive) "[redacted]" else truncateNodeText(text)

internal fun truncateNodeText(text: String?): String? {
  if (text == null || text.length <= MAX_TEXT_PER_NODE) return text
  return text.take(MAX_TEXT_PER_NODE - 1) + "…"
}

internal fun stableActionNames(actionIds: Collection<Int>): List<String> {
  val ids = actionIds.toSet()
  return buildList {
    if (AccessibilityNodeInfo.ACTION_CLICK in ids) add("activate")
    if (AccessibilityNodeInfo.ACTION_LONG_CLICK in ids) add("long_press")
    if (AccessibilityNodeInfo.ACTION_SET_TEXT in ids) add("set_text")
    if (AccessibilityNodeInfo.ACTION_SCROLL_FORWARD in ids) add("scroll_forward")
    if (AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD in ids) add("scroll_backward")
    if (AccessibilityNodeInfo.ACTION_FOCUS in ids) add("focus")
  }
}

internal fun stableRole(
  className: String?,
  clickable: Boolean,
  editable: Boolean,
): String {
  val simpleName = className?.substringAfterLast('.')
  return when {
    editable -> "text_field"
    simpleName == "Button" || simpleName == "ImageButton" -> "button"
    simpleName == "CheckBox" -> "checkbox"
    simpleName == "Switch" || simpleName == "SwitchCompat" -> "switch"
    simpleName == "RadioButton" -> "radio"
    simpleName == "ImageView" -> "image"
    simpleName == "TextView" -> if (clickable) "button" else "text"
    simpleName == "ListView" || simpleName == "RecyclerView" -> "list"
    simpleName == "ScrollView" || simpleName == "HorizontalScrollView" -> "scroll_view"
    simpleName == "WebView" -> "web_view"
    clickable -> "button"
    else -> "node"
  }
}

@Suppress("DEPRECATION")
private fun AccessibilityNodeInfo.readWindowTitle(): String? {
  val nodeWindow = window ?: return null
  return try {
    nodeWindow.title?.toString()
  } finally {
    nodeWindow.recycle()
  }
}
