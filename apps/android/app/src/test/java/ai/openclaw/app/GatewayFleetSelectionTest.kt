package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayFleetSelectionTest {
  @Test
  fun focusedGatewayIsExcludedButOtherEnabledGatewaysRemain() {
    val entries = listOf(entry("alpha"), entry("beta"), entry("gamma"))

    assertEquals(
      listOf("beta", "gamma"),
      backgroundGatewayStableIds(
        entries = entries,
        connectedIds = listOf("alpha", "beta", "gamma", "beta", "forgotten"),
        activeId = "alpha",
        foreground = true,
      ),
    )
    assertEquals(
      emptyList<String>(),
      backgroundGatewayStableIds(
        entries = entries,
        connectedIds = listOf("alpha", "beta"),
        activeId = "alpha",
        foreground = false,
      ),
    )
  }

  @Test
  fun endpointGapRetainsEnabledSecondaryUntilItIsDisabled() {
    val secondary = entry("bonjour|secondary")

    val duringGap =
      backgroundGatewayFleetPlan(
        entries = listOf(secondary),
        connectedIds = listOf(secondary.stableId),
        activeId = null,
        foreground = true,
        existingStableIds = listOf(secondary.stableId),
        resolveEndpoint = { null },
      )

    assertEquals(emptyList<String>(), duringGap.disconnectStableIds)
    assertEquals(emptyMap<String, GatewayEndpoint>(), duringGap.resolvedEndpoints)

    val disabled =
      backgroundGatewayFleetPlan(
        entries = listOf(secondary),
        connectedIds = emptyList(),
        activeId = null,
        foreground = true,
        existingStableIds = listOf(secondary.stableId),
        resolveEndpoint = { null },
      )

    assertEquals(listOf(secondary.stableId), disabled.disconnectStableIds)
  }

  @Test
  fun manualRegistryTlsControlsEndpointAndControlPageOrigin() {
    val endpoint =
      manualGatewayEndpoint(
        GatewayRegistryEntry(
          stableId = "manual|gateway.example|443",
          kind = GatewayRegistryEntryKind.MANUAL,
          name = "Gateway",
          host = " gateway.example ",
          port = 443,
          tls = true,
        ),
      )

    assertTrue(endpoint?.tlsEnabled == true)
    assertEquals("https://gateway.example:443", gatewayControlPageBaseUrl(requireNotNull(endpoint)))
  }

  @Test
  fun savingSameManualEndpointReplacesStaleTlsSetting() {
    val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 443, tlsEnabled = true)
    val previous =
      GatewayRegistryEntry(
        stableId = endpoint.stableId,
        kind = GatewayRegistryEntryKind.MANUAL,
        name = endpoint.name,
        host = endpoint.host,
        port = endpoint.port,
        tls = false,
        lastConnectedAtMs = 42L,
      )

    val updated = gatewayRegistryEntry(endpoint, previous)

    assertTrue(updated.tls)
    assertEquals(42L, updated.lastConnectedAtMs)
  }

  private fun entry(stableId: String) =
    GatewayRegistryEntry(
      stableId = stableId,
      kind = GatewayRegistryEntryKind.DISCOVERED,
      name = stableId,
    )
}
