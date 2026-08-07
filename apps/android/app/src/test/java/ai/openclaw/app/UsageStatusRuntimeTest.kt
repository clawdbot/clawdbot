package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
  fun coldIncompleteUsageRefetchesUntilTheRefreshLands() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    runtime.usageIncompleteRetryDelayMsForTests = 10L
    val calls = AtomicInteger()
    runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
      check(method == "usage.status") { "unexpected method $method" }
      if (calls.incrementAndGet() == 1) {
        """{"updatedAt":1,"providers":[],"refreshing":true}"""
      } else {
        """{"updatedAt":2,"providers":[{"displayName":"Claude","plan":"Pro","windows":[{"label":"5h","usedPercent":12}]}]}"""
      }
    }

    runtime.refreshUsage()
    waitUntil {
      runtime.usageSummary.value.providers
        .isNotEmpty()
    }

    assertEquals(2, calls.get())
    assertFalse(runtime.usageSummary.value.refreshing)
    assertEquals(
      "Claude",
      runtime.usageSummary.value.providers
        .single()
        .displayName,
    )
  }

  @Test
  fun incompleteUsageRefetchStaysBoundedWhenTheRefreshNeverLands() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    runtime.usageIncompleteRetryDelayMsForTests = 10L
    val calls = AtomicInteger()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ ->
      calls.incrementAndGet()
      """{"updatedAt":1,"providers":[],"refreshing":true}"""
    }

    runtime.refreshUsage()
    waitUntil { calls.get() >= 4 }
    Thread.sleep(100)

    assertEquals(4, calls.get())
    assertTrue(runtime.usageSummary.value.refreshing)
    assertTrue(
      runtime.usageSummary.value.providers
        .isEmpty(),
    )
  }

  @Test
  fun gatewaySwitchEndsTheIncompleteUsageRetryChain() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    runtime.usageIncompleteRetryDelayMsForTests = 50L
    val calls = AtomicInteger()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ ->
      calls.incrementAndGet()
      """{"updatedAt":1,"providers":[],"refreshing":true}"""
    }

    runtime.refreshUsage()
    waitUntil { calls.get() == 1 }
    writeField(runtime, "gatewayDataGeneration", readField<Long>(runtime, "gatewayDataGeneration") + 1)
    Thread.sleep(250)

    assertEquals(1, calls.get())
  }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun seedConnectedRuntime(runtime: NodeRuntime) {
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
    writeField(runtime, "operatorConnected", true)
  }

  private fun waitUntil(condition: () -> Boolean) {
    repeat(200) {
      if (condition()) return
      Thread.sleep(10)
    }
    error("Expected condition to become true")
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    field(target, name).set(target, value)
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> readField(
    target: Any,
    name: String,
  ): T = field(target, name).get(target) as T

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
    error("Field $name not found on ${target.javaClass.name}")
  }
}
