package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.LocationMode
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsScreensTest {
  @Test
  fun locationModes_hideAlwaysFromPlayAndMapThirdPartySelection() {
    assertEquals(listOf("Off", "While Using"), locationModeLabels(backgroundLocationAvailable = false))
    assertEquals(
      listOf("Off", "While Using", "Always"),
      locationModeLabels(backgroundLocationAvailable = true),
    )
    assertEquals(LocationMode.Always, locationModeForLabel("Always"))
  }

  @Test
  fun androidDistributionChannelUsesBuildFlavorLabels() {
    assertEquals("Play", androidDistributionChannel("play"))
    assertEquals("Third-party", androidDistributionChannel("thirdParty"))
    assertEquals("Unknown", androidDistributionChannel(""))
  }

  @Test
  fun gatewayStatusLabelReportsWhichAuthRecoveryAppliesInsteadOfGenericLabel() {
    assertEquals(
      "Setup code expired",
      gatewayStatusLabel(
        "Gateway error: unauthorized: bootstrap token invalid or expired",
        isConnected = false,
        gatewayConnectionProblem = authProblem("AUTH_BOOTSTRAP_TOKEN_INVALID"),
      ),
    )
    assertEquals(
      "Device identity required",
      gatewayStatusLabel(
        "Gateway error: device identity required",
        isConnected = false,
        gatewayConnectionProblem = authProblem("DEVICE_IDENTITY_REQUIRED"),
      ),
    )
  }

  @Test
  fun gatewayStatusLabelFallsBackToGenericAuthLabelWithoutAKnownReason() {
    assertEquals("Authentication needed", gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = null))
    assertEquals(
      "Authentication needed",
      gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = authProblem("SOME_UNMAPPED_CODE")),
    )
  }

  @Test
  fun gatewayStatusLabelLeavesUnrelatedStatesUnaffectedByConnectionProblem() {
    val problem = authProblem("AUTH_TOKEN_MISSING")
    assertEquals("Ready", gatewayStatusLabel("auth failed", isConnected = true, gatewayConnectionProblem = authProblem("AUTH_TOKEN_MISSING")))
    assertEquals("Pairing needed", gatewayStatusLabel("Pairing in progress", isConnected = false, gatewayConnectionProblem = problem))
    assertEquals("Cannot reach gateway", gatewayStatusLabel("Connection failed", isConnected = false, gatewayConnectionProblem = problem))
  }

  @Test
  fun gatewaySetupResetCopyExplainsCredentialAndApprovalImpact() {
    val text = gatewaySettingsSetupResetConfirmationText()

    assertEquals(true, text.contains("saved setup credentials"))
    assertEquals(true, text.contains("device tokens"))
    assertEquals(true, text.contains("node capability approval"))
  }

  @Test
  fun devicePairingAdminCopySeparatesPairingFromNodeApproval() {
    val text = devicePairingAdminUnavailableText()

    assertEquals(true, text.contains("approve new phone pairing"))
    assertEquals(true, text.contains("Node capability approval is separate"))
    assertEquals(true, text.contains("nodes approve <request id>"))
  }

  @Test
  fun nodeApprovalCommandUsesOnlyASafeExactRequestId() {
    assertEquals(
      "openclaw nodes approve request-1",
      gatewayNodeApprovalCommand(GatewayNodeCapabilityApproval.PendingApproval("request-1")),
    )
    assertEquals(
      "openclaw nodes status",
      gatewayNodeApprovalCommand(GatewayNodeCapabilityApproval.PendingReapproval("request-1; unsafe")),
    )
    assertEquals(null, gatewayNodeApprovalCommand(GatewayNodeCapabilityApproval.Approved))
  }

  @Test
  fun cronDetailRefreshRecoversWhenDirtyDraftHasNoLoadedJob() {
    assertEquals(
      true,
      cronDetailRefreshEnabled(
        isConnected = true,
        loading = false,
        hasCurrentJob = false,
        draftRequiresResolution = true,
        saveSucceeded = false,
      ),
    )
    assertEquals(
      false,
      cronDetailRefreshEnabled(
        isConnected = true,
        loading = false,
        hasCurrentJob = true,
        draftRequiresResolution = true,
        saveSucceeded = false,
      ),
    )
  }

  @Test
  fun cronDetailDisposalRetainsTransientStateOnlyForActivityRecreation() {
    assertEquals(false, cronDetailDisposalClearsTransientState(isChangingConfigurations = true))
    assertEquals(true, cronDetailDisposalClearsTransientState(isChangingConfigurations = false))
  }

  private fun authProblem(code: String): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = code,
      message = "Authentication failed.",
      reason = null,
      requestId = null,
      recommendedNextStep = null,
      pauseReconnect = false,
      retryable = false,
    )
}
