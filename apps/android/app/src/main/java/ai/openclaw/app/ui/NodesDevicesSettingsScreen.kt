package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDeviceTokenSummary
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.GatewayNodeSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPairedDeviceSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.uppercaseFirstGraphemeOrNull
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/** Settings screen for gateway nodes, paired devices, and pending pairing requests. */
@Composable
internal fun NodesDevicesSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val summary by viewModel.nodesDevicesSummary.collectAsState()
  val refreshing by viewModel.nodesDevicesRefreshing.collectAsState()
  val errorText by viewModel.nodesDevicesErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      // Refresh once on connection; user-triggered refresh handles later changes
      // so device admin state is not polled from Compose.
      viewModel.refreshNodesDevices()
    }
  }

  SettingsDetailFrame(
    title = nativeString("Nodes & Devices"),
    subtitle = nativeString("Live nodes, paired phones, and pending device requests."),
    icon = Icons.Default.Cloud,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Nodes"), summary.nodes.size.toString()),
          SettingsMetric(nativeString("Online"), summary.nodes.count { it.connected }.toString()),
          SettingsMetric(nativeString("Devices"), if (summary.devicePairingAvailable) summary.pairedDevices.size.toString() else nativeString("Admin")),
          SettingsMetric(nativeString("Pending"), summary.pendingDevices.size.toString()),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (refreshing) nativeString("Refreshing") else nativeString("Refresh"),
        onClick = viewModel::refreshNodesDevices,
        enabled = isConnected && !refreshing,
        modifier = Modifier.weight(1f),
      )
    }
    errorText?.let {
      ClawPanel {
        Text(text = it, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = nativeString("Connect the gateway to load nodes and paired devices."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      summary.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = nativeString("No nodes or paired devices."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = nativeString("Linked phones and node hosts will appear here after pairing."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> NodesDevicesPanel(summary = summary)
    }
  }
}

@Composable
private fun NodesDevicesPanel(summary: GatewayNodesDevicesSummary) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    if (!summary.devicePairingAvailable) {
      ClawPanel {
        Text(text = devicePairingAdminUnavailableText(), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
    val approvalCommands = summary.nodes.mapNotNull(::nodeApprovalCommandRow)
    if (approvalCommands.isNotEmpty()) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(text = nativeString("Node approval required"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = nativeString("Run on the Gateway host:"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          approvalCommands.forEach { (label, command) ->
            Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
            SelectionContainer {
              Text(
                text = command,
                style = ClawTheme.type.body.copy(fontFamily = FontFamily.Monospace),
                color = ClawTheme.colors.text,
              )
            }
          }
        }
      }
    }
    if (summary.pendingDevices.isNotEmpty()) {
      NodesSection(title = nativeString("Pending Requests")) {
        summary.pendingDevices.forEachIndexed { index, device ->
          PendingDeviceRow(device = device)
          if (index != summary.pendingDevices.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
    if (summary.nodes.isNotEmpty()) {
      NodesSection(title = nativeString("Nodes")) {
        summary.nodes.forEachIndexed { index, node ->
          NodeRow(node = node)
          if (index != summary.nodes.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
    if (summary.pairedDevices.isNotEmpty()) {
      NodesSection(title = nativeString("Paired Devices")) {
        summary.pairedDevices.forEachIndexed { index, device ->
          PairedDeviceRow(device = device)
          if (index != summary.pairedDevices.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
  }
}

private fun nodeApprovalCommandRow(node: GatewayNodeSummary): Pair<String, String>? {
  val command = gatewayNodeApprovalCommand(node.approvalState, node.pendingRequestId) ?: return null
  return (node.displayName ?: node.id) to command
}

@Composable
private fun NodesSection(
  title: String,
  content: @Composable () -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(
      text = localizedUppercase(title, currentAppLanguage().languageTag),
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
    )
    ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
      Column {
        content()
      }
    }
  }
}

@Composable
private fun NodeRow(node: GatewayNodeSummary) {
  DeviceListRow(
    badge = nodeBadge(node.displayName ?: node.id),
    title = node.displayName ?: node.id,
    subtitle = nodeSubtitle(node),
    statusText = nodeStatusText(node),
    status = nodeStatus(node),
  )
}

@Composable
private fun PendingDeviceRow(device: GatewayPendingDeviceSummary) {
  DeviceListRow(
    badge = nodeBadge(device.displayName ?: device.deviceId),
    title = device.displayName ?: nativeString("New device"),
    subtitle = pendingDeviceSubtitle(device),
    statusText = if (device.repair) nativeString("Repair") else nativeString("Review"),
    status = ClawStatus.Warning,
  )
}

@Composable
private fun PairedDeviceRow(device: GatewayPairedDeviceSummary) {
  DeviceListRow(
    badge = nodeBadge(device.displayName ?: device.deviceId),
    title = device.displayName ?: nativeString("Paired device"),
    subtitle = pairedDeviceSubtitle(device),
    statusText = pairedDeviceStatusText(device.tokens),
    status = pairedDeviceStatus(device.tokens),
  )
}

@Composable
private fun DeviceListRow(
  badge: String,
  title: String,
  subtitle: String,
  statusText: String,
  status: ClawStatus,
) {
  ClawDetailRow(
    title = title,
    subtitle = subtitle,
    leading = { ClawTextBadge(text = badge) },
    trailing = { ClawStatusPill(text = statusText, status = status) },
  )
}

/** True when the gateway returned no node or device rows to render. */
private fun GatewayNodesDevicesSummary.isEmpty(): Boolean = nodes.isEmpty() && pendingDevices.isEmpty() && pairedDevices.isEmpty()

private fun nodeSubtitle(node: GatewayNodeSummary): String {
  val kind = node.deviceFamily ?: nativeString("Node host")
  val version = node.version?.let { "OpenClaw $it" }
  val status = if (node.paired) nativeString("Paired") else nativeString("Unpaired")
  val approval = nodeApprovalSubtitle(node.approvalState)
  val commands =
    node.commands
      .take(2)
      .joinToString(", ")
      .takeIf { it.isNotBlank() }
  return listOfNotNull(kind, version, status, approval, commands).joinToString(" · ")
}

private fun nodeStatusText(node: GatewayNodeSummary): String =
  when (node.approvalState) {
    GatewayNodeApprovalState.PendingApproval -> nativeString("Needs approval")
    GatewayNodeApprovalState.PendingReapproval -> nativeString("Needs reapproval")
    GatewayNodeApprovalState.Unapproved -> nativeString("Unapproved")
    else -> if (node.connected) nativeString("Online") else nativeString("Offline")
  }

private fun nodeStatus(node: GatewayNodeSummary): ClawStatus =
  when (node.approvalState) {
    GatewayNodeApprovalState.Approved -> if (node.connected) ClawStatus.Success else ClawStatus.Warning
    GatewayNodeApprovalState.PendingApproval,
    GatewayNodeApprovalState.PendingReapproval,
    GatewayNodeApprovalState.Unapproved,
    -> ClawStatus.Warning
    GatewayNodeApprovalState.Loading,
    GatewayNodeApprovalState.Unsupported,
    -> if (node.connected) ClawStatus.Neutral else ClawStatus.Warning
  }

private fun nodeApprovalSubtitle(approvalState: GatewayNodeApprovalState): String? =
  when (approvalState) {
    GatewayNodeApprovalState.Approved -> nativeString("Approved")
    GatewayNodeApprovalState.PendingApproval -> nativeString("Capability approval pending")
    GatewayNodeApprovalState.PendingReapproval -> nativeString("Capability reapproval pending")
    GatewayNodeApprovalState.Unapproved -> nativeString("Capability unapproved")
    GatewayNodeApprovalState.Loading,
    GatewayNodeApprovalState.Unsupported,
    -> null
  }

internal fun devicePairingAdminUnavailableText(): String =
  nativeString(
    "This gateway sign-in can list connected nodes, but it cannot approve new phone pairing. Pair new phones from a gateway admin session. Node capability approval is separate and still uses nodes approve <request id>.",
  )

private fun pendingDeviceSubtitle(device: GatewayPendingDeviceSummary): String {
  val roles = formatDeviceList(device.roles, DeviceListKind.Role)
  val scopes = formatDeviceList(device.scopes, DeviceListKind.Scope)
  val requested = device.requestedAtMs?.let { nativeString("requested \${relativeDeviceTime(it)}", relativeDeviceTime(it)) }
  return listOfNotNull(roles, scopes, requested, device.remoteIp).joinToString(" · ")
}

private fun pairedDeviceSubtitle(device: GatewayPairedDeviceSummary): String {
  val roles = formatDeviceList(device.roles, DeviceListKind.Role)
  val scopes = formatDeviceList(device.scopes, DeviceListKind.Scope)
  val tokens =
    nativeString(
      "\${device.tokens.count { !it.revoked }}/\${device.tokens.size} active tokens",
      device.tokens.count { !it.revoked },
      device.tokens.size,
    )
  return listOfNotNull(roles, scopes, tokens, device.remoteIp).joinToString(" · ")
}

private fun pairedDeviceStatusText(tokens: List<GatewayDeviceTokenSummary>): String =
  when {
    tokens.isEmpty() -> nativeString("Paired")
    tokens.any { !it.revoked } -> nativeString("Active")
    else -> nativeString("Needs Token")
  }

private fun pairedDeviceStatus(tokens: List<GatewayDeviceTokenSummary>): ClawStatus =
  when {
    tokens.isEmpty() -> ClawStatus.Neutral
    tokens.any { !it.revoked } -> ClawStatus.Success
    else -> ClawStatus.Warning
  }

internal enum class DeviceListKind {
  Role,
  Scope,
}

internal fun formatDeviceList(
  values: List<String>,
  kind: DeviceListKind,
): String? =
  when (values.size) {
    0 -> null
    1 -> values.first()
    else ->
      when (kind) {
        DeviceListKind.Role -> nativeString("\${values.size} roles", values.size)
        DeviceListKind.Scope -> nativeString("\${values.size} scopes", values.size)
      }
  }

private fun nodeBadge(value: String): String =
  value
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.uppercaseFirstGraphemeOrNull() }
    .joinToString("")
    .ifBlank { "N" }

internal fun relativeDeviceTime(
  timeMs: Long,
  nowMs: Long = System.currentTimeMillis(),
): String {
  val minutes = ((nowMs - timeMs).coerceAtLeast(0L)) / 60_000L
  if (minutes < 1) return nativeString("now")
  if (minutes < 60) return nativeString("\${minutes}m ago", minutes)
  val hours = minutes / 60L
  if (hours < 24) return nativeString("\${hours}h ago", hours)
  val days = hours / 24L
  return nativeString("\${days}d ago", days)
}
