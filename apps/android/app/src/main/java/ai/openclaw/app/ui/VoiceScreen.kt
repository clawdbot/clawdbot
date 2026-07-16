package ai.openclaw.app.ui

import ai.openclaw.app.GatewayTalkSetupReadiness
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.isReady
import ai.openclaw.app.requiresSetup
import ai.openclaw.app.takeUtf16Safe
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.TalkWaveform
import ai.openclaw.app.ui.design.TalkWaveformPalette
import ai.openclaw.app.ui.design.TalkWaveformPhase
import ai.openclaw.app.voice.VoiceConversationEntry
import ai.openclaw.app.voice.VoiceConversationRole
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PhoneDisabled
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat

/** Voice home screen that routes between talk mode, dictation, and idle setup. */
@Composable
fun VoiceScreen(
  viewModel: MainViewModel,
  onOpenCommand: () -> Unit,
  onOpenGatewaySettings: () -> Unit,
  onOpenVoiceSettings: () -> Unit,
) {
  val context = LocalContext.current
  val gatewayStatus by viewModel.statusText.collectAsState()
  val voiceCaptureMode by viewModel.voiceCaptureMode.collectAsState()
  val micEnabled by viewModel.micEnabled.collectAsState()
  val micCooldown by viewModel.micCooldown.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val micStatusText by viewModel.micStatusText.collectAsState()
  val micLiveTranscript by viewModel.micLiveTranscript.collectAsState()
  val micQueuedMessages by viewModel.micQueuedMessages.collectAsState()
  val micConversation by viewModel.micConversation.collectAsState()
  val micIsSending by viewModel.micIsSending.collectAsState()
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val talkModeListening by viewModel.talkModeListening.collectAsState()
  val talkModeSpeaking by viewModel.talkModeSpeaking.collectAsState()
  val talkModeStatusText by viewModel.talkModeStatusText.collectAsState()
  val talkModeConversation by viewModel.talkModeConversation.collectAsState()
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val micInputLevel by viewModel.micInputLevel.collectAsState()
  val talkInputLevel by viewModel.talkInputLevel.collectAsState()
  val talkOutputLevel by viewModel.talkOutputLevel.collectAsState()
  val talkSpeechActive by viewModel.talkSpeechActive.collectAsState()
  val talkAwaitingAgent by viewModel.talkAwaitingAgent.collectAsState()

  var pendingAction by remember { mutableStateOf<VoiceAction?>(null) }
  var hasMicPermission by remember { mutableStateOf(context.hasRecordAudioPermission()) }
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      hasMicPermission = granted
      if (granted) {
        // Gateway readiness can change while the system permission dialog is open.
        when (pendingAction) {
          VoiceAction.Talk ->
            if (talkSetupReadiness.realtimeTalk.requiresSetup) {
              onOpenVoiceSettings()
            } else {
              viewModel.setTalkModeEnabled(true)
            }
          VoiceAction.Dictation ->
            if (talkSetupReadiness.dictation.requiresSetup) {
              onOpenVoiceSettings()
            } else {
              viewModel.setMicEnabled(true)
            }
          null -> Unit
        }
      }
      pendingAction = null
    }

  // Talk mode and dictation use different managers, so choose the transcript
  // from the mode the user is actually seeing.
  val activeConversation = if (voiceCaptureMode == VoiceCaptureMode.TalkMode) talkModeConversation else micConversation
  val showTranscriptThinking =
    micIsSending && activeConversation.none { it.role == VoiceConversationRole.Assistant && it.isStreaming }
  val voiceActive = micEnabled || micIsSending || talkModeEnabled
  val gatewayReady = gatewayStatus.isVoiceGatewayReady()
  val voiceAttentionStatus =
    voiceAttentionStatus(
      talkModeStatusText = talkModeStatusText,
      voiceCaptureMode = voiceCaptureMode,
      micEnabled = micEnabled,
      micIsSending = micIsSending,
      talkModeEnabled = talkModeEnabled,
      talkModeListening = talkModeListening,
      talkModeSpeaking = talkModeSpeaking,
    )
  val activeStatus =
    voiceStatusLabel(
      gatewayStatus = gatewayStatus,
      voiceCaptureMode = voiceCaptureMode,
      micStatusText = micStatusText,
      micQueuedMessages = micQueuedMessages.size,
      micIsSending = micIsSending,
      talkModeListening = talkModeListening,
      talkModeSpeaking = talkModeSpeaking,
      voiceAttentionStatus = voiceAttentionStatus,
    )

  if (talkModeEnabled) {
    TalkSessionScreen(
      entries = talkModeConversation,
      listening = talkModeListening,
      speaking = talkModeSpeaking,
      statusText = talkModeStatusText,
      awaitingAgent = talkAwaitingAgent,
      inputLevel = talkInputLevel,
      outputLevel = talkOutputLevel,
      speechActive = talkSpeechActive,
      speakerEnabled = speakerEnabled,
      onToggleSpeaker = { viewModel.setSpeakerEnabled(!speakerEnabled) },
      onEndTalk = { viewModel.setTalkModeEnabled(false) },
      onOpenVoiceSettings = onOpenVoiceSettings,
    )
    return
  }

  if (voiceCaptureMode == VoiceCaptureMode.ManualMic || micEnabled || micIsSending) {
    // Manual mic mode owns the whole screen while a turn is being captured or
    // delivered, even after the user releases the mic.
    DictationScreen(
      liveTranscript = micLiveTranscript,
      conversation = micConversation,
      listening = micEnabled,
      sending = micIsSending,
      inputLevel = micInputLevel,
      statusText = activeStatus,
      gatewayStatus = gatewayStatus,
      onCancel = { viewModel.cancelMicCapture() },
      onSend = { viewModel.setMicEnabled(false) },
      onOpenVoiceSettings = onOpenVoiceSettings,
    )
    return
  }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .imePadding()
        .padding(horizontal = 16.dp, vertical = 10.dp),
    verticalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    VoiceHeader(
      statusText = voiceAttentionStatus ?: if (voiceActive || !gatewayReady) activeStatus else nativeString("Your voice command center."),
      speakerEnabled = speakerEnabled,
      onToggleSpeaker = { viewModel.setSpeakerEnabled(!speakerEnabled) },
      onOpenCommand = onOpenCommand,
    )

    VoiceHero(
      gatewayStatus = gatewayStatus,
      micEnabled = micEnabled,
      talkModeEnabled = talkModeEnabled,
      talkModeListening = talkModeListening,
      talkModeSpeaking = talkModeSpeaking,
      orbPhase =
        voiceHeroWaveformPhase(
          micEnabled = micEnabled,
          micInputLevel = micInputLevel,
          talkModeEnabled = talkModeEnabled,
          talkModeListening = talkModeListening,
          talkModeSpeaking = talkModeSpeaking,
          talkInputLevel = talkInputLevel,
          talkOutputLevel = talkOutputLevel,
          talkSpeechActive = talkSpeechActive,
        ),
      micLiveTranscript = micLiveTranscript,
      gatewayReady = gatewayReady,
      voiceAttentionStatus = voiceAttentionStatus,
      talkSetupReadiness = talkSetupReadiness,
      onStartTalk = {
        runVoiceAction(
          action = VoiceAction.Talk,
          hasMicPermission = hasMicPermission,
          requestPermission = {
            pendingAction = VoiceAction.Talk
            requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
          },
          run = { viewModel.setTalkModeEnabled(!talkModeEnabled) },
        )
      },
      onStartDictation = {
        if (micCooldown) return@VoiceHero
        runVoiceAction(
          action = VoiceAction.Dictation,
          hasMicPermission = hasMicPermission,
          requestPermission = {
            pendingAction = VoiceAction.Dictation
            requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
          },
          run = { viewModel.setMicEnabled(!micEnabled) },
        )
      },
      onConnectGateway = onOpenGatewaySettings,
      onOpenVoiceSettings = onOpenVoiceSettings,
    )

    if (!hasMicPermission) {
      VoicePermissionPanel(
        onRequestPermission = {
          pendingAction = null
          requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
        },
      )
    }

    if (activeConversation.isNotEmpty() || showTranscriptThinking) {
      VoiceTranscript(
        entries = activeConversation,
        showThinking = showTranscriptThinking,
        modifier = Modifier.weight(1f),
      )
    }
  }
}

