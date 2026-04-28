package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.voice.VoiceConversationEntry
import ai.openclaw.app.voice.VoiceConversationRole
import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlin.math.max

@Composable
fun VoiceTabScreen(viewModel: MainViewModel) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val activity = remember(context) { context.findActivity() }
  val listState = rememberLazyListState()

  val gatewayStatus by viewModel.statusText.collectAsState()
  val voiceCaptureMode by viewModel.voiceCaptureMode.collectAsState()
  val micEnabled by viewModel.micEnabled.collectAsState()
  val micCooldown by viewModel.micCooldown.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val micStatusText by viewModel.micStatusText.collectAsState()
  val micLiveTranscript by viewModel.micLiveTranscript.collectAsState()
  val micQueuedMessages by viewModel.micQueuedMessages.collectAsState()
  val micConversation by viewModel.micConversation.collectAsState()
  val micInputLevel by viewModel.micInputLevel.collectAsState()
  val micIsSending by viewModel.micIsSending.collectAsState()
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val talkModeListening by viewModel.talkModeListening.collectAsState()
  val talkModeSpeaking by viewModel.talkModeSpeaking.collectAsState()

  val hasStreamingAssistant = micConversation.any { it.role == VoiceConversationRole.Assistant && it.isStreaming }
  val showThinkingBubble = micIsSending && !hasStreamingAssistant

  var hasMicPermission by remember { mutableStateOf(context.hasRecordAudioPermission()) }
  var pendingVoicePermissionAction by remember { mutableStateOf<PendingVoicePermissionAction?>(null) }

  DisposableEffect(lifecycleOwner, context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          hasMicPermission = context.hasRecordAudioPermission()
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
      // Manual mic is tied to the Voice tab; Talk Mode is explicit and can continue.
      viewModel.setVoiceScreenActive(false)
    }
  }

  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      hasMicPermission = granted
      if (granted) {
        when (pendingVoicePermissionAction) {
          PendingVoicePermissionAction.ManualMic -> viewModel.setMicEnabled(true)
          PendingVoicePermissionAction.TalkMode -> viewModel.setTalkModeEnabled(true)
          null -> Unit
        }
      }
      pendingVoicePermissionAction = null
    }

  LaunchedEffect(micConversation.size, showThinkingBubble) {
    val total = micConversation.size + if (showThinkingBubble) 1 else 0
    if (total > 0) {
      listState.animateScrollToItem(total - 1)
    }
  }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(mobileBackgroundGradient)
        .imePadding()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
        .padding(horizontal = 20.dp, vertical = 14.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxWidth().weight(1f),
      contentPadding = PaddingValues(vertical = 4.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      if (micConversation.isEmpty() && !showThinkingBubble) {
        item {
          Box(
            modifier = Modifier.fillParentMaxHeight().fillMaxWidth(),
            contentAlignment = Alignment.Center,
          ) {
            Column(
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              Icon(
                imageVector = Icons.Default.Mic,
                contentDescription = null,
                modifier = Modifier.size(48.dp),
                tint = mobileTextTertiary,
              )
              Text(
                "Tap mic or Talk",
                style = mobileHeadline,
                color = mobileTextSecondary,
              )
              Text(
                "Mic sends turns; Talk keeps the conversation open.",
                style = mobileCallout,
                color = mobileTextTertiary,
              )
            }
          }
        }
      }

      items(items = micConversation, key = { it.id }) { entry ->
        VoiceTurnBubble(entry = entry)
      }

      if (showThinkingBubble) {
        item {
          VoiceThinkingBubble()
        }
      }
    }

    Column(
      modifier = Modifier.fillMaxWidth(),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      if (!micLiveTranscript.isNullOrBlank()) {
        Surface(
          modifier = Modifier.fillMaxWidth(),
          shape = RoundedCornerShape(14.dp),
          color = mobileAccentSoft,
          border = BorderStroke(1.dp, mobileAccent.copy(alpha = 0.2f)),
        ) {
          Text(
            micLiveTranscript!!.trim(),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            style = mobileCallout,
            color = mobileText,
          )
        }
      }

      // Mic button with input-reactive ring + speaker toggle
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        // Speaker toggle
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
          IconButton(
            onClick = { viewModel.setSpeakerEnabled(!speakerEnabled) },
            modifier = Modifier.size(48.dp),
            colors =
              IconButtonDefaults.iconButtonColors(
                containerColor = if (speakerEnabled) mobileSurface else mobileDangerSoft,
              ),
          ) {
            Icon(
              imageVector = if (speakerEnabled) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
              contentDescription = if (speakerEnabled) "Mute speaker" else "Unmute speaker",
              modifier = Modifier.size(22.dp),
              tint = if (speakerEnabled) mobileTextSecondary else mobileDanger,
            )
          }
          Text(
            if (speakerEnabled) "Speaker" else "Muted",
            style = mobileCaption2,
            color = if (speakerEnabled) mobileTextTertiary else mobileDanger,
          )
        }

        // Ring size = 68dp base + up to 22dp driven by mic input level.
        // The outer Box is fixed at 90dp (max ring size) so the ring never shifts the button.
        Box(
          modifier = Modifier.padding(horizontal = 16.dp).size(90.dp),
          contentAlignment = Alignment.Center,
        ) {
          if (micEnabled) {
            val ringLevel = micInputLevel.coerceIn(0f, 1f)
            val ringSize = 68.dp + (22.dp * max(ringLevel, 0.05f))
            Box(
              modifier =
                Modifier
                  .size(ringSize)
                  .background(mobileAccent.copy(alpha = 0.12f + 0.14f * ringLevel), CircleShape),
            )
          }
          Button(
            onClick = {
              if (micCooldown) return@Button
              if (micEnabled) {
                viewModel.setMicEnabled(false)
                return@Button
              }
              if (hasMicPermission) {
                viewModel.setMicEnabled(true)
              } else {
                pendingVoicePermissionAction = PendingVoicePermissionAction.ManualMic
                requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
              }
            },
            enabled = !micCooldown,
            shape = CircleShape,
            contentPadding = PaddingValues(0.dp),
            modifier = Modifier.size(60.dp),
            colors =
              ButtonDefaults.buttonColors(
                containerColor =
                  if (micCooldown) {
                    mobileTextSecondary
                  } else if (micEnabled) {
                    mobileDanger
                  } else {
                    mobileAccent
                  },
                contentColor = Color.White,
                disabledContainerColor = mobileTextSecondary,
                disabledContentColor = Color.White.copy(alpha = 0.5f),
              ),
          ) {
            Icon(
              imageVector = if (micEnabled) Icons.Default.MicOff else Icons.Default.Mic,
              contentDescription = if (micEnabled) "Turn microphone off" else "Turn microphone on",
              modifier = Modifier.size(24.dp),
            )
          }
        }

        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
          IconButton(
            onClick = {
              if (talkModeEnabled) {
                viewModel.setTalkModeEnabled(false)
                return@IconButton
              }
              if (hasMicPermission) {
                viewModel.setTalkModeEnabled(true)
              } else {
                pendingVoicePermissionAction = PendingVoicePermissionAction.TalkMode
                requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
              }
            },
            modifier = Modifier.size(48.dp),
            colors =
              IconButtonDefaults.iconButtonColors(
                containerColor = if (talkModeEnabled) mobileSuccessSoft else mobileSurface,
              ),
          ) {
            Icon(
              imageVector = Icons.Default.RecordVoiceOver,
              contentDescription = if (talkModeEnabled) "Turn Talk Mode off" else "Turn Talk Mode on",
              modifier = Modifier.size(22.dp),
              tint = if (talkModeEnabled) mobileSuccess else mobileTextSecondary,
            )
          }
          Spacer(modifier = Modifier.height(4.dp))
          Text(
            if (talkModeEnabled) "Talk on" else "Talk",
            style = mobileCaption2,
            color = if (talkModeEnabled) mobileSuccess else mobileTextTertiary,
          )
        }
      }

      // Status + labels
      val queueCount = micQueuedMessages.size
      val stateText =
        when {
          voiceCaptureMode == VoiceCaptureMode.TalkMode && talkModeSpeaking -> "Talk speaking"
          voiceCaptureMode == VoiceCaptureMode.TalkMode && talkModeListening -> "Talk listening"
          voiceCaptureMode == VoiceCaptureMode.TalkMode -> "Talk on"
          queueCount > 0 -> "$queueCount queued"
          micIsSending -> "Sending"
          micCooldown -> "Cooldown"
          micEnabled -> "Listening"
          else -> "Mic off"
        }
      val stateColor =
        when {
          voiceCaptureMode == VoiceCaptureMode.TalkMode -> mobileSuccess
          micEnabled -> mobileSuccess
          micIsSending -> mobileAccent
          else -> mobileTextSecondary
        }
      Surface(
        shape = RoundedCornerShape(999.dp),
        color = if (micEnabled || talkModeEnabled) mobileSuccessSoft else mobileSurface,
        border = BorderStroke(1.dp, if (micEnabled || talkModeEnabled) mobileSuccess.copy(alpha = 0.3f) else mobileBorder),
      ) {
        Text(
          "$gatewayStatus · $stateText",
          style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
          color = stateColor,
          modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
        )
      }

      if (!hasMicPermission) {
        val showRationale =
          if (activity == null) {
            false
          } else {
            ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.RECORD_AUDIO)
          }
        Text(
          if (showRationale) {
            "Microphone permission is required for voice mode."
          } else {
            "Microphone blocked. Open app settings to enable it."
          },
          style = mobileCaption1,
          color = mobileWarning,
          textAlign = TextAlign.Center,
        )
        Button(
          onClick = { openAppSettings(context) },
          shape = RoundedCornerShape(12.dp),
          colors = ButtonDefaults.buttonColors(containerColor = mobileSurfaceStrong, contentColor = mobileText),
        ) {
          Text("Open settings", style = mobileCallout.copy(fontWeight = FontWeight.SemiBold))
        }
      }
    }
  }
}

