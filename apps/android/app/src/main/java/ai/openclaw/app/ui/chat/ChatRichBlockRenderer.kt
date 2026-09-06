package ai.openclaw.app.ui.chat

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.graphics.createBitmap
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayInputStream
import java.lang.ref.WeakReference
import java.util.Locale
import kotlin.math.ceil
import android.graphics.Color as AndroidColor

internal const val CHAT_RENDER_ORIGIN = "https://appassets.androidplatform.net"
internal const val CHAT_MERMAID_MAX_SOURCE_CHARS = 20_000
internal const val CHAT_MERMAID_MAX_SVG_CHARS = 1_000_000
private const val RENDER_MAX_BITMAP_DIMENSION = 8192
private const val RENDER_NEGATIVE_CACHE_ENTRIES = 64

internal data class ChatRichBlockImage(
  val bitmap: Bitmap,
  val svg: String?,
)

private class ChatRichBlockBitmapCache(
  maxBytes: Int,
) : ChatRichBlockCache<ChatRichBlockImage> {
  private val images =
    object : LruCache<ChatRichBlockRequest, ChatRichBlockImage>(maxBytes) {
      override fun sizeOf(
        key: ChatRichBlockRequest,
        value: ChatRichBlockImage,
      ): Int = value.bitmap.allocationByteCount + (value.svg?.length ?: 0) * 2 + key.source.length * 2
    }
  private val failures = LinkedHashMap<ChatRichBlockRequest, Unit>(RENDER_NEGATIVE_CACHE_ENTRIES, 0.75f, true)

  override fun get(request: ChatRichBlockRequest): ChatRichBlockResult<ChatRichBlockImage>? {
    images.get(request)?.let { return ChatRichBlockResult.Success(it) }
    return if (failures[request] != null) ChatRichBlockResult.Failure else null
  }

  override fun put(
    request: ChatRichBlockRequest,
    result: ChatRichBlockResult<ChatRichBlockImage>,
  ) {
    when (result) {
      is ChatRichBlockResult.Success -> {
        failures.remove(request)
        images.put(request, result.value)
      }

      ChatRichBlockResult.Failure -> {
        failures[request] = Unit
        while (failures.size > RENDER_NEGATIVE_CACHE_ENTRIES) failures.remove(failures.entries.first().key)
      }

      ChatRichBlockResult.TransientFailure -> {}
    }
  }
}

internal data class ChatRichBlockRenderMessage(
  val id: String,
  val success: Boolean,
  val widthCssPx: Double,
  val heightCssPx: Double,
  val svg: String?,
  val retryable: Boolean = false,
)

internal fun parseChatRichBlockRenderMessage(
  payload: String?,
  kind: ChatRichBlockKind,
): ChatRichBlockRenderMessage? {
  // JSON string escaping can expand a bounded SVG by six times. Reject the envelope
  // before parsing, then bound the decoded SVG independently.
  val maxMessageChars = if (kind == ChatRichBlockKind.Mermaid) CHAT_MERMAID_MAX_SVG_CHARS * 6 + 4096 else 4096
  if (payload == null || payload.length > maxMessageChars) return null
  return runCatching {
    val value = Json.parseToJsonElement(payload).jsonObject
    val id = value["id"]?.jsonPrimitive?.takeIf { it.isString }?.content ?: return@runCatching null
    if (id.isEmpty() || id.length > 32) return@runCatching null
    val success = value["success"]?.jsonPrimitive?.booleanOrNull ?: return@runCatching null
    if (!success) {
      return@runCatching ChatRichBlockRenderMessage(
        id,
        false,
        0.0,
        0.0,
        null,
        retryable = value["retryable"]?.jsonPrimitive?.booleanOrNull == true,
      )
    }
    val width = value["widthCssPx"]?.jsonPrimitive?.doubleOrNull ?: return@runCatching null
    val height = value["heightCssPx"]?.jsonPrimitive?.doubleOrNull ?: return@runCatching null
    val svg =
      if (kind == ChatRichBlockKind.Mermaid) {
        value["svg"]
          ?.jsonPrimitive
          ?.takeIf { it.isString }
          ?.content
          ?.takeIf { it.isNotEmpty() && it.length <= CHAT_MERMAID_MAX_SVG_CHARS }
          ?: return@runCatching null
      } else {
        null
      }
    ChatRichBlockRenderMessage(id, true, width, height, svg)
  }.getOrNull()
}

