package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.core.graphics.createBitmap
import androidx.core.graphics.scale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume

class CanvasController {
  enum class SnapshotFormat(
    val rawValue: String,
  ) {
    Png("png"),
    Jpeg("jpeg"),
  }

  @Volatile private var webView: WebView? = null

  @Volatile private var url: String? = null

  @Volatile private var debugStatusEnabled: Boolean = false

  @Volatile private var debugStatusTitle: String? = null

  @Volatile private var debugStatusSubtitle: String? = null

  @Volatile private var homeCanvasStateJson: String? = null
  private val _currentUrl = MutableStateFlow<String?>(null)
  val currentUrl: StateFlow<String?> = _currentUrl.asStateFlow()

  private val scaffoldAssetUrl = "file:///android_asset/CanvasScaffold/scaffold.html"

  private fun clampJpegQuality(quality: Double?): Int {
    val q = (quality ?: 0.82).coerceIn(0.1, 1.0)
    return (q * 100.0).toInt().coerceIn(1, 100)
  }

  private fun Bitmap.scaleForMaxWidth(maxWidth: Int?): Bitmap {
    if (maxWidth == null || maxWidth <= 0 || width <= maxWidth) {
      return this
    }
    val scaledHeight = (height.toDouble() * (maxWidth.toDouble() / width.toDouble())).toInt().coerceAtLeast(1)
    return scale(maxWidth, scaledHeight)
  }

  fun attach(webView: WebView) {
    this.webView = webView
    reload()
    applyDebugStatus()
    applyHomeCanvasState()
  }

  fun detach(webView: WebView) {
    if (this.webView === webView) {
      this.webView = null
    }
  }

  fun navigate(url: String) {
    val trimmed = url.trim()
    this.url = if (trimmed.isBlank() || trimmed == "/") null else trimmed
    _currentUrl.value = this.url
    reload()
  }

  fun currentUrl(): String? = url

  fun isDefaultCanvas(): Boolean = url == null

  fun setDebugStatusEnabled(enabled: Boolean) {
    debugStatusEnabled = enabled
    applyDebugStatus()
  }

  fun setDebugStatus(
    title: String?,
    subtitle: String?,
  ) {
    debugStatusTitle = title
    debugStatusSubtitle = subtitle
    applyDebugStatus()
  }

  fun onPageFinished() {
    applyDebugStatus()
    applyHomeCanvasState()
  }

  fun updateHomeCanvasState(json: String?) {
    homeCanvasStateJson = json
    applyHomeCanvasState()
  }

