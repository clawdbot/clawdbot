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
  fun suppressesReconnectWhenOneOfMultipleValidatedNetworksIsLost() {
    val state = ValidatedNetworkState<String>()

    assertEquals(true, state.update("wifi", isValidated = true))
    assertEquals(false, state.update("cellular", isValidated = true))
    assertEquals(false, state.update("wifi", isValidated = false))
    assertEquals(false, state.update("cellular", isValidated = true))
    assertEquals(false, state.update("cellular", isValidated = false))
    assertEquals(true, state.update("wifi", isValidated = true))
  }

  @Test
  fun initialValidatedNetworkSuppressesRegistrationSnapshot() {
    val state = ValidatedNetworkState(setOf("wifi"))

    assertEquals(false, state.update("wifi", isValidated = true))
  }
}
