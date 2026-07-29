package ai.openclaw.app.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

private const val GESTURE_RESULT_TIMEOUT_MS = 10_000L

sealed interface MobileUiAction {
  data class Activate(
    val ref: String,
  ) : MobileUiAction

  data class SetText(
    val ref: String,
    val text: String,
  ) : MobileUiAction

  data class Scroll(
    val ref: String,
    val direction: ScrollDirection,
  ) : MobileUiAction

  data class Tap(
    val x: Int,
    val y: Int,
  ) : MobileUiAction

  data class Swipe(
    val x1: Int,
    val y1: Int,
    val x2: Int,
    val y2: Int,
    val durationMs: Long,
  ) : MobileUiAction

  data class GlobalAction(
    val name: GlobalActionName,
  ) : MobileUiAction

  data class Wait(
    val ms: Long,
  ) : MobileUiAction
}

enum class ScrollDirection {
  Forward,
  Backward,
}

enum class GlobalActionName {
  Back,
  Home,
  Recents,
  Notifications,
}

enum class ActionOutcomeCode(
  val value: String,
) {
  Completed("completed"),
  AcceptedButUnverified("accepted_but_unverified"),
  TargetStale("target_stale"),
  TargetNotFound("target_not_found"),
  ActionNotSupported("action_not_supported"),
  ActionRejected("action_rejected"),
  GestureCancelled("gesture_cancelled"),
  PackageChanged("package_changed"),
  ServiceDisabled("service_disabled"),
  SecureContent("secure_content"),
  TimedOutOutcomeUnknown("timed_out_outcome_unknown"),
}

data class ActionResult(
  val code: ActionOutcomeCode,
  val message: String? = null,
)

internal class AccessibilityServiceDisabledException(
  message: String = "Accessibility service is disabled",
) : IllegalStateException(message)

