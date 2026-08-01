package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.node.CanvasController
import ai.openclaw.app.node.CanvasNavigationPolicy
import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicReference

/** Hosts the gateway canvas WebView and attaches it to the runtime canvas controller. */
@SuppressLint("SetJavaScriptEnabled")
@Suppress("DEPRECATION")
@Composable
fun CanvasScreen(
  viewModel: MainViewModel,
  visible: Boolean,
  modifier: Modifier = Modifier,
) {
  AndroidView(
    modifier = modifier,
    factory = { context ->
      CanvasHostView(
        context = context,
        controller = viewModel.canvas,
        isTrustedPage = viewModel::isTrustedCanvasActionUrl,
        onA2uiMessage = viewModel::handleCanvasA2UIActionFromWebView,
      ).apply {
        updateVisible(visible)
      }
    },
    update = { host -> host.updateVisible(visible) },
    onRelease = CanvasHostView::release,
  )
}

/**
 * Retained shell host whose WebView child can be replaced after renderer death.
 *
 * Compose creates this host directly; XML inflation cannot supply its controller and callbacks.
 */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
@Suppress("DEPRECATION")
internal class CanvasHostView(
  context: Context,
  private val controller: CanvasController,
  private val isTrustedPage: (String?) -> Boolean,
  private val onA2uiMessage: (String) -> Unit,
) : FrameLayout(context) {
  internal var currentWebView: WebView? = null
    private set

  private val isDebuggable =
    (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
  private val currentPageUrlRef = AtomicReference<String?>(null)

  init {
    visibility = View.INVISIBLE
  }

  fun updateVisible(visible: Boolean) {
    if (visible) {
      val webView = currentWebView ?: createWebView()
      visibility = View.VISIBLE
      webView.visibility = View.VISIBLE
      webView.onResume()
      return
    }
    visibility = View.INVISIBLE
    currentWebView?.let { webView ->
      webView.visibility = View.INVISIBLE
      webView.onPause()
    }
  }

  fun release() {
    controller.releaseHost()
    currentWebView?.let(::destroyWebView)
  }

  private fun createWebView(): WebView =
    WebView(context).also { webView ->
      val webSettings = webView.settings
      webSettings.setAllowContentAccess(false)
      webSettings.setAllowFileAccess(false)
      webSettings.setAllowFileAccessFromFileURLs(false)
      webSettings.setAllowUniversalAccessFromFileURLs(false)
      webSettings.setSafeBrowsingEnabled(true)
      webSettings.javaScriptEnabled = true
      webSettings.domStorageEnabled = true
      webSettings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      webSettings.useWideViewPort = false
      webSettings.loadWithOverviewMode = false
      webSettings.builtInZoomControls = false
      webSettings.displayZoomControls = false
      webSettings.setSupportZoom(false)
      webView.visibility = View.INVISIBLE
      // targetSdk 33+ ignores Force Dark APIs, so only opt out through the supported
      // algorithmic darkening flag when this WebView implementation exposes it.
      if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
        WebSettingsCompat.setAlgorithmicDarkeningAllowed(webSettings, false)
      }
      if (isDebuggable) {
        Log.d("OpenClawWebView", "userAgent: ${webSettings.userAgentString}")
      }
      webView.isScrollContainer = true
      webView.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
      webView.isVerticalScrollBarEnabled = true
      webView.isHorizontalScrollBarEnabled = true
      webView.webViewClient =
        object : WebViewClient() {
          override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
          ): Boolean {
            if (!request.isForMainFrame) return false
            return blockUnsafeCanvasNavigation(controller, currentPageUrlRef, request.url.toString())
          }

          override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
          ): WebResourceResponse? {
            val shouldBlock =
              CanvasNavigationPolicy.shouldBlockNonGetMainFrame(
                method = request.method,
                isForMainFrame = request.isForMainFrame,
              )
            if (!shouldBlock) return null
            // shouldOverrideUrlLoading excludes POST navigations and their redirects. WebView does
            // not expose those redirect targets, so non-GET main-frame loads fail closed here.
            currentPageUrlRef.set(null)
            view.post { controller.navigate("") }
            return blockedCanvasResponse()
          }

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

          override fun onPageFinished(
            view: WebView,
            url: String?,
          ) {
            currentPageUrlRef.set(url)
            if (isDebuggable) {
              Log.d("OpenClawWebView", "onPageFinished: $url")
            }
            controller.onPageFinished()
          }

          override fun onRenderProcessGone(
            view: WebView,
            detail: RenderProcessGoneDetail,
          ): Boolean {
            if (isDebuggable) {
              Log.e(
                "OpenClawWebView",
                "onRenderProcessGone didCrash=${detail.didCrash()} priorityAtExit=${detail.rendererPriorityAtExit()}",
              )
            }
            if (view === currentWebView) {
              controller.onRenderProcessGone(view)
              destroyWebView(view)
              visibility = View.INVISIBLE
            }
            return true
          }
        }
      webView.webChromeClient =
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

      // The listener accepts any WebView origin at registration time; native
      // dispatch still requires the live URL to be an app-owned bundled page.
      val bridge =
        CanvasA2UIActionBridge(
          isTrustedPage = { isTrustedPage(currentPageUrlRef.get()) },
          onMessage = onA2uiMessage,
        )
      if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        WebViewCompat.addWebMessageListener(
          webView,
          CanvasA2UIActionBridge.interfaceName,
          CanvasA2UIActionBridge.allowedOriginRules,
          bridge,
        )
      } else if (isDebuggable) {
        Log.w("OpenClawWebView", "WebMessageListener unsupported; canvas actions disabled")
      }
      addView(
        webView,
        ViewGroup.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
      currentWebView = webView
      controller.attach(webView)
    }

  private fun destroyWebView(webView: WebView) {
    if (currentWebView !== webView) return
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.removeWebMessageListener(webView, CanvasA2UIActionBridge.interfaceName)
    }
    removeView(webView)
    webView.stopLoading()
    webView.destroy()
    currentWebView = null
  }
}

private fun blockUnsafeCanvasNavigation(
  controller: CanvasController,
  currentPageUrlRef: AtomicReference<String?>,
  rawUrl: String,
): Boolean {
  val url = rawUrl.trim()
  if (!CanvasNavigationPolicy.shouldBlock(url)) return false
  currentPageUrlRef.set(null)
  controller.navigate("")
  return true
}

private fun blockedCanvasResponse(): WebResourceResponse =
  WebResourceResponse(
    "text/plain",
    "UTF-8",
    403,
    "Blocked",
    mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream(ByteArray(0)),
  )

/** Filters WebView postMessage payloads before they enter the A2UI action handler. */
internal class CanvasA2UIActionBridge(
  private val isTrustedPage: () -> Boolean,
  private val onMessage: (String) -> Unit,
) : WebViewCompat.WebMessageListener {
  override fun onPostMessage(
    view: WebView,
    message: WebMessageCompat,
    sourceOrigin: Uri,
    isMainFrame: Boolean,
    replyProxy: JavaScriptReplyProxy,
  ) {
    if (!isMainFrame) return
    postMessage(message.data)
  }

  fun postMessage(payload: String?) {
    val msg = payload?.trim().orEmpty()
    if (msg.isEmpty()) return
    if (!isTrustedPage()) return
    onMessage(msg)
  }

  companion object {
    const val interfaceName: String = "openclawCanvasA2UIAction"
    val allowedOriginRules: Set<String> = setOf("*")
  }
}
