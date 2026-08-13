package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.requiresSetup
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

internal enum class ChatRealtimeTalkLaunch {
  RequestPermission,
  ShowSetupMessage,
  StartTalk,
}

/** Resolves the only side effect a Live Talk tap may perform. */
internal fun resolveChatRealtimeTalkLaunch(
  hasMicPermission: Boolean,
  requiresSetup: Boolean,
): ChatRealtimeTalkLaunch =
  when {
    !hasMicPermission -> ChatRealtimeTalkLaunch.RequestPermission
    requiresSetup -> ChatRealtimeTalkLaunch.ShowSetupMessage
    else -> ChatRealtimeTalkLaunch.StartTalk
  }

@Composable
internal fun rememberChatRealtimeTalkLauncher(viewModel: MainViewModel): () -> Unit {
  val context = LocalContext.current
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val currentTalkSetup by rememberUpdatedState(talkSetupReadiness.realtimeTalk)
  val showSetupMessage = {
    Toast
      .makeText(context, gatewayTalkSetupDescription(currentTalkSetup), Toast.LENGTH_LONG)
      .show()
  }
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (!granted) return@rememberLauncherForActivityResult
      if (currentTalkSetup.requiresSetup) {
        showSetupMessage()
      } else {
        viewModel.setTalkModeEnabled(true)
      }
    }

  return {
    when (
      resolveChatRealtimeTalkLaunch(
        hasMicPermission = context.hasRecordAudioPermission(),
        requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,
      )
    ) {
      ChatRealtimeTalkLaunch.RequestPermission -> requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
      ChatRealtimeTalkLaunch.ShowSetupMessage -> showSetupMessage()
      ChatRealtimeTalkLaunch.StartTalk -> viewModel.setTalkModeEnabled(true)
    }
  }
}

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
