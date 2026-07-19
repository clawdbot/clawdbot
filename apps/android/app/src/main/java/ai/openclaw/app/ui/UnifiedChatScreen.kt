package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.chat.rememberChatRealtimeTalkLauncher
import ai.openclaw.app.ui.design.ClawScaffold
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp

@Composable
internal fun UnifiedChatShellScreen(
  viewModel: MainViewModel,
  onOpenSessions: () -> Unit,
  onOpenGatewaySettings: () -> Unit,
) {
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val startTalk = rememberChatRealtimeTalkLauncher(viewModel)
  LaunchedEffect(viewModel) { viewModel.refreshTalkSetupReadiness() }

  ClawScaffold(
    contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 0.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    ChatScreen(
      viewModel = viewModel,
      talkActive = talkModeEnabled,
      onToggleTalk = {
        if (talkModeEnabled) {
          viewModel.setTalkModeEnabled(false)
        } else {
          startTalk()
        }
      },
      onOpenSessions = onOpenSessions,
      onOpenGatewaySettings = onOpenGatewaySettings,
    )
  }
}
