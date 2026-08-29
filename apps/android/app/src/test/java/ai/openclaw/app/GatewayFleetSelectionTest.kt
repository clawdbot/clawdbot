package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.controlUiOriginRule
import ai.openclaw.app.ui.desktopUrl
import ai.openclaw.app.ui.sessionDashboardUrl
import ai.openclaw.app.ui.terminalUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayControlPageContextPathTest {
  @Test
  fun controlPageBasePreservesNormalizedGatewayContextPaths() {
    val cases =
      listOf(
        GatewayEndpoint.manual("gateway.example", 443, true, "openclaw-gw") to
          "https://gateway.example:443/openclaw-gw",
        GatewayEndpoint.manual("gateway.example", 443, true, "/tenant%2Fgateway%20west") to
          "https://gateway.example:443/tenant%2Fgateway%20west",
        GatewayEndpoint.manual("gateway.example", 443, true, "//openclaw") to
          "https://gateway.example:443//openclaw",
        GatewayEndpoint.manual("gateway.example", 443, true, "/") to
          "https://gateway.example:443",
        GatewayEndpoint.manual("::1", 18789, false, "/gateway") to
          "http://[::1]:18789/gateway",
      )

    cases.forEach { (endpoint, expected) ->
      assertEquals(endpoint.contextPath, expected, gatewayControlPageBaseUrl(endpoint))
    }
  }

  @Test
  fun everyControlPagePreservesEncodedGatewayContextPathAndOrigin() {
    val baseUrl =
      gatewayControlPageBaseUrl(
        GatewayEndpoint.manual("gateway.example", 443, true, "/tenant%2Fgateway%20west"),
      )

    assertEquals(
      "https://gateway.example:443/tenant%2Fgateway%20west/focus/terminal",
      terminalUrl(baseUrl),
    )
    assertEquals(
      "https://gateway.example:443/tenant%2Fgateway%20west/focus/desktop",
      desktopUrl(baseUrl),
    )
    assertEquals(
      "https://gateway.example:443/tenant%2Fgateway%20west/chat?session=agent%3Amain%3Aqa&face=dashboard",
      sessionDashboardUrl(baseUrl, "agent:main:qa"),
    )
    assertEquals("https://gateway.example:443", controlUiOriginRule(baseUrl))
  }
}
