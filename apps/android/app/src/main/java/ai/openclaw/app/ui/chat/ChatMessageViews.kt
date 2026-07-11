package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.MessageSpeechPhase
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.normalizeVisibleChatMessageRole
import ai.openclaw.app.tools.ToolDisplayRegistry
import ai.openclaw.app.ui.MobileColorsAccessor
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileAccentSoft
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileBorderStrong
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCaption2
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileCodeBg
import ai.openclaw.app.ui.mobileCodeBorder
import ai.openclaw.app.ui.mobileCodeText
import ai.openclaw.app.ui.mobileDanger
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import ai.openclaw.app.ui.mobileWarning
import ai.openclaw.app.ui.mobileWarningSoft
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

private data class ChatBubbleStyle(
  val alignEnd: Boolean,
  val containerColor: Color,
  val borderColor: Color,
  val roleColor: Color,
)

/** Renders one persisted chat message as text and image parts. */
@Composable
internal fun ChatMessageBubble(
  message: ChatMessage,
  onReplyMessage: (String) -> Unit = {},
  speechState: MessageSpeechState? = null,
  onToggleListen: ((String, String) -> Unit)? = null,
) {
  val role = normalizeVisibleChatMessageRole(message.role) ?: return
  val style = bubbleStyle(role)

  // Filter to only displayable content parts (text with content, or base64 images).
  val displayableContent =
    message.content.filter { part ->
      when (part.type) {
        "text" -> !part.text.isNullOrBlank()
        "image" -> !part.base64.isNullOrBlank()
        else -> part.isAudioAttachment()
      }
    }

  if (displayableContent.isEmpty()) return

  val messageText = chatMessagePlainText(displayableContent)
  val messageSpeech = speechState?.takeIf { it.messageId == message.id }
  val canListen = role == "assistant" && messageText.isNotBlank() && onToggleListen != null
  val toggleListen: (() -> Unit)? =
    if (canListen) {
      { checkNotNull(onToggleListen).invoke(message.id, messageText) }
    } else {
      null
    }
  ChatMessageActionHost(
    text = messageText,
    onReply = onReplyMessage,
    listenActive = messageSpeech != null,
    onToggleListen = toggleListen,
    modifier = Modifier.fillMaxWidth(),
  ) {
    ChatBubbleContainer(style = style, roleLabel = roleLabel(role)) {
      ChatMessageBody(content = displayableContent, textColor = mobileText)
      ChatMessageLinkPreview(messageId = message.id, role = role, content = displayableContent)
      messageSpeech?.let { speech ->
        MessageSpeechIndicator(
          phase = speech.phase,
          onStop = { checkNotNull(onToggleListen).invoke(message.id, messageText) },
        )
      }
    }
  }
}

@Composable
private fun MessageSpeechIndicator(
  phase: MessageSpeechPhase,
  onStop: () -> Unit,
) {
  Surface(
    onClick = onStop,
    shape = RoundedCornerShape(999.dp),
    color = mobileAccentSoft,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(
        imageVector =
          if (phase == MessageSpeechPhase.Preparing) {
            Icons.Default.HourglassEmpty
          } else {
            Icons.AutoMirrored.Filled.VolumeUp
          },
        contentDescription = null,
        modifier = Modifier.size(14.dp),
        tint = mobileTextSecondary,
      )
      Text(
        text = if (phase == MessageSpeechPhase.Preparing) "Preparing audio…" else "Speaking…",
        style = mobileCaption1,
        color = mobileTextSecondary,
      )
    }
  }
}

@Composable
private fun ChatBubbleContainer(
  style: ChatBubbleStyle,
  roleLabel: String,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = if (style.alignEnd) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      border = BorderStroke(1.dp, style.borderColor),
      color = style.containerColor,
      tonalElevation = 0.dp,
      shadowElevation = 0.dp,
      modifier = Modifier.fillMaxWidth(0.90f),
    ) {
      Column(
        modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
      ) {
        Text(
          text = roleLabel,
          style = mobileCaption2.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
          color = style.roleColor,
        )
        content()
      }
    }
  }
}

