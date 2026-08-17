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
import ai.openclaw.app.ui.MobileColorsAccessor
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.image.RemoteImageResult
import ai.openclaw.app.ui.image.safeRemoteImageStore
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileAccentBorderStrong
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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.OpenInFull
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

@Composable
private fun ChatBubbleContainer(
  user: Boolean,
  speaker: String,
  borderColor: Color? = null,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      border = BorderStroke(1.dp, borderColor ?: if (user) mobileAccentBorderStrong else mobileBorderStrong),
      color = if (user) mobileAccentSoft else mobileCardSurface,
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
      color = mobileCardSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = nativeString("Preview · \$domain", domain),
          style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
          color = mobileTextSecondary,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        androidx.compose.material3.Icon(
          imageVector = Icons.Default.ExpandMore,
          contentDescription = nativeString("Expand link preview"),
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
      when (val image = imageUrl?.let { safeRemoteImageStore.get(it) }) {
        is RemoteImageResult.Raster -> image.bitmap.asImageBitmap()
        is RemoteImageResult.Svg, RemoteImageResult.Failed, null -> null
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
          null -> Text(nativeString("Loading preview…"), style = mobileCaption1, color = mobileTextSecondary)
          LinkPreviewResult.Failed -> Text(nativeString("No preview available"), style = mobileCallout, color = mobileTextSecondary)
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
      WorkingClawIcon(runKey = runKey, color = mobileAccent)
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Text(formatLocalizedChatDurationCompact(elapsedMs), style = mobileCallout, color = mobileTextSecondary)
        tokens?.let {
          Text(nativeStringResource("·"), style = mobileCallout, color = mobileTextSecondary)
          Text(it, style = mobileCallout, color = mobileTextSecondary)
        }
        phrase?.let { Text(nativeStringResource("· \$phrase", it), style = mobileCallout, color = mobileTextSecondary) }
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
  val statusColor = if (failed) mobileDanger else mobileWarning
  val statusLabel =
    when (item.status) {
      ChatOutboxStatus.Queued -> nativeString("Queued — sends when reconnected")
      ChatOutboxStatus.Sending -> nativeString("Sending…")
      ChatOutboxStatus.Accepted -> nativeString("Sent — confirming delivery…")
      ChatOutboxStatus.Failed ->
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

  ChatBubbleContainer(
    user = true,
    speaker = nativeString("You"),
    borderColor = statusColor.copy(alpha = 0.6f),
  ) {
    if (item.text.isNotBlank()) {
      ChatMarkdown(text = item.text, textColor = mobileText)
    }
    item.attachments.forEach { attachment ->
      Text(
        text = nativeString("📎 \${attachment.fileName}", attachment.fileName),
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
      if (failed && retryEnabled) {
        ChatOutboxAction(label = nativeString("Retry"), color = mobileAccent, onClick = onRetry)
      }
      // Sending rows are mid-dispatch and accepted rows may already be delivered; both stay
      // action-free until reconciliation resolves them, so a delete can never race a send.
      if (item.status == ChatOutboxStatus.Queued || failed) {
        ChatOutboxAction(label = nativeString("Delete"), color = mobileTextSecondary, onClick = onDelete)
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
    Text(nativeString("Unsupported attachment"), style = mobileCaption1, color = mobileTextSecondary)
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
    image != null -> ChatImagePreview(image = checkNotNull(image), description = label, stateKey = artifactId)
    failed ->
      Surface(
        onClick = { retryGeneration += 1 },
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, mobileBorder),
        color = mobileCardSurface,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text(
          nativeString("Image unavailable · Tap to retry"),
          modifier = Modifier.padding(12.dp),
          style = mobileCaption1,
          color = mobileTextSecondary,
        )
      }
    else ->
      Text(
        nativeString("Loading image…"),
        modifier = Modifier.padding(12.dp),
        style = mobileCaption1,
        color = mobileTextSecondary,
      )
  }
}

@Composable
private fun ChatImagePreview(
  image: ImageBitmap,
  description: String,
  stateKey: String,
) {
  var previewVisible by rememberSaveable(stateKey) { mutableStateOf(false) }
  Surface(
    onClick = { previewVisible = true },
    shape = RoundedCornerShape(10.dp),
    border = BorderStroke(1.dp, mobileBorder),
    color = mobileCardSurface,
    modifier = Modifier.fillMaxWidth(),
  ) {
    Box {
      Image(
        bitmap = image,
        contentDescription = description,
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth(),
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
