package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.AndroidVoiceNoteRecordingEngine
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.VoiceNoteRecorderController
import ai.openclaw.app.chat.VoiceNoteRecorderState
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.TalkWaveform
import ai.openclaw.app.ui.design.TalkWaveformPhase
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal fun rememberVoiceNoteRecorderController(
  viewModel: MainViewModel,
  ownerKey: ChatComposerOwner,
  mainSessionKey: String,
  onFinished: (String, PendingAttachment) -> Unit,
): VoiceNoteRecorderController {
  val context = LocalContext.current.applicationContext
  val lifecycleOwner = LocalLifecycleOwner.current
  val scope = rememberCoroutineScope()
  val currentOnFinished by rememberUpdatedState(onFinished)
  val ownerTracker = remember { VoiceNoteRecorderOwnerTracker(ownerKey) }
  lateinit var controller: VoiceNoteRecorderController
  controller =
    remember(context, viewModel, scope) {
      VoiceNoteRecorderController(
        scope = scope,
        outputDirectory = context.cacheDir,
        engine = AndroidVoiceNoteRecordingEngine(context),
        requestPermission = viewModel::requestVoiceNotePermission,
        acquireMic = viewModel::tryAcquireVoiceNoteMic,
        releaseMic = viewModel::releaseVoiceNoteMic,
        onFinished = { recording ->
          scope.launch(Dispatchers.IO) {
            val attachment = runCatching { stageVoiceNoteAttachment(recording) }
            withContext(Dispatchers.Main) {
              if (!controller.canCommitPreparation(recording.id)) return@withContext
              attachment.fold(
                onSuccess = {
                  currentOnFinished(recording.id, it)
                  controller.completePreparation()
                },
                onFailure = { controller.reportFailure("Could not prepare voice note.") },
              )
            }
          }
        },
      )
    }
  LaunchedEffect(controller, ownerKey, mainSessionKey) {
    if (!ownerTracker.moveTo(ownerKey, mainSessionKey)) controller.cancel()
  }
  DisposableEffect(controller, lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_STOP) controller.cancel()
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
      controller.cancel()
    }
  }
  return controller
}

internal class VoiceNoteRecorderOwnerTracker(
  initialOwner: ChatComposerOwner,
) {
  private var owner = initialOwner

  /** Returns false only when the next owner represents a genuinely different chat. */
  fun moveTo(
    next: ChatComposerOwner,
    mainSessionKey: String,
  ): Boolean {
    val retain = owner == next || shouldMigrateComposerDraft(owner, next, mainSessionKey)
    owner = next
    return retain
  }
}

@Composable
internal fun VoiceNotePreparing(modifier: Modifier = Modifier) {
  Surface(
    modifier = modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.textSubtle,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Icon(imageVector = Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
      Text(text = nativeString("Preparing voice note…"), style = ClawTheme.type.label)
    }
  }
}

@Composable
internal fun VoiceNoteRecordButton(
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.size(ClawTheme.spacing.touchTarget),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textSubtle,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.Default.Mic, contentDescription = nativeString("Record voice note"), modifier = Modifier.size(18.dp))
    }
  }
}

@Composable
internal fun VoiceNoteRecordingControls(
  elapsedMs: Long,
  level: Float,
  onCancel: () -> Unit,
  onDone: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.fillMaxWidth().heightIn(min = ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.danger, CircleShape))
      Text(
        text = formatVoiceNoteDuration(elapsedMs),
        style = ClawTheme.type.label.copy(fontWeight = FontWeight.SemiBold),
      )
      TalkWaveform(
        phase = TalkWaveformPhase.Listening(level = level, speechActive = false),
        modifier = Modifier.weight(1f).height(30.dp),
      )
      Surface(
        onClick = onCancel,
        modifier = Modifier.size(ClawTheme.spacing.touchTarget),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        contentColor = ClawTheme.colors.text,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.Close, contentDescription = nativeString("Cancel voice note"), modifier = Modifier.size(17.dp))
        }
      }
      Surface(
        onClick = onDone,
        modifier = Modifier.size(ClawTheme.spacing.touchTarget),
        shape = CircleShape,
        color = ClawTheme.colors.primary,
        contentColor = ClawTheme.colors.primaryText,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.Check, contentDescription = nativeString("Finish voice note"), modifier = Modifier.size(17.dp))
        }
      }
    }
  }
}

@Composable
internal fun VoiceNoteRecorderError(state: VoiceNoteRecorderState) {
  val message = (state as? VoiceNoteRecorderState.Failure)?.message ?: return
  Text(text = message, style = ClawTheme.type.caption, color = ClawTheme.colors.danger)
}

internal fun ChatMessageContent.isAudioAttachment(): Boolean = type == "audio" || mimeType?.startsWith("audio/") == true

@Composable
internal fun VoiceNoteMessageRow(durationMs: Long?) {
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Icon(
      imageVector = Icons.Default.Mic,
      contentDescription = null,
      modifier = Modifier.size(16.dp),
      tint = ClawTheme.colors.textMuted,
    )
    Text(text = nativeString("Voice note"), style = ClawTheme.type.body, color = ClawTheme.colors.text)
    durationMs?.let { duration ->
      Text(
        text = formatVoiceNoteDuration(duration),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}
