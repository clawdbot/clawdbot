package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.controlUiOriginRule
import ai.openclaw.app.ui.desktopUrl
import ai.openclaw.app.ui.sessionDashboardUrl
import ai.openclaw.app.ui.terminalUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
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
  fun networkRestoreWakesTheOperatorNodeAndEverySecondaryGateway() {
    // The regression this pins: the fan-out used to name only the operator and node pair, so a
    // secondary gateway kept waiting out its retry timer after the network came back. That cost
    // at most ~8s before this policy allowed minutes.
    val operator = session()
    val node = session()
    val first = session()
    val second = session()
    val third = session()

    val woken =
      gatewaySessionsToWakeOnNetworkRestore(
        operator = operator,
        node = node,
        secondary = mapOf("a" to first, "b" to second, "c" to third),
      )

    assertEquals(5, woken.size)
    assertSame(operator, woken[0])
    assertSame(node, woken[1])
    for (secondary in listOf(first, second, third)) {
      assertTrue("secondary gateway was left out of the wake", woken.any { it === secondary })
    }
  }

  @Test
  fun networkRestoreWakesASingleSecondaryGateway() {
    val operator = session()
    val node = session()
    val only = session()

    val woken =
      gatewaySessionsToWakeOnNetworkRestore(operator = operator, node = node, secondary = mapOf("only" to only))

    assertEquals(3, woken.size)
    assertTrue("the one secondary gateway was left out of the wake", woken.any { it === only })
  }

  @Test
  fun networkRestoreStillWakesThePrimaryPairWithNoSecondaries() {
    val operator = session()
    val node = session()

    val woken = gatewaySessionsToWakeOnNetworkRestore(operator = operator, node = node, secondary = emptyMap())

    assertEquals(listOf(operator, node), woken)
  }

  @Test
  fun networkRestoreSnapshotsTheFleetSoALaterEditCannotShrinkIt() {
    // The fleet is a live ConcurrentHashMap in NodeRuntime; the wake must act on what it captured.
    val operator = session()
    val node = session()
    val leaving = session()
    val fleet = linkedMapOf("leaving" to leaving)

    val woken = gatewaySessionsToWakeOnNetworkRestore(operator = operator, node = node, secondary = fleet)
    fleet.clear()

    assertEquals(3, woken.size)
    assertTrue("the wake list changed when the fleet was edited afterwards", woken.any { it === leaving })
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

/** Stands in for a GatewaySession: the wake decision only cares about session identity. */
private fun session(): Any = Any()

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
      "https://gateway.example:443/tenant%2Fgateway%20west/dashboard/main/~key/qa",
      sessionDashboardUrl(baseUrl, "agent:main:qa"),
    )
    assertEquals("https://gateway.example:443", controlUiOriginRule(baseUrl))
  }
}
