package ai.openclaw.app.ui

import ai.openclaw.app.node.CanvasController
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.webkit.WebView
import android.widget.Button
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.util.concurrent.atomic.AtomicInteger

const val canvasLifecycleSlowPageDelayMs = 2_000L

class CanvasLifecycleTestActivity : ComponentActivity() {
  val controller = CanvasController()

  internal var host: CanvasHostView? = null
    internal set

  var underlayClickCount: Int = 0
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      CanvasLifecycleTestContent(
        activity = this,
        onUnderlayClick = { underlayClickCount += 1 },
      )
    }
  }

  fun presentSlowPage(): Long = presentHtml(slowPageHtml)

  fun presentFastPage(): Long = presentHtml("<html><body>ready</body></html>")

  fun hideCanvas() {
    controller.hide()
  }

  fun showCanvas() {
    controller.show()
  }

  fun currentWebView(): WebView? = host?.currentWebView

  private fun presentHtml(html: String): Long {
    val startedAt = SystemClock.elapsedRealtime()
    val encoded = Base64.encodeToString(html.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    controller.navigate("data:text/html;base64,$encoded")
    controller.show()
    return SystemClock.elapsedRealtime() - startedAt
  }
}

@Composable
private fun CanvasLifecycleTestContent(
  activity: CanvasLifecycleTestActivity,
  onUnderlayClick: () -> Unit,
) {
  val state by activity.controller.presentationState.collectAsState()
  Box(modifier = Modifier.fillMaxSize()) {
    AndroidView(
      factory = { context ->
        Button(context).apply {
          setOnClickListener { onUnderlayClick() }
        }
      },
      modifier = Modifier.fillMaxSize(),
    )
    if (state != CanvasController.PresentationState.Unmounted) {
      AndroidView(
        factory = { context ->
          CanvasHostView(
            context = context,
            controller = activity.controller,
            isTrustedPage = { false },
            onA2uiMessage = {},
          ).also { host ->
            activity.host = host
            host.updateVisible(state == CanvasController.PresentationState.Visible)
          }
        },
        update = { host ->
          host.updateVisible(state == CanvasController.PresentationState.Visible)
        },
        modifier = Modifier.fillMaxSize(),
        onRelease = { host ->
          val hadWebView = host.currentWebView != null
          host.release()
          if (activity.host === host) activity.host = null
          CanvasLifecycleTestMetrics.hostReleaseCount.incrementAndGet()
          if (hadWebView) CanvasLifecycleTestMetrics.webViewDestroyCount.incrementAndGet()
        },
      )
    }
  }
}

object CanvasLifecycleTestMetrics {
  val hostReleaseCount = AtomicInteger()
  val webViewDestroyCount = AtomicInteger()

  fun reset() {
    hostReleaseCount.set(0)
    webViewDestroyCount.set(0)
  }
}

private val slowPageHtml =
  """
  <html>
    <body>
      <script>
        const deadline = Date.now() + $canvasLifecycleSlowPageDelayMs;
        while (Date.now() < deadline) {}
      </script>
      ready
    </body>
  </html>
  """.trimIndent()
