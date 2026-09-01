package ai.openclaw.app.ui.chat

import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [36],
  instrumentedPackages = ["androidx.webkit"],
  shadows = [RichBlockWebViewFeatureShadow::class, RichBlockWebViewCompatShadow::class],
)
class ChatRichBlockRendererLifecycleTest {
  @Test
  fun destroyingMathHostRetiresDocumentBeforeReentrantRender() {
    assertHostDestruction(ChatRichBlockKind.Math)
  }

  @Test
  fun destroyingMermaidHostRetiresDocumentBeforeReentrantRender() {
    assertHostDestruction(ChatRichBlockKind.Mermaid)
  }

  private fun assertHostDestruction(kind: ChatRichBlockKind) {
    val oldActivity = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val replacementActivity = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    lateinit var retired: WebView
    var destroyedBeforeCompletion = false
    var outcome: ChatRichBlockResult<ChatRichBlockImage>? = null
    var replacementSubscription: ChatRenderCancellation? = null
    ChatRichBlockRenderer.render(oldActivity.get(), request(kind, "old")) { result ->
      outcome = result
      destroyedBeforeCompletion = shadowOf(retired).wasDestroyCalled()
      replacementSubscription = ChatRichBlockRenderer.render(replacementActivity.get(), request(kind, "fresh")) {}
    }
    retired = findRenderer(oldActivity.get().window.decorView as ViewGroup)
    val retiredClient = retired.webViewClient
    val shellUrl = "$CHAT_RENDER_ORIGIN/assets/${kind.assetDirectory}/index.html"
    retiredClient.onPageFinished(retired, shellUrl)
    assertTrue(shadowOf(retired).lastEvaluatedJavascript.contains("old"))

    oldActivity.pause().stop().destroy()
    try {
      assertEquals(ChatRichBlockResult.TransientFailure, outcome)
      assertTrue("The retired document must lose authority before a completion can reenter render", destroyedBeforeCompletion)
      assertNull(retired.parent)
      val replacement = findRenderer(replacementActivity.get().window.decorView as ViewGroup)
      assertNotSame(retired, replacement)
      assertNull(shadowOf(replacement).lastEvaluatedJavascript)

      retiredClient.onPageFinished(retired, shellUrl)
      assertNull("A late load from the destroyed document cannot ready its replacement", shadowOf(replacement).lastEvaluatedJavascript)
      replacement.webViewClient.onPageFinished(replacement, shellUrl)
      assertTrue(shadowOf(replacement).lastEvaluatedJavascript.contains("fresh"))
    } finally {
      replacementSubscription?.cancel()
      replacementActivity.pause().stop().destroy()
    }
  }

  private fun findRenderer(host: ViewGroup): WebView = (0 until host.childCount).map(host::getChildAt).filterIsInstance<WebView>().single()

  private fun request(
    kind: ChatRichBlockKind,
    source: String,
  ): ChatRichBlockRequest =
    when (kind) {
      ChatRichBlockKind.Math -> {
        ChatMathRenderRequest.create(source, widthPx = 320, darkMode = false, textColor = 0xff000000.toInt(), fontSizePx = 16f, density = 1f)
      }

      ChatRichBlockKind.Mermaid -> {
        ChatMermaidRequest(
          "flowchart LR\nA[$source] --> B[End]",
          widthPx = 320,
          density = 1f,
          theme = ChatMermaidTheme("#ffffff", "#000000", "#666666", "#cccccc", "#ff0000", darkMode = false),
        )
      }
    }
}

// Robolectric has no AndroidX renderer bridge; only this platform capability is
// substituted. Activity callbacks, WebView ownership, and queue completion are real.
@Implements(value = WebViewFeature::class, isInAndroidSdk = false)
class RichBlockWebViewFeatureShadow {
  companion object {
    @JvmStatic
    @Implementation
    fun isFeatureSupported(feature: String): Boolean = feature == WebViewFeature.WEB_MESSAGE_LISTENER
  }
}

@Implements(value = WebViewCompat::class, isInAndroidSdk = false)
class RichBlockWebViewCompatShadow {
  companion object {
    @JvmStatic
    @Implementation
    fun addWebMessageListener(
      view: WebView,
      name: String,
      origins: Set<String>,
      listener: WebViewCompat.WebMessageListener,
    ) = Unit

    @JvmStatic
    @Implementation
    fun removeWebMessageListener(
      view: WebView,
      name: String,
    ) = Unit
  }
}
