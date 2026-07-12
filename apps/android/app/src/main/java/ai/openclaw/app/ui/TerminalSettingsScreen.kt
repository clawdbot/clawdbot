package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import android.annotation.SuppressLint
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Full-height terminal surface: embeds the gateway-served terminal-only
 * Control UI document (`/?view=terminal`, the same ghostty-web surface the
 * desktop Control UI uses) for the currently connected gateway.
 */
@Composable
internal fun TerminalSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  ClawScaffold(
    contentPadding = PaddingValues(start = ClawTheme.spacing.lg, top = 14.dp, end = ClawTheme.spacing.lg, bottom = 6.dp),
  ) {
    Column(modifier = Modifier.fillMaxSize().imePadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        ClawPlainIconButton(
          icon = Icons.AutoMirrored.Filled.ArrowBack,
          contentDescription = nativeString("Back"),
          onClick = onBack,
        )
        Text(text = nativeString("Terminal"), style = ClawTheme.type.title, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(imageVector = Icons.Outlined.Terminal, contentDescription = null, tint = ClawTheme.colors.textMuted)
      }
      Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
        val page = controlPage
        if (isConnected && page != null) {
          // Recreate the WebView only when the gateway page or credentials
          // change; recompositions must not restart live shell sessions.
          key(page) {
            TerminalWebView(page = page, modifier = Modifier.fillMaxSize())
          }
        } else {
          Column(modifier = Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(text = nativeString("Terminal needs a connected gateway"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = nativeString("Connect to your gateway to open a shell in the agent workspace."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      }
    }
  }
}

/** Minimal WebView host for the terminal page; no script bridges needed. */
@SuppressLint("SetJavaScriptEnabled")
// Deprecated file-URL settings are still force-disabled defensively, like the canvas host.
@Suppress("DEPRECATION")
@Composable
private fun TerminalWebView(
  page: NodeRuntime.GatewayControlPage,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val webViewRef = remember { arrayOfNulls<WebView>(1) }

  DisposableEffect(Unit) {
    onDispose {
      val webView = webViewRef[0] ?: return@onDispose
      webView.stopLoading()
      webView.destroy()
      webViewRef[0] = null
    }
  }

  AndroidView(
    modifier = modifier,
    factory = {
      val webView = WebView(context)
      val webSettings = webView.settings
      webSettings.setAllowContentAccess(false)
      webSettings.setAllowFileAccess(false)
      webSettings.setAllowFileAccessFromFileURLs(false)
      webSettings.setAllowUniversalAccessFromFileURLs(false)
      webSettings.setSafeBrowsingEnabled(true)
      webSettings.javaScriptEnabled = true
      webSettings.domStorageEnabled = true
      webSettings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      webSettings.builtInZoomControls = false
      webSettings.displayZoomControls = false
      webSettings.setSupportZoom(false)
      // targetSdk 33+ ignores Force Dark APIs; the terminal page owns its own
      // dark palette, so opt out of algorithmic darkening like the canvas host.
      if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
        WebSettingsCompat.setAlgorithmicDarkeningAllowed(webSettings, false)
      }
      webView.overScrollMode = View.OVER_SCROLL_NEVER
      webView.webViewClient = WebViewClient()
      installTerminalAuthScript(webView, page)
      webView.loadUrl("${page.baseUrl}/?view=terminal")
      webViewRef[0] = webView
      webView
    },
  )
}

/**
 * Hands the gateway credentials to the Control UI via its
 * `__OPENCLAW_NATIVE_CONTROL_AUTH__` startup contract (the same mechanism the
 * macOS Dashboard and iOS Terminal hub use), origin-locked by the platform's
 * allowed-origin rules, so the token never appears in the page URL. Without
 * document-start script support the page simply shows its own login gate.
 */
private fun installTerminalAuthScript(
  webView: WebView,
  page: NodeRuntime.GatewayControlPage,
) {
  if (page.token == null && page.password == null) return
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
  val gatewayUrl = page.baseUrl.replaceFirst("http", "ws")
  val payload =
    buildJsonObject {
      put("gatewayUrl", gatewayUrl)
      page.token?.let { put("token", it) }
      page.password?.let { put("password", it) }
    }
  val script =
    """
    (() => {
      try {
        Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
          value: $payload,
          configurable: true,
        });
      } catch (e) {}
    })();
    """.trimIndent()
  WebViewCompat.addDocumentStartJavaScript(webView, script, setOf(page.baseUrl))
}
