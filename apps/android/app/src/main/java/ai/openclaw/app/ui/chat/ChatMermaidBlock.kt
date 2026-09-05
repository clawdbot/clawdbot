package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import org.commonmark.node.FencedCodeBlock
import org.json.JSONObject

internal fun isChatMermaidFence(
  block: FencedCodeBlock,
  isStreaming: Boolean,
): Boolean =
  block.info
    .orEmpty()
    .trim()
    .takeWhile { !it.isWhitespace() }
    .equals("mermaid", ignoreCase = true) &&
    (!isStreaming || block.closingFenceLength != null)

internal data class ChatMermaidTheme(
  val background: String,
  val foreground: String,
  val muted: String,
  val border: String,
  val accent: String,
  val darkMode: Boolean,
) {
  fun payload(): JSONObject =
    JSONObject()
      .put("background", background)
      .put("foreground", foreground)
      .put("muted", muted)
      .put("border", border)
      .put("accent", accent)
      .put("fontFamily", "sans-serif")
      .put("darkMode", darkMode)
}

internal data class ChatMermaidRequest(
  override val source: String,
  override val widthPx: Int,
  override val density: Float,
  val theme: ChatMermaidTheme,
) : ChatRichBlockRequest {
  override val kind get() = ChatRichBlockKind.Mermaid

  override fun payload(id: String): JSONObject =
    JSONObject()
      .put("id", id)
      .put("source", source)
      .put("widthCssPx", widthPx / density)
      .put("theme", theme.payload())
}

private sealed interface MermaidBlockState {
  data object Loading : MermaidBlockState

  data class Rendered(
    val image: ChatRichBlockImage,
  ) : MermaidBlockState

  data class Unavailable(
    val retryable: Boolean,
  ) : MermaidBlockState
}

@Composable
internal fun ChatMermaidBlock(source: String) {
  val context = LocalContext.current
  val density = LocalDensity.current
  val colors = ClawTheme.colors
  val theme =
    remember(colors) {
      ChatMermaidTheme(
        background = chatRenderCssColor(colors.surfaceRaised.toArgb()),
        foreground = chatRenderCssColor(colors.text.toArgb()),
        muted = chatRenderCssColor(colors.textMuted.toArgb()),
        border = chatRenderCssColor(colors.borderStrong.toArgb()),
        accent = chatRenderCssColor(colors.accent.toArgb()),
        darkMode = colors.surfaceRaised.luminance() < 0.5f,
      )
    }
  var showSource by rememberSaveable(source) { mutableStateOf(false) }
  var expanded by rememberSaveable(source) { mutableStateOf(false) }
  var menuExpanded by remember(source) { mutableStateOf(false) }
  var retryGeneration by remember(source) { mutableIntStateOf(0) }

  BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
    val widthPx = with(density) { maxWidth.roundToPx().coerceAtLeast(1) }
    val request = remember(source, widthPx, density.density, theme) { ChatMermaidRequest(source, widthPx, density.density, theme) }
    var state by remember(request, retryGeneration) { mutableStateOf<MermaidBlockState>(MermaidBlockState.Loading) }
    DisposableEffect(request, retryGeneration) {
      val subscription =
        ChatRichBlockRenderer.render(context, request) { result ->
          state =
            when (result) {
              is ChatRichBlockResult.Success -> MermaidBlockState.Rendered(result.value)
              ChatRichBlockResult.Failure -> MermaidBlockState.Unavailable(retryable = false)
              ChatRichBlockResult.TransientFailure -> MermaidBlockState.Unavailable(retryable = true)
            }
        }
      onDispose { subscription.cancel() }
    }

    val rendered = (state as? MermaidBlockState.Rendered)?.image
    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(8.dp),
      border = BorderStroke(1.dp, colors.border),
      color = colors.surfaceRaised,
    ) {
      Box(modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)) {
        when {
          showSource -> {
            Column(modifier = Modifier.padding(top = 48.dp)) { ChatCodeBlock(source, language = null) }
          }

          rendered != null -> {
            Image(
              bitmap = rendered.bitmap.asImageBitmap(),
              contentDescription = nativeString("Mermaid diagram"),
              contentScale = ContentScale.Fit,
              modifier =
                Modifier
                  .fillMaxWidth()
                  .clickable(role = Role.Button, onClickLabel = nativeString("Expand diagram")) { expanded = true }
                  .padding(start = 8.dp, end = 8.dp, top = 48.dp, bottom = 8.dp),
            )
          }

          else -> {
            Column(modifier = Modifier.padding(start = 10.dp, end = 10.dp, top = 48.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(
                text =
                  when {
                    state is MermaidBlockState.Loading -> nativeString("Rendering diagram…")
                    (state as? MermaidBlockState.Unavailable)?.retryable == true -> nativeString("Diagram temporarily unavailable. Open Diagram options and choose Retry diagram. You can still read or copy its source.")
                    else -> nativeString("Diagram unavailable. Check the syntax or simplify the diagram. You can still read or copy its source.")
                  },
                style = ClawTheme.type.caption,
                color = colors.textMuted,
              )
              ChatCodeBlock(source, language = null)
            }
          }
        }
        Surface(modifier = Modifier.align(Alignment.TopEnd), shape = RoundedCornerShape(8.dp), color = colors.surfaceRaised.copy(alpha = 0.92f)) {
          Row {
            IconButton(onClick = { copyChatText(context, source) }) {
              Icon(Icons.Default.ContentCopy, contentDescription = nativeString("Copy diagram source"), modifier = Modifier.size(18.dp), tint = colors.textMuted)
            }
            Box {
              IconButton(onClick = { menuExpanded = true }) {
                Icon(Icons.Default.MoreVert, contentDescription = nativeString("Diagram options"), modifier = Modifier.size(20.dp), tint = colors.textMuted)
              }
              DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                DropdownMenuItem(
                  text = { Text(if (showSource) nativeString("View diagram") else nativeString("View source")) },
                  onClick = {
                    showSource = !showSource
                    menuExpanded = false
                  },
                )
                DropdownMenuItem(
                  text = { Text(nativeString("Expand diagram")) },
                  enabled = rendered?.svg != null,
                  onClick = {
                    expanded = true
                    menuExpanded = false
                  },
                )
                if ((state as? MermaidBlockState.Unavailable)?.retryable == true) {
                  DropdownMenuItem(
                    text = { Text(nativeString("Retry diagram")) },
                    onClick = {
                      retryGeneration += 1
                      menuExpanded = false
                    },
                  )
                }
              }
            }
          }
        }
      }
    }
    if (expanded && rendered?.svg != null) {
      ChatMermaidPreview(svg = rendered.svg, background = colors.surfaceRaised, onDismiss = { expanded = false })
    }
  }
}
