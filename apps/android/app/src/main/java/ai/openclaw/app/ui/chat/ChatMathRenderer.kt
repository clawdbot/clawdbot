package ai.openclaw.app.ui.chat

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.sp
import androidx.core.graphics.createBitmap
import androidx.core.net.toUri
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.lang.ref.WeakReference
import java.util.Locale
import android.graphics.Color as AndroidColor

private const val MATH_BITMAP_CACHE_BYTES = 4 * 1024 * 1024
private const val MATH_NEGATIVE_CACHE_ENTRIES = 64
private const val MATH_RENDER_TIMEOUT_MS = 3000L
private const val MATH_WIDTH_BUCKET_PX = 64
private const val MATH_MAX_BITMAP_DIMENSION = 8192
private const val MATH_MAX_BITMAP_PIXELS = MATH_BITMAP_CACHE_BYTES / 4
private const val KATEX_ASSET_ROOT = "file:///android_asset/katex/"
private const val KATEX_SHELL_URL = "${KATEX_ASSET_ROOT}index.html"

internal data class ChatMathRenderKey(
  val latex: String,
  val widthBucket: Int,
  val darkMode: Boolean,
)

internal data class ChatMathRenderRequest(
  val key: ChatMathRenderKey,
  val textColor: Int,
  val fontSizePx: Float,
  val density: Float,
) {
  companion object {
    fun create(
      latex: String,
      widthPx: Int,
      darkMode: Boolean,
      textColor: Int,
      fontSizePx: Float,
      density: Float,
    ): ChatMathRenderRequest {
      val boundedWidth = widthPx.coerceAtLeast(1)
      val widthBucket = ((boundedWidth / MATH_WIDTH_BUCKET_PX) * MATH_WIDTH_BUCKET_PX).coerceAtLeast(MATH_WIDTH_BUCKET_PX)
      return ChatMathRenderRequest(
        key = ChatMathRenderKey(latex = latex, widthBucket = widthBucket, darkMode = darkMode),
        textColor = textColor,
        fontSizePx = fontSizePx,
        density = density,
      )
    }
  }
}

internal sealed interface ChatMathRenderResult<out T> {
  data class Success<T>(
    val value: T,
  ) : ChatMathRenderResult<T>

  data object Failure : ChatMathRenderResult<Nothing>

  data object TransientFailure : ChatMathRenderResult<Nothing>
}

internal sealed interface ChatMathCacheEntry<out T> {
  data class Success<T>(
    val value: T,
  ) : ChatMathCacheEntry<T>

  data object Failure : ChatMathCacheEntry<Nothing>

  data object Missing : ChatMathCacheEntry<Nothing>
}

internal interface ChatMathRenderCache<T> {
  fun get(request: ChatMathRenderRequest): ChatMathCacheEntry<T>

  fun put(
    request: ChatMathRenderRequest,
    result: ChatMathRenderResult<T>,
  )
}

internal fun interface ChatMathRenderBackend<T> {
  fun render(
    request: ChatMathRenderRequest,
    completion: (ChatMathRenderResult<T>) -> Unit,
  )
}

internal fun interface ChatMathTimeout {
  fun cancel()
}

internal fun interface ChatMathTimeoutScheduler {
  fun schedule(
    delayMs: Long,
    action: () -> Unit,
  ): ChatMathTimeout
}

internal fun interface ChatMathRenderSubscription {
  fun cancel()
}

