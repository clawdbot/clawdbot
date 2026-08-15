package ai.openclaw.app.ui.chat

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.PixelCopy
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.core.graphics.createBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.coroutines.resume

internal enum class ChatWidgetExportDestination {
  Clipboard,
  Downloads,
}

private const val WIDGET_EXPORT_STEM_MAX_CODE_POINTS = 80
private const val WIDGET_EXPORT_STEM_MAX_UTF8_BYTES = 120
private const val WIDGET_EXPORT_RETENTION_MILLIS = 24 * 60 * 60 * 1000L
private val widgetExportUnsafeCharacters = Regex("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]+")
private val widgetExportWhitespace = Regex("\\s+")

internal fun widgetExportFileName(title: String?): String {
  val normalized =
    title
      .orEmpty()
      .replace(widgetExportUnsafeCharacters, " ")
      .replace(widgetExportWhitespace, " ")
      .trim(' ', '.')
  val stem =
    normalized
      .takeCodePoints(WIDGET_EXPORT_STEM_MAX_CODE_POINTS)
      .takeUtf8Bytes(WIDGET_EXPORT_STEM_MAX_UTF8_BYTES)
      .trim(' ', '.')
      .ifEmpty { "widget" }
  return "$stem.png"
}

internal suspend fun exportChatWidgetImage(
  context: Context,
  webView: WebView,
  title: String?,
  destination: ChatWidgetExportDestination,
) {
  val bitmap = captureChatWidgetBitmap(webView)
  try {
    val fileName = widgetExportFileName(title)
    when (destination) {
      ChatWidgetExportDestination.Clipboard -> copyChatWidgetImage(context, bitmap, fileName)
      ChatWidgetExportDestination.Downloads -> saveChatWidgetImage(context, bitmap, fileName)
    }
  } finally {
    bitmap.recycle()
  }
}

private suspend fun captureChatWidgetBitmap(webView: WebView): Bitmap =
  withContext(Dispatchers.Main.immediate) {
    require(webView.width > 0 && webView.height > 0) { "widget has no rendered size" }
    captureChatWidgetWithPixelCopy(webView) ?: drawChatWidgetBitmap(webView)
  }

@Suppress("DEPRECATION")
private suspend fun captureChatWidgetWithPixelCopy(webView: WebView): Bitmap? {
  if (!webView.isAttachedToWindow) return null
  val window = webView.context.findActivity()?.window ?: return null
  val globalVisibleRect = Rect()
  if (
    !canCaptureWithPixelCopy(
      hasGlobalVisibleRect = webView.getGlobalVisibleRect(globalVisibleRect),
      visibleWidth = globalVisibleRect.width(),
      visibleHeight = globalVisibleRect.height(),
      viewWidth = webView.width,
      viewHeight = webView.height,
    )
  ) {
    return null
  }
  val location = IntArray(2)
  webView.getLocationInWindow(location)
  val sourceRect =
    Rect(
      location[0],
      location[1],
      location[0] + webView.width,
      location[1] + webView.height,
    )
  val decorView = window.decorView
  val windowRect = Rect(0, 0, decorView.width, decorView.height)
  if (!windowRect.contains(sourceRect)) return null

  val bitmap = createBitmap(webView.width, webView.height, Bitmap.Config.ARGB_8888)
  val result =
    try {
      suspendCancellableCoroutine<Int> { continuation ->
        PixelCopy.request(
          window,
          sourceRect,
          bitmap,
          { status ->
            if (continuation.isActive) {
              continuation.resume(status) { bitmap.recycle() }
            } else {
              bitmap.recycle()
            }
          },
          Handler(Looper.getMainLooper()),
        )
      }
    } catch (_: IllegalArgumentException) {
      bitmap.recycle()
      return null
    }
  if (result == PixelCopy.SUCCESS) return bitmap
  bitmap.recycle()
  return null
}

private fun drawChatWidgetBitmap(webView: WebView): Bitmap =
  createBitmap(webView.width, webView.height, Bitmap.Config.ARGB_8888).also { bitmap ->
    bitmap.eraseColor(Color.TRANSPARENT)
    webView.draw(Canvas(bitmap))
  }

