package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayDevicePairingTest {
  private val allMethods =
    setOf(
      "device.pair.list",
      "device.pair.approve",
      "device.pair.reject",
      "device.pair.remove",
    )

  @Test
  fun capabilitiesRequireAdvertisedMethodAndPairingOrAdminScope() {
    assertEquals(
      GatewayDevicePairingCapabilities(),
      selectGatewayDevicePairingCapabilities(allMethods, listOf("operator.read")),
    )

    val pairing = selectGatewayDevicePairingCapabilities(allMethods, listOf("operator.pairing"))
    assertTrue(pairing.canList)
    assertTrue(pairing.canApprove)
    assertTrue(pairing.canReject)
    assertFalse(pairing.canRemove)
    assertTrue(pairing.canManage)

    val admin = selectGatewayDevicePairingCapabilities(allMethods, listOf("operator.admin"))
    assertTrue(admin.canManage)
    assertTrue(admin.supports(GatewayDevicePairingAction.Approve))
    assertTrue(admin.supports(GatewayDevicePairingAction.Reject))
    assertTrue(admin.supports(GatewayDevicePairingAction.Remove))

    val missingList =
      selectGatewayDevicePairingCapabilities(
        methods = allMethods - "device.pair.list",
        scopes = listOf("operator.admin"),
      )
    assertFalse(missingList.supports(GatewayDevicePairingAction.Approve))
  }

  @Test
  fun mutationParamsMatchGatewayProtocolIds() {
    assertEquals(
      """{"requestId":"request-1"}""",
      buildGatewayDevicePairingMutationParams(
        GatewayDevicePairingMutation(GatewayDevicePairingAction.Approve, "request-1"),
      ).toString(),
    )
    assertEquals(
      """{"deviceId":"device-1"}""",
      buildGatewayDevicePairingMutationParams(
        GatewayDevicePairingMutation(GatewayDevicePairingAction.Remove, "device-1"),
      ).toString(),
    )
  }

  @Test
  fun pairingOnlyCallerCannotApproveScopesItDoesNotHave() {
    val pairingOnly =
      selectGatewayDevicePairingCapabilities(allMethods, listOf("operator.pairing", "operator.read"))
    val pending = pending("request-1", "device-1").copy(scopes = listOf("operator.read", "operator.admin"))

    assertFalse(canApproveGatewayDevicePairing(pairingOnly, listOf("operator.pairing", "operator.read"), pending))
    assertTrue(
      canApproveGatewayDevicePairing(
        pairingOnly,
        listOf("operator.pairing", "operator.read", "operator.admin"),
        pending,
      ),
    )
  }

  @Test
  fun mutationOutcomesRequireCanonicalTerminalState() {
    val pending = listOf(pending("request-1", "device-1"))
    val paired = listOf(paired("device-1"))

    assertEquals(
      GatewayDevicePairingMutationOutcome.Approved,
      verifyGatewayDevicePairingMutation(
        mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Approve, "request-1"),
        expectedDeviceId = "device-1",
        mutationAccepted = true,
        pending = emptyList(),
        paired = paired,
      ),
    )
    assertEquals(
      GatewayDevicePairingMutationOutcome.NotVerified,
      verifyGatewayDevicePairingMutation(
        mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Approve, "request-1"),
        expectedDeviceId = "device-1",
        mutationAccepted = true,
        pending = pending,
        paired = paired,
      ),
    )
    assertEquals(
      GatewayDevicePairingMutationOutcome.Rejected,
      verifyGatewayDevicePairingMutation(
        mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Reject, "request-1"),
        expectedDeviceId = "",
        mutationAccepted = true,
        pending = emptyList(),
        paired = emptyList(),
      ),
    )
    assertEquals(
      GatewayDevicePairingMutationOutcome.Removed,
      verifyGatewayDevicePairingMutation(
        mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Remove, "device-1"),
        expectedDeviceId = "device-1",
        mutationAccepted = true,
        pending = emptyList(),
        paired = emptyList(),
      ),
    )
    assertEquals(
      GatewayDevicePairingMutationOutcome.NotVerified,
      verifyGatewayDevicePairingMutation(
        mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Reject, "request-1"),
        expectedDeviceId = "",
        mutationAccepted = false,
        pending = emptyList(),
        paired = emptyList(),
      ),
    )
  }

  private fun pending(
    requestId: String,
    deviceId: String,
  ): GatewayPendingDeviceSummary =
    GatewayPendingDeviceSummary(
      requestId = requestId,
      deviceId = deviceId,
      displayName = "Pixel",
      remoteIp = null,
      roles = listOf("operator"),
      scopes = listOf("operator.read"),
      requestedAtMs = 1L,
      repair = false,
    )

  private fun paired(deviceId: String): GatewayPairedDeviceSummary =
    GatewayPairedDeviceSummary(
      deviceId = deviceId,
      displayName = "Pixel",
      remoteIp = null,
      roles = listOf("operator"),
      scopes = listOf("operator.read"),
      tokens = emptyList(),
      approvedAtMs = 1L,
    )
}
