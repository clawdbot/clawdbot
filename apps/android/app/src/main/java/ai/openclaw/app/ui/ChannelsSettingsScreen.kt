package ai.openclaw.app.ui

import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.uppercaseFirstGraphemeOrNull
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp

/** Settings screen for gateway channel readiness and account status. */
@Composable
internal fun ChannelsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val state by viewModel.channelsState.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

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
    SettingsRefreshControls(isConnected, state.refreshing, state.errorText, viewModel::refreshChannels)
    SettingsSummaryContent(state, isConnected, nativeString("Connect the gateway to load channels.")) { summary ->
      val channels = summary.channels
      SettingsMetricPanel(
        rows =
          listOf(
            SettingsMetric(nativeString("Channels"), channels.size.toString()),
            SettingsMetric(nativeString("Connected"), channels.count { it.connected }.toString()),
            SettingsMetric(nativeString("Configured"), channels.count { it.configured }.toString()),
            SettingsMetric(nativeString("Issues"), channels.count { it.error != null }.toString()),
          ),
      )
      if (summary.partial || summary.warnings.isNotEmpty()) {
        // Partial scans still contain useful rows; keep them visible beside the warning.
        ClawPanel {
          Text(text = channelsWarningText(summary), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
      if (channels.isEmpty()) {
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = nativeString("No channels found."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = nativeString("Telegram, WhatsApp, email, and other channels appear here after setup."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      } else {
        ClawListPanel(items = channels) { channel -> ChannelRow(channel) }
      }
    }
  }
}

@Composable
private fun ChannelRow(channel: GatewayChannelSummary) {
  ClawListItem(
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