/** Full-screen dictation capture and send state. */
@Composable
private fun DictationScreen(
  liveTranscript: String?,
  conversation: List<VoiceConversationEntry>,
  listening: Boolean,
  sending: Boolean,
  inputLevel: Float,
  statusText: String,
  gatewayStatus: String,
  onCancel: () -> Unit,
  onSend: () -> Unit,
  onOpenVoiceSettings: () -> Unit,
) {
  val lastUserText = conversation.lastOrNull { it.role == VoiceConversationRole.User }?.text
  val draftText = liveTranscript?.takeIf { it.isNotBlank() } ?: lastUserText.orEmpty()
  val providerAttentionStatus = voiceRuntimeAttentionStatus(statusText)
  val displayStatusText = providerAttentionStatus ?: statusText
  val speechProviderReady = providerAttentionStatus == null && gatewayStatus.isVoiceGatewayReady()
  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .imePadding()
        .padding(horizontal = 20.dp, vertical = 8.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
      ClawPlainIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back to voice"), onClick = onCancel)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = nativeString("Dictation"), style = ClawTheme.type.title.copy(fontSize = 16.sp, lineHeight = 20.sp), color = ClawTheme.colors.text)
        Text(text = nativeString("Transcribe then send"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
      ClawPlainIconButton(icon = Icons.Default.Settings, contentDescription = nativeString("Dictation settings"), onClick = onOpenVoiceSettings)
    }

    Surface(
      modifier = Modifier.fillMaxWidth().aspectRatio(0.82f),
      shape = RoundedCornerShape(ClawTheme.radii.panel),
      color = ClawTheme.colors.canvas,
      border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
    ) {
      Column(modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 12.dp), verticalArrangement = Arrangement.SpaceBetween) {
        Text(
          text = draftText.ifBlank { if (sending) nativeString("Sending to chat...") else nativeString("Start speaking...") },
          style = ClawTheme.type.title.copy(fontSize = 15.sp, lineHeight = 19.sp),
          color = if (draftText.isBlank()) ClawTheme.colors.textSubtle else ClawTheme.colors.text,
          maxLines = 7,
          overflow = TextOverflow.Ellipsis,
        )
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
          TalkWaveform(
            phase = TalkWaveformPhase.Listening(level = inputLevel, speechActive = false),
            modifier = Modifier.fillMaxWidth().height(56.dp),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(imageVector = Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(15.dp), tint = if (listening) ClawTheme.colors.success else ClawTheme.colors.textMuted)
            Text(text = displayStatusText, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      }
    }

    ClawPanel(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Surface(
          modifier = Modifier.size(30.dp),
          shape = CircleShape,
          color = ClawTheme.colors.surfacePressed,
          border = BorderStroke(1.dp, ClawTheme.colors.border),
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(imageVector = Icons.Default.GraphicEq, contentDescription = null, modifier = Modifier.size(16.dp), tint = ClawTheme.colors.text)
          }
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(text = nativeString("Speech provider"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(
            text = providerAttentionStatus ?: gatewayStatus.voiceGatewayLabel(),
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(
            text =
              when {
                sending -> nativeString("Sending")
                providerAttentionStatus != null -> nativeString("Attention")
                speechProviderReady -> nativeString("Ready")
                else -> nativeString("Offline")
              },
            style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
            color =
              when {
                sending -> ClawTheme.colors.warning
                providerAttentionStatus != null -> ClawTheme.colors.warning
                speechProviderReady -> ClawTheme.colors.success
                else -> ClawTheme.colors.textMuted
              },
          )
          Box(
            modifier =
              Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(
                  when {
                    sending -> ClawTheme.colors.warning
                    providerAttentionStatus != null -> ClawTheme.colors.warning
                    speechProviderReady -> ClawTheme.colors.success
                    else -> ClawTheme.colors.textSubtle
                  },
                ),
          )
        }
      }
    }

    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Icon(imageVector = Icons.Default.Info, contentDescription = null, modifier = Modifier.size(16.dp), tint = ClawTheme.colors.textMuted)
      Text(
        text = nativeString("Tip: stop listening to send the captured turn."),
        modifier = Modifier.weight(1f),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
    }

    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      ClawSecondaryButton(text = nativeString("Cancel"), icon = Icons.Default.Close, onClick = onCancel, modifier = Modifier.weight(0.95f))
      ClawPrimaryButton(text = if (sending) nativeString("Sending") else nativeString("Send to Chat"), icon = Icons.AutoMirrored.Filled.Send, onClick = onSend, enabled = !sending, modifier = Modifier.weight(1.25f))
    }
  }
}

@Composable
private fun TalkSessionScreen(
  entries: List<VoiceConversationEntry>,
  listening: Boolean,
  speaking: Boolean,
  statusText: String,
  awaitingAgent: Boolean,
  inputLevel: Float,
  outputLevel: Float?,
  speechActive: Boolean,
  speakerEnabled: Boolean,
  onToggleSpeaker: () -> Unit,
  onEndTalk: () -> Unit,
  onOpenVoiceSettings: () -> Unit,
) {
  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .imePadding()
        .padding(horizontal = 20.dp, vertical = 8.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      ClawPlainIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back to voice"), onClick = onEndTalk)
      Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(text = nativeString("Realtime Talk"), style = ClawTheme.type.title.copy(fontSize = 16.sp, lineHeight = 20.sp), color = ClawTheme.colors.text)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (speaking || listening) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
          Text(
            text =
              if (speaking) {
                nativeString("OpenClaw speaking")
              } else if (listening) {
                nativeString("Realtime voice")
              } else {
                nativeString("Connected")
              },
            style = ClawTheme.type.body,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
      ClawPlainIconButton(icon = Icons.Default.Info, contentDescription = nativeString("Talk settings"), onClick = onOpenVoiceSettings)
    }

    Surface(
      modifier = Modifier.fillMaxWidth().height(52.dp),
      shape = RoundedCornerShape(ClawTheme.radii.panel),
      color = ClawTheme.colors.canvas,
      border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
    ) {
      TalkWaveform(
        phase =
          talkSessionWaveformPhase(
            speaking = speaking,
            listening = listening,
            awaitingAgent = awaitingAgent,
            inputLevel = inputLevel,
            speechActive = speechActive,
            outputLevel = outputLevel,
          ),
        modifier = Modifier.fillMaxSize(),
      )
    }

    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(text = nativeString("Live transcript"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      TalkTranscript(entries = entries, modifier = Modifier.weight(1f))
    }

    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      TalkControl(
        icon = if (speakerEnabled) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
        label = if (speakerEnabled) nativeString("Mute") else nativeString("Unmute"),
        modifier = Modifier.weight(1f),
        onClick = onToggleSpeaker,
      )
      TalkControl(
        icon = Icons.Default.PhoneDisabled,
        label = nativeString("End"),
        primary = true,
        modifier = Modifier.weight(1f),
        onClick = onEndTalk,
      )
      TalkControl(
        icon = Icons.Default.GraphicEq,
        label = nativeString("Voice"),
        modifier = Modifier.weight(1f),
        onClick = onOpenVoiceSettings,
      )
    }
  }
}

@Composable
private fun TalkTranscript(
  entries: List<VoiceConversationEntry>,
  modifier: Modifier = Modifier,
) {
  LazyColumn(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    if (entries.isEmpty()) {
      item {
        TalkTranscriptCard(label = nativeString("OpenClaw"), text = nativeString("Listening for your next turn."), muted = true)
      }
    } else {
      items(entries.takeLast(6), key = { it.id }) { entry ->
        TalkTranscriptCard(
          label = if (entry.role == VoiceConversationRole.User) nativeString("You") else nativeString("OpenClaw"),
          text =
            if (entry.isStreaming && entry.text.isBlank()) {
              nativeString("Listening response...")
            } else {
              entry.localizedSource?.let(::nativeString) ?: entry.text
            },
          muted = entry.isStreaming,
        )
      }
    }
  }
}

@Composable
private fun TalkTranscriptCard(
  label: String,
  text: String,
  muted: Boolean = false,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
      Text(text = label, style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = text, style = ClawTheme.type.body, color = if (muted) ClawTheme.colors.textMuted else ClawTheme.colors.text)
    }
  }
}

