package ai.openclaw.app.ui.chat

import ai.openclaw.app.SharedAttachment
import ai.openclaw.app.SharedAttachmentKind
import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import ai.openclaw.app.isStageableSharedAttachmentMimeType
import ai.openclaw.app.node.JpegSizeLimiter
import ai.openclaw.app.normalizeSharedAttachmentMimeType
import ai.openclaw.app.sharedAttachmentKindForMimeType
import android.content.ContentResolver
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.LruCache
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

private const val CHAT_ATTACHMENT_MAX_WIDTH = 1600
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

internal fun loadPickedAudioOrDocumentAttachment(
  resolver: ContentResolver,
  uri: Uri,
): PendingAttachment {
  val mimeType = normalizeSharedAttachmentMimeType(resolver.getType(uri))
  if (!isStageableSharedAttachmentMimeType(mimeType)) throw IllegalStateException("unsupported attachment")
  val kind = sharedAttachmentKindForMimeType(mimeType)
  if (kind == null || kind == SharedAttachmentKind.Image) throw IllegalStateException("unsupported attachment")
  return loadSharedAttachment(resolver, SharedAttachment(uri = uri, kind = kind, mimeType = requireNotNull(mimeType)))
}

/** Revalidates provider MIME metadata while the sender grant is live, then loads bounded bytes. */
internal fun loadSharedAttachment(
  resolver: ContentResolver,
  attachment: SharedAttachment,
): PendingAttachment {
  val providerMimeType = normalizeSharedAttachmentMimeType(resolver.getType(attachment.uri))
  val mimeType = providerMimeType ?: attachment.mimeType
  if (!isStageableSharedAttachmentMimeType(mimeType)) throw IllegalStateException("unsupported attachment")
  val kind = sharedAttachmentKindForMimeType(mimeType) ?: throw IllegalStateException("unsupported attachment")
  if (providerMimeType != null && (kind != attachment.kind || mimeType != attachment.mimeType)) {
    throw IllegalStateException("attachment type changed")
  }
  if (kind == SharedAttachmentKind.Image) return loadSizedImageAttachment(resolver, attachment.uri)

  val maxBytes = chatComposerAttachmentDecodedByteLimit(mimeType)
  val bytes = readBoundedAttachmentBytes(resolver, attachment.uri, maxBytes)
  return PendingAttachment(
    id = attachment.uri.toString() + "#" + System.currentTimeMillis(),
    fileName = sharedAttachmentFileName(resolver, attachment.uri),
    mimeType = mimeType,
    base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
  )
}

private fun readBoundedAttachmentBytes(
  resolver: ContentResolver,
  uri: Uri,
  maxBytes: Long,
): ByteArray {
  val output = ByteArrayOutputStream()
  resolver.openInputStream(uri).use { input ->
    requireNotNull(input) { "attachment unavailable" }
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      total += count
      if (total > maxBytes) throw IllegalStateException("attachment too large")
      output.write(buffer, 0, count)
    }
  }
  return output.toByteArray()
}

private fun sharedAttachmentFileName(
  resolver: ContentResolver,
  uri: Uri,
): String {
  val displayName =
    try {
      resolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor -> cursor.firstString(OpenableColumns.DISPLAY_NAME) }
    } catch (_: Exception) {
      null
    }
  val raw = displayName ?: uri.lastPathSegment?.substringAfterLast('/') ?: "attachment"
  return raw
    .replace(Regex("[\\p{Cc}/\\\\]"), "_")
    .trim()
    .take(128)
    .ifEmpty { "attachment" }
}

private fun Cursor.firstString(columnName: String): String? {
  if (!moveToFirst()) return null
  val index = getColumnIndex(columnName)
  if (index < 0 || isNull(index)) return null
  return getString(index)?.trim()?.takeIf { it.isNotEmpty() }
}

/** Loads a picked image URI into the bounded JPEG attachment shape sent to chat. */
internal fun loadSizedImageAttachment(
  resolver: ContentResolver,
  uri: Uri,
): PendingAttachment {
  val fileName = normalizeAttachmentFileName((uri.lastPathSegment ?: "image").substringAfterLast('/'))
  val bitmap = decodeScaledBitmap(resolver, uri, maxDimension = CHAT_ATTACHMENT_MAX_WIDTH)
  if (bitmap == null) {
    throw IllegalStateException("unsupported attachment")
  }
  val maxBytes = (CHAT_IMAGE_MAX_BASE64_CHARS / 4) * 3
  // Reuse the node JPEG limiter so chat attachments and node photo payloads
  // stay within the same gateway frame budget.
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
  return PendingAttachment(
    id = uri.toString() + "#" + System.currentTimeMillis().toString(),
    fileName = fileName,
    mimeType = "image/jpeg",
    base64 = base64,
  )
}

/** Decodes chat image payloads into display-sized bitmaps with an LRU cache. */
internal fun decodeBase64Bitmap(
  base64: String,
  maxDimension: Int = CHAT_DECODE_MAX_DIMENSION,
): Bitmap? {
  if (base64.length > CHAT_IMAGE_MAX_BASE64_CHARS) return null
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

/** Computes Android's power-of-two bitmap sampling size for bounded decode. */
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

/** Normalizes arbitrary picked-image names to the JPEG file name sent upstream. */
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
