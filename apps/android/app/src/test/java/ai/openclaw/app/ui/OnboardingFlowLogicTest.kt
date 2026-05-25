package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingFlowLogicTest {
  @Test
  fun blocksFinishWhenOnlyOperatorIsConnected() {
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = false))
  }

  @Test
  fun blocksFinishWhenDisconnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = false))
  }

  @Test
  fun blocksFinishWhenOnlyNodeIsConnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = true))
  }

  @Test
  fun allowsFinishOnlyWhenOperatorAndNodeAreConnected() {
    assertTrue(canFinishOnboarding(isConnected = true, isNodeConnected = true))
  }

  @Test
  fun showsPairingStateForPairingRequiredGatewayStatus() {
    assertEquals(
      GatewayRecoveryUiState.Pairing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Gateway error: pairing required; approval in progress",
        connectSettling = false,
      ),
    )
  }

  @Test
  fun showsConnectedStateWhenGatewayBecomesReady() {
    assertEquals(
      GatewayRecoveryUiState.Connected,
      gatewayRecoveryUiState(
        ready = true,
        statusText = "Gateway error: pairing required",
        connectSettling = false,
      ),
    )
  }

  @Test
  fun showsFinishingStateWhileGatewayConnectionSettles() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Offline",
        connectSettling = true,
      ),
    )
  }

  @Test
  fun showsFinishingStateForPartialGatewayConnection() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
      ),
    )
  }

  @Test
  fun showsConnectionIssueForNonPairingFailure() {
    assertEquals(
      GatewayRecoveryUiState.Failed,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Gateway error: connection refused",
        connectSettling = false,
      ),
    )
  }
}
