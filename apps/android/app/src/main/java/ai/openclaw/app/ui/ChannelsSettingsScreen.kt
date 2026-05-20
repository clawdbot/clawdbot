package ai.openclaw.app.ui

import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
internal fun ChannelsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val summary by viewModel.channelsSummary.collectAsState()
  val refreshing by viewModel.channelsRefreshing.collectAsState()
  val errorText by viewModel.channelsErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val channels = summary.channels

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshChannels()
    }
  }

  SettingsDetailFrame(
    title = "Channels",
    subtitle = "Messaging surfaces connected to this gateway.",
    icon = Icons.Default.Notifications,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Channels", channels.size.toString()),
          SettingsMetric("Connected", channels.count { it.connected }.toString()),
          SettingsMetric("Configured", channels.count { it.configured }.toString()),
          SettingsMetric("Issues", channels.count { it.error != null }.toString()),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (refreshing) "Refreshing" else "Refresh",
        onClick = viewModel::refreshChannels,
        enabled = isConnected && !refreshing,
        modifier = Modifier.weight(1f),
      )
    }
    errorText?.let { error ->
      ClawPanel {
        Text(text = error, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    if (summary.partial || summary.warnings.isNotEmpty()) {
      ClawPanel {
        Text(text = channelsWarningText(summary), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load channels.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      channels.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No channels found.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Telegram, WhatsApp, email, and other channels appear here after setup.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> ChannelsPanel(channels = channels)
    }
  }
}

@Composable
private fun ChannelsPanel(channels: List<GatewayChannelSummary>) {
  ClawListPanel(items = channels) { channel ->
    ChannelRow(channel = channel)
  }
}

@Composable
private fun ChannelRow(channel: GatewayChannelSummary) {
  ClawDetailRow(
    title = channel.label,
    subtitle = channelSubtitle(channel),
    leading = { ClawTextBadge(text = channelBadge(channel.label)) },
    trailing = { ClawStatusPill(text = channelStatusText(channel), status = channelStatus(channel)) },
  )
}

private fun channelSubtitle(channel: GatewayChannelSummary): String {
  val accounts =
    when (channel.accountCount) {
      0 -> null
      1 -> "1 account"
      else -> "${channel.accountCount} accounts"
    }
  val lifecycle =
    when {
      channel.connected -> "Connected"
      channel.running -> "Running"
      channel.linked -> "Linked"
      channel.configured -> "Configured"
      channel.enabled -> "Enabled"
      else -> "Off"
    }
  return listOfNotNull(accounts, lifecycle, channel.error).joinToString(" · ")
}

private fun channelStatusText(channel: GatewayChannelSummary): String =
  when {
    channel.error != null -> "Issue"
    channel.connected -> "Connected"
    channel.running -> "Running"
    channel.linked || channel.configured -> "Ready"
    channel.enabled -> "Setup"
    else -> "Off"
  }

private fun channelStatus(channel: GatewayChannelSummary): ClawStatus =
  when {
    channel.error != null -> ClawStatus.Danger
    channel.connected || channel.running -> ClawStatus.Success
    channel.linked || channel.configured -> ClawStatus.Neutral
    channel.enabled -> ClawStatus.Warning
    else -> ClawStatus.Neutral
  }

private fun channelBadge(label: String): String =
  label
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "C" }

private fun channelsWarningText(summary: GatewayChannelsSummary): String = summary.warnings.firstOrNull()?.takeIf { it.isNotBlank() } ?: "Some channel status checks did not complete."
