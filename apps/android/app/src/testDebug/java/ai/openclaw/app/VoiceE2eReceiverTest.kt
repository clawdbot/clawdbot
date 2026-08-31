package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceE2eReceiverTest {
  @Test
  fun terminalAuthFailureStopsWaiting() {
    val problem =
      problem(
        code = "AUTH_TOKEN_MISSING",
        message = "unauthorized: gateway token missing",
        pauseReconnect = true,
        retryable = false,
      )

    assertEquals(
      "unauthorized: gateway token missing",
      voiceE2eTerminalGatewayFailure(problem),
    )
  }

  @Test
  fun pairingApprovalKeepsWaiting() {
    val problem =
      problem(
        code = "PAIRING_REQUIRED",
        message = "pairing approval required",
        pauseReconnect = true,
        retryable = true,
      )

    assertNull(voiceE2eTerminalGatewayFailure(problem))
  }

  @Test
  fun retryableTransportFailureKeepsWaiting() {
    val problem =
      problem(
        code = "UNAVAILABLE",
        message = "gateway unavailable",
        pauseReconnect = false,
        retryable = true,
      )

    assertNull(voiceE2eTerminalGatewayFailure(problem))
  }

  @Test
  fun timeoutIncludesLatestConnectionDetail() {
    assertEquals(
      "Gateway connection timed out after 12000 ms: pairing approval required",
      voiceE2eGatewayTimeoutMessage(
        timeoutMs = 12_000L,
        statusText = "Reconnecting...",
        problem =
          problem(
            code = "PAIRING_REQUIRED",
            message = "pairing approval required",
            pauseReconnect = true,
            retryable = true,
          ),
      ),
    )
    assertEquals(
      "Gateway connection timed out after 12000 ms: Connecting...",
      voiceE2eGatewayTimeoutMessage(
        timeoutMs = 12_000L,
        statusText = "Connecting...",
        problem = null,
      ),
    )
  }

  private fun problem(
    code: String,
    message: String,
    pauseReconnect: Boolean,
    retryable: Boolean,
  ): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = code,
      message = message,
      reason = null,
      requestId = null,
      recommendedNextStep = null,
      pauseReconnect = pauseReconnect,
      retryable = retryable,
    )
}
