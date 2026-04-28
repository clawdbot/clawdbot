package ai.openclaw.app.ui.chat

import ai.openclaw.app.node.JpegSizeLimiter
import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.util.LruCache
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

private const val CHAT_ATTACHMENT_MAX_WIDTH = 1600
private const val CHAT_ATTACHMENT_MAX_BASE64_CHARS = 300 * 1024
private const val CHAT_ATTACHMENT_START_QUALITY = 85
private const val CHAT_DECODE_MAX_DIMENSION = 1600
private const val CHAT_IMAGE_CACHE_BYTES = 16 * 1024 * 1024

private val decodedBitmapCache =
  object : LruCache<String, Bitmap>(CHAT_IMAGE_CACHE_BYTES) {
    override fun sizeOf(
      key: String,
      value: Bitmap,
    ): Int = value.byteCount.coerceAtLeast(1)
  }

internal fun loadSizedImageAttachment(
  resolver: ContentResolver,
  uri: Uri,
): PendingImageAttachment {
  val fileName = normalizeAttachmentFileName((uri.lastPathSegment ?: "image").substringAfterLast('/'))
  val bitmap = decodeScaledBitmap(resolver, uri, maxDimension = CHAT_ATTACHMENT_MAX_WIDTH)
  if (bitmap == null) {
    throw IllegalStateException("unsupported attachment")
  }
  val maxBytes = (CHAT_ATTACHMENT_MAX_BASE64_CHARS / 4) * 3
  val encoded =
    JpegSizeLimiter.compressToLimit(
      initialWidth = bitmap.width,
      initialHeight = bitmap.height,
      startQuality = CHAT_ATTACHMENT_START_QUALITY,
      maxBytes = maxBytes,
      minSize = 240,
      encode = { width, height, quality ->
        val working =
          if (width == bitmap.width && height == bitmap.height) {
            bitmap
          } else {
            bitmap.scale(width, height, true)
          }
        try {
          val out = ByteArrayOutputStream()
          if (!working.compress(Bitmap.CompressFormat.JPEG, quality, out)) {
            throw IllegalStateException("attachment encode failed")
          }
          out.toByteArray()
        } finally {
          if (working !== bitmap) {
            working.recycle()
          }
        }
      },
    )
  val base64 = Base64.encodeToString(encoded.bytes, Base64.NO_WRAP)
  return PendingImageAttachment(
    id = uri.toString() + "#" + System.currentTimeMillis().toString(),
    fileName = fileName,
    mimeType = "image/jpeg",
    base64 = base64,
  )
}

internal fun decodeBase64Bitmap(
  base64: String,
  maxDimension: Int = CHAT_DECODE_MAX_DIMENSION,
): Bitmap? {
  val cacheKey = "$maxDimension:${base64.length}:${base64.hashCode()}"
  decodedBitmapCache.get(cacheKey)?.let { return it }

  val bytes = Base64.decode(base64, Base64.DEFAULT)
  if (bytes.isEmpty()) return null

  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
  if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

  val bitmap =
    BitmapFactory.decodeByteArray(
      bytes,
      0,
      bytes.size,
      BitmapFactory.Options().apply {
        inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
        inPreferredConfig = Bitmap.Config.RGB_565
      },
    ) ?: return null

  decodedBitmapCache.put(cacheKey, bitmap)
  return bitmap
}

internal fun computeInSampleSize(
  width: Int,
  height: Int,
  maxDimension: Int,
): Int {
  if (width <= 0 || height <= 0 || maxDimension <= 0) return 1

  var sample = 1
  var longestEdge = max(width, height)
  while (longestEdge > maxDimension && sample < 64) {
    sample *= 2
    longestEdge = max(width / sample, height / sample)
  }
  return sample.coerceAtLeast(1)
}

internal fun normalizeAttachmentFileName(raw: String): String {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) return "image.jpg"
  val stem = trimmed.substringBeforeLast('.', missingDelimiterValue = trimmed).ifEmpty { "image" }
  return "$stem.jpg"
}

private fun decodeScaledBitmap(
  resolver: ContentResolver,
  uri: Uri,
  maxDimension: Int,
): Bitmap? {
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  resolver.openInputStream(uri).use { input ->
    if (input == null) return null
    BitmapFactory.decodeStream(input, null, bounds)
  }
  if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

  val decoded =
    resolver.openInputStream(uri).use { input ->
      if (input == null) return null
      BitmapFactory.decodeStream(
        input,
        null,
        BitmapFactory.Options().apply {
          inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
          inPreferredConfig = Bitmap.Config.ARGB_8888
        },
      )
    } ?: return null

  val longestEdge = max(decoded.width, decoded.height)
  if (longestEdge <= maxDimension) return decoded

  val scale = maxDimension.toDouble() / longestEdge.toDouble()
  val targetWidth = max(1, (decoded.width * scale).roundToInt())
  val targetHeight = max(1, (decoded.height * scale).roundToInt())
  val scaled = decoded.scale(targetWidth, targetHeight, true)
  if (scaled !== decoded) {
    decoded.recycle()
  }
  return scaled
}
