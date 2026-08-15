package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.i18n.nativeString
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

internal fun chatMessagePlainText(content: List<ChatMessageContent>): String =
  content
    .asSequence()
    .filter { it.type == "text" }
    .mapNotNull(ChatMessageContent::text)
    .filter(String::isNotBlank)
    .joinToString("\n\n")

internal fun quoteChatMessage(text: String): String {
  val quoted =
    text
      .lineSequence()
      .joinToString("\n") { line -> if (line.isEmpty()) ">" else "> $line" }
  return nativeString("\$quoted\n\n", quoted)
}

/** Long-press message actions shared by the full Chat tab and compact chat sheet. */
@Composable
internal fun ChatMessageActionHost(
  text: String,
  onReply: (String) -> Unit,
  modifier: Modifier = Modifier,
  showSessionActions: Boolean = false,
  onRewind: (() -> Unit)? = null,
  onFork: (() -> Unit)? = null,
  enabled: Boolean = true,
  listenActive: Boolean = false,
  onToggleListen: (() -> Unit)? = null,
  content: @Composable () -> Unit,
) {
  if (!enabled || text.isBlank()) {
    Box(modifier = modifier) { content() }
    return
  }

  val context = LocalContext.current
  var menuExpanded by remember { mutableStateOf(false) }
  var selectText by remember { mutableStateOf(false) }

  Box(
    modifier =
      modifier.combinedClickable(
        onClick = {},
        onLongClick = { menuExpanded = true },
        onLongClickLabel = nativeString("Message actions"),
      ),
  ) {
    content()
    DropdownMenu(
      expanded = menuExpanded,
      onDismissRequest = { menuExpanded = false },
    ) {
      onToggleListen?.let { toggleListen ->
        MessageActionItem(label = if (listenActive) nativeString("Stop") else nativeString("Listen")) {
          toggleListen()
          menuExpanded = false
        }
      }
      MessageActionItem(label = nativeString("Copy")) {
        copyChatMessage(context, text)
        menuExpanded = false
      }
      MessageActionItem(label = nativeString("Select text")) {
        menuExpanded = false
        selectText = true
      }
      MessageActionItem(label = nativeString("Share")) {
        shareChatMessage(context, text)
        menuExpanded = false
      }
      MessageActionItem(label = nativeString("Reply")) {
        onReply(quoteChatMessage(text))
        menuExpanded = false
      }
      if (showSessionActions) {
        onRewind?.let { rewind ->
          MessageActionItem(label = nativeString("Rewind to here")) {
            rewind()
            menuExpanded = false
          }
        }
        onFork?.let { fork ->
          MessageActionItem(label = nativeString("Fork from here")) {
            fork()
            menuExpanded = false
          }
        }
      }
    }
  }

  if (selectText) {
    AlertDialog(
      onDismissRequest = { selectText = false },
      title = { Text(nativeString("Select text")) },
      text = {
        Box(
          modifier =
            Modifier
              .fillMaxWidth()
              .heightIn(max = 400.dp)
              .verticalScroll(rememberScrollState()),
        ) {
          SelectionContainer {
            Text(text)
          }
        }
      },
      confirmButton = {
        TextButton(onClick = { selectText = false }) {
          Text(nativeString("Done"))
        }
      },
    )
  }
}

@Composable
private fun MessageActionItem(
  label: String,
  onClick: () -> Unit,
) {
  DropdownMenuItem(text = { Text(label) }, onClick = onClick)
}

private fun copyChatMessage(
  context: Context,
  text: String,
) {
  val clipboard = context.getSystemService(ClipboardManager::class.java)
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw chat message", text))
  Toast.makeText(context, nativeString("Message copied"), Toast.LENGTH_SHORT).show()
}

private fun shareChatMessage(
  context: Context,
  text: String,
) {
  val sendIntent =
    Intent(Intent.ACTION_SEND)
      .setType("text/plain")
      .putExtra(Intent.EXTRA_TEXT, text)
  val chooser = Intent.createChooser(sendIntent, nativeString("Share message"))
  if (context !is Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  runCatching { context.startActivity(chooser) }
    .onFailure {
      Toast.makeText(context, nativeString("No app can share this message"), Toast.LENGTH_SHORT).show()
    }
}
