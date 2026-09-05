package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import android.annotation.SuppressLint
import android.util.Base64
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
internal fun ChatMermaidPreview(
  svg: String,
  background: Color,
  onDismiss: () -> Unit,
) {
  var failed by remember(svg) { mutableStateOf(false) }
  Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
    Column(modifier = Modifier.fillMaxSize().background(background).windowInsetsPadding(WindowInsets.safeDrawing)) {
      Surface(modifier = Modifier.align(Alignment.End).padding(horizontal = 8.dp), color = background) {
        IconButton(onClick = onDismiss) {
          Icon(Icons.Default.Close, contentDescription = nativeString("Close diagram preview"), modifier = Modifier.size(24.dp), tint = ClawTheme.colors.text)
        }
      }
      Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
        if (failed) {
          Text(
            nativeString("Diagram preview unavailable"),
            modifier = Modifier.align(Alignment.Center).padding(24.dp),
            color = ClawTheme.colors.text,
          )
        } else {
          MermaidSvgView(svg, background, onFailure = { failed = true })
        }
      }
    }
  }
}

// SVG stays an image document, not inline active markup. JavaScript and every network/
// file route are disabled; native WebView zoom keeps labels sharp without another engine.
@SuppressLint("MissingOnRenderProcessGone")
@Suppress("DEPRECATION")
@Composable
private fun MermaidSvgView(
  svg: String,
  background: Color,
  onFailure: () -> Unit,
) {
  val html = remember(svg) { mermaidPreviewHtml(svg) }
  key(svg, background) {
    val handle = remember { MermaidPreviewHandle() }
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = { context ->
        WebView(context).apply {
          // WRAP_CONTENT forces WebView's CSS viewport height to zero, even with exact measured bounds.
          layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
          setBackgroundColor(background.toArgb())
          settings.apply {
            javaScriptEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            blockNetworkLoads = true
            domStorageEnabled = false
            databaseEnabled = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            setSupportMultipleWindows(false)
          }
          webViewClient =
            object : WebViewClient() {
              override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
              ): Boolean = true

              override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
              ): WebResourceResponse? = if (request?.url?.scheme == "data") null else emptyRenderResponse()

              override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
              ): Boolean {
                handle.release(view)
                onFailure()
                return true
              }
            }
          loadDataWithBaseURL("$CHAT_RENDER_ORIGIN/mermaid-preview/", html, "text/html", "UTF-8", null)
        }
      },
      onRelease = handle::release,
    )
  }
}

private class MermaidPreviewHandle {
  private var released = false

  fun release(view: WebView) {
    if (released) return
    released = true
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
  }
}

private fun mermaidPreviewHtml(svg: String): String {
  val encoded = Base64.encodeToString(svg.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
  return """
    <!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8, user-scalable=yes">
    <style>html,body{margin:0;min-height:100%;background:transparent}html{height:100%}body{display:flex;align-items:center}img{display:block;width:100%;height:auto}</style>
    </head><body><img alt="" src="data:image/svg+xml;base64,$encoded"></body></html>
    """.trimIndent()
}
