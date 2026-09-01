package ai.openclaw.app.ui.chat

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.sp
import org.json.JSONObject

private const val MATH_WIDTH_BUCKET_PX = 64

internal data class ChatMathRenderKey(
  val latex: String,
  val widthBucket: Int,
  val darkMode: Boolean,
)

internal data class ChatMathRenderRequest(
  val key: ChatMathRenderKey,
  val textColor: Int,
  val fontSizePx: Float,
  override val density: Float,
) : ChatRichBlockRequest {
  override val kind get() = ChatRichBlockKind.Math
  override val source get() = key.latex
  override val widthPx get() = key.widthBucket

  override fun payload(id: String): JSONObject =
    JSONObject()
      .put("id", id)
      .put("latex", source)
      .put("widthCssPx", widthPx / density)
      .put("fontSizeCssPx", fontSizePx / density)
      .put("color", chatRenderCssColor(textColor))

  companion object {
    fun create(
      latex: String,
      widthPx: Int,
      darkMode: Boolean,
      textColor: Int,
      fontSizePx: Float,
      density: Float,
    ): ChatMathRenderRequest {
      val boundedWidth = widthPx.coerceAtLeast(1)
      val widthBucket = ((boundedWidth / MATH_WIDTH_BUCKET_PX) * MATH_WIDTH_BUCKET_PX).coerceAtLeast(MATH_WIDTH_BUCKET_PX)
      return ChatMathRenderRequest(
        key = ChatMathRenderKey(latex = latex, widthBucket = widthBucket, darkMode = darkMode),
        textColor = textColor,
        fontSizePx = fontSizePx,
        density = density,
      )
    }
  }
}

@Composable
internal fun ChatMathBlock(
  latex: String,
  textColor: Color,
) {
  val context = LocalContext.current
  val density = LocalDensity.current
  val darkMode = textColor.luminance() > 0.5f
  BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
    val widthPx = with(density) { maxWidth.roundToPx() }
    val fontSizePx = with(density) { 16.sp.toPx() }
    val densityScale = density.density
    val request =
      remember(latex, widthPx, darkMode, textColor, fontSizePx, densityScale) {
        ChatMathRenderRequest.create(
          latex = latex,
          widthPx = widthPx,
          darkMode = darkMode,
          textColor = textColor.toArgb(),
          fontSizePx = fontSizePx,
          density = densityScale,
        )
      }
    var bitmap by remember(request) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(request) { mutableStateOf(false) }
    DisposableEffect(request) {
      val subscription =
        ChatRichBlockRenderer.render(context, request) { result ->
          when (result) {
            is ChatRichBlockResult.Success -> {
              bitmap = result.value.bitmap
              failed = false
            }

            ChatRichBlockResult.Failure,
            ChatRichBlockResult.TransientFailure,
            -> {
              failed = true
            }
          }
        }
      onDispose { subscription.cancel() }
    }

    val rendered = bitmap
    if (rendered == null || failed) {
      ChatMathFallback(latex)
    } else {
      val scrollState = rememberScrollState()
      Box(
        modifier =
          Modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState),
      ) {
        Image(
          bitmap = rendered.asImageBitmap(),
          contentDescription = latex,
          modifier =
            Modifier
              .width(with(density) { rendered.width.toDp() })
              .height(with(density) { rendered.height.toDp() }),
        )
      }
    }
  }
}

@Composable
internal fun ChatMathFallback(latex: String) {
  ChatCodeBlock(code = latex, language = null)
}
