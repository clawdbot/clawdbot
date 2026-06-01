package ai.openclaw.app

import android.app.Application
import android.os.StrictMode

/**
 * Android Application singleton that owns process-wide secure prefs and lazy NodeRuntime startup.
 */
class NodeApp : Application() {
  val prefs: SecurePrefs by lazy { SecurePrefs(this) }

  @Volatile private var runtimeInstance: NodeRuntime? = null

  /**
   * Returns the single NodeRuntime for this process, creating it on first use.
   */
  fun ensureRuntime(): NodeRuntime {
    runtimeInstance?.let { return it }
    return synchronized(this) {
      runtimeInstance ?: NodeRuntime(this, prefs).also { runtimeInstance = it }
    }
  }

  /**
   * Reads the runtime without forcing startup, used by lifecycle probes and services.
   */
  fun peekRuntime(): NodeRuntime? = runtimeInstance

  override fun onCreate() {
    super.onCreate()
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
}