class AccessibilityActionExecutor internal constructor(
  private val connectionProvider: () -> AccessibilityServiceConnection<OpenClawAccessibilityService> = {
    OpenClawAccessibilityService.connection.value
  },
  private val captureSnapshot: (OpenClawAccessibilityService) -> AccessibilitySnapshotCapture =
    AccessibilitySnapshotter()::capture,
  private val foregroundPackageProvider: (OpenClawAccessibilityService) -> String? =
    OpenClawAccessibilityService::foregroundPackageName,
  private val uiEpochProvider: () -> Long = { OpenClawAccessibilityService.uiEpoch },
) : AutoCloseable {
  private val generationLock = Any()
  private var closed = false
  private val generation =
    SnapshotGenerationStore<AccessibilityNodeInfo> { node ->
      @Suppress("DEPRECATION")
      node.recycle()
    }

  fun observe(): MobileUiSnapshot {
    synchronized(generationLock) {
      if (closed) throw AccessibilityServiceDisabledException("Accessibility executor is closed")
    }
    val capturedConnection = connectionProvider()
    val service = capturedConnection.instance
    if (service == null) {
      synchronized(generationLock) { generation.clear() }
      throw AccessibilityServiceDisabledException()
    }
    val capturedUiEpoch = uiEpochProvider()
    val capturedConnectionGeneration = capturedConnection.generation
    val capture = captureSnapshot(service)
    synchronized(generationLock) {
      val currentConnection = connectionProvider()
      val connectionChanged =
        currentConnection.instance !== service || currentConnection.generation != capturedConnectionGeneration
      if (closed || connectionChanged) {
        generation.clear()
        recycleCapture(capture)
        val message = if (closed) "Accessibility executor closed during observe" else "Accessibility service changed during observe"
        throw AccessibilityServiceDisabledException(message)
      }
      generation.replace(
        snapshotId = capture.snapshot.id,
        packageName = capture.snapshot.packageName,
        uiEpoch = capturedUiEpoch,
        connectionGeneration = capturedConnectionGeneration,
        values = capture.nodesByRef,
      )
    }
    return capture.snapshot
  }

  suspend fun act(
    snapshotId: String,
    action: MobileUiAction,
  ): ActionResult {
    val currentConnection = connectionProvider()
    val service = currentConnection.instance
    if (service == null) {
      synchronized(generationLock) { generation.clear() }
      return ActionResult(ActionOutcomeCode.ServiceDisabled, "Accessibility service is not connected")
    }
    synchronized(generationLock) {
      if (closed) {
        return ActionResult(ActionOutcomeCode.ServiceDisabled, "Accessibility executor is closed")
      }
    }
    if (action is MobileUiAction.GlobalAction) {
      return performGlobalAction(service, action.name)
    }
    synchronized(generationLock) {
      if (closed) {
        return ActionResult(ActionOutcomeCode.ServiceDisabled, "Accessibility executor is closed")
      }
      if (!generation.matches(snapshotId)) {
        return ActionResult(ActionOutcomeCode.TargetStale, "Observe again before acting")
      }
      if (currentConnection.generation != generation.connectionGeneration) {
        return ActionResult(ActionOutcomeCode.TargetStale, "Accessibility service reconnected; re-observe before acting")
      }

      when (action) {
        is MobileUiAction.Tap,
        is MobileUiAction.Swipe,
        -> coordinateGesturePreflight(service)?.let { return it }
        // Node actions use per-node refresh() for freshness; UI epoch gates only blind coordinates.
        // Do not add an epoch check here: unrelated changes/app switches would break valid act flows.
        is MobileUiAction.Activate,
        is MobileUiAction.SetText,
        is MobileUiAction.Scroll,
        -> nodeActionPackagePreflight(service)?.let { return it }
        is MobileUiAction.GlobalAction,
        is MobileUiAction.Wait,
        -> Unit
      }
    }

    return when (action) {
      is MobileUiAction.Activate ->
        synchronized(generationLock) {
          performNodeAction(
            snapshotId = snapshotId,
            ref = action.ref,
            actionId = AccessibilityNodeInfo.ACTION_CLICK,
            actionName = "activate",
          )
        }
      is MobileUiAction.SetText -> synchronized(generationLock) { setText(snapshotId, action) }
      is MobileUiAction.Scroll -> synchronized(generationLock) { scroll(snapshotId, action) }
      is MobileUiAction.Tap -> {
        val gesture =
          runCatching { tapGesture(action.x, action.y) }
            .getOrElse { return ActionResult(ActionOutcomeCode.ActionRejected, "Invalid tap gesture") }
        dispatchGesture(service, gesture)
      }
      is MobileUiAction.Swipe -> {
        if (action.durationMs <= 0) {
          ActionResult(ActionOutcomeCode.ActionRejected, "Swipe duration must be positive")
        } else {
          val gesture =
            runCatching { swipeGesture(action) }
              .getOrElse { return ActionResult(ActionOutcomeCode.ActionRejected, "Invalid swipe gesture") }
          dispatchGesture(service, gesture)
        }
      }
      is MobileUiAction.GlobalAction -> performGlobalAction(service, action.name)
      is MobileUiAction.Wait -> {
        if (action.ms < 0) {
          ActionResult(ActionOutcomeCode.ActionRejected, "Wait duration cannot be negative")
        } else {
          delay(action.ms)
          ActionResult(ActionOutcomeCode.Completed)
        }
      }
    }
  }

  override fun close() {
    synchronized(generationLock) {
      if (closed) return
      closed = true
      generation.clear()
    }
  }

  @Suppress("DEPRECATION")
  private fun recycleCapture(capture: AccessibilitySnapshotCapture) {
    capture.nodesByRef.values.forEach(AccessibilityNodeInfo::recycle)
  }

  private fun coordinateGesturePreflight(service: OpenClawAccessibilityService): ActionResult? {
    val expectedPackage = generation.packageName
    val currentPackage = foregroundPackageProvider(service)
    if (expectedPackage == null || currentPackage == null || expectedPackage != currentPackage) {
      return ActionResult(
        ActionOutcomeCode.PackageChanged,
        "Active package cannot be verified against the snapshot; re-observe before coordinate actions",
      )
    }
    if (uiEpochProvider() > generation.uiEpoch) {
      return ActionResult(
        ActionOutcomeCode.TargetStale,
        "UI changed since observe; re-observe before coordinate actions",
      )
    }
    return null
  }

  private fun nodeActionPackagePreflight(service: OpenClawAccessibilityService): ActionResult? {
    val expectedPackage = generation.packageName
    val currentPackage = foregroundPackageProvider(service)
    if (expectedPackage == null || currentPackage == null || expectedPackage != currentPackage) {
      return ActionResult(
        ActionOutcomeCode.PackageChanged,
        "Active package cannot be verified against the snapshot; re-observe before node actions",
      )
    }
    return null
  }

  private fun performNodeAction(
    snapshotId: String,
    ref: String,
    actionId: Int,
    actionName: String,
    arguments: Bundle? = null,
    validateRefreshedNode: ((AccessibilityNodeInfo) -> ActionResult?)? = null,
  ): ActionResult {
    val node =
      when (val target = generation.resolve(snapshotId, ref)) {
        is GenerationTarget.Found -> target.value
        GenerationTarget.Stale ->
          return ActionResult(ActionOutcomeCode.TargetStale, "Node $ref is not in the current snapshot")
      }
    if (!runCatching { node.refresh() }.getOrDefault(false)) {
      return ActionResult(ActionOutcomeCode.TargetNotFound, "Node $ref is no longer available")
    }
    validateRefreshedNode?.invoke(node)?.let { return it }
    if (node.actionList.none { it.id == actionId }) {
      return ActionResult(ActionOutcomeCode.ActionNotSupported, "Node $ref does not advertise $actionName")
    }
    val accepted = runCatching { node.performAction(actionId, arguments) }.getOrDefault(false)
    return if (accepted) {
      ActionResult(ActionOutcomeCode.AcceptedButUnverified)
    } else {
      ActionResult(ActionOutcomeCode.ActionRejected, "Android rejected $actionName for node $ref")
    }
  }

  private fun setText(
    snapshotId: String,
    action: MobileUiAction.SetText,
  ): ActionResult {
    val arguments =
      Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, action.text)
      }
    return performNodeAction(
      snapshotId = snapshotId,
      ref = action.ref,
      actionId = AccessibilityNodeInfo.ACTION_SET_TEXT,
      actionName = "set_text",
      arguments = arguments,
    ) { node ->
      if (shouldRedactText(node.isPassword, node.isEditable, node.inputType)) {
        ActionResult(ActionOutcomeCode.SecureContent, "Text entry into password fields is refused")
      } else {
        null
      }
    }
  }

  private fun scroll(
    snapshotId: String,
    action: MobileUiAction.Scroll,
  ): ActionResult {
    val (actionId, actionName) =
      when (action.direction) {
        ScrollDirection.Forward -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD to "scroll_forward"
        ScrollDirection.Backward -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD to "scroll_backward"
      }
    return performNodeAction(snapshotId, action.ref, actionId, actionName)
  }

  private suspend fun dispatchGesture(
    service: OpenClawAccessibilityService,
    gesture: GestureDescription,
  ): ActionResult =
    withTimeoutOrNull(GESTURE_RESULT_TIMEOUT_MS) {
      suspendCancellableCoroutine { continuation ->
        val callback =
          object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
              if (continuation.isActive) continuation.resume(ActionResult(ActionOutcomeCode.Completed))
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
              if (continuation.isActive) {
                continuation.resume(ActionResult(ActionOutcomeCode.GestureCancelled))
              }
            }
          }
        val accepted = runCatching { service.dispatchGesture(gesture, callback, null) }.getOrDefault(false)
        if (!accepted && continuation.isActive) {
          continuation.resume(ActionResult(ActionOutcomeCode.ActionRejected, "Android rejected the gesture"))
        }
      }
    } ?: ActionResult(
      ActionOutcomeCode.TimedOutOutcomeUnknown,
      "Gesture callback did not arrive within $GESTURE_RESULT_TIMEOUT_MS ms",
    )

  private fun performGlobalAction(
    service: OpenClawAccessibilityService,
    name: GlobalActionName,
  ): ActionResult {
    val actionId =
      when (name) {
        GlobalActionName.Back -> AccessibilityService.GLOBAL_ACTION_BACK
        GlobalActionName.Home -> AccessibilityService.GLOBAL_ACTION_HOME
        GlobalActionName.Recents -> AccessibilityService.GLOBAL_ACTION_RECENTS
        GlobalActionName.Notifications -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
      }
    return if (runCatching { service.performGlobalAction(actionId) }.getOrDefault(false)) {
      ActionResult(ActionOutcomeCode.Completed)
    } else {
      ActionResult(ActionOutcomeCode.ActionRejected, "Android rejected global action ${name.name.lowercase()}")
    }
  }
}

