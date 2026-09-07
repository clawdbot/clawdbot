package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class GatewayConnectionDisplayTest {
  @Test
  fun operatorProblemStaysCorrelatedWhenNodeConnects() {
    val operatorProblem = problem("AUTH_TOKEN_MISSING")
    val nodeProblem = problem("DEVICE_IDENTITY_REQUIRED")

    val display =
      gatewayConnectionDisplay(
        operatorConnected = false,
        nodeConnected = true,
        operatorStatusText = "Gateway error: unauthorized",
        nodeStatusText = "Connected",
        operatorProblem = operatorProblem,
        nodeProblem = nodeProblem,
      )

    assertEquals("Connected (operator: Gateway error: unauthorized)", display.statusText)
    assertSame(operatorProblem, display.problem)
  }

  @Test
  fun nodeProblemIsSelectedWhenOperatorHasNoStatus() {
    val operatorProblem = problem("AUTH_TOKEN_MISSING")
    val nodeProblem = problem("DEVICE_IDENTITY_REQUIRED")

    val display =
      gatewayConnectionDisplay(
        operatorConnected = false,
        nodeConnected = false,
        operatorStatusText = "Offline",
        nodeStatusText = "Gateway error: device identity required",
        operatorProblem = operatorProblem,
        nodeProblem = nodeProblem,
      )

    assertEquals("Gateway error: device identity required", display.statusText)
    assertSame(nodeProblem, display.problem)
  }

  private fun problem(code: String): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = code,
      message = code,
      reason = null,
      requestId = null,
      recommendedNextStep = null,
      pauseReconnect = true,
      retryable = false,
    )
}
