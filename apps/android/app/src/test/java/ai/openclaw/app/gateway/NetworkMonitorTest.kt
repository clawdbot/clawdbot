package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class NetworkMonitorTest {
  @Test
  fun emitsOnceOnOfflineToOnline() {
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("wifi", isValidated = true))
    assertEquals(false, state.update("wifi", isValidated = true))
  }

  @Test
  fun emitsAgainAfterAllValidatedNetworksAreLost() {
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("wifi", isValidated = true))
    assertEquals(false, state.update("wifi", isValidated = false))
    assertEquals(true, state.update("wifi", isValidated = true))
  }

  @Test
  fun aSecondNetworkValidatingWhileAnotherIsAlreadyOnlineStillWakes() {
    // A saved Gateway can be reachable over one specific route only (a returning Wi-Fi/LAN
    // network), not merely "the internet is up somewhere" — so cellular staying validated the
    // whole time must not swallow Wi-Fi's own restore. Regression for the P1 finding on #127873.
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("cellular", isValidated = true))
    assertEquals(true, state.update("wifi", isValidated = true))
  }

  @Test
  fun losingOneOfMultipleValidatedNetworksDoesNotWake() {
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("wifi", isValidated = true))
    assertEquals(true, state.update("cellular", isValidated = true))
    assertEquals(false, state.update("wifi", isValidated = false))
    // Capability churn on the still-validated network must not re-fire either.
    assertEquals(false, state.update("cellular", isValidated = true))
    // The last validated network being lost is an offline transition, not a restore.
    assertEquals(false, state.update("cellular", isValidated = false))
    assertEquals(true, state.update("wifi", isValidated = true))
  }

  @Test
  fun initialValidatedNetworkSuppressesRegistrationSnapshot() {
    val state = ValidatedNetworkState(setOf("wifi"))

    assertEquals(false, state.update("wifi", isValidated = true))
  }
}