/** Serializes one renderer backend, deduplicates in-flight keys, and owns timeout fallback. */
internal class ChatMathRenderCoordinator<T>(
  private val backend: ChatMathRenderBackend<T>,
  private val cache: ChatMathRenderCache<T>,
  private val timeoutScheduler: ChatMathTimeoutScheduler,
) {
  private val queued = LinkedHashMap<ChatMathRenderRequest, PendingRender<T>>()
  private var active: PendingRender<T>? = null
  private var callbackId = 0L
  private var renderAttemptId = 0L
  private var activeAttemptId = 0L
  private var timeout: ChatMathTimeout? = null

  fun render(
    request: ChatMathRenderRequest,
    completion: (ChatMathRenderResult<T>) -> Unit,
  ): ChatMathRenderSubscription {
    when (val cached = cache.get(request)) {
      is ChatMathCacheEntry.Success -> {
        completion(ChatMathRenderResult.Success(cached.value))
        return ChatMathRenderSubscription {}
      }
      ChatMathCacheEntry.Failure -> {
        completion(ChatMathRenderResult.Failure)
        return ChatMathRenderSubscription {}
      }
      ChatMathCacheEntry.Missing -> Unit
    }

    callbackId += 1
    val id = callbackId
    val pending = active?.takeIf { item -> item.request == request } ?: queued[request]
    if (pending != null) {
      pending.callbacks[id] = completion
    } else {
      queued[request] = PendingRender(request = request, callbacks = linkedMapOf(id to completion))
      pump()
    }
    return ChatMathRenderSubscription {
      active?.callbacks?.remove(id)
      val iterator = queued.iterator()
      while (iterator.hasNext()) {
        val item = iterator.next().value
        item.callbacks.remove(id)
        if (item.callbacks.isEmpty()) iterator.remove()
      }
    }
  }

  private fun pump() {
    if (active != null) return
    val next = queued.entries.firstOrNull() ?: return
    queued.remove(next.key)
    active = next.value
    renderAttemptId += 1
    activeAttemptId = renderAttemptId
    val attemptId = activeAttemptId
    timeout =
      timeoutScheduler.schedule(MATH_RENDER_TIMEOUT_MS) {
        finish(attemptId, ChatMathRenderResult.TransientFailure)
      }
    backend.render(next.value.request) { result -> finish(attemptId, result) }
  }

  private fun finish(
    attemptId: Long,
    result: ChatMathRenderResult<T>,
  ) {
    if (attemptId != activeAttemptId) return
    val current = active ?: return
    timeout?.cancel()
    timeout = null
    active = null
    cache.put(current.request, result)
    current.callbacks.values
      .toList()
      .forEach { callback -> callback(result) }
    pump()
  }

  private data class PendingRender<T>(
    val request: ChatMathRenderRequest,
    val callbacks: MutableMap<Long, (ChatMathRenderResult<T>) -> Unit>,
  )
}

private class ChatMathBitmapCache : ChatMathRenderCache<Bitmap> {
  private val bitmaps =
    object : LruCache<ChatMathRenderKey, CachedBitmap>(MATH_BITMAP_CACHE_BYTES) {
      override fun sizeOf(
        key: ChatMathRenderKey,
        value: CachedBitmap,
      ): Int = value.bitmap.byteCount.coerceAtLeast(1)
    }
  private val failures = LinkedHashMap<ChatMathRenderKey, RenderStyle>(MATH_NEGATIVE_CACHE_ENTRIES, 0.75f, true)

  override fun get(request: ChatMathRenderRequest): ChatMathCacheEntry<Bitmap> {
    val style = request.renderStyle
    bitmaps.get(request.key)?.let { cached ->
      if (cached.style == style) return ChatMathCacheEntry.Success(cached.bitmap)
      bitmaps.remove(request.key)
    }
    failures[request.key]?.let { failedStyle ->
      if (failedStyle == style) return ChatMathCacheEntry.Failure
      failures.remove(request.key)
    }
    return ChatMathCacheEntry.Missing
  }

  override fun put(
    request: ChatMathRenderRequest,
    result: ChatMathRenderResult<Bitmap>,
  ) {
    when (result) {
      is ChatMathRenderResult.Success -> {
        failures.remove(request.key)
        bitmaps.put(request.key, CachedBitmap(request.renderStyle, result.value))
      }
      ChatMathRenderResult.Failure -> {
        failures[request.key] = request.renderStyle
        while (failures.size > MATH_NEGATIVE_CACHE_ENTRIES) {
          failures.remove(failures.entries.first().key)
        }
      }
      ChatMathRenderResult.TransientFailure -> Unit
    }
  }

