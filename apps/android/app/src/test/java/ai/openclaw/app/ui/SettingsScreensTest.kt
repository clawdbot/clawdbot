package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayExecApprovalSummary
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.GatewayUsageProviderSummary
import ai.openclaw.app.GatewayUsageWindowSummary
import ai.openclaw.app.LocationMode
import ai.openclaw.app.i18n.verbatimText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.Locale

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
    assertEquals("enterpriseInternal", androidDistributionChannel("enterpriseInternal"))
  }

  @Test
  fun aboutAndPermissionFallbacksLocalizeOnlyControlledLabels() {
    assertEquals("Website", aboutLinkTitle("Website"))
    assertEquals("Docs", aboutLinkTitle("Docs"))
    assertEquals("GitHub", aboutLinkTitle("GitHub"))
    assertEquals("Custom", aboutLinkTitle("Custom"))
    assertEquals("Allow all the time", resolvedBackgroundPermissionLabel("  "))
    assertEquals("Android system label", resolvedBackgroundPermissionLabel(" Android system label "))
  }

  @Test
  fun aboutBuildIdentityFormatsVersionShortCommitAndUtcDate() {
    val identity =
      aboutBuildIdentity(
        versionName = "2026.7.1",
        versionCode = 2026070102,
        gitCommit = "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        buildTimestamp = "2026-07-10T00:30:00.000Z",
        locale = Locale.US,
        unknownLabel = "Unknown",
      )

    assertEquals("2026.7.1 (2026070102)", identity.version)
    assertEquals("abcdef012345", identity.commit)
    assertEquals("abcdef0123456789abcdef0123456789abcdef01", identity.fullCommit)
    assertEquals("Jul 10, 2026", identity.built)
    assertEquals("2026-07-10T00:30:00.000Z", identity.buildTimestamp)
  }

  @Test
  fun aboutBuildIdentityKeepsUnknownFallbacksVisible() {
    val identity =
      aboutBuildIdentity(
        versionName = "dev",
        versionCode = 1,
        gitCommit = "unknown",
        buildTimestamp = "unknown",
        locale = Locale.US,
        unknownLabel = "Unbekannt",
      )

    assertEquals("dev (1)", identity.version)
    assertEquals("Unbekannt", identity.commit)
    assertEquals(null, identity.fullCommit)
    assertEquals("Unbekannt", identity.built)
    assertEquals(null, identity.buildTimestamp)
    assertEquals("Unbekannt", aboutCommitAccessibilityValue(identity.fullCommit, "Unbekannt"))
  }

  @Test
  fun aboutCommitAccessibilityValueSpellsTheFullHash() {
    val commit = "abcdef0123456789abcdef0123456789abcdef01"

    assertEquals(
      commit.toCharArray().joinToString(" "),
      aboutCommitAccessibilityValue(commit, "Unknown"),
    )
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

  @Test
  fun cronDetailDeliveryStatusUsesLocalizedLabelsAndNullFallback() {
    assertEquals("Delivered", cronJobDeliveryStatusText("delivered"))
    assertEquals("future-status", cronJobDeliveryStatusText("future-status"))
    assertEquals("None", cronJobDeliveryStatusText(null))
  }

  @Test
  fun approvalActionsUseUnabridgedSafetyLabelsInLargeFontSafeOrder() {
    assertEquals(
      listOf(
        ExecApprovalAction("allow-once", "Allow Once"),
        ExecApprovalAction("allow-always", "Allow Always"),
        ExecApprovalAction("deny", "Deny"),
      ),
      execApprovalActions(listOf("allow-once", "allow-always", "deny")),
    )
  }

  @Test
  fun approvalPresentationLocalizesControlledCopyAndPreservesGatewayValues() {
    val approval =
      GatewayExecApprovalSummary(
        id = "approval-1",
        commandText = verbatimText("echo ok"),
        commandPreview = "echo",
        warningText = null,
        allowedDecisions = listOf("allow-once"),
        host = "node",
        nodeId = "node-123456",
        agentId = "agent-123456",
        createdAtMs = 0,
        expiresAtMs = 3_660_000,
      )

    assertEquals(
      "Node node-123 · Agent agent-12 · Waiting 1h · Expires 1m",
      execApprovalMetadata(approval, nowMs = 3_600_000),
    )
    assertEquals(
      "ssh.EXAMPLE",
      execApprovalMetadata(
        approval.copy(host = "ssh.EXAMPLE", nodeId = null, agentId = null, createdAtMs = null, expiresAtMs = null),
        nowMs = 0,
      ),
    )
    assertEquals(
      "Node",
      execApprovalMetadata(
        approval.copy(host = "node", nodeId = null, agentId = null, createdAtMs = null, expiresAtMs = null),
        nowMs = 0,
      ),
    )
    assertEquals(
      "Gateway",
      execApprovalMetadata(
        approval.copy(host = "gateway", nodeId = null, agentId = null, createdAtMs = null, expiresAtMs = null),
        nowMs = 0,
      ),
    )
    assertEquals("soon", formatApprovalDuration(0))
    assertEquals("Action Request", approvalActionName(""))
  }

  @Test
  fun cronSessionTargetsLocalizeClosedCodesAndPreserveCustomTargets() {
    assertEquals("Main", cronSessionTargetLabel("main"))
    assertEquals("Isolated", cronSessionTargetLabel("isolated"))
    assertEquals("Current", cronSessionTargetLabel("current"))
    assertEquals("session:custom", cronSessionTargetLabel("session:custom"))
  }

  @Test
  fun usageAndCronSummariesLocalizeOnlyControlledWords() {
    val provider =
      GatewayUsageProviderSummary(
        displayName = "Provider",
        plan = "Team Plan",
        error = null,
        windows =
          listOf(
            GatewayUsageWindowSummary(
              label = "Custom Window",
              usedPercent = 25.0,
              resetAtMs = null,
            ),
          ),
      )

    assertEquals("Team Plan · 75% left Custom Window", usageProviderSubtitle(provider))
    assertEquals("provider error", usageProviderSubtitle(provider.copy(error = "provider error")))
    assertEquals("Never", formatUsageUpdated(updatedAtMs = null, nowMs = 60_000))
    assertEquals("Now", formatUsageUpdated(updatedAtMs = 59_999, nowMs = 60_000))
    assertEquals("None", formatCronWake(timeMs = null, nowMs = 60_000))
    assertEquals("Due", formatCronWake(timeMs = 60_000, nowMs = 60_000))
    assertEquals("Soon", formatCronWake(timeMs = 60_001, nowMs = 60_000))
    assertEquals("None", formatCronTimestamp(null))
  }

  @Test
  fun approvalCardShowsTheWholeMonospacedCommandBeforeStackedActions() {
    val source = settingsScreensSource()
    val cardStart = source.indexOf("private fun ExecApprovalCard(")
    val reviewCall = source.indexOf("ExecApprovalCommandReview(", cardStart)
    val actionsCall = source.indexOf("execApprovalActions(approval.allowedDecisions)", reviewCall)
    val reviewStart = source.indexOf("private fun ExecApprovalCommandReview(", actionsCall)
    val reviewEnd = source.indexOf("internal data class ExecApprovalAction", reviewStart)
    assertTrue(cardStart >= 0 && reviewCall > cardStart && actionsCall > reviewCall)
    assertTrue(reviewStart > actionsCall && reviewEnd > reviewStart)
    val reviewBody = source.substring(reviewStart, reviewEnd)
    val actionBody = source.substring(reviewCall, reviewStart)

    assertTrue(reviewBody.contains("FontFamily.Monospace"))
    assertFalse(reviewBody.contains("maxLines"))
    assertFalse(reviewBody.contains("TextOverflow"))
    assertTrue(actionBody.contains("Column(modifier = Modifier.fillMaxWidth()"))
    assertFalse(actionBody.contains("Modifier.weight(1f)"))
  }

  @Test
  fun terminalNoticeRendersAsStandaloneDismissibleBannerRegardlessOfRemainingCards() {
    val source = settingsScreensSource()
    // Terminal outcomes retire their card before the notice publishes, so any
    // card-scoped or empty-inbox-only rendering hides losing outcomes whenever
    // another approval card remains visible.
    assertFalse(source.contains("execApprovalNoticeForCard"))
    assertFalse(source.contains("execApprovalEmptyInboxNotice"))
    val screenStart = source.indexOf("private fun ApprovalsSettingsScreen(")
    val bannerCall = source.indexOf("execApprovalsNotice?.let", screenStart)
    val listPanelCall = source.indexOf("ExecApprovalsPanel(", screenStart)
    assertTrue(screenStart >= 0 && bannerCall > screenStart && listPanelCall > bannerCall)

    val noticeStart = source.indexOf("private fun ExecApprovalNotice(")
    val noticeEnd = source.indexOf("@Composable", noticeStart + 1)
    val noticeBody = source.substring(noticeStart, noticeEnd)
    assertTrue(noticeBody.contains("onDismiss: () -> Unit"))
    assertTrue(noticeBody.contains("notice.approvalId"))
    assertTrue(
      noticeBody.contains(
        "contentDescription = nativeString(\"Dismiss approval notice\")",
      ),
    )
  }

  private fun settingsScreensSource(): String {
    val candidates =
      listOf(
        Path.of("src/main/java/ai/openclaw/app/ui/SettingsScreens.kt"),
        Path.of("apps/android/app/src/main/java/ai/openclaw/app/ui/SettingsScreens.kt"),
      )
    val path = candidates.firstOrNull(Files::exists) ?: error("SettingsScreens.kt not found")
    return Files.readString(path)
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
