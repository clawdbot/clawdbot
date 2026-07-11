package ai.openclaw.app

import ai.openclaw.app.chat.ChatCacheDatabase
import ai.openclaw.app.chat.RoomChatCommandOutbox
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import android.app.Application
import android.os.StrictMode
import androidx.room.withTransaction
import kotlinx.coroutines.runBlocking

/**
 * Android Application singleton that owns process-wide secure prefs and lazy NodeRuntime startup.
 */
class NodeApp : Application() {
  val prefs: SecurePrefs by lazy { SecurePrefs(this) }

  private val runtimeLock = Any()
  private var runtimeInstance: NodeRuntime? = null

  /**
   * Returns the single NodeRuntime for this process, creating it on first use.
   */
  fun ensureRuntime(): NodeRuntime =
    synchronized(runtimeLock) {
      runtimeInstance ?: NodeRuntime(this, prefs).also { runtimeInstance = it }
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

  /** Clears pairing auth without racing lazy process-runtime construction. */
  suspend fun resetGatewaySetupAuth(stableId: String): Boolean {
    val runtime =
      synchronized(runtimeLock) {
        runtimeInstance?.let { return@synchronized it }
        // Keep runtime construction blocked through the direct purge: a runtime built from the old
        // credentials could otherwise reconnect and rewrite device auth after this reset returns.
        return runCatching { resetGatewaySetupAuthBeforeRuntime(stableId) }.getOrDefault(false)
      }
    return runtime.resetGatewaySetupAuth(stableId)
  }

  private fun resetGatewaySetupAuthBeforeRuntime(stableId: String): Boolean {
    val gatewayId = stableId.trim().takeIf { it.isNotEmpty() } ?: return false
    val database = ChatCacheDatabase.open(this)
    try {
      runBlocking {
        database.withTransaction {
          database.dao().deleteMessages(gatewayId)
          database.dao().deleteSessions(gatewayId)
          // The outbox owns command/attachment cascade deletes; nested transactions join this one.
          RoomChatCommandOutbox(database).clearGateway(gatewayId)
        }
      }
    } finally {
      database.close()
    }
    prefs.clearGatewayCredentials(gatewayId)
    val deviceId = DeviceIdentityStore(this).loadOrCreate().deviceId
    val deviceAuthStore = DeviceAuthStore(prefs)
    deviceAuthStore.clearToken(gatewayId, deviceId, "node")
    deviceAuthStore.clearToken(gatewayId, deviceId, "operator")
    return true
  }

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