  private data class CachedBitmap(
    val style: RenderStyle,
    val bitmap: Bitmap,
  )
}

private data class RenderStyle(
  val textColor: Int,
  val fontSizePx: Float,
  val density: Float,
)

private val ChatMathRenderRequest.renderStyle: RenderStyle
  get() = RenderStyle(textColor = textColor, fontSizePx = fontSizePx, density = density)

/** Process-singleton entry point. Its sole WebView and all queue state stay on the main thread. */
internal object ChatMathRenderer {
  private val handler = Handler(Looper.getMainLooper())

  // This is intentionally process-owned: its WebView uses the Application context, and the
  // activity host is weak, detached on destruction, then replaced on the next render.
  @SuppressLint("StaticFieldLeak")
  private var backend: ChatMathWebViewBackend? = null
  private var coordinator: ChatMathRenderCoordinator<Bitmap>? = null

  fun render(
    context: Context,
    request: ChatMathRenderRequest,
    completion: (ChatMathRenderResult<Bitmap>) -> Unit,
  ): ChatMathRenderSubscription {
    check(Looper.myLooper() == Looper.getMainLooper()) { "ChatMathRenderer must run on the main thread" }
    val host = context.findActivity()?.window?.decorView as? ViewGroup
    if (host == null) {
      completion(ChatMathRenderResult.TransientFailure)
      return ChatMathRenderSubscription {}
    }
    val renderBackend =
      backend
        ?: ChatMathWebViewBackend(context.applicationContext as Application, host).also { created -> backend = created }
    renderBackend.updateHost(host)
    val renderer =
      coordinator
        ?: ChatMathRenderCoordinator(
          backend = renderBackend,
          cache = ChatMathBitmapCache(),
          timeoutScheduler =
            ChatMathTimeoutScheduler { delayMs, action ->
              val runnable = Runnable(action)
              handler.postDelayed(runnable, delayMs)
              ChatMathTimeout { handler.removeCallbacks(runnable) }
            },
        ).also { created -> coordinator = created }
    return renderer.render(request, completion)
  }
}

