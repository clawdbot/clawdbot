package ai.openclaw.app.ui.design

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import coil3.compose.AsyncImagePainter
import coil3.compose.rememberAsyncImagePainter
import java.util.Locale

internal fun providerIconSlug(provider: String): String? {
  val normalized = provider.trim().lowercase(Locale.US)
  if (normalized.isEmpty()) return null
  return when (normalized) {
    "anthropic", "claude-cli" -> "claude"
    "amazon", "amazon-bedrock", "aws", "aws-bedrock" -> "bedrock"
    "cloudflare-ai-gateway" -> "cloudflare"
    "google", "google-ai", "google-gemini-cli" -> "gemini"
    "copilot-proxy", "github", "github-copilot" -> "copilot"
    "kilocode" -> "kilo"
    "kimi-coding", "moonshot" -> "kimi"
    "microsoft-foundry" -> "microsoft"
    "minimax-portal" -> "minimax"
    "ollama-cloud" -> "ollama"
    "openai", "openai-codex" -> "codex"
    "qwen", "qwen-token-plan" -> "alibaba"
    "stepfun-plan" -> "stepfun"
    "tencent-tokenhub", "tencent-tokenplan" -> "tencent"
    "vercel-ai-gateway" -> "vercel"
    "x-ai", "xai" -> "grok"
    "xiaomi", "xiaomi-token-plan" -> "mimo"
    "google-vertex", "vertex", "vertex-ai" -> "vertexai"
    "hugging-face" -> "huggingface"
    "llama.cpp" -> "llamacpp"
    "lm-studio" -> "lmstudio"
    else -> normalized.filter(Char::isLetterOrDigit).takeIf(String::isNotEmpty)
  }
}

internal fun providerFallbackLabel(provider: String): String =
  provider
    .trim()
    .firstOrNull(Char::isLetterOrDigit)
    ?.uppercaseChar()
    ?.toString()
    .orEmpty()

internal fun providerBrandTintArgb(slug: String?): Long? =
  when (slug) {
    "codex" -> 0xFF10A37FL
    "claude" -> 0xFFD97757L
    "gemini" -> 0xFF4285F4L
    else -> null
  }

@Composable
internal fun ProviderBrandIcon(
  provider: String,
  size: Dp,
  modifier: Modifier = Modifier,
) {
  val slug = providerIconSlug(provider)
  val painter = rememberAsyncImagePainter(slug?.let { "file:///android_asset/ProviderIcon-$it.svg" })
  val painterState by painter.state.collectAsState()
  val iconTint = providerBrandTintArgb(slug)?.let { argb -> Color(argb) } ?: ClawTheme.colors.text

  Box(
    modifier = modifier.size(size),
    contentAlignment = Alignment.Center,
  ) {
    if (painterState is AsyncImagePainter.State.Success) {
      Image(
        painter = painter,
        contentDescription = null,
        modifier = Modifier.fillMaxSize(),
        contentScale = ContentScale.Fit,
        colorFilter = ColorFilter.tint(iconTint),
      )
    } else {
      Surface(
        modifier = Modifier.fillMaxSize(),
        shape = CircleShape,
        color = ClawTheme.colors.surfacePressed,
        contentColor = ClawTheme.colors.textMuted,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text = providerFallbackLabel(provider),
            style = ClawTheme.type.caption,
            maxLines = 1,
          )
        }
      }
    }
  }
}