private enum class PendingVoicePermissionAction {
  ManualMic,
  TalkMode,
}

@Composable
private fun VoiceTurnBubble(entry: VoiceConversationEntry) {
  val isUser = entry.role == VoiceConversationRole.User
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth(0.90f),
      shape = RoundedCornerShape(12.dp),
      color = if (isUser) mobileAccentSoft else mobileCardSurface,
      border = BorderStroke(1.dp, if (isUser) mobileAccent else mobileBorderStrong),
    ) {
      Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
      ) {
        Text(
          if (isUser) "You" else "OpenClaw",
          style = mobileCaption2.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
          color = if (isUser) mobileAccent else mobileTextSecondary,
        )
        Text(
          if (entry.isStreaming && entry.text.isBlank()) "Listening response…" else entry.text,
          style = mobileCallout,
          color = mobileText,
        )
      }
    }
  }
}

@Composable
private fun VoiceThinkingBubble() {
  Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
    Surface(
      modifier = Modifier.fillMaxWidth(0.68f),
      shape = RoundedCornerShape(12.dp),
      color = mobileCardSurface,
      border = BorderStroke(1.dp, mobileBorderStrong),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        ThinkingDots(color = mobileTextSecondary)
        Text("OpenClaw is thinking…", style = mobileCallout, color = mobileTextSecondary)
      }
    }
  }
}

@Composable
private fun ThinkingDots(color: Color) {
  Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
    ThinkingDot(alpha = 0.38f, color = color)
    ThinkingDot(alpha = 0.62f, color = color)
    ThinkingDot(alpha = 0.90f, color = color)
  }
}

@Composable
private fun ThinkingDot(
  alpha: Float,
  color: Color,
) {
  Surface(
    modifier = Modifier.size(6.dp).alpha(alpha),
    shape = CircleShape,
    color = color,
  ) {}
}

private fun Context.hasRecordAudioPermission(): Boolean =
  (
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  )

private fun Context.findActivity(): Activity? =
  when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
  }

private fun openAppSettings(context: Context) {
  val intent =
    Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", context.packageName, null),
    )
  context.startActivity(intent)
}