internal class SnapshotGenerationStore<T>(
  private val release: (T) -> Unit,
) {
  var packageName: String? = null
    private set
  var uiEpoch: Long = 0
    private set
  var connectionGeneration: Long = 0
    private set
  private var snapshotId: String? = null
  private var values: Map<String, T> = emptyMap()

  fun replace(
    snapshotId: String,
    packageName: String?,
    uiEpoch: Long,
    connectionGeneration: Long,
    values: Map<String, T>,
  ) {
    clear()
    this.snapshotId = snapshotId
    this.packageName = packageName
    this.uiEpoch = uiEpoch
    this.connectionGeneration = connectionGeneration
    this.values = values
  }

  fun matches(snapshotId: String): Boolean = this.snapshotId == snapshotId

  fun resolve(
    snapshotId: String,
    ref: String,
  ): GenerationTarget<T> {
    if (!matches(snapshotId)) return GenerationTarget.Stale
    return values[ref]?.let { value -> GenerationTarget.Found(value) } ?: GenerationTarget.Stale
  }

  fun clear() {
    values.values.forEach(release)
    values = emptyMap()
    snapshotId = null
    packageName = null
    uiEpoch = 0
    connectionGeneration = 0
  }
}

internal sealed interface GenerationTarget<out T> {
  data class Found<T>(
    val value: T,
  ) : GenerationTarget<T>

  data object Stale : GenerationTarget<Nothing>
}

private fun tapGesture(
  x: Int,
  y: Int,
): GestureDescription {
  val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
  return GestureDescription
    .Builder()
    .addStroke(GestureDescription.StrokeDescription(path, 0, 1))
    .build()
}

private fun swipeGesture(action: MobileUiAction.Swipe): GestureDescription {
  val path =
    Path().apply {
      moveTo(action.x1.toFloat(), action.y1.toFloat())
      lineTo(action.x2.toFloat(), action.y2.toFloat())
    }
  return GestureDescription
    .Builder()
    .addStroke(GestureDescription.StrokeDescription(path, 0, action.durationMs))
    .build()
}
