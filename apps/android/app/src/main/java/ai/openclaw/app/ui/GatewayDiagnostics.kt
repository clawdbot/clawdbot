package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.gateway.normalizeGatewayApprovalRequestId
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast

/** App version label shared by diagnostics and gateway-facing Android metadata. */
internal fun openClawAndroidVersionLabel(): String {
  val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
  return if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
    "$versionName-dev"
  } else {
    versionName
  }
}

/** Normalizes blank gateway status text for display and diagnostics copy. */
internal fun gatewayStatusForDisplay(statusText: String): String = statusText.trim().ifEmpty { "Offline" }

/** Resolves the best non-secret endpoint label available to diagnostics surfaces. */
internal fun gatewayDiagnosticsEndpoint(
  remoteAddress: String?,
  manualHost: String,
  manualPort: Int,
  manualTls: Boolean,
): String {
  remoteAddress?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
  return composeGatewayManualUrl(manualHost, manualPort.toString(), manualTls)?.let { parseGatewayEndpoint(it)?.displayUrl } ?: "Not set"
}

/** Detects pairing/approval status text so UI can offer pairing-specific actions. */
internal fun gatewayStatusLooksLikePairing(statusText: String): Boolean {
  val lower = gatewayStatusForDisplay(statusText).lowercase()
  return lower.contains("pair") || lower.contains("approve")
}

/** Maps structured gateway auth failures to the compact labels used by status surfaces. */
internal fun gatewayAuthRecoveryLabel(problem: GatewayConnectionProblem?): String? {
  val kind =
    when (problem?.code) {
      "AUTH_BOOTSTRAP_TOKEN_INVALID" -> GatewayAuthRecoveryLabelKind.SETUP_CODE_EXPIRED
      "AUTH_TOKEN_MISSING" -> GatewayAuthRecoveryLabelKind.TOKEN_NEEDED
      "AUTH_TOKEN_NOT_CONFIGURED" -> GatewayAuthRecoveryLabelKind.TOKEN_NOT_CONFIGURED
      "AUTH_PASSWORD_MISSING" -> GatewayAuthRecoveryLabelKind.PASSWORD_NEEDED
      "AUTH_PASSWORD_MISMATCH" -> GatewayAuthRecoveryLabelKind.PASSWORD_INVALID
      "AUTH_PASSWORD_NOT_CONFIGURED" -> GatewayAuthRecoveryLabelKind.PASSWORD_NOT_CONFIGURED
      "AUTH_SCOPE_MISMATCH" -> GatewayAuthRecoveryLabelKind.ACCESS_NEEDS_REVIEW
      "AUTH_TOKEN_MISMATCH",
      "AUTH_DEVICE_TOKEN_MISMATCH",
      -> GatewayAuthRecoveryLabelKind.SAVED_AUTH_INVALID
      "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
      "DEVICE_IDENTITY_REQUIRED",
      -> GatewayAuthRecoveryLabelKind.DEVICE_IDENTITY_REQUIRED
      else -> return null
    }
  return gatewayAuthRecoveryLabel(kind)
}

private enum class GatewayAuthRecoveryLabelKind {
  SETUP_CODE_EXPIRED,
  TOKEN_NEEDED,
  TOKEN_NOT_CONFIGURED,
  PASSWORD_NEEDED,
  PASSWORD_INVALID,
  PASSWORD_NOT_CONFIGURED,
  ACCESS_NEEDS_REVIEW,
  SAVED_AUTH_INVALID,
  DEVICE_IDENTITY_REQUIRED,
}

private fun gatewayAuthRecoveryLabel(kind: GatewayAuthRecoveryLabelKind): String =
  when (kind) {
    GatewayAuthRecoveryLabelKind.SETUP_CODE_EXPIRED -> "Setup code expired"
    GatewayAuthRecoveryLabelKind.TOKEN_NEEDED -> "Gateway token needed"
    GatewayAuthRecoveryLabelKind.TOKEN_NOT_CONFIGURED -> "Gateway token not configured"
    GatewayAuthRecoveryLabelKind.PASSWORD_NEEDED -> "Gateway password needed"
    GatewayAuthRecoveryLabelKind.PASSWORD_INVALID -> "Gateway password invalid"
    GatewayAuthRecoveryLabelKind.PASSWORD_NOT_CONFIGURED -> "Gateway password not configured"
    GatewayAuthRecoveryLabelKind.ACCESS_NEEDS_REVIEW -> "Gateway access needs review"
    GatewayAuthRecoveryLabelKind.SAVED_AUTH_INVALID -> "Saved auth invalid"
    GatewayAuthRecoveryLabelKind.DEVICE_IDENTITY_REQUIRED -> "Device identity required"
  }

