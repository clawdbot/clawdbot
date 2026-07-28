package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.chat.ChatCommandEntry
import ai.openclaw.app.chat.VoiceNoteRecorderState
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileAccentBorderStrong
import ai.openclaw.app.ui.mobileAccentSoft
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileBorderStrong
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileHeadline
import ai.openclaw.app.ui.mobileSurface
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import ai.openclaw.app.ui.mobileTextTertiary
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/** Result of applying a stored chat draft to the current composer input. */
internal data class DraftApplication(
  val input: String,
  val lastAppliedDraft: String?,
  val consumed: Boolean,
)

internal fun mergeChatDraft(
  draft: ChatDraft?,
  currentInput: String,
): String? {
  val text = draft?.text?.takeIf { it.isNotBlank() } ?: return null
  return when (draft.placement) {
    ChatDraftPlacement.Replace -> text
    ChatDraftPlacement.BeforeExisting -> text + currentInput
  }
}

internal data class SheetSlashCommandSelection(
  val input: String,
)

internal data class SheetComposerSendAction(
  val sendMessage: Boolean,
)

internal fun resolveSheetSlashCommandSelection(command: ChatCommandEntry): SheetSlashCommandSelection = SheetSlashCommandSelection(input = slashCommandCompletion(command))

internal fun resolveSheetComposerSendAction(input: String): SheetComposerSendAction = SheetComposerSendAction(sendMessage = input.trim().isNotEmpty())

/** Applies a draft exactly once so restored prompts do not overwrite user edits. */
internal fun applyDraftText(
  draft: ChatDraft?,
  currentInput: String,
  lastAppliedDraft: String?,
): DraftApplication {
  val appliedDraft =
    draft ?: return DraftApplication(
      input = currentInput,
      lastAppliedDraft = null,
      consumed = false,
    )
  val nextInput =
    mergeChatDraft(appliedDraft, currentInput) ?: return DraftApplication(
      input = currentInput,
      lastAppliedDraft = null,
      consumed = false,
    )
  val draftText = appliedDraft.text
  if (draftText == lastAppliedDraft) {
    return DraftApplication(
      input = currentInput,
      lastAppliedDraft = lastAppliedDraft,
      consumed = false,
    )
  }
  return DraftApplication(
    input = nextInput,
    lastAppliedDraft = draftText,
    consumed = true,
  )
}

