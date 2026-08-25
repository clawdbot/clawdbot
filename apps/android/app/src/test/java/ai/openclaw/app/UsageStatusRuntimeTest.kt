package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.usageRefreshVisible
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
class UsageStatusRuntimeTest {
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
      runtime.usageSummary.value.providers
        .isNotEmpty()
    }
    assertEquals(2, calls.get())
    assertFalse(runtime.usageSummary.value.refreshing)
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
    assertFalse(runtime.usageSummary.value.refreshing)
    assertFalse(
      usageRefreshVisible(
        requestRefreshing = runtime.usageRefreshing.value,
        summaryRefreshing = runtime.usageSummary.value.refreshing,
      ),
    )
    // Clearing the marker without this would render "No usage data yet.",
    // claiming the operator has no providers instead of a failed load.
    assertNotNull(runtime.usageErrorText.value)
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
      runtime.usageErrorText.value != null
    }
    Thread.sleep(100)
    assertEquals(2, calls.get())
    assertEquals(
      "Claude",
      runtime.usageSummary.value.providers
        .single()
        .displayName,
    )
    assertFalse(runtime.usageSummary.value.refreshing)
  }

  private fun createRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val prefs =
      app.getSharedPreferences(
        "usage.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = prefs))
  }

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