private class ChatMathWebViewBackend(
  private val application: Application,
  host: ViewGroup,
) : ChatMathRenderBackend<Bitmap> {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var ready = false
  private var nextRenderId = 0L
  private var active: ActiveRender? = null
  private var host = WeakReference(host)
  private var webView = createWebView(application)
  private val activityCallbacks =
    object : Application.ActivityLifecycleCallbacks {
      override fun onActivityDestroyed(activity: Activity) {
        releaseHost(activity)
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
    }

  init {
    application.registerActivityLifecycleCallbacks(activityCallbacks)
    attachWebView(webView)
  }

  fun updateHost(host: ViewGroup) {
    this.host = WeakReference(host)
    attachWebView(webView)
  }

  override fun render(
    request: ChatMathRenderRequest,
    completion: (ChatMathRenderResult<Bitmap>) -> Unit,
  ) {
    if (host.get() == null) {
      completion(ChatMathRenderResult.TransientFailure)
      return
    }
    nextRenderId += 1
    active = ActiveRender(nextRenderId.toString(), request, completion)
    if (ready) evaluateActiveRender()
  }

  // JavaScript is required only for the bundled KaTeX shell. The client blocks network loads,
  // rejects every URL outside the asset root, and receives LaTeX as a JSON value rather than HTML.
  @SuppressLint("SetJavaScriptEnabled")
  @Suppress("DEPRECATION")
  private fun createWebView(context: Context): WebView =
    WebView(context).apply {
      alpha = 0f
      visibility = View.VISIBLE
      isClickable = false
      setBackgroundColor(AndroidColor.TRANSPARENT)
      setLayerType(View.LAYER_TYPE_SOFTWARE, null)
      setWillNotDraw(false)
      settings.apply {
        javaScriptEnabled = true
        allowFileAccess = true
        allowContentAccess = false
        allowFileAccessFromFileURLs = false
        allowUniversalAccessFromFileURLs = false
        blockNetworkLoads = true
        domStorageEnabled = false
        databaseEnabled = false
        cacheMode = WebSettings.LOAD_NO_CACHE
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        offscreenPreRaster = true
      }
      addJavascriptInterface(RenderBridge(), "ChatMathBridge")
      webViewClient =
        object : WebViewClient() {
          override fun shouldInterceptRequest(
            view: WebView?,
            request: WebResourceRequest?,
          ): WebResourceResponse? {
            val url = request?.url?.toString().orEmpty()
            return if (isAllowedAssetUrl(url)) null else emptyResponse()
          }

          override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?,
          ): Boolean = !isAllowedAssetUrl(request?.url?.toString().orEmpty())

          override fun onPageFinished(
            view: WebView?,
            url: String?,
          ) {
            if (url == KATEX_SHELL_URL) {
              ready = true
              evaluateActiveRender()
            }
          }

          override fun onRenderProcessGone(
            view: WebView,
            detail: RenderProcessGoneDetail,
          ): Boolean {
            if (webView !== view) return true
            val interrupted = active
            active = null
            ready = false
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            mainHandler.post {
              webView = createWebView(application)
              attachWebView(webView)
              interrupted?.completion?.invoke(ChatMathRenderResult.TransientFailure)
            }
            return true
          }
        }
      loadUrl(KATEX_SHELL_URL)
    }

  private fun attachWebView(view: WebView) {
    val currentHost = host.get() ?: return
    if (view.parent === currentHost) return
    (view.parent as? ViewGroup)?.removeView(view)
    // Android's visual-state contract requires a visible attached WebView. Keep this sole
    // process renderer transparent, 1 px, and behind the activity content; it never enters chat.
    currentHost.addView(view, 0, ViewGroup.LayoutParams(1, 1))
  }

  private fun releaseHost(activity: Activity) {
    val currentHost = host.get() ?: return
    if (currentHost !== activity.window.decorView) return
    (webView.parent as? ViewGroup)?.removeView(webView)
    host.clear()
    val interrupted = active
    active = null
    interrupted?.completion?.invoke(ChatMathRenderResult.TransientFailure)
  }

  private fun evaluateActiveRender() {
    val render = active ?: return
    val viewportWidth = render.request.key.widthBucket
    val density = render.request.density
    webView.measure(
      View.MeasureSpec.makeMeasureSpec(viewportWidth, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(1, View.MeasureSpec.EXACTLY),
    )
    webView.layout(0, 0, viewportWidth, 1)
    webView.scrollTo(0, 0)

    val payload =
      JSONObject()
        .put("id", render.id)
        .put("latex", render.request.key.latex)
        .put("widthCssPx", viewportWidth / density)
        .put("fontSizeCssPx", render.request.fontSizePx / density)
        .put("color", cssColor(render.request.textColor))
    webView.evaluateJavascript("window.renderMath($payload);", null)
  }

  private inner class RenderBridge {
    @JavascriptInterface
    fun onRenderComplete(
      id: String,
      widthCssPx: Double,
      heightCssPx: Double,
      success: Boolean,
    ) {
      mainHandler.post {
        val render = active?.takeIf { item -> item.id == id } ?: return@post
        val density = render.request.density
        if (!success) {
          active = null
          render.completion(ChatMathRenderResult.Failure)
          return@post
        }
        val width =
          kotlin.math
            .ceil(widthCssPx * density)
            .toInt()
            .coerceAtLeast(1)
        val height =
          kotlin.math
            .ceil(heightCssPx * density)
            .toInt()
            .coerceAtLeast(1)
        if (!isSafeBitmapSize(width, height)) {
          active = null
          render.completion(ChatMathRenderResult.Failure)
          return@post
        }

        webView.measure(
          View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
          View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
        )
        webView.layout(0, 0, width, height)
        webView.scrollTo(0, 0)
        webView.postVisualStateCallback(
          id.toLong(),
          object : WebView.VisualStateCallback() {
            override fun onComplete(requestId: Long) {
              val current = active?.takeIf { item -> item.id == requestId.toString() } ?: return
              val bitmap =
                runCatching {
                  webView.measure(
                    View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
                  )
                  webView.layout(0, 0, width, height)
                  createBitmap(width, height, Bitmap.Config.ARGB_8888).also { target ->
                    target.eraseColor(AndroidColor.TRANSPARENT)
                    webView.draw(Canvas(target))
                  }
                }.getOrNull()
              active = null
              current.completion(
                bitmap?.let { target -> ChatMathRenderResult.Success(target) }
                  ?: ChatMathRenderResult.TransientFailure,
              )
            }
          },
        )
      }
    }
  }

  private data class ActiveRender(
    val id: String,
    val request: ChatMathRenderRequest,
    val completion: (ChatMathRenderResult<Bitmap>) -> Unit,
  )
}

private tailrec fun Context.findActivity(): Activity? =
  when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
  }