/** Chat input surface for text, image attachments, thinking level, and run controls. */
@Composable
internal fun ChatComposer(
  draftText: ChatDraft?,
  healthOk: Boolean,
  thinkingLevel: String,
  thinkingSupported: Boolean,
  pendingRunCount: Int,
  commands: List<ChatCommandEntry>,
  attachments: List<PendingAttachment>,
  onDraftApplied: () -> Unit,
  onPickImages: () -> Unit,
  onRemoveAttachment: (id: String) -> Unit,
  voiceNoteState: VoiceNoteRecorderState,
  voiceNoteElapsedMs: Long,
  recordVoiceNoteEnabled: Boolean,
  onStartVoiceNote: () -> Unit,
  onCancelVoiceNote: () -> Unit,
  onFinishVoiceNote: () -> Unit,
  onSetThinkingLevel: (level: String) -> Unit,
  onRefresh: () -> Unit,
  onAbort: () -> Unit,
  /** Returns whether the send/enqueue was accepted; refusals restore the cleared draft. */
  onSend: suspend (text: String) -> Boolean,
) {
  var input by rememberSaveable { mutableStateOf("") }
  var lastAppliedDraft by rememberSaveable { mutableStateOf<String?>(null) }
  var showThinkingMenu by remember { mutableStateOf(false) }
  val sendScope = rememberCoroutineScope()
  val slashCommands =
    remember(input, commands) {
      matchingSlashCommands(input = input, commands = commands)
    }

  LaunchedEffect(draftText) {
    val next = applyDraftText(draft = draftText, currentInput = input, lastAppliedDraft = lastAppliedDraft)
    input = next.input
    lastAppliedDraft = next.lastAppliedDraft
    if (next.consumed) {
      // Consume only after the composer state has accepted the draft so
      // recomposition cannot reapply it over user edits.
      onDraftApplied()
    }
  }

  LaunchedEffect(thinkingSupported) {
    if (!thinkingSupported) showThinkingMenu = false
  }

  // One in-flight run owns the composer actions; attachments alone are enough to send when the
  // gateway is healthy. Offline, only text can be sent (it is queued durably; text-only v1).
  val canSend =
    pendingRunCount == 0 &&
      if (healthOk) {
        input.trim().isNotEmpty() || attachments.isNotEmpty()
      } else {
        input.trim().isNotEmpty() && attachments.isEmpty()
      }
  val sendBusy = pendingRunCount > 0
  val recordingVoiceNote = voiceNoteState is VoiceNoteRecorderState.Recording
  val preparingVoiceNote = voiceNoteState is VoiceNoteRecorderState.Preparing
  val sendCurrentInput = {
    val message = input.trim()
    val action = resolveSheetComposerSendAction(input = message)
    if (action.sendMessage || attachments.isNotEmpty()) {
      input = ""
      sendScope.launch {
        val accepted = onSend(message)
        // Refused sends (offline queue full, enqueue failure) must not eat the draft;
        // restore it unless the user already started typing something new.
        if (!accepted && input.isEmpty()) {
          input = message
        }
      }
    }
  }

  Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    if (attachments.isNotEmpty()) {
      AttachmentsStrip(attachments = attachments, onRemoveAttachment = onRemoveAttachment)
    }

    if (shouldShowSlashCommandMenu(input)) {
      SheetSlashCommandPanel(
        commands = slashCommands,
        onSelect = { command ->
          val selection = resolveSheetSlashCommandSelection(command = command)
          input = selection.input
        },
      )
    }

    if (recordingVoiceNote) {
      VoiceNoteRecordingControls(
        elapsedMs = voiceNoteElapsedMs,
        onCancel = onCancelVoiceNote,
        onDone = onFinishVoiceNote,
      )
    } else if (preparingVoiceNote) {
      VoiceNotePreparing()
    } else {
      OutlinedTextField(
        value = input,
        onValueChange = { input = it },
        modifier =
          Modifier
            .fillMaxWidth()
            .onPreviewKeyEvent { event ->
              handlePhysicalChatSend(
                event = event,
                sendEnabled = canSend,
                onSend = sendCurrentInput,
              )
            },
        placeholder = { Text("Type a message…", style = mobileBodyStyle(), color = mobileTextTertiary) },
        minLines = 2,
        maxLines = 5,
        textStyle = mobileBodyStyle().copy(color = mobileText),
        shape = RoundedCornerShape(14.dp),
        colors = chatTextFieldColors(),
      )
    }

    VoiceNoteRecorderError(voiceNoteState)

    if (!healthOk) {
      Text(
        text = "Gateway is offline. Text messages are queued and sent after reconnecting.",
        style = mobileCallout,
        color = ai.openclaw.app.ui.mobileWarning,
      )
    }

    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      if (thinkingSupported) {
        Box {
          Surface(
            onClick = { showThinkingMenu = true },
            shape = RoundedCornerShape(14.dp),
            color = mobileCardSurface,
            border = BorderStroke(1.dp, mobileBorderStrong),
          ) {
            Row(
              modifier = Modifier.padding(horizontal = 10.dp, vertical = 10.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Text(
                text = thinkingLabel(thinkingLevel),
                style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
                color = mobileTextSecondary,
              )
              Icon(
                Icons.Default.ArrowDropDown,
                contentDescription = "Select thinking level",
                modifier = Modifier.size(18.dp),
                tint = mobileTextTertiary,
              )
            }
          }

          DropdownMenu(
            expanded = showThinkingMenu,
            onDismissRequest = { showThinkingMenu = false },
            shape = RoundedCornerShape(16.dp),
            containerColor = mobileCardSurface,
            tonalElevation = 0.dp,
            shadowElevation = 8.dp,
            border = BorderStroke(1.dp, mobileBorder),
          ) {
            ThinkingMenuItem("off", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
            ThinkingMenuItem("low", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
            ThinkingMenuItem("medium", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
            ThinkingMenuItem("high", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
          }
        }
      }

      SecondaryActionButton(
        label = "Attach",
        icon = Icons.Default.AttachFile,
        enabled = true,
        compact = true,
        onClick = onPickImages,
      )

      if (!recordingVoiceNote) {
        VoiceNoteRecordButton(
          enabled = recordVoiceNoteEnabled && !preparingVoiceNote,
          onClick = onStartVoiceNote,
        )
      }

      SecondaryActionButton(
        label = "Refresh",
        icon = Icons.Default.Refresh,
        enabled = true,
        compact = true,
        onClick = onRefresh,
      )

      SecondaryActionButton(
        label = "Abort",
        icon = Icons.Default.Stop,
        enabled = pendingRunCount > 0,
        compact = true,
        onClick = onAbort,
      )

      Spacer(modifier = Modifier.weight(1f))

      Button(
        onClick = sendCurrentInput,
        enabled = canSend && !recordingVoiceNote && !preparingVoiceNote,
        modifier = Modifier.height(44.dp),
        shape = RoundedCornerShape(14.dp),
        contentPadding = PaddingValues(horizontal = 20.dp),
        colors =
          ButtonDefaults.buttonColors(
            containerColor = mobileAccent,
            contentColor = Color.White,
            disabledContainerColor = mobileBorderStrong,
            disabledContentColor = mobileTextTertiary,
          ),
        border =
          BorderStroke(
            1.dp,
            if (canSend && !recordingVoiceNote && !preparingVoiceNote) mobileAccentBorderStrong else mobileBorderStrong,
          ),
      ) {
        if (sendBusy) {
          CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
        } else {
          Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, modifier = Modifier.size(16.dp))
        }
        Spacer(modifier = Modifier.width(6.dp))
        Text(
          text = "Send",
          style = mobileHeadline.copy(fontWeight = FontWeight.Bold),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}

@Composable
private fun SheetSlashCommandPanel(
  commands: List<ChatCommandEntry>,
  onSelect: (ChatCommandEntry) -> Unit,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = mobileCardSurface,
    shape = RoundedCornerShape(14.dp),
    border = BorderStroke(1.dp, mobileBorderStrong),
    tonalElevation = 0.dp,
    shadowElevation = 0.dp,
  ) {
    Column(modifier = Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      if (commands.isEmpty()) {
        Text(
          text = "No commands found",
          style = mobileCaption1,
          color = mobileTextTertiary,
        )
      } else {
        for (command in commands) {
          Surface(
            onClick = { onSelect(command) },
            shape = RoundedCornerShape(10.dp),
            color = Color.Transparent,
            contentColor = mobileText,
          ) {
            Row(
              modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 7.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              Text(
                text = slashCommandText(command),
                style = mobileCaption1.copy(fontWeight = FontWeight.Bold),
                color = mobileText,
                modifier = Modifier.width(76.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
              Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                  text = command.description.ifBlank { command.category ?: "Command" },
                  style = mobileCaption1,
                  color = mobileTextSecondary,
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                )
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun SecondaryActionButton(
  label: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  enabled: Boolean,
  compact: Boolean = false,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    modifier = if (compact) Modifier.size(44.dp) else Modifier.height(44.dp),
    shape = RoundedCornerShape(14.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = mobileCardSurface,
        contentColor = mobileTextSecondary,
        disabledContainerColor = mobileCardSurface,
        disabledContentColor = mobileTextTertiary,
      ),
    border = BorderStroke(1.dp, mobileBorderStrong),
    contentPadding = if (compact) PaddingValues(0.dp) else ButtonDefaults.ContentPadding,
  ) {
    Icon(icon, contentDescription = label, modifier = Modifier.size(14.dp))
    if (!compact) {
      Spacer(modifier = Modifier.width(5.dp))
      Text(
        text = label,
        style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
        color = if (enabled) mobileTextSecondary else mobileTextTertiary,
      )
    }
  }
}

@Composable
private fun ThinkingMenuItem(
  value: String,
  current: String,
  onSet: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  DropdownMenuItem(
    text = { Text(thinkingLabel(value), style = mobileCallout, color = mobileText) },
    onClick = {
      onSet(value)
      onDismiss()
    },
    trailingIcon = {
      if (value == current.trim().lowercase()) {
        Text("✓", style = mobileCallout, color = mobileAccent)
      } else {
        Spacer(modifier = Modifier.width(10.dp))
      }
    },
  )
}

private fun thinkingLabel(raw: String): String =
  when (raw.trim().lowercase()) {
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    else -> "Off"
  }

@Composable
private fun AttachmentsStrip(
  attachments: List<PendingAttachment>,
  onRemoveAttachment: (id: String) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    for (att in attachments) {
      AttachmentChip(
        attachment = att,
        onRemove = { onRemoveAttachment(att.id) },
      )
    }
  }
}

@Composable
private fun AttachmentChip(
  attachment: PendingAttachment,
  onRemove: () -> Unit,
) {
  Surface(
    shape = RoundedCornerShape(999.dp),
    color = mobileAccentSoft,
    border = BorderStroke(1.dp, mobileBorderStrong),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      if (attachment.mimeType.startsWith("audio/")) {
        Icon(imageVector = Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(14.dp), tint = mobileTextSecondary)
      }
      Text(
        text =
          attachment.durationMs?.let { duration -> "Voice note · ${formatVoiceNoteDuration(duration)}" }
            ?: attachment.fileName,
        style = mobileCaption1,
        color = mobileText,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Surface(
        onClick = onRemove,
        shape = RoundedCornerShape(999.dp),
        color = mobileCardSurface,
        border = BorderStroke(1.dp, mobileBorderStrong),
      ) {
        Text(
          text = "×",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold),
          color = mobileTextSecondary,
          modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
      }
    }
  }
}

@Composable
private fun chatTextFieldColors() =
  OutlinedTextFieldDefaults.colors(
    focusedContainerColor = mobileSurface,
    unfocusedContainerColor = mobileSurface,
    focusedBorderColor = mobileAccent,
    unfocusedBorderColor = mobileBorder,
    focusedTextColor = mobileText,
    unfocusedTextColor = mobileText,
    cursorColor = mobileAccent,
  )

@Composable
private fun mobileBodyStyle() =
  MaterialTheme.typography.bodyMedium.copy(
    fontFamily = ai.openclaw.app.ui.mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 15.sp,
    lineHeight = 22.sp,
  )