@Composable
private fun TalkControl(
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  label: String,
  modifier: Modifier = Modifier,
  primary: Boolean = false,
  onClick: () -> Unit,
) {
  Column(
    modifier = modifier,
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(5.dp),
  ) {
    Surface(
      onClick = onClick,
      modifier = Modifier.size(ClawTheme.spacing.touchTarget),
      shape = RoundedCornerShape(ClawTheme.radii.button),
      color = if (primary) ClawTheme.colors.primary else ClawTheme.colors.canvas,
      contentColor = if (primary) ClawTheme.colors.primaryText else ClawTheme.colors.text,
      border = BorderStroke(1.dp, if (primary) ClawTheme.colors.primary else ClawTheme.colors.border),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Icon(imageVector = icon, contentDescription = label, modifier = Modifier.size(if (primary) 20.dp else 18.dp))
      }
    }
    Text(
      text = label,
      modifier = Modifier.fillMaxWidth(),
      style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
      color = ClawTheme.colors.textMuted,
      textAlign = TextAlign.Center,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun VoiceHeader(
  statusText: String,
  speakerEnabled: Boolean,
  onToggleSpeaker: () -> Unit,
  onOpenCommand: () -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      OpenClawMascot(modifier = Modifier.size(25.dp))
      Text(
        text = nativeString("OpenClaw"),
        style = ClawTheme.type.title.copy(fontSize = 17.sp, lineHeight = 21.sp),
        color = ClawTheme.colors.text,
        modifier = Modifier.weight(1f),
      )
      ClawPlainIconButton(icon = Icons.Default.Search, contentDescription = nativeString("Search voice"), onClick = onOpenCommand)
    }
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(text = nativeString("Voice"), style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp), color = ClawTheme.colors.text)
        Text(
          text = statusText,
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      ClawPlainIconButton(
        icon = if (speakerEnabled) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
        contentDescription = if (speakerEnabled) nativeString("Mute speaker") else nativeString("Unmute speaker"),
        onClick = onToggleSpeaker,
      )
    }
  }
}