private fun isAllowedAssetUrl(url: String): Boolean =
  runCatching {
    val uri = url.toUri()
    uri.scheme == "file" &&
      uri.host.isNullOrEmpty() &&
      uri.path.orEmpty().startsWith("/android_asset/katex/") &&
      uri.pathSegments.none { segment -> segment == ".." }
  }.getOrDefault(false)

private fun emptyResponse(): WebResourceResponse = WebResourceResponse("text/plain", Charsets.UTF_8.name(), ByteArrayInputStream(ByteArray(0)))

private fun cssColor(argb: Int): String = String.format(Locale.US, "#%02x%02x%02x", AndroidColor.red(argb), AndroidColor.green(argb), AndroidColor.blue(argb))

private fun isSafeBitmapSize(
  width: Int,
  height: Int,
): Boolean =
  width <= MATH_MAX_BITMAP_DIMENSION &&
    height <= MATH_MAX_BITMAP_DIMENSION &&
    width.toLong() * height.toLong() <= MATH_MAX_BITMAP_PIXELS

@Composable
internal fun ChatMathBlock(
  latex: String,
  textColor: Color,
) {
  val context = LocalContext.current
  val density = LocalDensity.current
  val darkMode = textColor.luminance() > 0.5f
  BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
    val widthPx = with(density) { maxWidth.roundToPx() }
    val fontSizePx = with(density) { 16.sp.toPx() }
    val densityScale = density.density
    val request =
      remember(latex, widthPx, darkMode, textColor, fontSizePx, densityScale) {
        ChatMathRenderRequest.create(
          latex = latex,
          widthPx = widthPx,
          darkMode = darkMode,
          textColor = textColor.toArgb(),
          fontSizePx = fontSizePx,
          density = densityScale,
        )
      }
    var bitmap by remember(request) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(request) { mutableStateOf(false) }
    DisposableEffect(request) {
      val subscription =
        ChatMathRenderer.render(context, request) { result ->
          when (result) {
            is ChatMathRenderResult.Success -> {
              bitmap = result.value
              failed = false
            }
            ChatMathRenderResult.Failure,
            ChatMathRenderResult.TransientFailure,
            -> failed = true
          }
        }
      onDispose { subscription.cancel() }
    }

    val rendered = bitmap
    if (rendered == null || failed) {
      ChatMathFallback(latex)
    } else {
      val scrollState = rememberScrollState()
      Box(
        modifier =
          Modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState),
      ) {
        Image(
          bitmap = rendered.asImageBitmap(),
          contentDescription = latex,
          modifier =
            Modifier
              .width(with(density) { rendered.width.toDp() })
              .height(with(density) { rendered.height.toDp() }),
        )
      }
    }
  }
}

@Composable
internal fun ChatMathFallback(latex: String) {
  ChatCodeBlock(code = latex, language = null)
}
