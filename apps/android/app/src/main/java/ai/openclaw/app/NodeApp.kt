package ai.openclaw.app

import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.notifyNativeLocaleChanged
import ai.openclaw.app.wear.GoogleWearMessageSender
import ai.openclaw.app.wear.GoogleWearPeerResolver
import ai.openclaw.app.wear.WearProxyBridge
import ai.openclaw.app.wear.WearRealtimeChannelRegistry
import android.app.Application
import android.content.res.Configuration
import android.os.StrictMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

/**
 * Android Application singleton that owns process-wide secure prefs and lazy NodeRuntime startup.
 */
class NodeApp : Application() {
  val prefs: SecurePrefs by lazy { SecurePrefs(this) }

  // System share senders can create overlapping Activity tasks; keep one bounded process queue.
  internal val chatShareDraftSeq = AtomicLong()
  internal val chatShareDraftQueue = ChatShareDraftQueue()

  private val runtimeScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val runtimeLock = Any()
  private var runtimeInstance: NodeRuntime? = null

  internal val wearProxyBridge: WearProxyBridge by lazy {
    WearProxyBridge(
      scope = runtimeScope,
      sender = GoogleWearMessageSender(this),
      peerResolver = GoogleWearPeerResolver(this),
      handleRequest = { sourceNodeId, request ->
        ensureBackgroundRuntime().handleWearProxyRequest(sourceNodeId, request)
      },
    )
  }

  internal val wearRealtimeChannels: WearRealtimeChannelRegistry by lazy {
    WearRealtimeChannelRegistry(this, runtimeScope)
  }

  /**
   * Returns the single NodeRuntime for this process, creating it on first use.
   */
  fun ensureRuntime(): NodeRuntime =
    synchronized(runtimeLock) {
      runtimeInstance ?: NodeRuntime(this, prefs).also { runtimeInstance = it }
    }

  /** Creates a cold-process runtime with foreground-only capabilities disabled before publication. */
  internal fun ensureBackgroundRuntime(): NodeRuntime =
    synchronized(runtimeLock) {
      runtimeInstance
        ?: NodeRuntime(this, prefs, initialForeground = false).also { runtimeInstance = it }
    }

  internal fun ensureScreenshotFixtureRuntime(): NodeRuntime =
    synchronized(runtimeLock) {
      check(BuildConfig.DEBUG) { "Android screenshot fixtures require a debug build" }
      runtimeInstance?.also { runtime ->
        check(runtime.mode == NodeRuntimeMode.ScreenshotFixture) {
          "NodeRuntime already started in live mode"
        }
      } ?: NodeRuntime(this, prefs, NodeRuntimeMode.ScreenshotFixture).also { runtimeInstance = it }
    }

  /**
   * Reads the runtime without forcing startup, used by lifecycle probes and services.
   */
  fun peekRuntime(): NodeRuntime? = synchronized(runtimeLock) { runtimeInstance }

  /** Disconnects the current or concurrently constructing runtime without blocking the caller. */
  internal fun disconnectRuntimeAsync() {
    // The process-owned scope outlives a stopping service, so cancellation cannot
    // strand an Activity-created runtime that the service has not observed yet.
    runtimeScope.launch { peekRuntime()?.disconnect() }
  }

  /** Clears pairing auth without racing lazy process-runtime construction. */
  suspend fun resetGatewaySetupAuth(stableId: String): Boolean {
    val runtime =
      synchronized(runtimeLock) {
        runtimeInstance
          ?: NodeRuntime.forGatewayAuthReset(this, prefs).also { runtimeInstance = it }
      }
    return runtime.resetGatewaySetupAuth(stableId)
  }

  override fun onCreate() {
    super.onCreate()
    NativeStringResources.install(this)
    if (BuildConfig.DEBUG) {
      StrictMode.setThreadPolicy(
        StrictMode.ThreadPolicy
          .Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
      StrictMode.setVmPolicy(
        StrictMode.VmPolicy
          .Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // The process runtime survives Activity recreation, so retained text and
    // serialized Home Canvas state need an explicit locale refresh signal.
    NativeStringResources.setConfigurationLocales(newConfig)
    notifyNativeLocaleChanged()
  }
}
