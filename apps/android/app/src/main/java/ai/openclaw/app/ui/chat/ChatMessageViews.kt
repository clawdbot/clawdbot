package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.OUTBOX_BRANCH_CHANGED_ERROR
import ai.openclaw.app.chat.chatOutboxDisplayError
import ai.openclaw.app.chat.normalizeVisibleChatMessageRole
import ai.openclaw.app.gateway.GatewayLoadedImage
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeStringResource
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.image.RemoteImageResult
import ai.openclaw.app.ui.image.safeRemoteImageStore
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

@Composable
private fun ChatBubbleContainer(
  user: Boolean,
  speaker: String,
  modifier: Modifier = Modifier,
  borderColor: Color? = null,
  content: @Composable () -> Unit,
) {
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      border = BorderStroke(1.dp, borderColor ?: if (user) ClawTheme.colors.accentBorder else ClawTheme.colors.borderStrong),
      color = if (user) ClawTheme.colors.accentSoft else ClawTheme.colors.surfaceRaised,
      tonalElevation = 0.dp,
      shadowElevation = 0.dp,
      modifier =
        Modifier
          .fillMaxWidth(0.90f)
          .semantics(mergeDescendants = true) { contentDescription = speaker },
    ) {
      Column(
        modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
      ) {
        content()
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
      color = ClawTheme.colors.surfaceRaised,
      border = BorderStroke(1.dp, ClawTheme.colors.border),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = nativeString("Preview · \$domain", domain),
          style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
          color = ClawTheme.colors.textMuted,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        androidx.compose.material3.Icon(
          imageVector = Icons.Default.ExpandMore,
          contentDescription = nativeString("Expand link preview"),
          tint = ClawTheme.colors.textMuted,
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
      when (val image = imageUrl?.let { safeRemoteImageStore.get(it) }) {
        is RemoteImageResult.Raster -> image.bitmap.asImageBitmap()
        is RemoteImageResult.Svg, RemoteImageResult.Failed, null -> null
      }
  }
  val uriHandler = LocalUriHandler.current
  val cardShape = RoundedCornerShape(ClawTheme.radii.sheet)
  val metadataAnchor = rememberChatReaderAnchor(result)
  Surface(
    onClick = { uriHandler.openUri(url) },
    shape = cardShape,
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.fillMaxWidth()) {
      previewImage?.let { image ->
        val imageAnchor = rememberChatReaderAnchor(imageUrl)
        Image(
          bitmap = image,
          contentDescription = null,
          contentScale = ContentScale.Crop,
          modifier =
            Modifier
              .fillMaxWidth()
              .heightIn(max = 120.dp)
              .clip(cardShape)
              .then(imageAnchor?.modifier ?: Modifier),
        )
      }
      Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp).then(metadataAnchor?.modifier ?: Modifier),
        verticalArrangement = Arrangement.spacedBy(3.dp),
      ) {
        Text(domain, style = ClawTheme.type.captionSmall, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        when (val preview = result) {
          null -> {
            Text(nativeString("Loading preview…"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          }

          LinkPreviewResult.Failed -> {
            Text(nativeString("No preview available"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }

          is LinkPreviewResult.Loaded -> {
            preview.metadata.title?.let { title ->
              Text(
                text = title,
                style = ClawTheme.type.body.copy(fontWeight = FontWeight.SemiBold),
                color = ClawTheme.colors.text,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
              )
            }
            preview.metadata.description?.let { description ->
              Text(
                text = description,
                style = ClawTheme.type.caption,
                color = ClawTheme.colors.textMuted,
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
fun ChatTypingIndicatorBubble(
  runKey: String,
  observedAtElapsedMs: Long,
  outputTokens: Long? = null,
) {
  val elapsedMs = rememberWorkingElapsedMs(observedAtElapsedMs)
  val phrase = workingPhraseText(seed = runKey, elapsedMs = elapsedMs)
  val tokens = outputTokens?.let { localizedChatOutputTokens(it) }
  ChatBubbleContainer(
    user = false,
    speaker = nativeString("OpenClaw"),
  ) {
    Row(
      modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = nativeString("Working") },
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      WorkingClawIcon(runKey = runKey, color = ClawTheme.colors.accent)
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Text(formatLocalizedChatDurationCompact(elapsedMs), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        tokens?.let {
          Text(nativeStringResource("·"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          Text(it, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
        phrase?.let { Text(nativeStringResource("· \$phrase", it), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) }
      }
    }
  }
}

/** Queued/failed offline command with inline retry/delete controls; rendered as a user bubble. */
@Composable
fun ChatOutboxBubble(
  item: ChatOutboxItem,
  retryEnabled: Boolean = true,
  onRetry: () -> Unit,
  onDelete: () -> Unit,
) {
  val failed = item.status == ChatOutboxStatus.Failed
  val statusColor = if (failed) ClawTheme.colors.danger else ClawTheme.colors.warning
  val statusLabel =
    when (item.status) {
      ChatOutboxStatus.Queued -> {
        nativeString("Queued — sends when reconnected")
      }

      ChatOutboxStatus.Sending -> {
        nativeString("Sending…")
      }

      ChatOutboxStatus.Accepted -> {
        nativeString("Sent — confirming delivery…")
      }

      ChatOutboxStatus.Failed -> {
        chatOutboxDisplayError(item.lastError)
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?.let { error ->
            val localized =
              if (error == OUTBOX_BRANCH_CHANGED_ERROR) {
                nativeString("Session branch changed; review and retry this message.")
              } else {
                error
              }
            nativeString("Failed — \$it", localized)
          } ?: nativeString("Failed")
      }
    }

  ChatBubbleContainer(
    user = true,
    speaker = nativeString("You"),
    borderColor = statusColor.copy(alpha = 0.6f),
  ) {
    if (item.text.isNotBlank()) {
      ChatMarkdown(text = item.text, textColor = ClawTheme.colors.text)
    }
    item.attachments.forEach { attachment ->
      Text(
        text = nativeString("📎 \${attachment.fileName}", attachment.fileName),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text(
        text = statusLabel,
        style = ClawTheme.type.caption,
        color = statusColor,
        modifier = Modifier.weight(1f),
      )
      if (failed && retryEnabled) {
        ChatOutboxAction(label = nativeString("Retry"), borderColor = ClawTheme.colors.accent, onClick = onRetry)
      }
      // Sending rows are mid-dispatch and accepted rows may already be delivered; both stay
      // action-free until reconciliation resolves them, so a delete can never race a send.
      if (item.status == ChatOutboxStatus.Queued || failed) {
        ChatOutboxAction(label = nativeString("Delete"), borderColor = ClawTheme.colors.textMuted, onClick = onDelete)
      }
    }
  }
}

@Composable
private fun ChatOutboxAction(
  label: String,
  borderColor: Color,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(8.dp),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, borderColor.copy(alpha = 0.5f)),
  ) {
    Text(
      text = label,
      style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
    )
  }
}

@Composable
internal fun ChatBase64Image(
  base64: String,
  mimeType: String?,
) {
  val imageState = rememberBase64ImageState(base64)
  val image = imageState.image

  if (image != null) {
    ChatImagePreview(image = image, description = mimeType ?: nativeString("Attachment"), stateKey = base64)
  } else if (imageState.failed) {
    Text(nativeString("Unsupported attachment"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
  }
}

@Composable
internal fun ChatManagedImage(
  artifactId: String,
  label: String,
  resolverReady: Boolean,
  loadImage: suspend (String) -> GatewayLoadedImage?,
) {
  var image by remember(artifactId) { mutableStateOf<ImageBitmap?>(null) }
  var failed by remember(artifactId) { mutableStateOf(false) }
  var retryGeneration by rememberSaveable(artifactId) { mutableStateOf(0) }

  LaunchedEffect(artifactId, resolverReady, retryGeneration) {
    if (!resolverReady) {
      failed = true
      image = null
      return@LaunchedEffect
    }
    failed = false
    image = null
    val loaded = runCatching { loadImage(artifactId) }.getOrNull()
    image =
      loaded?.let { value ->
        withContext(Dispatchers.Default) { decodeImageBytes(value.bytes)?.asImageBitmap() }
      }
    failed = image == null
  }

  when {
    image != null -> {
      ChatImagePreview(image = checkNotNull(image), description = label, stateKey = artifactId)
    }

    failed -> {
      Surface(
        onClick = { retryGeneration += 1 },
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, ClawTheme.colors.border),
        color = ClawTheme.colors.surfaceRaised,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text(
          nativeString("Image unavailable · Tap to retry"),
          modifier = Modifier.padding(12.dp),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
      }
    }

    else -> {
      Text(
        nativeString("Loading image…"),
        modifier = Modifier.padding(12.dp),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun ChatImagePreview(
  image: ImageBitmap,
  description: String,
  stateKey: String,
) {
  val anchor = rememberChatReaderAnchor(stateKey)
  var previewVisible by rememberSaveable(stateKey) { mutableStateOf(false) }
  Surface(
    onClick = { previewVisible = true },
    shape = RoundedCornerShape(10.dp),
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    color = ClawTheme.colors.surfaceRaised,
    modifier = Modifier.fillMaxWidth(),
  ) {
    Box {
      Image(
        bitmap = image,
        contentDescription = description,
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth().then(anchor?.modifier ?: Modifier),
      )
      Surface(
        modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp).size(32.dp),
        shape = CircleShape,
        color = Color.Black.copy(alpha = 0.62f),
        contentColor = Color.White,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(
            imageVector = Icons.Default.OpenInFull,
            contentDescription = nativeString("Open image preview"),
            modifier = Modifier.size(17.dp),
          )
        }
      }
    }
  }
  if (previewVisible) {
    Dialog(
      onDismissRequest = { previewVisible = false },
      properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
      Box(
        modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.96f)).clickable { previewVisible = false },
        contentAlignment = Alignment.Center,
      ) {
        Image(
          bitmap = image,
          contentDescription = nativeString("Image preview"),
          contentScale = ContentScale.Fit,
          modifier = Modifier.fillMaxSize().padding(20.dp),
        )
        Surface(
          onClick = { previewVisible = false },
          modifier = Modifier.align(Alignment.TopEnd).padding(16.dp).size(44.dp),
          shape = CircleShape,
          color = Color.Black.copy(alpha = 0.62f),
          contentColor = Color.White,
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = Icons.Default.Close,
              contentDescription = nativeString("Close image preview"),
              modifier = Modifier.size(22.dp),
            )
          }
        }
      }
    }
  }
}

/** Shared code block renderer used by chat Markdown. */
@Composable
fun ChatCodeBlock(
  code: String,
  language: String?,
  isComplete: Boolean = true,
) {
  val display = code.trimEnd()
  // A custom accent may be too light for keywords on the code surface.
  val tokenColors =
    CodeTokenColors(
      keyword = ClawTheme.colors.codeText,
      string = ClawTheme.colors.success,
      comment = ClawTheme.colors.textMuted,
      number = ClawTheme.colors.danger,
    )
  // Keyed on content: streaming re-renders of unchanged blocks reuse the tokenized result,
  // and still-open fences stay plain until the closing fence arrives.
  val highlighted =
    remember(display, language, isComplete, tokenColors) {
      if (isComplete) buildHighlightedCode(display, language, tokenColors) else AnnotatedString(display)
    }
  val ranges = remember(display) { chatTextLayoutRanges(display, maxLines = 256) }
  Surface(
    shape = RoundedCornerShape(8.dp),
    color = ClawTheme.colors.codeBg,
    border = BorderStroke(1.dp, ClawTheme.colors.codeBorder),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      if (!language.isNullOrBlank()) {
        Text(
          text = language.uppercase(Locale.US),
          style = ClawTheme.type.captionSmall,
          color = ClawTheme.colors.textMuted,
        )
      }
      if (ranges.size == 1) {
        SelectionContainer {
          ChatCodeText(highlighted, rememberChatReaderAnchor())
        }
      } else {
        val scroll = rememberLazyListState()
        val action = key(display) { rememberChatReaderAction() }
        val requester = remember { BringIntoViewRequester() }
        val viewportAnchor = rememberChatReaderAnchor(display)
        val context = LocalContext.current
        LaunchedEffect(scroll, action) {
          scroll.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) action.pause()
          }
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          TextButton(onClick = {
            action.launch {
              scroll.scrollToItem(0)
              val size = scroll.layoutInfo.viewportSize
              requester.bringIntoView(Rect(0f, 0f, size.width.toFloat(), action.viewportHeight(size.height).toFloat()))
            }
          }) { Text(nativeString("Start of code")) }
          TextButton(onClick = {
            action.launch {
              scroll.scrollToItem(ranges.size)
              val layout = scroll.layoutInfo
              // The measured terminal item follows the text. An oversized request can
              // satisfy a short scroll parent while leaving the last line clipped.
              val terminal = layout.visibleItemsInfo.first { it.index == ranges.size }
              val top = terminal.offset.toFloat()
              requester.bringIntoView(Rect(0f, top, layout.viewportSize.width.toFloat(), top + terminal.size))
            }
          }) { Text(nativeString("End of code")) }
        }
        TextButton(onClick = { copyChatText(context, code) }) { Text(nativeString("Copy code")) }
        // Quoted Markdown asks for intrinsic height; the fixed viewport answers that
        // without forwarding an unsupported intrinsic query into the lazy layout.
        LazyColumn(
          state = scroll,
          modifier =
            Modifier
              .fillMaxWidth()
              .height(400.dp)
              .bringIntoViewRequester(requester)
              .then(viewportAnchor?.modifier ?: Modifier),
        ) {
          items(ranges.size) { index ->
            val range = ranges[index]
            val end = range.last + 1
            // A forced character boundary can fall immediately before a line break.
            // The new layout already starts a line; account for that one separator only.
            val visibleStart =
              when {
                index > 0 && display[range.first - 1] != '\n' && display.startsWith("\r\n", range.first) -> range.first + 2
                index > 0 && display[range.first - 1] != '\n' && display[range.first] == '\n' -> range.first + 1
                else -> range.first
              }
            // The next layout starts the next line. Do not render the boundary line
            // break twice; source ranges and full-message actions still retain it.
            val visibleEnd =
              if (end < display.length && display[end - 1] == '\n') {
                if (end > range.first + 1 && display[end - 2] == '\r') end - 2 else end - 1
              } else {
                end
              }
            // Selection cannot span recycled layouts. Copy code retains the full
            // source even in workspace previews, which have no message-action menu.
            // A separator-only range before an over-budget grapheme is already
            // represented by its neighbors; an empty Text would add a blank line.
            if (visibleStart <= visibleEnd) {
              SelectionContainer {
                ChatCodeText(highlighted.subSequence(visibleStart, visibleEnd))
              }
            }
          }
          // A terminal anchor lets End reveal the bottom of even a tall final layout.
          item { Spacer(Modifier.height(1.dp)) }
        }
      }
    }
  }
}

@Composable
private fun ChatCodeText(
  text: AnnotatedString,
  anchor: ChatReaderAnchor? = null,
) {
  Text(
    text = text,
    fontFamily = FontFamily.Monospace,
    // Every layout is part of the same code block; trimming each fragment's first
    // and last line would change spacing at otherwise invisible boundaries.
    style = ClawTheme.type.body.copy(lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Proportional, LineHeightStyle.Trim.None)),
    color = ClawTheme.colors.codeText,
    modifier = anchor?.modifier ?: Modifier,
    onTextLayout = anchor?.onTextLayout ?: {},
  )
}