  private inline fun withWebViewOnMain(crossinline block: (WebView) -> Unit) {
    val wv = webView ?: return
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block(wv)
    } else {
      wv.post { block(wv) }
    }
  }

  private fun reload() {
    val currentUrl = url
    withWebViewOnMain { wv ->
      if (currentUrl == null) {
        if (BuildConfig.DEBUG) {
          Log.d("OpenClawCanvas", "load scaffold: $scaffoldAssetUrl")
        }
        wv.loadUrl(scaffoldAssetUrl)
      } else {
        if (BuildConfig.DEBUG) {
          Log.d("OpenClawCanvas", "load url: $currentUrl")
        }
        wv.loadUrl(currentUrl)
      }
    }
  }

  private fun applyDebugStatus() {
    val enabled = debugStatusEnabled
    val title = debugStatusTitle
    val subtitle = debugStatusSubtitle
    withWebViewOnMain { wv ->
      val titleJs = title?.let { JSONObject.quote(it) } ?: "null"
      val subtitleJs = subtitle?.let { JSONObject.quote(it) } ?: "null"
      val js =
        """
        (() => {
          try {
            const api = globalThis.__openclaw;
            if (!api) return;
            if (typeof api.setDebugStatusEnabled === 'function') {
              api.setDebugStatusEnabled(${if (enabled) "true" else "false"});
            }
            if (!${if (enabled) "true" else "false"}) return;
            if (typeof api.setStatus === 'function') {
              api.setStatus($titleJs, $subtitleJs);
            }
          } catch (_) {}
        })();
        """.trimIndent()
      wv.evaluateJavascript(js, null)
    }
  }

  private fun applyHomeCanvasState() {
    val payload = homeCanvasStateJson ?: "null"
    withWebViewOnMain { wv ->
      val js =
        """
        (() => {
          try {
            const api = globalThis.__openclaw;
            if (!api || typeof api.renderHome !== 'function') return;
            api.renderHome($payload);
          } catch (_) {}
        })();
        """.trimIndent()
      wv.evaluateJavascript(js, null)
    }
  }

  suspend fun eval(javaScript: String): String =
    withContext(Dispatchers.Main) {
      val wv = webView ?: throw IllegalStateException("no webview")
      suspendCancellableCoroutine { cont ->
        wv.evaluateJavascript(javaScript) { result ->
          cont.resume(result ?: "")
        }
      }
    }

  suspend fun snapshotPngBase64(maxWidth: Int?): String =
    withContext(Dispatchers.Main) {
      val wv = webView ?: throw IllegalStateException("no webview")
      val bmp = wv.captureBitmap()
      try {
        val scaled = bmp.scaleForMaxWidth(maxWidth)
        try {
          val out = ByteArrayOutputStream()
          scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
          Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally {
          if (scaled !== bmp) scaled.recycle()
        }
      } finally {
        bmp.recycle()
      }
    }

  suspend fun snapshotBase64(
    format: SnapshotFormat,
    quality: Double?,
    maxWidth: Int?,
  ): String =
    withContext(Dispatchers.Main) {
      val wv = webView ?: throw IllegalStateException("no webview")
      val bmp = wv.captureBitmap()
      try {
        val scaled = bmp.scaleForMaxWidth(maxWidth)
        try {
          val out = ByteArrayOutputStream()
          val (compressFormat, compressQuality) =
            when (format) {
              SnapshotFormat.Png -> Bitmap.CompressFormat.PNG to 100
              SnapshotFormat.Jpeg -> Bitmap.CompressFormat.JPEG to clampJpegQuality(quality)
            }
          scaled.compress(compressFormat, compressQuality, out)
          Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally {
          if (scaled !== bmp) scaled.recycle()
        }
      } finally {
        bmp.recycle()
      }
    }

  private suspend fun WebView.captureBitmap(): Bitmap =
    suspendCancellableCoroutine { cont ->
      val width = width.coerceAtLeast(1)
      val height = height.coerceAtLeast(1)
      val bitmap = createBitmap(width, height, Bitmap.Config.ARGB_8888)

      // WebView isn't supported by PixelCopy.request(...) directly; draw() is the most reliable
      // cross-version snapshot for this lightweight "canvas" use-case.
      draw(Canvas(bitmap))
      cont.resume(bitmap)
    }

  companion object {
    data class SnapshotParams(
      val format: SnapshotFormat,
      val quality: Double?,
      val maxWidth: Int?,
    )

    fun parseNavigateUrl(paramsJson: String?): String {
      val obj = parseParamsObject(paramsJson) ?: return ""
      return obj.string("url").trim()
    }

    fun parseEvalJs(paramsJson: String?): String? {
      val obj = parseParamsObject(paramsJson) ?: return null
      val js = obj.string("javaScript").trim()
      return js.takeIf { it.isNotBlank() }
    }

    fun parseSnapshotMaxWidth(paramsJson: String?): Int? {
      val obj = parseParamsObject(paramsJson) ?: return null
      if (!obj.containsKey("maxWidth")) return null
      val width = obj.int("maxWidth") ?: 0
      return width.takeIf { it > 0 }
    }

    fun parseSnapshotFormat(paramsJson: String?): SnapshotFormat {
      val obj = parseParamsObject(paramsJson) ?: return SnapshotFormat.Jpeg
      val raw = obj.string("format").trim().lowercase()
      return when (raw) {
        "png" -> SnapshotFormat.Png
        "jpeg", "jpg" -> SnapshotFormat.Jpeg
        "" -> SnapshotFormat.Jpeg
        else -> SnapshotFormat.Jpeg
      }
    }

    fun parseSnapshotQuality(paramsJson: String?): Double? {
      val obj = parseParamsObject(paramsJson) ?: return null
      if (!obj.containsKey("quality")) return null
      val q = obj.double("quality") ?: Double.NaN
      if (!q.isFinite()) return null
      return q.coerceIn(0.1, 1.0)
    }

    fun parseSnapshotParams(paramsJson: String?): SnapshotParams =
      SnapshotParams(
        format = parseSnapshotFormat(paramsJson),
        quality = parseSnapshotQuality(paramsJson),
        maxWidth = parseSnapshotMaxWidth(paramsJson),
      )

    private val json = Json { ignoreUnknownKeys = true }

    private fun parseParamsObject(paramsJson: String?): JsonObject? {
      val raw = paramsJson?.trim().orEmpty()
      if (raw.isEmpty()) return null
      return try {
        json.parseToJsonElement(raw).asObjectOrNull()
      } catch (_: Throwable) {
        null
      }
    }

    private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

    private fun JsonObject.string(key: String): String {
      val prim = this[key] as? JsonPrimitive ?: return ""
      val raw = prim.content
      return raw.takeIf { it != "null" }.orEmpty()
    }

    private fun JsonObject.int(key: String): Int? {
      val prim = this[key] as? JsonPrimitive ?: return null
      return prim.content.toIntOrNull()
    }

    private fun JsonObject.double(key: String): Double? {
      val prim = this[key] as? JsonPrimitive ?: return null
      return prim.content.toDoubleOrNull()
    }
  }
}
