package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

internal enum class ChatRealtimeTalkLaunch {
  RequestPermission,
  StartTalk,
}

/** The unscoped catalog cannot veto a call for the selected chat; creation validates that target. */
internal fun resolveChatRealtimeTalkLaunch(hasMicPermission: Boolean): ChatRealtimeTalkLaunch = if (hasMicPermission) ChatRealtimeTalkLaunch.StartTalk else ChatRealtimeTalkLaunch.RequestPermission

@Composable
internal fun rememberChatRealtimeTalkLauncher(viewModel: MainViewModel): () -> Unit {
  val context = LocalContext.current
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (granted) viewModel.setTalkModeEnabled(true)
    }

  return {
    when (resolveChatRealtimeTalkLaunch(context.hasRecordAudioPermission())) {
      ChatRealtimeTalkLaunch.RequestPermission -> requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
      ChatRealtimeTalkLaunch.StartTalk -> viewModel.setTalkModeEnabled(true)
    }
  }
}

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
