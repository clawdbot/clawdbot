package ai.openclaw.app.ui.chat

import ai.openclaw.app.R
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawIconButton
import ai.openclaw.app.ui.design.ClawTheme
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.util.TypedValue
import android.view.Gravity
import android.widget.TextView
import android.widget.Toast
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.LastPage
import androidx.compose.material.icons.automirrored.filled.NavigateBefore
import androidx.compose.material.icons.automirrored.filled.NavigateNext
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

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
  if (!enabled || (text.isBlank() && !showSessionActions)) {
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
      if (text.isNotBlank()) {
        onToggleListen?.let { toggleListen ->
          MessageActionItem(label = if (listenActive) nativeString("Stop") else nativeString("Listen")) {
            toggleListen()
            menuExpanded = false
          }
        }
        MessageActionItem(label = nativeString("Copy")) {
          copyChatText(context, text)
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
    ChatTextReaderDialog(
      text = text,
      title = nativeString("Select text"),
      dismissLabel = nativeString("Done"),
      onDismiss = { selectText = false },
    )
  }
}

@Composable
internal fun ChatTextReaderDialog(
  text: String,
  title: String,
  dismissLabel: String,
  onDismiss: () -> Unit,
) {
  val colors = ClawTheme.colors
  val body = ClawTheme.type.body
  val fontSizePx = with(LocalDensity.current) { body.fontSize.toPx() }
  val lineHeightPx = with(LocalDensity.current) { body.lineHeight.roundToPx() }
  val pages = remember(text) { chatTextLayoutRanges(text) }
  var page by remember(text) { mutableIntStateOf(0) }
  val pageText = remember(text, page) { text.substring(pages[page]) }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(title) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        key(text, page) {
          AndroidView(
            modifier = Modifier.weight(1f, fill = false).fillMaxWidth().heightIn(max = 400.dp),
            factory = { context ->
              TextView(context).apply {
                gravity = Gravity.TOP or Gravity.START
                typeface = resources.getFont(R.font.manrope_500_medium)
                includeFontPadding = false
                isVerticalScrollBarEnabled = true
                setHorizontallyScrolling(false)
                setTextIsSelectable(true)
                this.text = pageText
              }
            },
            update = { view ->
              view.setTextSize(TypedValue.COMPLEX_UNIT_PX, fontSizePx)
              view.setLineHeight(lineHeightPx)
              view.setTextColor(colors.text.toArgb())
              view.highlightColor = colors.accent.copy(alpha = 0.3f).toArgb()
            },
          )
        }
        if (pages.size > 1) {
          val pageNumber = page + 1
          val pageCount = pages.size
          Text(nativeString("Page \$pageNumber of \$pageCount · Select text on this page", pageNumber, pageCount), style = ClawTheme.type.caption)
          Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            ClawIconButton(Icons.AutoMirrored.Filled.LastPage, nativeString("First page"), { page = 0 }, modifier = Modifier.rotate(180f), enabled = page > 0)
            ClawIconButton(Icons.AutoMirrored.Filled.NavigateBefore, nativeString("Previous page"), { page = (page - 1).coerceAtLeast(0) }, enabled = page > 0)
            ClawIconButton(Icons.AutoMirrored.Filled.NavigateNext, nativeString("Next page"), { page = (page + 1).coerceAtMost(pages.lastIndex) }, enabled = page < pages.lastIndex)
            ClawIconButton(Icons.AutoMirrored.Filled.LastPage, nativeString("Last page"), { page = pages.lastIndex }, enabled = page < pages.lastIndex)
          }
        }
      }
    },
    confirmButton = { TextButton(onClick = onDismiss) { Text(dismissLabel) } },
  )
}

@Composable
private fun MessageActionItem(
  label: String,
  onClick: () -> Unit,
) {
  DropdownMenuItem(text = { Text(label) }, onClick = onClick)
}

internal fun copyChatText(
  context: Context,
  text: String,
) {
  val clipboard = context.getSystemService(ClipboardManager::class.java)
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw text", text))
  Toast.makeText(context, nativeString("Text copied"), Toast.LENGTH_SHORT).show()
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