/** Returns the exact host command for one node's approval state when available. */
internal fun gatewayNodeApprovalCommand(
  state: GatewayNodeApprovalState,
  requestId: String?,
): String? =
  when (state) {
    GatewayNodeApprovalState.PendingApproval,
    GatewayNodeApprovalState.PendingReapproval,
    -> normalizeGatewayApprovalRequestId(requestId)?.let { "openclaw nodes approve $it" } ?: "openclaw nodes status"
    GatewayNodeApprovalState.Unapproved -> "openclaw nodes status"
    GatewayNodeApprovalState.Loading,
    GatewayNodeApprovalState.Unsupported,
    GatewayNodeApprovalState.Approved,
    -> null
  }

internal fun gatewayNodeApprovalCommand(approval: GatewayNodeCapabilityApproval): String? =
  when (approval) {
    is GatewayNodeCapabilityApproval.PendingApproval ->
      gatewayNodeApprovalCommand(GatewayNodeApprovalState.PendingApproval, approval.requestId)
    is GatewayNodeCapabilityApproval.PendingReapproval ->
      gatewayNodeApprovalCommand(GatewayNodeApprovalState.PendingReapproval, approval.requestId)
    GatewayNodeCapabilityApproval.Unapproved ->
      gatewayNodeApprovalCommand(GatewayNodeApprovalState.Unapproved, requestId = null)
    GatewayNodeCapabilityApproval.Loading,
    GatewayNodeCapabilityApproval.Unsupported,
    GatewayNodeCapabilityApproval.Approved,
    -> null
  }

/** Builds the copyable support prompt with device, endpoint, and exact status context. */
internal fun buildGatewayDiagnosticsReport(
  screen: String,
  gatewayAddress: String,
  statusText: String,
): String {
  val device =
    listOfNotNull(Build.MANUFACTURER, Build.MODEL)
      .joinToString(" ")
      .trim()
      .ifEmpty { "Android" }
  val androidVersion =
    Build.VERSION.RELEASE
      ?.trim()
      .orEmpty()
      .ifEmpty { Build.VERSION.SDK_INT.toString() }
  val endpoint = gatewayAddress.trim().ifEmpty { "unknown" }
  val status = gatewayStatusForDisplay(statusText)
  return """
    Help diagnose this OpenClaw Android gateway connection failure.

    Please:
    - pick one route only: same machine, same LAN, Tailscale, or public URL
    - classify this as pairing/auth, TLS trust, wrong advertised route, wrong address/port, or gateway down
    - remember: public routes require wss:// or Tailscale Serve; ws:// is allowed for localhost, .local hosts, the Android emulator, and private LAN IPs
    - quote the exact app status/error below
    - tell me whether `openclaw devices list` should show a pending pairing request
    - if more signal is needed, ask for `openclaw qr --json`, `openclaw devices list`, and `openclaw nodes status`
    - give the next exact command or tap

    Debug info:
    - screen: $screen
    - app version: ${openClawAndroidVersionLabel()}
    - device: $device
    - android: $androidVersion (SDK ${Build.VERSION.SDK_INT})
    - gateway address: $endpoint
    - status/error: $status
    """.trimIndent()
}

/** Copies the diagnostics report to Android clipboard and shows a short confirmation toast. */
internal fun copyGatewayDiagnosticsReport(
  context: Context,
  screen: String,
  gatewayAddress: String,
  statusText: String,
) {
  val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
  val report = buildGatewayDiagnosticsReport(screen = screen, gatewayAddress = gatewayAddress, statusText = statusText)
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw gateway diagnostics", report))
  Toast.makeText(context, "Copied gateway diagnostics", Toast.LENGTH_SHORT).show()
}
