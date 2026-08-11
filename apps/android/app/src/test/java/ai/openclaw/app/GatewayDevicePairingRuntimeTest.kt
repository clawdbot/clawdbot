package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayDevicePairingRuntimeTest {
  @Before
  fun clearPlainPrefs() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @Test
  fun approveRefetchesListAndPublishesOnlyVerifiedSuccess() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      seedNodesDevices(runtime, pending = listOf(pendingDevice()))
      val requests = mutableListOf<Pair<String, String?>>()
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        requests += method to params
        when (method) {
          "device.pair.approve" -> """{"requestId":"request-1","device":{"deviceId":"device-1"}}"""
          "device.pair.list" ->
            """{"pending":[],"paired":[{"deviceId":"device-1","displayName":"Pixel","roles":["operator"],"scopes":["operator.read"],"tokens":[],"approvedAtMs":2}]}"""
          else -> error("unexpected method $method")
        }
      }

      runtime.approveDevicePairing("request-1", "device-1")
      waitUntil { runtime.devicePairingMutation.value == null && runtime.nodesDevicesNoticeText.value != null }

      assertEquals(
        listOf("device.pair.approve", "device.pair.list"),
        requests.map { it.first },
      )
      assertEquals("""{"requestId":"request-1"}""", requests.first().second)
      assertEquals("Device approved.", runtime.nodesDevicesNoticeText.value)
      assertEquals(
        listOf("device-1"),
        runtime.nodesDevicesSummary.value.pairedDevices
          .map { it.deviceId },
      )
      assertEquals(emptyList<GatewayPendingDeviceSummary>(), runtime.nodesDevicesSummary.value.pendingDevices)
    }

  @Test
  fun ambiguousWriteKeepsOutcomeUnverifiedAfterListReadback() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      seedNodesDevices(runtime, pending = listOf(pendingDevice()))
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "device.pair.reject" -> error("outcome unknown")
          "device.pair.list" -> """{"pending":[],"paired":[]}"""
          else -> error("unexpected method $method")
        }
      }

      runtime.rejectDevicePairing("request-1")
      waitUntil { runtime.devicePairingMutation.value == null && runtime.nodesDevicesErrorText.value != null }

      assertEquals(null, runtime.nodesDevicesNoticeText.value)
      assertEquals(
        "Could not verify the device pairing change. Refresh and try again.",
        runtime.nodesDevicesErrorText.value,
      )
    }

  @Test
  fun definitivePairingDenialPreservesGatewayErrorMessage() =
    runBlocking {
      val runtime = createTestRuntime()
      seedConnectedRuntime(runtime)
      seedNodesDevices(runtime, pending = listOf(pendingDevice()))
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        when (method) {
          "device.pair.approve" ->
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape("INVALID_REQUEST", "device pairing approval denied"),
            )
          "device.pair.list" -> """{"pending":[{"requestId":"request-1","deviceId":"device-1","roles":["operator"],"scopes":["operator.read"]}],"paired":[]}"""
          else -> error("unexpected method $method")
        }
      }

      runtime.approveDevicePairing("request-1", "device-1")
      waitUntil { runtime.devicePairingMutation.value == null && runtime.nodesDevicesErrorText.value != null }

      assertEquals(null, runtime.nodesDevicesNoticeText.value)
      assertEquals("device pairing approval denied", runtime.nodesDevicesErrorText.value)
    }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.device.pairing.runtime.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun seedConnectedRuntime(runtime: NodeRuntime) {
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
    writeField(runtime, "operatorConnected", true)
    readField<MutableStateFlow<GatewayDevicePairingCapabilities>>(runtime, "_devicePairingCapabilities").value =
      GatewayDevicePairingCapabilities(
        canList = true,
        canApprove = true,
        canReject = true,
        canRemove = true,
      )
  }

  private fun seedNodesDevices(
    runtime: NodeRuntime,
    pending: List<GatewayPendingDeviceSummary>,
  ) {
    readField<MutableStateFlow<GatewayNodesDevicesSummary>>(runtime, "_nodesDevicesSummary").value =
      GatewayNodesDevicesSummary(
        nodes = emptyList(),
        pendingDevices = pending,
        pairedDevices = emptyList(),
      )
  }

  private fun pendingDevice(): GatewayPendingDeviceSummary =
    GatewayPendingDeviceSummary(
      requestId = "request-1",
      deviceId = "device-1",
      displayName = "Pixel",
      remoteIp = null,
      roles = listOf("operator"),
      scopes = listOf("operator.read"),
      requestedAtMs = 1L,
      repair = false,
    )

  private suspend fun waitUntil(condition: () -> Boolean) {
    withTimeout(10_000) {
      while (!condition()) delay(10)
    }
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    findField(target, name).set(target, value)
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> readField(
    target: Any,
    name: String,
  ): T = findField(target, name).get(target) as T

  private fun findField(
    target: Any,
    name: String,
  ): Field =
    target.javaClass
      .getDeclaredField(name)
      .apply { isAccessible = true }
}
