package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.chat.rememberChatRealtimeTalkLauncher
import ai.openclaw.app.ui.design.ClawScaffold
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
internal fun UnifiedChatShellScreen(
  viewModel: MainViewModel,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onOpenDashboard: (String) -> Unit,
  onOpenGatewaySettings: () -> Unit,
  onOpenProvidersModels: () -> Unit,
) {
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val talkStatus by viewModel.talkModeStatusText.collectAsState()
  val talkHasFailure by viewModel.talkModeHasFailure.collectAsState()
  val startTalk = rememberChatRealtimeTalkLauncher(viewModel)
  LaunchedEffect(viewModel) { viewModel.refreshTalkSetupReadiness() }

  ClawScaffold(
    contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 0.dp),
    contentWindowInsets = WindowInsets.safeDrawing,
  ) {
    Column(Modifier.fillMaxSize()) {
      TalkStatusRow(enabled = talkModeEnabled, hasFailure = talkHasFailure, status = talkStatus)
      Box(Modifier.weight(1f)) {
        ChatScreen(
          viewModel = viewModel,
          talkActive = talkModeEnabled,
          showSidebarButton = showSidebarButton,
          onOpenSidebar = onOpenSidebar,
          onToggleTalk = {
            if (talkModeEnabled) {
              viewModel.setTalkModeEnabled(false)
            } else {
              startTalk()
            }
          },
          onOpenDashboard = onOpenDashboard,
          onOpenGatewaySettings = onOpenGatewaySettings,
          onOpenProvidersModels = onOpenProvidersModels,
        )
      }
    }
  }
}

/** Failure remains visible after automatic shutdown; normal Off has no status row. */
@Composable
internal fun TalkStatusRow(
  enabled: Boolean,
  hasFailure: Boolean,
  status: String,
) {
  if (enabled || hasFailure) {
    Text(
      text = status,
      style = MaterialTheme.typography.labelSmall,
      color = if (hasFailure) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    )
  }
}
