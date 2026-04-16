package ai.openclaw.app.ui

import android.annotation.SuppressLint
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import ai.openclaw.app.MainViewModel
import java.util.concurrent.atomic.AtomicReference

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CanvasScreen(viewModel: MainViewModel, visible: Boolean, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  val isDebuggable = (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
  val webViewRef = remember { mutableStateOf<WebView?>(null) }
  val currentPageUrlRef = remember { AtomicReference<String?>(null) }

  DisposableEffect(viewModel) {
    onDispose {
      val webView = webViewRef.value ?: return@onDispose
      viewModel.canvas.detach(webView)
      webView.removeJavascriptInterface(CanvasA2UIActionBridge.interfaceName)
      webView.stopLoading()
      webView.destroy()
      webViewRef.value = null
    }
  }

  AndroidView(
    modifier = modifier,
    factory = {
      WebView(context).apply {
        visibility = if (visible) View.VISIBLE else View.INVISIBLE
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.useWideViewPort = false
        settings.loadWithOverviewMode = false
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.setSupportZoom(false)
        // targetSdk 33+ ignores Force Dark APIs, so only opt out through the supported
        // algorithmic darkening flag when this WebView implementation exposes it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
          WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
        }
        if (isDebuggable) {
          Log.d("OpenClawWebView", "userAgent: ${settings.userAgentString}")
        }
        isScrollContainer = true
        overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        isVerticalScrollBarEnabled = true
        isHorizontalScrollBarEnabled = true
        webViewClient =
          object : WebViewClient() {
            override fun onPageStarted(
              view: WebView,
              url: String?,
              favicon: android.graphics.Bitmap?,
            ) {
              currentPageUrlRef.set(url)
            }

            override fun onReceivedError(
              view: WebView,
              request: WebResourceRequest,
              error: WebResourceError,
            ) {
              if (!isDebuggable || !request.isForMainFrame) return
              Log.e("OpenClawWebView", "onReceivedError: ${error.errorCode} ${error.description} ${request.url}")
            }

            override fun onReceivedHttpError(
              view: WebView,
              request: WebResourceRequest,
              errorResponse: WebResourceResponse,
            ) {
              if (!isDebuggable || !request.isForMainFrame) return
              Log.e(
                "OpenClawWebView",
                "onReceivedHttpError: ${errorResponse.statusCode} ${errorResponse.reasonPhrase} ${request.url}",
              )
            }

            override fun onPageFinished(view: WebView, url: String?) {
              currentPageUrlRef.set(url)
              if (isDebuggable) {
                Log.d("OpenClawWebView", "onPageFinished: $url")
              }
              viewModel.canvas.onPageFinished()
            }

            override fun onRenderProcessGone(
              view: WebView,
              detail: android.webkit.RenderProcessGoneDetail,
            ): Boolean {
              if (isDebuggable) {
                Log.e(
                  "OpenClawWebView",
                  "onRenderProcessGone didCrash=${detail.didCrash()} priorityAtExit=${detail.rendererPriorityAtExit()}",
                )
              }
              return true
            }
          }
        webChromeClient =
          object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
              if (!isDebuggable) return false
              val msg = consoleMessage ?: return false
              Log.d(
                "OpenClawWebView",
                "console ${msg.messageLevel()} @ ${msg.sourceId()}:${msg.lineNumber()} ${msg.message()}",
              )
              return false
            }
          }

        val bridge =
          CanvasA2UIActionBridge(
            isTrustedPage = { viewModel.isTrustedCanvasActionUrl(currentPageUrlRef.get()) },
          ) { payload ->
            viewModel.handleCanvasA2UIActionFromWebView(payload)
          }
        addJavascriptInterface(bridge, CanvasA2UIActionBridge.interfaceName)
        viewModel.canvas.attach(this)
        webViewRef.value = this
      }
    },
    update = { webView ->
      webView.visibility = if (visible) View.VISIBLE else View.INVISIBLE
      if (visible) {
        webView.resumeTimers()
        webView.onResume()
      } else {
        webView.onPause()
        webView.pauseTimers()
      }
    },
  )
}

internal class CanvasA2UIActionBridge(
  private val isTrustedPage: () -> Boolean,
  private val onMessage: (String) -> Unit,
) {
  @JavascriptInterface
  fun postMessage(payload: String?) {
    val msg = payload?.trim().orEmpty()
    if (msg.isEmpty()) return
    if (!isTrustedPage()) return
    onMessage(msg)
  }

  companion object {
    const val interfaceName: String = "openclawCanvasA2UIAction"
  }
}
