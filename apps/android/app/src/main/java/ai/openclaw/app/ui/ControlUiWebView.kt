package ai.openclaw.app.ui

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.gateway.normalizeGatewayTlsFingerprintInput
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
      // The native gateway connection already established this route's trust.
      // Reuse only that exact accepted fingerprint; every other SSL error cancels.
      // The same client protects both terminal and dashboard pages.
      webView.webViewClient = ControlUiWebViewClient(page)
      installControlUiAuthScript(webView, page)
      webView.loadUrl(url)
      webViewRef[0] = webView
      webView
    },
  )
}

/**
 * Hands gateway credentials through the origin-restricted native startup contract,
 * keeping them out of page URLs and WebView history.
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

private const val X509_CERTIFICATE_BUNDLE_KEY = "x509-certificate"

private class ControlUiWebViewClient(
  private val page: NodeRuntime.GatewayControlPage,
) : WebViewClient() {
  // Android lint cannot infer the exact pin and origin checks below; every other path cancels.
  // WebView exposes no pre-document certificate hook for successful CA-trusted handshakes;
  // this callback extends native pin trust only to recoverable self-signed errors.
  @SuppressLint("WebViewClientOnReceivedSslError")
  override fun onReceivedSslError(
    view: WebView,
    handler: android.webkit.SslErrorHandler,
    error: android.net.http.SslError,
  ) {
    // SslCertificate exposes the encoded leaf only through its AOSP saveState bundle.
    val encodedCertificate =
      android.net.http.SslCertificate
        .saveState(error.certificate)
        ?.getByteArray(X509_CERTIFICATE_BUNDLE_KEY)
    if (
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = page.baseUrl,
        expectedFingerprint = page.tlsFingerprintSha256,
        errorUrl = error.url,
        encodedCertificate = encodedCertificate,
      )
    ) {
      // The native gateway connection already accepted this exact certificate.
      // Never extend the exception to another origin or a different certificate.
      handler.proceed()
    } else {
      handler.cancel()
    }
  }
}

internal fun shouldProceedForPinnedControlUiSslError(
  pageBaseUrl: String,
  expectedFingerprint: String?,
  errorUrl: String?,
  encodedCertificate: ByteArray?,
): Boolean {
  val expected =
    expectedFingerprint
      ?.let(::normalizeGatewayTlsFingerprintInput)
      ?: return false
  val certificate = encodedCertificate ?: return false
  if (!sameHttpsOrigin(pageBaseUrl, errorUrl)) return false
  return java.security.MessageDigest
    .getInstance("SHA-256")
    .digest(certificate)
    .joinToString(separator = "") { byte ->
      "%02x".format(java.util.Locale.US, byte.toInt() and 0xff)
    } == expected
}

private fun sameHttpsOrigin(
  pageBaseUrl: String,
  errorUrl: String?,
): Boolean {
  val pageOrigin = parsedHttpsOrigin(pageBaseUrl) ?: return false
  val errorOrigin = errorUrl?.let(::parsedHttpsOrigin) ?: return false
  return pageOrigin == errorOrigin
}

private data class HttpsOrigin(
  val host: String,
  val port: Int,
)

private fun parsedHttpsOrigin(rawUrl: String): HttpsOrigin? {
  val uri = rawUrl.toUri()
  if (!uri.scheme.equals("https", ignoreCase = true)) return null
  val host = uri.host?.lowercase(java.util.Locale.US) ?: return null
  val port = uri.port.takeIf { it >= 0 } ?: 443
  return HttpsOrigin(host = host, port = port)
}
