package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDreamDiaryEntry
import ai.openclaw.app.GatewayDreamingSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Settings screen for gateway dreaming state and recent dream diary entries. */
@Composable
internal fun DreamingSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val summary by viewModel.dreamingSummary.collectAsState()
  val refreshing by viewModel.dreamingRefreshing.collectAsState()
  val errorText by viewModel.dreamingErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshDreaming()
    }
  }

  SettingsDetailFrame(
    title = "Dreaming",
    subtitle = "Memory consolidation and dream diary.",
    icon = Icons.Default.Storage,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Status", if (summary.enabled) "On" else "Off"),
          SettingsMetric("Waiting", summary.shortTermCount.toString()),
          SettingsMetric("Signals", summary.totalSignalCount.toString()),
          SettingsMetric("Next Cycle", formatDreamingNextRun(summary.nextRunAtMs)),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (refreshing) "Refreshing" else "Refresh",
        onClick = viewModel::refreshDreaming,
        enabled = isConnected && !refreshing,
        modifier = Modifier.weight(1f),
      )
    }
    errorText?.let { error ->
      ClawPanel {
        Text(text = error, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load dreaming.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else -> DreamingPanel(summary = summary)
    }
  }
}

@Composable
private fun DreamingPanel(summary: GatewayDreamingSummary) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
      Column {
        DreamingHealthRow(
          title = "Memory Store",
          value = if (summary.storeHealthy) "Healthy" else "Needs attention",
          healthy = summary.storeHealthy,
        )
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        DreamingHealthRow(
          title = "Signal Index",
          value = if (summary.phaseSignalHealthy) "Healthy" else "Needs attention",
          healthy = summary.phaseSignalHealthy,
        )
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        DreamingHealthRow(
          title = "Promoted",
          value = "${summary.promotedToday} today · ${summary.promotedTotal} total",
          healthy = true,
        )
      }
    }
    DreamDiaryPanel(summary = summary)
  }
}

@Composable
private fun DreamingHealthRow(
  title: String,
  value: String,
  healthy: Boolean,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Box(modifier = Modifier.size(7.dp))
    Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
    ClawStatusPill(text = value, status = if (healthy) ClawStatus.Success else ClawStatus.Warning)
  }
}

@Composable
private fun DreamDiaryPanel(summary: GatewayDreamingSummary) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(text = "DIARY", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    if (!summary.diaryFound) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = "No dream diary yet.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = "Entries appear after a dreaming cycle writes a narrative summary.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
      return
    }
    if (summary.diaryEntries.isEmpty()) {
      ClawPanel {
        Text(text = "The diary is waiting for its first entry.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
      return
    }
    ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
      Column {
        summary.diaryEntries.forEachIndexed { index, entry ->
          DreamDiaryRow(entry = entry)
          if (index != summary.diaryEntries.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
  }
}

@Composable
private fun DreamDiaryRow(entry: GatewayDreamDiaryEntry) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.Top,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Surface(
      modifier = Modifier.size(30.dp),
      shape = CircleShape,
      color = ClawTheme.colors.surfacePressed,
      border = BorderStroke(1.dp, ClawTheme.colors.border),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Text(text = "D", style = ClawTheme.type.label, color = ClawTheme.colors.text)
      }
    }
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = entry.date, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(text = entry.text, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
  }
}

/** Formats the next dreaming cycle as a compact relative label. */
private fun formatDreamingNextRun(nextRunAtMs: Long?): String {
  val next = nextRunAtMs ?: return "Not scheduled"
  val deltaMinutes = ((next - System.currentTimeMillis()) / 60_000L).coerceAtLeast(0L)
  val hours = deltaMinutes / 60L
  return when {
    hours >= 24L -> "In ${hours / 24L}d"
    hours >= 1L -> "In ${hours}h"
    deltaMinutes >= 1L -> "In ${deltaMinutes}m"
    else -> "Soon"
  }
}
