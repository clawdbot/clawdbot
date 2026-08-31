package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayDiagnosticsTest {
  @Test
  fun authRecoveryLabelsComeFromStructuredProblemCodes() {
    val labels =
      mapOf(
        "AUTH_BOOTSTRAP_TOKEN_INVALID" to "Setup code expired",
        "AUTH_TOKEN_MISSING" to "Gateway token needed",
        "AUTH_TOKEN_NOT_CONFIGURED" to "Gateway token not configured",
        "AUTH_PASSWORD_MISSING" to "Gateway password needed",
        "AUTH_PASSWORD_MISMATCH" to "Gateway password invalid",
        "AUTH_PASSWORD_NOT_CONFIGURED" to "Gateway password not configured",
        "AUTH_SCOPE_MISMATCH" to "Gateway access needs review",
        "AUTH_TOKEN_MISMATCH" to "Saved auth invalid",
        "AUTH_DEVICE_TOKEN_MISMATCH" to "Saved auth invalid",
        "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" to "Device identity required",
        "DEVICE_IDENTITY_REQUIRED" to "Device identity required",
      )

    labels.forEach { (code, label) ->
      assertEquals(label, gatewayAuthRecoveryLabel(authProblem(code)))
    }
    assertNull(gatewayAuthRecoveryLabel(authProblem("SOME_UNMAPPED_CODE")))
    assertNull(gatewayAuthRecoveryLabel(null))
  }

  @Test
  fun endpointPrefersLiveRemoteAddress() {
    assertEquals(
      "wss://gateway.example.test",
      gatewayDiagnosticsEndpoint(
        remoteAddress = " wss://gateway.example.test ",
        manualHost = "10.0.2.2",
        manualPort = 18789,
        manualTls = false,
      ),
    )
  }

  @Test
  fun endpointFallsBackToManualConfig() {
    assertEquals(
      "http://10.0.2.2:18789",
      gatewayDiagnosticsEndpoint(
        remoteAddress = null,
        manualHost = "10.0.2.2",
        manualPort = 18789,
        manualTls = false,
      ),
    )
  }

  @Test
  fun endpointReportsMissingConfig() {
    assertEquals(
      "Not set",
      gatewayDiagnosticsEndpoint(
        remoteAddress = null,
        manualHost = "",
        manualPort = 18789,
        manualTls = false,
      ),
    )
  }

  @Test
  fun diagnosticsReportIncludesSupportContext() {
    val report =
      buildGatewayDiagnosticsReport(
        screen = "chat composer",
        gatewayAddress = "http://10.0.2.2:18789",
        statusText = "connection refused",
      )

    assertTrue(report.contains("- screen: chat composer"))
    assertTrue(report.contains("- gateway address: http://10.0.2.2:18789"))
    assertTrue(report.contains("- status/error: connection refused"))
  }

  private fun authProblem(code: String) =
    ai.openclaw.app.GatewayConnectionProblem(
      code = code,
      message = "Authentication failed.",
      reason = null,
      requestId = null,
      recommendedNextStep = null,
      pauseReconnect = false,
      retryable = false,
    )
}