private suspend fun copyChatWidgetImage(
  context: Context,
  bitmap: Bitmap,
  fileName: String,
) {
  val directory =
    withContext(Dispatchers.IO) {
      // Clipboard grants can outlive this screen. A unique directory prevents a later
      // same-title export from replacing the bytes behind an earlier content URI.
      val exportRoot = File(context.cacheDir, "exports")
      pruneExpiredWidgetExportDirectories(exportRoot, System.currentTimeMillis())
      File(exportRoot, UUID.randomUUID().toString()).also {
        check(it.mkdirs()) { "could not create widget export directory" }
      }
    }
  try {
    val target =
      withContext(Dispatchers.IO) {
        File(directory, fileName).also { file ->
          FileOutputStream(file).use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "could not encode widget PNG" }
          }
        }
      }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    clipboard.setPrimaryClip(ClipData.newUri(context.contentResolver, fileName, uri))
  } catch (error: Throwable) {
    // Preserve the original export failure while removing an unpublished attempt directory.
    withContext(NonCancellable + Dispatchers.IO) {
      runCatching { directory.deleteRecursively() }
    }
    throw error
  }
}

internal fun canCaptureWithPixelCopy(
  hasGlobalVisibleRect: Boolean,
  visibleWidth: Int,
  visibleHeight: Int,
  viewWidth: Int,
  viewHeight: Int,
): Boolean =
  hasGlobalVisibleRect &&
    visibleWidth == viewWidth &&
    visibleHeight == viewHeight

internal fun shouldPruneWidgetExportDirectory(
  directoryLastModifiedMillis: Long,
  newestLastModifiedMillis: Long,
  nowMillis: Long,
): Boolean =
  directoryLastModifiedMillis < newestLastModifiedMillis &&
    directoryLastModifiedMillis < nowMillis - WIDGET_EXPORT_RETENTION_MILLIS

private fun pruneExpiredWidgetExportDirectories(
  exportRoot: File,
  nowMillis: Long,
) {
  val directories = exportRoot.listFiles()?.filter(File::isDirectory).orEmpty()
  val newestLastModifiedMillis = directories.maxOfOrNull(File::lastModified) ?: return
  // Clipboard URI grants can outlive the current screen, so the newest export always survives cleanup.
  directories
    .filter {
      shouldPruneWidgetExportDirectory(it.lastModified(), newestLastModifiedMillis, nowMillis)
    }.forEach(File::deleteRecursively)
}

private suspend fun saveChatWidgetImage(
  context: Context,
  bitmap: Bitmap,
  fileName: String,
) = withContext(Dispatchers.IO) {
  val resolver = context.contentResolver
  val values =
    ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
      put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
      put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
  val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("could not create Downloads item")
  try {
    resolver.openOutputStream(uri, "w")?.use { output ->
      check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "could not encode widget PNG" }
    } ?: error("could not open Downloads item")
    check(
      resolver.update(
        uri,
        ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
        null,
        null,
      ) == 1,
    ) { "could not publish Downloads item" }
  } catch (error: Throwable) {
    resolver.delete(uri, null, null)
    throw error
  }
}

private fun String.takeCodePoints(limit: Int): String {
  val count = codePointCount(0, length)
  if (count <= limit) return this
  return substring(0, offsetByCodePoints(0, limit))
}

private fun String.takeUtf8Bytes(limit: Int): String {
  var end = 0
  var byteCount = 0
  while (end < length) {
    val codePoint = codePointAt(end)
    val codePointByteCount =
      when {
        codePoint <= 0x7f -> 1
        codePoint <= 0x7ff -> 2
        codePoint <= 0xffff -> 3
        else -> 4
      }
    if (byteCount + codePointByteCount > limit) break
    byteCount += codePointByteCount
    end += Character.charCount(codePoint)
  }
  return substring(0, end)
}

private tailrec fun Context.findActivity(): Activity? =
  when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
  }
