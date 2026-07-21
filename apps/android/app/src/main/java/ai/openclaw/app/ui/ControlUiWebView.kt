package ai.openclaw.app.ui

import ai.openclaw.app.NodeRuntime
import android.annotation.SuppressLint
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Authenticated, hardened WebView host for gateway-served Control UI pages. */
@SuppressLint("SetJavaScriptEnabled")
// Deprecated file-URL settings are still force-disabled defensively, like the canvas host.
@Suppress("DEPRECATION")
@Composable
internal fun ControlUiWebView(
  page: NodeRuntime.GatewayControlPage,
  url: String,
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
      if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
        WebSettingsCompat.setAlgorithmicDarkeningAllowed(webSettings, false)
      }
      webView.overScrollMode = View.OVER_SCROLL_NEVER
      // System trust only, matching the terminal host this was extracted from:
      // fingerprint-pinned (self-signed) gateways render natively but not here.
      // Tracked follow-up: verified SSL handling shared with the native pin.
      webView.webViewClient = WebViewClient()
      installControlUiAuthScript(webView, page)
      webView.loadUrl(url)
      webViewRef[0] = webView
      webView
    },
  )
}

/**
 * Hands gateway credentials to the Control UI through its native startup
 * contract. The script is restricted to the connected gateway origin, so
 * credentials never appear in page URLs or WebView history.
 */
private fun installControlUiAuthScript(
  webView: WebView,
  page: NodeRuntime.GatewayControlPage,
) {
  if (page.token == null && page.password == null) return
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
  // Document-start rules are origins (scheme://host[:port]); a base-path URL
  // is an invalid rule and throws while constructing the WebView.
  val originRule = controlUiOriginRule(page.baseUrl) ?: return
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
  WebViewCompat.addDocumentStartJavaScript(webView, script, setOf(originRule))
}

/** scheme://host[:port] origin for WebView script rules; brackets IPv6 hosts. */
internal fun controlUiOriginRule(baseUrl: String): String? {
  val uri = baseUrl.toUri()
  val scheme = uri.scheme ?: return null
  val host = uri.host ?: return null
  val hostPart = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
  val port = if (uri.port != -1) ":${uri.port}" else ""
  return "$scheme://$hostPart$port"
}