@Composable
private fun ChatMessageBody(
  content: List<ChatMessageContent>,
  textColor: Color,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    for (part in content) {
      when {
        part.type == "text" -> {
          val text = part.text ?: continue
          ChatMarkdown(text = text, textColor = textColor)
        }
        part.isAudioAttachment() -> VoiceNoteMessageRow(durationMs = part.durationMs)
        else -> {
          val b64 = part.base64 ?: continue
          ChatBase64Image(base64 = b64, mimeType = part.mimeType)
        }
      }
    }
  }
}

@Composable
internal fun ChatMessageLinkPreview(
  messageId: String,
  role: String,
  content: List<ChatMessageContent>,
) {
  val normalizedRole = normalizeVisibleChatMessageRole(role) ?: return
  if (normalizedRole != "user" && normalizedRole != "assistant") return
  val previewUrl =
    remember(messageId, normalizedRole, content) {
      content
        .asSequence()
        .filter { it.type == "text" }
        .mapNotNull { it.text?.let(::extractFirstBareUrl) }
        .firstOrNull()
    }
  if (previewUrl != null) {
    ChatLinkPreview(messageId = messageId, url = previewUrl)
  }
}

@Composable
private fun ChatLinkPreview(
  messageId: String,
  url: String,
) {
  var expanded by rememberSaveable(messageId, url) { mutableStateOf(false) }
  var result by remember(messageId, url) { mutableStateOf<LinkPreviewResult?>(null) }
  val domain = remember(url) { linkPreviewDomain(url) }

  if (!expanded) {
    Surface(
      onClick = { expanded = true },
      shape = RoundedCornerShape(8.dp),
      color = mobileCardSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = "Preview · $domain",
          style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
          color = mobileTextSecondary,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        androidx.compose.material3.Icon(
          imageVector = Icons.Default.ExpandMore,
          contentDescription = "Expand link preview",
          tint = mobileTextSecondary,
        )
      }
    }
    return
  }

  LaunchedEffect(messageId, url) {
    result = chatLinkPreviewStore.get(url)
  }
  val imageUrl = (result as? LinkPreviewResult.Loaded)?.metadata?.imageUrl
  var previewImage by remember(messageId, url, imageUrl) { mutableStateOf<ImageBitmap?>(null) }
  LaunchedEffect(imageUrl) {
    previewImage =
      when (val image = imageUrl?.let { chatLinkPreviewImageStore.get(it) }) {
        is LinkPreviewImageResult.Loaded -> image.bitmap.asImageBitmap()
        LinkPreviewImageResult.Failed, null -> null
      }
  }
  val uriHandler = LocalUriHandler.current
  val cardShape = RoundedCornerShape(ClawTheme.radii.sheet)
  Surface(
    onClick = { uriHandler.openUri(url) },
    shape = cardShape,
    color = mobileCardSurface,
    border = BorderStroke(1.dp, mobileBorder),
  ) {
    Column(modifier = Modifier.fillMaxWidth()) {
      previewImage?.let { image ->
        Image(
          bitmap = image,
          contentDescription = null,
          contentScale = ContentScale.Crop,
          modifier = Modifier.fillMaxWidth().heightIn(max = 120.dp).clip(cardShape),
        )
      }
      Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
      ) {
        Text(domain, style = mobileCaption2, color = mobileTextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        when (val preview = result) {
          null -> Text("Loading preview…", style = mobileCaption1, color = mobileTextSecondary)
          LinkPreviewResult.Failed -> Text("No preview available", style = mobileCallout, color = mobileTextSecondary)
          is LinkPreviewResult.Loaded -> {
            preview.metadata.title?.let { title ->
              Text(
                text = title,
                style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
                color = mobileText,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
              )
            }
            preview.metadata.description?.let { description ->
              Text(
                text = description,
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

private fun linkPreviewDomain(url: String): String =
  runCatching { java.net.URI(url).host }
    .getOrNull()
    ?.removePrefix("www.")
    ?.takeIf(String::isNotBlank)
    ?: url

/** Assistant placeholder shown while a run is active but no text has streamed yet. */
@Composable
fun ChatTypingIndicatorBubble() {
  ChatBubbleContainer(
    style = bubbleStyle("assistant"),
    roleLabel = roleLabel("assistant"),
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      DotPulse(color = mobileTextSecondary)
      Text("Thinking...", style = mobileCallout, color = mobileTextSecondary)
    }
  }
}

/** Tool progress bubble resolved through Android's tool display registry. */
@Composable
fun ChatPendingToolsBubble(toolCalls: List<ChatPendingToolCall>) {
  val context = LocalContext.current
  val displays =
    remember(toolCalls, context) {
      toolCalls.map { ToolDisplayRegistry.resolve(context, it.name, it.args) }
    }

  ChatBubbleContainer(
    style = bubbleStyle("assistant"),
    roleLabel = "Tools",
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text("Running tools...", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
      for (display in displays.take(6)) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(
            "${display.emoji} ${display.label}",
            style = mobileCallout,
            color = mobileTextSecondary,
            fontFamily = FontFamily.Monospace,
          )
          display.detailLine?.let { detail ->
            Text(
              detail,
              style = mobileCaption1,
              color = mobileTextSecondary,
              fontFamily = FontFamily.Monospace,
            )
          }
        }
      }
      if (toolCalls.size > 6) {
        Text(
          text = "... +${toolCalls.size - 6} more",
          style = mobileCaption1,
          color = mobileTextSecondary,
        )
      }
    }
  }
}

/** Queued/failed offline command with inline retry/delete controls; rendered as a user bubble. */
@Composable
fun ChatOutboxBubble(
  item: ChatOutboxItem,
  onRetry: () -> Unit,
  onDelete: () -> Unit,
) {
  val failed = item.status == ChatOutboxStatus.Failed
  val statusColor = if (failed) mobileDanger else mobileWarning
  val statusLabel =
    when (item.status) {
      ChatOutboxStatus.Queued -> "Queued — sends when reconnected"
      ChatOutboxStatus.Sending -> "Sending…"
      ChatOutboxStatus.Accepted -> "Sent — confirming delivery…"
      ChatOutboxStatus.Failed ->
        item.lastError
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?.let { "Failed — $it" } ?: "Failed"
    }

  ChatBubbleContainer(
    style = bubbleStyle("user").copy(borderColor = statusColor.copy(alpha = 0.6f)),
    roleLabel = "You",
  ) {
    if (item.text.isNotBlank()) {
      ChatMarkdown(text = item.text, textColor = mobileText)
    }
    item.attachments.forEach { attachment ->
      Text(
        text = "📎 ${attachment.fileName}",
        style = mobileCaption1,
        color = mobileTextSecondary,
      )
    }
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text(
        text = statusLabel,
        style = mobileCaption1,
        color = statusColor,
        modifier = Modifier.weight(1f),
      )
      if (failed) {
        ChatOutboxAction(label = "Retry", color = mobileAccent, onClick = onRetry)
      }
      // Sending rows are mid-dispatch and accepted rows may already be delivered; both stay
      // action-free until reconciliation resolves them, so a delete can never race a send.
      if (item.status == ChatOutboxStatus.Queued || failed) {
        ChatOutboxAction(label = "Delete", color = mobileTextSecondary, onClick = onDelete)
      }
    }
  }
}

@Composable
private fun ChatOutboxAction(
  label: String,
  color: Color,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(8.dp),
    color = Color.Transparent,
    contentColor = color,
    border = BorderStroke(1.dp, color.copy(alpha = 0.5f)),
  ) {
    Text(
      text = label,
      style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
    )
  }
}

/** Live assistant stream bubble shown before the final message is committed. */
@Composable
fun ChatStreamingAssistantBubble(text: String) {
  ChatBubbleContainer(
    style = bubbleStyle("assistant").copy(borderColor = mobileAccent),
    roleLabel = "OpenClaw · Live",
  ) {
    ChatMarkdown(text = text, textColor = mobileText, isStreaming = true)
  }
}

@Composable
private fun bubbleStyle(role: String): ChatBubbleStyle =
  when (role) {
    "user" ->
      ChatBubbleStyle(
        alignEnd = true,
        containerColor = mobileAccentSoft,
        borderColor = mobileAccent,
        roleColor = mobileAccent,
      )

    "system" ->
      ChatBubbleStyle(
        alignEnd = false,
        containerColor = mobileWarningSoft,
        borderColor = mobileWarning.copy(alpha = 0.45f),
        roleColor = mobileWarning,
      )

    else ->
      ChatBubbleStyle(
        alignEnd = false,
        containerColor = mobileCardSurface,
        borderColor = mobileBorderStrong,
        roleColor = mobileTextSecondary,
      )
  }

private fun roleLabel(role: String): String =
  when (role) {
    "user" -> "You"
    "system" -> "System"
    else -> "OpenClaw"
  }

@Composable
private fun ChatBase64Image(
  base64: String,
  mimeType: String?,
) {
  val imageState = rememberBase64ImageState(base64)
  val image = imageState.image

  if (image != null) {
    Surface(
      shape = RoundedCornerShape(10.dp),
      border = BorderStroke(1.dp, mobileBorder),
      color = mobileCardSurface,
      modifier = Modifier.fillMaxWidth(),
    ) {
      Image(
        bitmap = image,
        contentDescription = mimeType ?: "attachment",
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  } else if (imageState.failed) {
    Text("Unsupported attachment", style = mobileCaption1, color = mobileTextSecondary)
  }
}

@Composable
private fun DotPulse(color: Color) {
  Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
    PulseDot(alpha = 0.38f, color = color)
    PulseDot(alpha = 0.62f, color = color)
    PulseDot(alpha = 0.90f, color = color)
  }
}

@Composable
private fun PulseDot(
  alpha: Float,
  color: Color,
) {
  Surface(
    modifier = Modifier.size(6.dp).alpha(alpha),
    shape = CircleShape,
    color = color,
  ) {}
}

/** Shared code block renderer used by chat Markdown. */
@Composable
fun ChatCodeBlock(
  code: String,
  language: String?,
  isComplete: Boolean = true,
) {
  val display = code.trimEnd()
  // Token colors come from the theme's code palette so light/dark both keep readable contrast.
  val palette = MobileColorsAccessor.current
  val tokenColors =
    CodeTokenColors(
      keyword = palette.codeKeyword,
      string = palette.codeString,
      comment = palette.codeComment,
      number = palette.codeNumber,
    )
  // Keyed on content: streaming re-renders of unchanged blocks reuse the tokenized result,
  // and still-open fences stay plain until the closing fence arrives.
  val highlighted =
    remember(display, language, isComplete, tokenColors) {
      if (isComplete) buildHighlightedCode(display, language, tokenColors) else AnnotatedString(display)
    }
  Surface(
    shape = RoundedCornerShape(8.dp),
    color = mobileCodeBg,
    border = BorderStroke(1.dp, mobileCodeBorder),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      if (!language.isNullOrBlank()) {
        Text(
          text = language.uppercase(Locale.US),
          style = mobileCaption2.copy(letterSpacing = 0.4.sp),
          color = mobileTextSecondary,
        )
      }
      Text(
        text = highlighted,
        fontFamily = FontFamily.Monospace,
        style = mobileCallout,
        color = mobileCodeText,
      )
    }
  }
}