@Composable
private fun VoiceHero(
  gatewayStatus: String,
  micEnabled: Boolean,
  talkModeEnabled: Boolean,
  talkModeListening: Boolean,
  talkModeSpeaking: Boolean,
  orbPhase: TalkWaveformPhase,
  micLiveTranscript: String?,
  gatewayReady: Boolean,
  voiceAttentionStatus: String?,
  talkSetupReadiness: GatewayTalkSetupReadiness,
  onStartTalk: () -> Unit,
  onStartDictation: () -> Unit,
  onConnectGateway: () -> Unit,
  onOpenVoiceSettings: () -> Unit,
) {
  val talkNeedsSetup = gatewayReady && talkSetupReadiness.realtimeTalk.requiresSetup
  val dictationNeedsSetup = gatewayReady && talkSetupReadiness.dictation.requiresSetup
  Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(9.dp)) {
    VoiceOrb(phase = orbPhase)

    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
      Box(
        modifier =
          Modifier
            .size(7.dp)
            .clip(CircleShape)
            .background(if (micEnabled || talkModeEnabled) ClawTheme.colors.success else ClawTheme.colors.textSubtle),
      )
      Text(
        text =
          when {
            voiceAttentionStatus != null -> voiceAttentionStatus
            talkModeSpeaking -> nativeString("OpenClaw is replying")
            talkModeListening -> nativeString("Listening")
            talkModeEnabled -> nativeString("Talk is live")
            micEnabled -> nativeString("Dictation is listening")
            !gatewayReady -> nativeString("Gateway offline")
            else -> nativeString("Ready to talk")
          },
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
        modifier = Modifier.weight(1f, fill = false),
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }

    if (!micLiveTranscript.isNullOrBlank()) {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(ClawTheme.radii.panel),
        color = ClawTheme.colors.surface,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Text(
          text = micLiveTranscript.trim(),
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
        )
      }
    }

    ClawPanel(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
      VoiceModeRow(
        title = if (talkModeEnabled) nativeString("End Talk") else nativeString("Realtime Talk"),
        subtitle =
          when {
            talkModeEnabled -> nativeString("Conversation is live")
            gatewayReady -> gatewayTalkSetupDescription(talkSetupReadiness.realtimeTalk)
            else -> nativeString("Connect gateway to start")
          },
        icon = if (talkModeEnabled) Icons.Default.PhoneDisabled else Icons.Default.RecordVoiceOver,
        onClick = if (talkNeedsSetup) onOpenVoiceSettings else onStartTalk,
        enabled = gatewayReady || talkModeEnabled,
      )
      VoiceModeRow(
        title = if (micEnabled) nativeString("Stop Dictation") else nativeString("Dictation"),
        subtitle =
          when {
            micEnabled -> nativeString("Listening for one turn")
            gatewayReady -> gatewayTalkSetupDescription(talkSetupReadiness.dictation)
            else -> nativeString("Connect gateway to start")
          },
        icon = if (micEnabled) Icons.Default.MicOff else Icons.Default.TextFields,
        onClick = if (dictationNeedsSetup) onOpenVoiceSettings else onStartDictation,
        enabled = gatewayReady || micEnabled,
      )
    }

    VoiceProviderCard(
      gatewayStatus = gatewayStatus,
      voiceAttentionStatus = voiceAttentionStatus,
      talkSetupReadiness = talkSetupReadiness,
    )

    VoicePrimaryAction(
      text =
        when {
          talkModeEnabled -> nativeString("End Talk")
          talkNeedsSetup -> nativeString("Set Up Talk")
          gatewayReady -> nativeString("Start Talk")
          else -> nativeString("Connect Gateway")
        },
      icon =
        when {
          talkModeEnabled -> Icons.Default.PhoneDisabled
          talkNeedsSetup -> Icons.Default.Settings
          gatewayReady -> Icons.Default.Phone
          else -> Icons.Default.Cloud
        },
      onClick =
        when {
          talkModeEnabled || (gatewayReady && !talkNeedsSetup) -> onStartTalk
          talkNeedsSetup -> onOpenVoiceSettings
          else -> onConnectGateway
        },
    )
  }
}

