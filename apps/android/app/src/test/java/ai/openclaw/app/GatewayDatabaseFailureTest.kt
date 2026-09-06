package ai.openclaw.app

import ai.openclaw.app.chat.AndroidClientDatabases
import ai.openclaw.app.chat.CLIENT_STATE_DB_NAME
import ai.openclaw.app.chat.ChatOutboxEnqueueResult
import ai.openclaw.app.gateway.GatewayEndpoint
import android.content.Context
import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [NodeForegroundServiceTest.ServiceRuntimePrefsShadow::class])
class GatewayDatabaseFailureTest {
  @Test
  fun automaticColdStartReportsUnavailableStorageWithoutCrashingOrDeletingQueuedInput() = assertFailedConnection(automatic = true)

  @Test
  fun manualViewModelConnectionReportsUnavailableStorageWithoutCrashingOrDeletingQueuedInput() = assertFailedConnection(automatic = false)

  @Test
  fun supersededConnectionDoesNotPublishALateDatabaseFailure() = assertRetiredConnection(cancel = false)

  @Test
  fun cancelledConnectionPropagatesCancellationWithoutPublishingFailure() = assertRetiredConnection(cancel = true)

  private fun assertRetiredConnection(cancel: Boolean) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val gateway = MockWebServer().apply { start() }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    val originalBase = app.baseContext
    val opening = CountDownLatch(1)
    val release = CountDownLatch(1)
    var runtime: NodeRuntime? = null
    try {
      seedUnavailableState(app, endpoint)
      val context =
        object : ContextWrapper(originalBase) {
          override fun getApplicationContext(): Context = app

          override fun getDatabasePath(name: String): File {
            if (name == CLIENT_STATE_DB_NAME) {
              opening.countDown()
              check(release.await(10, TimeUnit.SECONDS)) { "Database open was not released" }
            }
            return super.getDatabasePath(name)
          }
        }
      // Keep the real NodeApp identity; intercept only its platform database path lookup.
      ReflectionHelpers.setField(app, "mBase", context)
      val active = app.ensureBackgroundRuntime()
      runtime = active
      assertTrue("Real database initialization did not start", opening.await(10, TimeUnit.SECONDS))
      val current = AtomicBoolean(true)
      runBlocking {
        // Unconfined reaches the real suspended database await before returning to the test.
        val attempt =
          async(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
            active.connectSwitchingGateway(endpoint, isCurrent = current::get)
          }
        assertFalse(attempt.isCompleted)
        if (cancel) {
          attempt.cancelAndJoin()
          assertTrue(attempt.isCancelled)
          release.countDown()
        } else {
          current.set(false)
          release.countDown()
          assertFalse(attempt.await())
        }
      }
      assertEquals("Offline", active.statusText.value)
      assertFalse(active.isConnected.value)
      assertEquals(0, gateway.requestCount)
      assertPreservedState(app)
    } finally {
      release.countDown()
      try {
        runtime?.let(::closeFailedRuntime)
      } finally {
        ReflectionHelpers.setField(app, "mBase", originalBase)
        gateway.shutdown()
      }
    }
  }

  private fun assertFailedConnection(automatic: Boolean) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val gateway = MockWebServer().apply { start() }
    try {
      assertFailedConnection(automatic, app, gateway)
    } finally {
      gateway.shutdown()
    }
  }

  private fun assertFailedConnection(
    automatic: Boolean,
    app: NodeApp,
    gateway: MockWebServer,
  ) {
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    seedUnavailableState(app, endpoint)
    val stateFile = app.getDatabasePath(CLIENT_STATE_DB_NAME)
    app.prefs.setManualTls(false)
    app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
    if (automatic) app.prefs.gatewayRegistry.setActive(endpoint.stableId)

    // Observe the real launch's uncaught failure instead of replacing the runtime scope.
    // A captured exception is a test failure, never a recovery path.
    val uncaught = ConcurrentLinkedQueue<Throwable>()
    val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { _, error -> uncaught.add(error) }
    var runtime: NodeRuntime? = null
    val viewModels = ViewModelStore()
    try {
      runtime = app.ensureBackgroundRuntime()
      if (!automatic) {
        val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
        viewModels.put("database-failure", viewModel)
        viewModel.connect(endpoint)
      }
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
      while (uncaught.isEmpty() && !runtime.statusText.value.contains("local chat data") && System.nanoTime() < deadline) {
        shadowOf(Looper.getMainLooper()).idle()
        Thread.sleep(10)
      }
      assertTrue("Connection must not escape its owner: " + uncaught.map { it.toString() }, uncaught.isEmpty())
      assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
      assertEquals(
        "Failed: couldn't open local chat data. Restart OpenClaw. If this continues, contact support before clearing app data.",
        runtime.statusText.value,
      )
      assertEquals("A failed initialization must not start a gateway connection", 0, gateway.requestCount)
      assertTrue(stateFile.exists())
      assertPreservedState(app)
    } finally {
      try {
        viewModels.clear()
        runtime?.let(::closeFailedRuntime)
        NodeForegroundService.resume(app, startNow = false)
      } finally {
        Thread.setDefaultUncaughtExceptionHandler(previousHandler)
      }
    }
  }

  private fun closeFailedRuntime(active: NodeRuntime) {
    drainWithMainLooper {
      active.disconnect()
      ReflectionHelpers
        .getField<CoroutineScope>(active, "scope")
        .coroutineContext.job
        .cancelAndJoin()
      // Failed initialization is the fixture, not a cleanup error to rethrow.
      ReflectionHelpers.getField<AndroidClientDatabases>(active, "clientDatabases").close()
    }
  }

  private fun seedUnavailableState(
    app: NodeApp,
    endpoint: GatewayEndpoint,
  ) {
    runBlocking {
      AndroidClientDatabases.start(app).use { databases ->
        assertTrue(
          databases.commandOutbox().enqueue(
            gatewayId = endpoint.stableId,
            sessionKey = "main",
            text = "preserve queued input",
            thinkingLevel = "off",
            nowMs = System.currentTimeMillis(),
            ownerAgentId = "main",
          ) is ChatOutboxEnqueueResult.Queued,
        )
      }
    }
    val stateFile = app.getDatabasePath(CLIENT_STATE_DB_NAME)
    SQLiteDatabase.openDatabase(stateFile.path, null, SQLiteDatabase.OPEN_READWRITE).use { it.version = 99 }
  }

  private fun assertPreservedState(app: NodeApp) {
    val stateFile = app.getDatabasePath(CLIENT_STATE_DB_NAME)
    assertTrue(stateFile.exists())
    SQLiteDatabase.openDatabase(stateFile.path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
      assertEquals(99, database.version)
      database.rawQuery("SELECT text FROM outbox_commands", null).use { rows ->
        assertTrue(rows.moveToFirst())
        assertEquals("preserve queued input", rows.getString(0))
        assertFalse(rows.moveToNext())
      }
    }
  }
}