internal fun bitmapDimension(
  cssPixels: Double,
  density: Float,
): Int? {
  val scale = density.toDouble()
  if (!cssPixels.isFinite() || cssPixels <= 0.0 || !scale.isFinite() || scale <= 0.0) return null
  if (cssPixels > RENDER_MAX_BITMAP_DIMENSION.toDouble() / scale) return null
  return ceil(cssPixels * scale).takeIf { it in 1.0..RENDER_MAX_BITMAP_DIMENSION.toDouble() }?.toInt()
}

/** One lazy renderer per bundled document; chat rows contain only passive native images. */
internal object ChatRichBlockRenderer {
  private val handler = Handler(Looper.getMainLooper())

  // Backends use the Application context and weak activity hosts. Keeping math and
  // diagrams warm separately avoids reloading both engines in mixed replies.
  @SuppressLint("StaticFieldLeak")
  private val renderers = mutableMapOf<ChatRichBlockKind, Renderer>()

  fun render(
    context: Context,
    request: ChatRichBlockRequest,
    completion: (ChatRichBlockResult<ChatRichBlockImage>) -> Unit,
  ): ChatRenderCancellation {
    check(Looper.myLooper() == Looper.getMainLooper()) { "ChatRichBlockRenderer must run on the main thread" }
    if (request.kind == ChatRichBlockKind.Mermaid && request.source.length > CHAT_MERMAID_MAX_SOURCE_CHARS) {
      completion(ChatRichBlockResult.Failure)
      return ChatRenderCancellation {}
    }
    val host = context.findActivity()?.window?.decorView as? ViewGroup
    if (host == null) {
      completion(ChatRichBlockResult.TransientFailure)
      return ChatRenderCancellation {}
    }
    val renderer =
      renderers.getOrPut(request.kind) {
        val backend = ChatRichBlockWebViewBackend(context.applicationContext as Application, host, request.kind)
        Renderer(
          backend,
          ChatRichBlockCoordinator(
            backend,
            ChatRichBlockBitmapCache(request.kind.cacheBytes),
            ChatRenderTimeoutScheduler { delayMs, action ->
              val runnable = Runnable(action)
              handler.postDelayed(runnable, delayMs)
              ChatRenderCancellation { handler.removeCallbacks(runnable) }
            },
          ),
        )
      }
    renderer.backend.updateHost(host)
    return renderer.coordinator.render(request, completion)
  }

  private data class Renderer(
    val backend: ChatRichBlockWebViewBackend,
    val coordinator: ChatRichBlockCoordinator<ChatRichBlockImage>,
  )
}