@Composable
private fun VoiceModeRow(
  title: String,
  subtitle: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  onClick: () -> Unit,
  enabled: Boolean = true,
) {
  Surface(onClick = onClick, enabled = enabled, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier = Modifier.fillMaxWidth().heightIn(min = 58.dp).padding(horizontal = 0.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Surface(
        modifier = Modifier.size(30.dp),
        shape = RoundedCornerShape(ClawTheme.radii.control),
        color = if (enabled) ClawTheme.colors.surface else ClawTheme.colors.canvas,
        contentColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textSubtle,
        border = BorderStroke(1.dp, ClawTheme.colors.border),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(15.dp))
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
          text = title,
          style = ClawTheme.type.body,
          color = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = subtitle,
          style = ClawTheme.type.caption.copy(lineHeight = 16.sp),
          color = ClawTheme.colors.textMuted,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }
      if (enabled) {
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = null,
          modifier = Modifier.size(18.dp),
          tint = ClawTheme.colors.textMuted,
        )
      }
    }
  }
}

@Composable
private fun VoiceProviderCard(
  gatewayStatus: String,
  voiceAttentionStatus: String?,
  talkSetupReadiness: GatewayTalkSetupReadiness,
) {
  val ready =
    voiceAttentionStatus == null &&
      gatewayStatus.isVoiceGatewayReady() &&
      talkSetupReadiness.realtimeTalk.isReady &&
      talkSetupReadiness.dictation.isReady
  val needsSetup =
    voiceAttentionStatus == null &&
      gatewayStatus.isVoiceGatewayReady() &&
      (talkSetupReadiness.realtimeTalk.requiresSetup || talkSetupReadiness.dictation.requiresSetup)
  Surface(
    modifier = Modifier.fillMaxWidth().heightIn(min = 58.dp),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Surface(
        modifier = Modifier.size(30.dp),
        shape = RoundedCornerShape(ClawTheme.radii.control),
        color = ClawTheme.colors.canvas,
        contentColor = ClawTheme.colors.text,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.GraphicEq, contentDescription = null, modifier = Modifier.size(15.dp))
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
          text = nativeString("Voice setup"),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = voiceAttentionStatus ?: voiceSetupSummary(gatewayStatus, talkSetupReadiness),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Box(
          modifier =
            Modifier
              .size(7.dp)
              .clip(CircleShape)
              .background(
                when {
                  ready -> ClawTheme.colors.success
                  needsSetup -> ClawTheme.colors.warning
                  voiceAttentionStatus != null -> ClawTheme.colors.warning
                  else -> ClawTheme.colors.textSubtle
                },
              ),
        )
        Text(
          text =
            when {
              ready -> nativeString("Ready")
              needsSetup -> nativeString("Setup")
              voiceAttentionStatus != null -> nativeString("Attention")
              gatewayStatus.isVoiceGatewayReady() -> nativeString("Unverified")
              else -> nativeString("Offline")
            },
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}

private fun voiceSetupSummary(
  gatewayStatus: String,
  readiness: GatewayTalkSetupReadiness,
): String {
  if (!gatewayStatus.isVoiceGatewayReady()) return gatewayStatus.voiceGatewayLabel()
  return listOf(
    nativeString("Talk: \${gatewayTalkSetupDescription(readiness.realtimeTalk)}", gatewayTalkSetupDescription(readiness.realtimeTalk)),
    nativeString("Dictation: \${gatewayTalkSetupDescription(readiness.dictation)}", gatewayTalkSetupDescription(readiness.dictation)),
  ).joinToString(" · ")
}

@Composable
private fun VoicePrimaryAction(
  text: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth().height(ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.primary,
    contentColor = ClawTheme.colors.primaryText,
  ) {
    Row(
      modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(17.dp))
      Text(
        text = text,
        modifier = Modifier.padding(start = 8.dp),
        style = ClawTheme.type.label,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

// White wave stack for the tinted orb background (standard palette reds would
// vanish against the blue), mirroring how the macOS orb passes its own colors.
private val voiceOrbPalette =
  TalkWaveformPalette(
    active = listOf(Color.White, Color.White.copy(alpha = 0.75f), Color.White.copy(alpha = 0.5f)),
    inactive = listOf(Color.White.copy(alpha = 0.62f), Color.White.copy(alpha = 0.5f), Color.White.copy(alpha = 0.38f)),
  )

@Composable
private fun VoiceOrb(phase: TalkWaveformPhase) {
  Surface(
    modifier = Modifier.size(112.dp),
    shape = CircleShape,
    color = if (phase != TalkWaveformPhase.Idle) Color(0xFF1976D2) else Color(0xFF123B63),
    contentColor = Color.White,
    tonalElevation = 3.dp,
    shadowElevation = 7.dp,
  ) {
    // The circular surface clips the wave, matching the macOS orb treatment.
    TalkWaveform(
      phase = phase,
      modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp),
      palette = voiceOrbPalette,
    )
  }
}

@Composable
private fun VoiceTranscript(
  entries: List<VoiceConversationEntry>,
  showThinking: Boolean,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()
  LaunchedEffect(entries.size, showThinking) {
    if (entries.isNotEmpty() || showThinking) {
      listState.animateScrollToItem(0)
    }
  }

  LazyColumn(
    modifier = modifier.fillMaxWidth(),
    state = listState,
    reverseLayout = true,
    verticalArrangement = Arrangement.spacedBy(10.dp),
    contentPadding = PaddingValues(bottom = 8.dp),
  ) {
    if (showThinking) {
      item(key = "thinking") {
        VoiceThinkingCard()
      }
    }

    items(entries.asReversed(), key = { it.id }) { entry ->
      VoiceTurnCard(entry = entry)
    }
  }
}

@Composable
private fun VoiceTurnCard(entry: VoiceConversationEntry) {
  val isUser = entry.role == VoiceConversationRole.User
  Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
    Surface(
      modifier = Modifier.fillMaxWidth(if (isUser) 0.82f else 0.92f),
      shape = RoundedCornerShape(ClawTheme.radii.panel),
      color = if (isUser) ClawTheme.colors.surfacePressed else ClawTheme.colors.surfaceRaised,
      contentColor = ClawTheme.colors.text,
      border = BorderStroke(1.dp, if (entry.isStreaming) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
    ) {
      Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(
          text = if (isUser) nativeString("You") else nativeString("OpenClaw"),
          style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
          color = ClawTheme.colors.textSubtle,
        )
        Text(
          text =
            if (entry.isStreaming && entry.text.isBlank()) {
              nativeString("Listening...")
            } else {
              entry.localizedSource?.let(::nativeString) ?: entry.text
            },
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
        )
      }
    }
  }
}

@Composable
private fun VoiceThinkingCard() {
  ClawPanel {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      ClawStatusPill(text = nativeString("Sending"), status = ClawStatus.Warning)
      Text(
        text = nativeString("OpenClaw is preparing a response."),
        modifier = Modifier.weight(1f),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

@Composable
private fun VoicePermissionPanel(onRequestPermission: () -> Unit) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawStatusPill(text = nativeString("Permission needed"), status = ClawStatus.Warning)
      Text(text = nativeString("Microphone access is needed."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(
        text = nativeString("OpenClaw only listens when you start Talk or Dictation."),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      ClawSecondaryButton(text = nativeString("Enable Microphone"), icon = Icons.Default.Mic, onClick = onRequestPermission)
    }
  }
}

private enum class VoiceAction {
  Talk,
  Dictation,
}

private fun runVoiceAction(
  action: VoiceAction,
  hasMicPermission: Boolean,
  requestPermission: () -> Unit,
  run: () -> Unit,
) {
  if (hasMicPermission) {
    run()
  } else {
    requestPermission()
  }
}

internal fun talkSessionWaveformPhase(
  speaking: Boolean,
  listening: Boolean,
  awaitingAgent: Boolean,
  inputLevel: Float,
  speechActive: Boolean,
  outputLevel: Float?,
): TalkWaveformPhase =
  when {
    speaking -> TalkWaveformPhase.Speaking(outputLevel)
    awaitingAgent -> TalkWaveformPhase.Thinking
    listening -> TalkWaveformPhase.Listening(level = inputLevel, speechActive = speechActive)
    else -> TalkWaveformPhase.Idle
  }

internal fun voiceHeroWaveformPhase(
  micEnabled: Boolean,
  micInputLevel: Float,
  talkModeEnabled: Boolean,
  talkModeListening: Boolean,
  talkModeSpeaking: Boolean,
  talkInputLevel: Float,
  talkOutputLevel: Float?,
  talkSpeechActive: Boolean,
): TalkWaveformPhase =
  when {
    talkModeSpeaking -> TalkWaveformPhase.Speaking(talkOutputLevel)
    talkModeListening -> TalkWaveformPhase.Listening(level = talkInputLevel, speechActive = talkSpeechActive)
    micEnabled -> TalkWaveformPhase.Listening(level = micInputLevel, speechActive = false)
    talkModeEnabled -> TalkWaveformPhase.Thinking
    else -> TalkWaveformPhase.Idle
  }

internal fun voiceStatusLabel(
  gatewayStatus: String,
  voiceCaptureMode: VoiceCaptureMode,
  micStatusText: String,
  micQueuedMessages: Int,
  micIsSending: Boolean,
  talkModeListening: Boolean,
  talkModeSpeaking: Boolean,
  voiceAttentionStatus: String?,
): String =
  when {
    voiceAttentionStatus != null -> voiceAttentionStatus
    voiceCaptureMode == VoiceCaptureMode.TalkMode && talkModeSpeaking -> nativeString("OpenClaw is speaking")
    voiceCaptureMode == VoiceCaptureMode.TalkMode && talkModeListening -> nativeString("Listening")
    voiceCaptureMode == VoiceCaptureMode.TalkMode -> nativeString("Talk is live")
    micIsSending -> nativeString("Sending dictation")
    voiceCaptureMode == VoiceCaptureMode.ManualMic -> micStatusText.ifBlank { nativeString("Listening") }
    micQueuedMessages > 0 -> nativeString("\$micQueuedMessages queued", micQueuedMessages)
    !gatewayStatus.isVoiceGatewayReady() -> nativeString("Gateway offline")
    else -> nativeString("Ready to talk")
  }

internal fun voiceAttentionStatus(
  talkModeStatusText: String,
  voiceCaptureMode: VoiceCaptureMode,
  micEnabled: Boolean,
  micIsSending: Boolean,
  talkModeEnabled: Boolean,
  talkModeListening: Boolean,
  talkModeSpeaking: Boolean,
): String? {
  if (voiceCaptureMode != VoiceCaptureMode.Off || micEnabled || micIsSending) return null
  if (talkModeEnabled || talkModeListening || talkModeSpeaking) return null
  val status = talkModeStatusText.trim()
  if (status.isBlank()) return null
  val lower = status.lowercase()
  if (lower == "off" || lower == "ready" || lower == "listening" || lower == "connecting…") return null
  return status
    .takeIf {
      lower.contains("failed") ||
        lower.contains("unavailable") ||
        lower.contains("permission required") ||
        lower.contains("not connected") ||
        lower.contains("error")
    }?.let(::userFacingVoiceAttentionStatus)
}

internal fun voiceRuntimeAttentionStatus(statusText: String): String? {
  val status = statusText.trim()
  if (status.isBlank()) return null
  val lower = status.lowercase()
  return status
    .takeIf {
      lower.contains("transcription unavailable") ||
        lower.contains("provider unavailable") ||
        (lower.contains("provider") && lower.contains("not configured")) ||
        lower.contains("no realtime transcription provider") ||
        lower.contains("failed")
    }?.let(::userFacingVoiceAttentionStatus)
}

private fun userFacingVoiceAttentionStatus(status: String): String {
  val normalized =
    status
      .removePrefix("Start failed:")
      .trim()
      .removePrefix("Transcription unavailable:")
      .trim()
      .removePrefix("UNAVAILABLE:")
      .trim()
      .removePrefix("Error:")
      .trim()
  val lower = normalized.lowercase()
  if (lower.contains("realtime voice provider") && lower.contains("not configured")) {
    return nativeString("Realtime voice provider is not configured.")
  }
  if (lower.contains("no realtime transcription provider")) {
    return nativeString("Realtime transcription provider is not configured.")
  }
  if (lower.contains("microphone permission required")) {
    return nativeString("Microphone permission is required.")
  }
  return if (normalized.length <= 90) normalized else "${normalized.takeUtf16Safe(87)}..."
}

private fun String.isVoiceGatewayReady(): Boolean {
  val status = lowercase()
  return !status.contains("offline") && !status.contains("not connected") && !status.contains("failed") && !status.contains("error")
}

private fun String.voiceGatewayLabel(): String = if (isVoiceGatewayReady()) nativeString("Connected and ready") else nativeString("Gateway not connected")

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
