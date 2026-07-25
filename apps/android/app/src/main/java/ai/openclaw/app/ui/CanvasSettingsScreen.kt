package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material3.Icon
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

/** Settings detail surface for live canvas status, refresh, and presentation. */
@Composable
internal fun CanvasSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val currentUrl by viewModel.canvasCurrentUrl.collectAsState()
  val hydrated by viewModel.canvasA2uiHydrated.collectAsState()
  val rehydratePending by viewModel.canvasRehydratePending.collectAsState()
  val rehydrateErrorText by viewModel.canvasRehydrateErrorText.collectAsState()
  val hasLivePage = currentUrl?.isNotBlank() == true
  val canvasLabel = if (hasLivePage) nativeString("Live page") else nativeString("Home canvas")

  LaunchedEffect(isConnected) {
    if (isConnected) {
      // Refresh once when the gateway comes online so current Canvas status is
      // populated before the user manually asks for a rehydrate.
      viewModel.refreshHomeCanvasOverviewIfConnected()
    }
  }

  SettingsDetailFrame(
    title = nativeString("Canvas"),
    subtitle = nativeString("Current screen output and interactive app surface."),
    icon = Icons.AutoMirrored.Filled.ScreenShare,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Connection"), if (isConnected) nativeString("Online") else nativeString("Offline")),
          SettingsMetric(nativeString("Surface"), canvasLabel),
          SettingsMetric(nativeString("Bridge"), if (hasLivePage && hydrated) nativeString("Ready") else nativeString("Standby")),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawPrimaryButton(
        text = if (rehydratePending) nativeString("Refreshing") else nativeString("Refresh Screen"),
        onClick = { viewModel.requestCanvasRehydrate(source = "settings_canvas") },
        enabled = isConnected && !rehydratePending,
        modifier = Modifier.weight(1f),
      )
      ClawSecondaryButton(
        text = if (isConnected) nativeString("Open Screen") else nativeString("Reconnect"),
        onClick = if (isConnected) viewModel::showCanvas else viewModel::refreshGatewayConnection,
        modifier = Modifier.weight(1f),
      )
    }
    rehydrateErrorText?.let {
      ClawPanel {
        Text(text = it, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    ClawPanel(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)) {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text = canvasLabel, style = ClawTheme.type.section, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        CanvasStandbyPanel(isConnected = isConnected)
      }
    }
  }
}

@Composable
private fun CanvasStandbyPanel(isConnected: Boolean) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 28.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Surface(
      modifier = Modifier.size(54.dp),
      shape = RoundedCornerShape(ClawTheme.radii.panel),
      color = ClawTheme.colors.surfacePressed,
      border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      contentColor = ClawTheme.colors.text,
    ) {
      Box(contentAlignment = Alignment.Center) {
        Icon(imageVector = Icons.AutoMirrored.Filled.ScreenShare, contentDescription = null, modifier = Modifier.size(26.dp))
      }
    }
    Text(
      text = if (isConnected) nativeString("Screen surface ready") else nativeString("Connect the gateway"),
      style = ClawTheme.type.title,
      color = ClawTheme.colors.text,
      modifier = Modifier.padding(top = 18.dp),
    )
    Text(
      text = if (isConnected) nativeString("Open the current Canvas surface to inspect or interact with it.") else nativeString("Canvas output needs an active gateway connection."),
      style = ClawTheme.type.body,
      color = ClawTheme.colors.textMuted,
      modifier = Modifier.padding(top = 6.dp),
    )
  }
}