private class ChatRichBlockWebViewBackend(
  private val application: Application,
  host: ViewGroup,
  private val kind: ChatRichBlockKind,
) : ChatRichBlockBackend<ChatRichBlockImage> {
  private val handler = Handler(Looper.getMainLooper())
  private val assetLoader =
    WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(application)).build()
  private val shellUrl = "$CHAT_RENDER_ORIGIN/assets/${kind.assetDirectory}/index.html"
  private var host = WeakReference(host)
  private var ready = false
  private var nextRenderId = 0L
  private var active: ActiveRender? = null
  private var webView: WebView? = null

  init {
    application.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityDestroyed(activity: Activity) {
          if (this@ChatRichBlockWebViewBackend.host.get() !== activity.window.decorView) return
          this@ChatRichBlockWebViewBackend.host.clear()
          val interrupted = active
          // Completion may synchronously admit work for the next Activity. Retire
          // the old document first so neither its scripts nor callbacks survive.
          reset()
          interrupted?.completion?.invoke(ChatRichBlockResult.TransientFailure)
        }

        override fun onActivityCreated(
          activity: Activity,
          savedInstanceState: Bundle?,
        ) = Unit

        override fun onActivityStarted(activity: Activity) = Unit

        override fun onActivityResumed(activity: Activity) = Unit

        override fun onActivityPaused(activity: Activity) = Unit

        override fun onActivityStopped(activity: Activity) = Unit

        override fun onActivitySaveInstanceState(
          activity: Activity,
          outState: Bundle,
        ) = Unit
      },
    )
    attachWebView()
  }

  fun updateHost(host: ViewGroup) {
    this.host = WeakReference(host)
    attachWebView()
  }

  override fun render(
    request: ChatRichBlockRequest,
    completion: (ChatRichBlockResult<ChatRichBlockImage>) -> Unit,
  ) {
    if (webView == null) {
      completion(ChatRichBlockResult.TransientFailure)
      return
    }
    check(request.kind == kind)
    active = ActiveRender((++nextRenderId).toString(), request, completion)
    if (ready) evaluateActiveRender()
  }

  override fun reset() {
    active = null
    ready = false
    val retired = webView
    webView = null
    retired?.let(::releaseWebView)
    attachWebView()
  }

  // Only bundled rendering scripts run here. Model input is a JSON value, network and
  // device-file access are denied, and the bridge exposes only render completions.
  @SuppressLint("SetJavaScriptEnabled", "MissingOnRenderProcessGone")
  @Suppress("DEPRECATION")
  private fun createWebView(): WebView? {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return null
    return WebView(application).apply {
      alpha = 0f
      visibility = View.VISIBLE
      isClickable = false
      isHorizontalScrollBarEnabled = false
      isVerticalScrollBarEnabled = false
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      setBackgroundColor(AndroidColor.TRANSPARENT)
      setLayerType(View.LAYER_TYPE_SOFTWARE, null)
      setWillNotDraw(false)
      settings.apply {
        javaScriptEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        allowFileAccessFromFileURLs = false
        allowUniversalAccessFromFileURLs = false
        blockNetworkLoads = true
        domStorageEnabled = false
        databaseEnabled = false
        cacheMode = WebSettings.LOAD_NO_CACHE
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        offscreenPreRaster = true
        javaScriptCanOpenWindowsAutomatically = false
        setSupportMultipleWindows(false)
      }
      webViewClient =
        object : WebViewClient() {
          override fun shouldInterceptRequest(
            view: WebView?,
            request: WebResourceRequest?,
          ): WebResourceResponse {
            val url = request?.url ?: return emptyRenderResponse()
            if (!isAllowedAssetUrl(url)) return emptyRenderResponse()
            return assetLoader.shouldInterceptRequest(url) ?: emptyRenderResponse()
          }

          override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?,
          ): Boolean = request?.isForMainFrame == true && request.url.toString() != shellUrl

          override fun onPageFinished(
            view: WebView?,
            url: String?,
          ) {
            if (view === webView && url == shellUrl) {
              ready = true
              evaluateActiveRender()
            }
          }

          override fun onRenderProcessGone(
            view: WebView,
            detail: RenderProcessGoneDetail,
          ): Boolean {
            if (view !== webView) return true
            val interrupted = active
            reset()
            interrupted?.completion?.invoke(ChatRichBlockResult.TransientFailure)
            return true
          }
        }
      WebViewCompat.addWebMessageListener(this, kind.bridgeName, setOf(CHAT_RENDER_ORIGIN), RenderMessageBridge())
      loadUrl(shellUrl)
    }
  }

  private fun releaseWebView(view: WebView) {
    (view.parent as? ViewGroup)?.removeView(view)
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.removeWebMessageListener(view, kind.bridgeName)
    }
    view.destroy()
  }

  private fun attachWebView() {
    val currentHost = host.get() ?: return
    val view = webView ?: createWebView()?.also { webView = it } ?: return
    if (view.parent === currentHost) return
    (view.parent as? ViewGroup)?.removeView(view)
    // VisualStateCallback requires an attached visible WebView. The transparent
    // renderer stays behind activity content and never participates in transcript layout.
    currentHost.addView(view, 0, ViewGroup.LayoutParams(1, 1))
  }

  private fun evaluateActiveRender() {
    val view = webView ?: return
    val render = active ?: return
    layoutRender(view, render.request.widthPx, 1)
    view.evaluateJavascript("window.${kind.entryPoint}(${render.request.payload(render.id)});", null)
  }

  private inner class RenderMessageBridge : WebViewCompat.WebMessageListener {
    override fun onPostMessage(
      view: WebView,
      message: WebMessageCompat,
      sourceOrigin: Uri,
      isMainFrame: Boolean,
      replyProxy: JavaScriptReplyProxy,
    ) {
      if (view !== webView || !isMainFrame || !isRenderOrigin(sourceOrigin)) return
      val result = parseChatRichBlockRenderMessage(message.data, kind) ?: return
      handler.post {
        if (view !== webView) return@post
        val render = active?.takeIf { it.id == result.id } ?: return@post
        val width = bitmapDimension(result.widthCssPx, render.request.density)
        val height = bitmapDimension(result.heightCssPx, render.request.density)
        if (!result.success || width == null || height == null || width.toLong() * height > kind.maxBitmapPixels) {
          active = null
          render.completion(if (!result.success && result.retryable) ChatRichBlockResult.TransientFailure else ChatRichBlockResult.Failure)
          return@post
        }
        layoutRender(view, width, height)
        view.postVisualStateCallback(
          render.id.toLong(),
          object : WebView.VisualStateCallback() {
            override fun onComplete(requestId: Long) {
              // WebView's visual-state guarantee begins after onComplete returns.
              handler.post capture@{
                if (view !== webView) return@capture
                val current = active?.takeIf { it.id == requestId.toString() } ?: return@capture
                val bitmap =
                  runCatching {
                    createBitmap(width, height, Bitmap.Config.ARGB_8888).also { target ->
                      target.eraseColor(AndroidColor.TRANSPARENT)
                      view.draw(Canvas(target))
                    }
                  }.getOrNull()
                active = null
                current.completion(
                  bitmap?.let { ChatRichBlockResult.Success(ChatRichBlockImage(it, result.svg)) }
                    ?: ChatRichBlockResult.TransientFailure,
                )
              }
            }
          },
        )
      }
    }
  }

  private fun layoutRender(
    view: WebView,
    width: Int,
    height: Int,
  ) {
    // Parent layout must preserve the size used by Blink's visual-state fence.
    // Resizing again in the callback would capture content prepared for an old viewport.
    view.layoutParams =
      view.layoutParams.apply {
        this.width = width
        this.height = height
      }
    view.measure(
      View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
    )
    view.layout(0, 0, width, height)
    view.scrollTo(0, 0)
  }

  private fun isAllowedAssetUrl(uri: Uri): Boolean =
    isRenderOrigin(uri) &&
      uri.path.orEmpty().startsWith("/assets/${kind.assetDirectory}/") &&
      uri.pathSegments.none { it == ".." }

  private data class ActiveRender(
    val id: String,
    val request: ChatRichBlockRequest,
    val completion: (ChatRichBlockResult<ChatRichBlockImage>) -> Unit,
  )
}

private tailrec fun Context.findActivity(): Activity? =
  when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
  }

private fun isRenderOrigin(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.port == -1

internal fun emptyRenderResponse(): WebResourceResponse = WebResourceResponse("text/plain", Charsets.UTF_8.name(), ByteArrayInputStream(ByteArray(0)))

internal fun chatRenderCssColor(argb: Int): String = String.format(Locale.US, "#%02x%02x%02x", AndroidColor.red(argb), AndroidColor.green(argb), AndroidColor.blue(argb))
