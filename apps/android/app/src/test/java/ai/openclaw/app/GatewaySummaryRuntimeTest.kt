package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.usageRefreshVisible
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySummaryRuntimeTest {
  private val runtimes = mutableListOf<NodeRuntime>()

  @Before
  fun clearPlainPrefs() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @After
  fun closeRuntimes() {
    runtimes.forEach(::closeNodeRuntimeTestFixture)
  }

  @Test
  fun summariesRemainUnknownUntilTheGatewayResponds() {
    val runtime = createRuntime()
    val summaries =
      listOf(
        runtime.channelsState.value,
        runtime.skillsState.value,
        runtime.dreamingState.value,
        runtime.healthLogsState.value,
        runtime.usageState.value,
      )

    summaries.forEach { assertNull("an unrequested summary is not a successful empty response", it.summary) }
  }

  @Test
  fun aFailedFirstRefreshDoesNotInventAnEmptyChannelSnapshot() =
    runBlocking<Unit> {
      val runtime = createRuntime()
      connect(runtime)
      val requests = Channel<HeldSummaryRequest>(Channel.UNLIMITED)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        check(method == "channels.status")
        val response = CompletableDeferred<String>()
        requests.send(HeldSummaryRequest(response, currentCoroutineContext().job))
        response.await()
      }

      runtime.refreshChannels()
      val failed = withTimeout(2_000) { requests.receive() }
      failed.response.completeExceptionally(IllegalStateException("channels unavailable"))
      withTimeout(2_000) { failed.job.join() }
      assertNotNull(runtime.channelsState.value.errorText)
      assertFalse(runtime.channelsState.value.refreshing)
      assertNull("a failed load does not prove that no channels exist", runtime.channelsState.value.summary)

      runtime.refreshChannels()
      val successful = withTimeout(2_000) { requests.receive() }
      successful.complete("""{"channels":{}}""")
      assertNotNull("a successful empty response is still a loaded snapshot", runtime.channelsState.value.summary)
      assertNull(runtime.channelsState.value.errorText)
      requests.close()
    }

  @Test
  fun olderRefreshCompletionKeepsNewerRefreshLoading() =
    runBlocking {
      withOverlappingChannelRefreshes { runtime, older, newer ->
        older.complete(channelSummary("older"))

        assertTrue("the newer refresh still owns loading", runtime.channelsState.value.refreshing)
        assertNull(runtime.channelsState.value.summary)
        assertNull(runtime.channelsState.value.errorText)

        newer.complete(channelSummary("newer"))
        assertEquals(
          "newer",
          checkNotNull(runtime.channelsState.value.summary)
            .channels
            .single()
            .id,
        )
        assertFalse(runtime.channelsState.value.refreshing)
      }
    }

  @Test
  fun olderRefreshSuccessCannotReplaceNewerSnapshot() =
    runBlocking {
      withOverlappingChannelRefreshes { runtime, older, newer ->
        newer.complete(channelSummary("newer"))
        older.complete(channelSummary("older"))

        assertEquals(
          "newer",
          checkNotNull(runtime.channelsState.value.summary)
            .channels
            .single()
            .id,
        )
        assertNull(runtime.channelsState.value.errorText)
        assertFalse(runtime.channelsState.value.refreshing)
      }
    }

  @Test
  fun olderRefreshFailureCannotReplaceNewerSuccess() =
    runBlocking {
      withOverlappingChannelRefreshes { runtime, older, newer ->
        newer.complete(channelSummary("newer"))
        older.response.completeExceptionally(IllegalStateException("older refresh failed"))
        withTimeout(2_000) { older.job.join() }

        assertNull("the older failure no longer owns the displayed result", runtime.channelsState.value.errorText)
        assertEquals(
          "newer",
          checkNotNull(runtime.channelsState.value.summary)
            .channels
            .single()
            .id,
        )
        assertFalse(runtime.channelsState.value.refreshing)
      }
    }

  @Test
  fun cancelledRefreshCannotPublishFailureOrClearNewerLoading() =
    runBlocking {
      withOverlappingChannelRefreshes { runtime, older, newer ->
        withTimeout(2_000) { older.job.cancelAndJoin() }

        assertNull(runtime.channelsState.value.errorText)
        assertTrue(runtime.channelsState.value.refreshing)
        newer.complete(channelSummary("newer"))
        assertEquals(
          "newer",
          checkNotNull(runtime.channelsState.value.summary)
            .channels
            .single()
            .id,
        )
      }
    }

  @Test
  fun disconnectRetiresHeldSummaryRefreshes() =
    runBlocking {
      withOverlappingChannelRefreshes { runtime, older, newer ->
        runtime.disconnect()
        newer.complete(channelSummary("newer"))
        older.complete(channelSummary("older"))

        assertNull(runtime.channelsState.value.summary)
        assertNull(runtime.channelsState.value.errorText)
        assertFalse(runtime.channelsState.value.refreshing)
      }
    }

  @Test
  fun incompleteUsageConvergesOnACompletedPayload() {
    val runtime = createRuntime()
    connect(runtime)
    runtime.usageIncompleteRetryDelayMsForTests = 10L
    val calls = AtomicInteger()
    runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
      check(method == "usage.status")
      if (calls.incrementAndGet() == 1) {
        """{"updatedAt":1,"providers":[],"refreshing":true}"""
      } else {
        """{"updatedAt":2,"providers":[{"displayName":"Claude","plan":"Pro","windows":[]}]}"""
      }
    }

    runtime.refreshUsage()
    waitUntil {
      runtime.usageState.value.summary
        ?.providers
        ?.isNotEmpty() == true
    }
    assertEquals(2, calls.get())
    assertFalse(checkNotNull(runtime.usageState.value.summary).refreshing)
  }

  @Test
  fun incompleteUsageRetriesStayBounded() {
    val runtime = createRuntime()
    connect(runtime)
    runtime.usageIncompleteRetryDelayMsForTests = 10L
    val calls = AtomicInteger()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ ->
      calls.incrementAndGet()
      """{"updatedAt":1,"providers":[],"refreshing":true}"""
    }

    runtime.refreshUsage()
    waitUntil { calls.get() == 4 }
    Thread.sleep(100)
    assertEquals(4, calls.get())
    assertFalse(checkNotNull(runtime.usageState.value.summary).refreshing)
    assertFalse(
      usageRefreshVisible(
        requestRefreshing = runtime.usageState.value.refreshing,
        summaryRefreshing = checkNotNull(runtime.usageState.value.summary).refreshing,
      ),
    )
    // Clearing the marker without this would render "No usage data yet.",
    // claiming the operator has no providers instead of a failed load.
    assertNotNull(runtime.usageState.value.errorText)
  }

  @Test
  fun aTransientFailurePreservesRowsAndStopsTheRetryChain() {
    val runtime = createRuntime()
    connect(runtime)
    runtime.usageIncompleteRetryDelayMsForTests = 10L
    val calls = AtomicInteger()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ ->
      if (calls.incrementAndGet() == 1) {
        """{"updatedAt":1,"providers":[{"displayName":"Claude","plan":"Pro","windows":[]}],"refreshing":true}"""
      } else {
        error("usage unavailable")
      }
    }

    runtime.refreshUsage()
    waitUntil {
      runtime.usageState.value.errorText != null
    }
    Thread.sleep(100)
    assertEquals(2, calls.get())
    assertEquals(
      "Claude",
      checkNotNull(runtime.usageState.value.summary)
        .providers
        .single()
        .displayName,
    )
    assertFalse(checkNotNull(runtime.usageState.value.summary).refreshing)
  }

  private fun createRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val prefs =
      app.getSharedPreferences(
        "usage.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = prefs)).also(runtimes::add)
  }

  private data class HeldSummaryRequest(
    val response: CompletableDeferred<String>,
    val job: Job,
  ) {
    suspend fun complete(payload: String) {
      response.complete(payload)
      withTimeout(2_000) { job.join() }
    }
  }

  private suspend fun withOverlappingChannelRefreshes(
    block: suspend (NodeRuntime, HeldSummaryRequest, HeldSummaryRequest) -> Unit,
  ) {
    val runtime = createRuntime()
    connect(runtime)
    val requests = Channel<HeldSummaryRequest>(Channel.UNLIMITED)
    runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
      check(method == "channels.status")
      val response = CompletableDeferred<String>()
      requests.send(HeldSummaryRequest(response, currentCoroutineContext().job))
      response.await()
    }
    runtime.refreshChannels()
    val older = withTimeout(2_000) { requests.receive() }
    runtime.refreshChannels()
    val newer = withTimeout(2_000) { requests.receive() }
    try {
      block(runtime, older, newer)
    } finally {
      older.response.complete("{}")
      newer.response.complete("{}")
      requests.close()
    }
  }

  private fun channelSummary(id: String): String = """{"channels":{"$id":{"connected":true}}}"""

  private fun connect(runtime: NodeRuntime) {
    field(runtime, "connectedEndpoint").set(runtime, GatewayEndpoint.manual("127.0.0.1", 18789))
    field(runtime, "operatorConnected").set(runtime, true)
  }

  private fun waitUntil(condition: () -> Boolean) {
    repeat(200) {
      if (condition()) return
      Thread.sleep(10)
    }
    error("condition did not become true")
  }

  private fun field(
    target: Any,
    name: String,
  ): Field {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        return type.getDeclaredField(name).apply { isAccessible = true }
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("field $name not found")
  }
}
