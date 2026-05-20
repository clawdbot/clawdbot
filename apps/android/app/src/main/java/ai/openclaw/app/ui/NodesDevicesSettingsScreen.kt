package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDeviceTokenSummary
import ai.openclaw.app.GatewayNodeSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPairedDeviceSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

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
      viewModel.refreshNodesDevices()
    }
  }

  SettingsDetailFrame(
    title = "Nodes & Devices",
    subtitle = "Live nodes, paired phones, and pending device requests.",
    icon = Icons.Default.Cloud,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Nodes", summary.nodes.size.toString()),
          SettingsMetric("Online", summary.nodes.count { it.connected }.toString()),
          SettingsMetric("Devices", if (summary.devicePairingAvailable) summary.pairedDevices.size.toString() else "Locked"),
          SettingsMetric("Pending", summary.pendingDevices.size.toString()),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (refreshing) "Refreshing" else "Refresh",
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
          Text(text = "Connect the gateway to load nodes and paired devices.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      summary.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No nodes or paired devices.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Linked phones and node hosts will appear here after pairing.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
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
        Text(text = "Pairing controls are not available from this connection.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
    if (summary.pendingDevices.isNotEmpty()) {
      NodesSection(title = "Pending Requests") {
        summary.pendingDevices.forEachIndexed { index, device ->
          PendingDeviceRow(device = device)
          if (index != summary.pendingDevices.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
    if (summary.nodes.isNotEmpty()) {
      NodesSection(title = "Nodes") {
        summary.nodes.forEachIndexed { index, node ->
          NodeRow(node = node)
          if (index != summary.nodes.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
    if (summary.pairedDevices.isNotEmpty()) {
      NodesSection(title = "Paired Devices") {
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

@Composable
private fun NodesSection(
  title: String,
  content: @Composable () -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(text = title.uppercase(), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
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
    statusText = if (node.connected) "Online" else "Offline",
    status = if (node.connected) ClawStatus.Success else ClawStatus.Warning,
  )
}

@Composable
private fun PendingDeviceRow(device: GatewayPendingDeviceSummary) {
  DeviceListRow(
    badge = nodeBadge(device.displayName ?: device.deviceId),
    title = device.displayName ?: "New device",
    subtitle = pendingDeviceSubtitle(device),
    statusText = if (device.repair) "Repair" else "Review",
    status = ClawStatus.Warning,
  )
}

@Composable
private fun PairedDeviceRow(device: GatewayPairedDeviceSummary) {
  DeviceListRow(
    badge = nodeBadge(device.displayName ?: device.deviceId),
    title = device.displayName ?: "Paired device",
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

private fun GatewayNodesDevicesSummary.isEmpty(): Boolean = nodes.isEmpty() && pendingDevices.isEmpty() && pairedDevices.isEmpty()

private fun nodeSubtitle(node: GatewayNodeSummary): String {
  val kind = node.deviceFamily ?: "Node host"
  val version = node.version?.let { "OpenClaw $it" }
  val status = if (node.paired) "Paired" else "Unpaired"
  val commands =
    node.commands
      .take(2)
      .joinToString(", ")
      .takeIf { it.isNotBlank() }
  return listOfNotNull(kind, version, status, commands).joinToString(" · ")
}

private fun pendingDeviceSubtitle(device: GatewayPendingDeviceSummary): String {
  val roles = formatDeviceList(device.roles, "role")
  val scopes = formatDeviceList(device.scopes, "scope")
  val requested = device.requestedAtMs?.let { "requested ${relativeDeviceTime(it)}" }
  return listOfNotNull(roles, scopes, requested, device.remoteIp).joinToString(" · ")
}

private fun pairedDeviceSubtitle(device: GatewayPairedDeviceSummary): String {
  val roles = formatDeviceList(device.roles, "role")
  val scopes = formatDeviceList(device.scopes, "scope")
  val tokens = "${device.tokens.count { !it.revoked }}/${device.tokens.size} active tokens"
  return listOfNotNull(roles, scopes, tokens, device.remoteIp).joinToString(" · ")
}

private fun pairedDeviceStatusText(tokens: List<GatewayDeviceTokenSummary>): String =
  when {
    tokens.isEmpty() -> "Paired"
    tokens.any { !it.revoked } -> "Active"
    else -> "Needs Token"
  }

private fun pairedDeviceStatus(tokens: List<GatewayDeviceTokenSummary>): ClawStatus =
  when {
    tokens.isEmpty() -> ClawStatus.Neutral
    tokens.any { !it.revoked } -> ClawStatus.Success
    else -> ClawStatus.Warning
  }

private fun formatDeviceList(
  values: List<String>,
  fallback: String,
): String? =
  when (values.size) {
    0 -> null
    1 -> values.first()
    else -> "${values.size} ${fallback}s"
  }

private fun nodeBadge(value: String): String =
  value
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "N" }

private fun relativeDeviceTime(timeMs: Long): String {
  val minutes = ((System.currentTimeMillis() - timeMs).coerceAtLeast(0L)) / 60_000L
  if (minutes < 1) return "now"
  if (minutes < 60) return "${minutes}m ago"
  val hours = minutes / 60L
  if (hours < 24) return "${hours}h ago"
  return "${hours / 24L}d ago"
}
