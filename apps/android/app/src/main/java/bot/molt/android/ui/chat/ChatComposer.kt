package bot.molt.android.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import bot.molt.android.chat.ChatSessionEntry

@Composable
fun ChatComposer(
  sessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  healthOk: Boolean,
  thinkingLevel: String,
  pendingRunCount: Int,
  errorText: String?,
  attachments: List<PendingImageAttachment>,
  onPickImages: () -> Unit,
  onRemoveAttachment: (id: String) -> Unit,
  onSetThinkingLevel: (level: String) -> Unit,
  onSelectSession: (sessionKey: String) -> Unit,
  onRefresh: () -> Unit,
  onAbort: () -> Unit,
  onSend: (text: String) -> Unit,
) {
  var input by rememberSaveable { mutableStateOf("") }
  var showThinkingMenu by remember { mutableStateOf(false) }
  var showSessionMenu by remember { mutableStateOf(false) }

  val sessionOptions = resolveSessionChoices(sessionKey, sessions, mainSessionKey = mainSessionKey)
  val currentSessionLabel =
    sessionOptions.firstOrNull { it.key == sessionKey }?.displayName ?: sessionKey

  val canSend = pendingRunCount == 0 && (input.trim().isNotEmpty() || attachments.isNotEmpty()) && healthOk

  Surface(
    shape = MaterialTheme.shapes.large,
    color = MaterialTheme.colorScheme.surfaceContainer,
    tonalElevation = 0.dp,
    shadowElevation = 0.dp,
  ) {
    Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Box {
          FilledTonalButton(
            onClick = { showSessionMenu = true },
            contentPadding = ButtonDefaults.ContentPadding,
          ) {
            Text("Session: $currentSessionLabel")
          }

          DropdownMenu(expanded = showSessionMenu, onDismissRequest = { showSessionMenu = false }) {
            for (entry in sessionOptions) {
              DropdownMenuItem(
                text = { Text(entry.displayName ?: entry.key) },
                onClick = {
                  onSelectSession(entry.key)
                  showSessionMenu = false
                },
                trailingIcon = {
                  if (entry.key == sessionKey) {
                    Text("✓")
                  } else {
                    Spacer(modifier = Modifier.width(10.dp))
                  }
                },
              )
            }
          }
        }

        Box {
          FilledTonalButton(
            onClick = { showThinkingMenu = true },
            contentPadding = ButtonDefaults.ContentPadding,
          ) {
            Text("Thinking: ${thinkingLabel(thinkingLevel)}")
          }

          DropdownMenu(expanded = showThinkingMenu, onDismissRequest = { showThinkingMenu = false }) {
            ThinkingMenuItem("off", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
            ThinkingMenuItem("low", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
            ThinkingMenuItem("medium", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
            ThinkingMenuItem("high", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
          }
        }

        Spacer(modifier = Modifier.weight(1f))

        FilledTonalIconButton(onClick = onRefresh, modifier = Modifier.size(42.dp)) {
          Icon(Icons.Default.Refresh, contentDescription = "Refresh")
        }

        FilledTonalIconButton(onClick = onPickImages, modifier = Modifier.size(42.dp)) {
          Icon(Icons.Default.AttachFile, contentDescription = "Add image")
        }
      }

      if (attachments.isNotEmpty()) {
        AttachmentsStrip(attachments = attachments, onRemoveAttachment = onRemoveAttachment)
      }

      OutlinedTextField(
        value = input,
        onValueChange = { input = it },
        modifier = Modifier.fillMaxWidth(),
        placeholder = { Text("Message Clawd…") },
        minLines = 2,
        maxLines = 6,
      )

      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        ConnectionPill(sessionLabel = currentSessionLabel, healthOk = healthOk)
        Spacer(modifier = Modifier.weight(1f))

        if (pendingRunCount > 0) {
          FilledTonalIconButton(
            onClick = onAbort,
            colors =
              IconButtonDefaults.filledTonalIconButtonColors(
                containerColor = Color(0x33E74C3C),
                contentColor = Color(0xFFE74C3C),
              ),
          ) {
            Icon(Icons.Default.Stop, contentDescription = "Abort")
          }
        } else {
          FilledTonalIconButton(onClick = {
            val text = input
            input = ""
            onSend(text)
          }, enabled = canSend) {
            Icon(Icons.Default.ArrowUpward, contentDescription = "Send")
          }
        }
      }

      if (!errorText.isNullOrBlank()) {
        Text(
          text = errorText,
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.error,
          maxLines = 2,
        )
      }
    }
  }
}

@Composable
private fun ConnectionPill(sessionLabel: String, healthOk: Boolean) {
  Surface(
    shape = RoundedCornerShape(999.dp),
    color = MaterialTheme.colorScheme.surfaceContainerHighest,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Surface(
        modifier = Modifier.size(7.dp),
        shape = androidx.compose.foundation.shape.CircleShape,
        color = if (healthOk) Color(0xFF2ECC71) else Color(0xFFF39C12),
      ) {}
      Text(sessionLabel, style = MaterialTheme.typography.labelSmall)
      Text(
        if (healthOk) "Connected" else "Connecting…",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
    text = { Text(thinkingLabel(value)) },
    onClick = {
      onSet(value)
      onDismiss()
    },
    trailingIcon = {
      if (value == current.trim().lowercase()) {
        Text("✓")
      } else {
        Spacer(modifier = Modifier.width(10.dp))
      }
    },
  )
}

private fun thinkingLabel(raw: String): String {
  return when (raw.trim().lowercase()) {
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    else -> "Off"
  }
}

@Composable
private fun AttachmentsStrip(
  attachments: List<PendingImageAttachment>,
  onRemoveAttachment: (id: String) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    for (att in attachments) {
      AttachmentChip(
        fileName = att.fileName,
        onRemove = { onRemoveAttachment(att.id) },
      )
    }
  }
}

@Composable
private fun AttachmentChip(fileName: String, onRemove: () -> Unit) {
  Surface(
    shape = RoundedCornerShape(999.dp),
    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.10f),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(text = fileName, style = MaterialTheme.typography.bodySmall, maxLines = 1)
      FilledTonalIconButton(
        onClick = onRemove,
        modifier = Modifier.size(30.dp),
      ) {
        Text("×")
      }
    }
  }
}
