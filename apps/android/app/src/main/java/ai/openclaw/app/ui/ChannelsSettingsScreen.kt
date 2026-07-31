package ai.openclaw.app.ui

import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.uppercaseFirstGraphemeOrNull
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

/** Settings screen for gateway channel readiness and account status. */
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
    title = nativeString("Channels"),
    subtitle = nativeString("Messaging surfaces connected to this gateway."),
    icon = Icons.Default.Notifications,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Channels"), channels.size.toString()),
          SettingsMetric(nativeString("Connected"), channels.count { it.connected }.toString()),
          SettingsMetric(nativeString("Configured"), channels.count { it.configured }.toString()),
          SettingsMetric(nativeString("Issues"), channels.count { it.error != null }.toString()),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (refreshing) nativeString("Refreshing") else nativeString("Refresh"),
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
      // Partial channel scans still include useful rows; surface the warning
      // without hiding successful channel status.
      ClawPanel {
        Text(text = channelsWarningText(summary), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = nativeString("Connect the gateway to load channels."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      channels.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = nativeString("No channels found."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = nativeString("Telegram, WhatsApp, email, and other channels appear here after setup."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
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
      1 -> nativeString("1 account")
      else -> nativeString("\${channel.accountCount} accounts", channel.accountCount)
    }
  val lifecycle =
    when {
      channel.connected -> nativeString("Connected")
      channel.running -> nativeString("Running")
      channel.linked -> nativeString("Linked")
      channel.configured -> nativeString("Configured")
      channel.enabled -> nativeString("Enabled")
      else -> nativeString("Off")
    }
  return listOfNotNull(accounts, lifecycle, channel.error).joinToString(" · ")
}

private fun channelStatusText(channel: GatewayChannelSummary): String =
  when {
    channel.error != null -> nativeString("Issue")
    channel.connected -> nativeString("Connected")
    channel.running -> nativeString("Running")
    channel.linked || channel.configured -> nativeString("Ready")
    channel.enabled -> nativeString("Setup")
    else -> nativeString("Off")
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
    .mapNotNull { it.uppercaseFirstGraphemeOrNull() }
    .joinToString("")
    .ifBlank { "C" }

/** Chooses the first gateway warning or a generic partial-scan message. */
private fun channelsWarningText(summary: GatewayChannelsSummary): String = summary.warnings.firstOrNull()?.takeIf { it.isNotBlank() } ?: nativeString("Some channel status checks did not complete.")
