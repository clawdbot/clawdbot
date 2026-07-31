package ai.openclaw.app.accessibility

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicLong

class OpenClawAccessibilityService : AccessibilityService() {
  override fun onServiceConnected() {
    super.onServiceConnected()
    connectionState.connect(this)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // Coordinate staleness epoch: advance on any event that can move or change on-screen content.
    // Pure focus/hover/announcement events are intentionally excluded.
    when (event?.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
      AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      AccessibilityEvent.TYPE_VIEW_SCROLLED,
      AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
      AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
      -> advanceUiEpoch()
      else -> Unit
    }
  }

  override fun onInterrupt() = Unit

  override fun onUnbind(intent: Intent?): Boolean {
    connectionState.disconnect(this)
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    connectionState.disconnect(this)
    super.onDestroy()
  }

  @Suppress("DEPRECATION")
  internal fun foregroundPackageName(): String? {
    val root = rootInActiveWindow ?: return null
    return try {
      root.packageName?.toString()
    } finally {
      root.recycle()
    }
  }

  companion object {
    private val connectionState = ObservableServiceInstance<OpenClawAccessibilityService>()
    private val uiEpochCounter = AtomicLong(0)

    val instance: OpenClawAccessibilityService?
      get() = connectionState.connection.value.instance

    internal val connection: StateFlow<AccessibilityServiceConnection<OpenClawAccessibilityService>> =
      connectionState.connection

    val isConnected: StateFlow<Boolean> = connectionState.isConnected

    val uiEpoch: Long
      get() = uiEpochCounter.get()

    val connectionGeneration: Long
      get() = connectionState.connection.value.generation

    internal fun advanceUiEpoch(): Long = uiEpochCounter.incrementAndGet()
  }
}

internal data class AccessibilityServiceConnection<T : Any>(
  val instance: T?,
  val generation: Long,
)

internal class ObservableServiceInstance<T : Any> {
  private val mutableConnection = MutableStateFlow(AccessibilityServiceConnection<T>(instance = null, generation = 0))
  private val mutableIsConnected = MutableStateFlow(false)

  val connection: StateFlow<AccessibilityServiceConnection<T>> = mutableConnection.asStateFlow()
  val isConnected: StateFlow<Boolean> = mutableIsConnected.asStateFlow()

  fun connect(instance: T) {
    val current = mutableConnection.value
    mutableConnection.value = AccessibilityServiceConnection(instance, generation = current.generation + 1)
    mutableIsConnected.value = true
  }

  fun disconnect(instance: T) {
    val current = mutableConnection.value
    // Only the current instance may clear connectivity: during a service-replacement
    // race the old instance's teardown must not publish false after the replacement
    // already connected, or NodeRuntime would withdraw the mobile UI capability.
    if (current.instance !== instance) return
    mutableConnection.value = current.copy(instance = null)
    mutableIsConnected.value = false
  }
}
