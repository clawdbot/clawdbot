package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import org.junit.Assert.assertEquals
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

  private fun entry(stableId: String) =
    GatewayRegistryEntry(
      stableId = stableId,
      kind = GatewayRegistryEntryKind.DISCOVERED,
      name = stableId,
    )
}
