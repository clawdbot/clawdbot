package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.core.graphics.scale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.time.Instant
import kotlin.math.max
import kotlin.math.roundToInt

private const val DEFAULT_PHOTOS_LIMIT = 1
private const val DEFAULT_PHOTOS_MAX_WIDTH = 1600
private const val DEFAULT_PHOTOS_QUALITY = 0.85
private const val MAX_TOTAL_BASE64_CHARS = 340 * 1024
private const val MAX_PER_PHOTO_BASE64_CHARS = 300 * 1024

internal data class PhotosLatestRequest(
  val limit: Int,
  val maxWidth: Int,
  val quality: Double,
)

internal data class EncodedPhotoPayload(
  val format: String,
  val base64: String,
  val width: Int,
  val height: Int,
  val createdAt: String?,
)

internal interface PhotosDataSource {
  fun hasPermission(context: Context): Boolean

  fun latest(
    context: Context,
    request: PhotosLatestRequest,
  ): List<EncodedPhotoPayload>
}

private object SystemPhotosDataSource : PhotosDataSource {
  override fun hasPermission(context: Context): Boolean {
    val permission =
      if (Build.VERSION.SDK_INT >= 33) {
        Manifest.permission.READ_MEDIA_IMAGES
      } else {
        Manifest.permission.READ_EXTERNAL_STORAGE
      }
    return ContextCompat.checkSelfPermission(context, permission) == android.content.pm.PackageManager.PERMISSION_GRANTED
  }

  override fun latest(
    context: Context,
    request: PhotosLatestRequest,
  ): List<EncodedPhotoPayload> {
    val resolver = context.contentResolver
    val rows = queryLatestRows(resolver, request.limit)
    if (rows.isEmpty()) return emptyList()

    var remainingBudget = MAX_TOTAL_BASE64_CHARS
    val out = mutableListOf<EncodedPhotoPayload>()
    for (row in rows) {
      if (remainingBudget <= 0) break
      val bitmap = decodeScaledBitmap(resolver, row.uri, request.maxWidth) ?: continue
      try {
        val encoded = encodeJpegUnderBudget(bitmap, request.quality, MAX_PER_PHOTO_BASE64_CHARS)
        if (encoded == null) continue
        if (encoded.base64.length > remainingBudget) break
        remainingBudget -= encoded.base64.length
        out +=
          EncodedPhotoPayload(
            format = "jpeg",
            base64 = encoded.base64,
            width = encoded.width,
            height = encoded.height,
            createdAt = row.createdAtMs?.let { Instant.ofEpochMilli(it).toString() },
          )
      } finally {
        bitmap.recycle()
      }
    }
    return out
  }

  private data class PhotoRow(
    val uri: Uri,
    val createdAtMs: Long?,
  )

  private data class EncodedJpeg(
    val base64: String,
    val width: Int,
    val height: Int,
  )

  private fun queryLatestRows(
    resolver: ContentResolver,
    limit: Int,
  ): List<PhotoRow> {
    val projection =
      arrayOf(
        MediaStore.Images.Media._ID,
        MediaStore.Images.Media.DATE_TAKEN,
        MediaStore.Images.Media.DATE_ADDED,
      )
    val sortOrder =
      "${MediaStore.Images.Media.DATE_TAKEN} DESC, ${MediaStore.Images.Media.DATE_ADDED} DESC"
    val args =
      Bundle().apply {
        putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sortOrder)
        putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
      }

    resolver
      .query(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        projection,
        args,
        null,
      ).use { cursor ->
        if (cursor == null) return emptyList()
        val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
        val takenIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
        val addedIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
        val rows = mutableListOf<PhotoRow>()
        while (cursor.moveToNext()) {
          val id = cursor.getLong(idIndex)
          val takenMs = cursor.getLong(takenIndex).takeIf { it > 0L }
          val addedMs = cursor.getLong(addedIndex).takeIf { it > 0L }?.times(1000L)
          rows +=
            PhotoRow(
              uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id),
              createdAtMs = takenMs ?: addedMs,
            )
        }
        return rows
      }
  }

  private fun decodeScaledBitmap(
    resolver: ContentResolver,
    uri: Uri,
    maxWidth: Int,
  ): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri).use { input ->
      if (input == null) return null
      BitmapFactory.decodeStream(input, null, bounds)
    }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    val inSampleSize = computeInSampleSize(bounds.outWidth, maxWidth)
    val decodeOptions = BitmapFactory.Options().apply { this.inSampleSize = inSampleSize }
    val decoded =
      resolver.openInputStream(uri).use { input ->
        if (input == null) return null
        BitmapFactory.decodeStream(input, null, decodeOptions)
      } ?: return null

    if (decoded.width <= maxWidth) return decoded
    val targetHeight = max(1, ((decoded.height.toDouble() * maxWidth) / decoded.width).roundToInt())
    return try {
      decoded.scale(maxWidth, targetHeight, true)
    } finally {
      decoded.recycle()
    }
  }

  private fun computeInSampleSize(
    width: Int,
    maxWidth: Int,
  ): Int {
    var sample = 1
    var candidate = width
    while (candidate > maxWidth && sample < 64) {
      sample *= 2
      candidate = width / sample
    }
    return sample
  }

  private fun encodeJpegUnderBudget(
    bitmap: Bitmap,
    quality: Double,
    maxBase64Chars: Int,
  ): EncodedJpeg? {
    var working = bitmap
    try {
      var jpegQuality = (quality.coerceIn(0.1, 1.0) * 100.0).roundToInt().coerceIn(10, 100)
      repeat(10) {
        val out = ByteArrayOutputStream()
        val ok = working.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
        if (!ok) return null
        val bytes = out.toByteArray()
        val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        if (base64.length <= maxBase64Chars) {
          return EncodedJpeg(
            base64 = base64,
            width = working.width,
            height = working.height,
          )
        }
        if (jpegQuality > 35) {
          jpegQuality = max(25, jpegQuality - 15)
          return@repeat
        }
        val nextWidth = max(240, (working.width * 0.75f).roundToInt())
        if (nextWidth >= working.width) return null
        val nextHeight = max(1, ((working.height.toDouble() * nextWidth) / working.width).roundToInt())
        val previous = working
        working = working.scale(nextWidth, nextHeight, true)
        if (previous !== bitmap) previous.recycle()
      }
      return null
    } finally {
      if (working !== bitmap) working.recycle()
    }
  }
}

class PhotosHandler private constructor(
  private val appContext: Context,
  private val dataSource: PhotosDataSource,
) {
  constructor(appContext: Context) : this(appContext = appContext, dataSource = SystemPhotosDataSource)

  fun handlePhotosLatest(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasPermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "PHOTOS_PERMISSION_REQUIRED",
        message = "PHOTOS_PERMISSION_REQUIRED: grant Photos permission",
      )
    }
    val request =
      parseRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    return try {
      val photos = dataSource.latest(appContext, request)
      val payload =
        buildJsonObject {
          put(
            "photos",
            buildJsonArray {
              photos.forEach { photo ->
                add(
                  buildJsonObject {
                    put("format", JsonPrimitive(photo.format))
                    put("base64", JsonPrimitive(photo.base64))
                    put("width", JsonPrimitive(photo.width))
                    put("height", JsonPrimitive(photo.height))
                    photo.createdAt?.let { put("createdAt", JsonPrimitive(it)) }
                  },
                )
              }
            },
          )
        }.toString()
      GatewaySession.InvokeResult.ok(payload)
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "PHOTOS_UNAVAILABLE",
        message = "PHOTOS_UNAVAILABLE: ${err.message ?: "photo fetch failed"}",
      )
    }
  }

  private fun parseRequest(paramsJson: String?): PhotosLatestRequest? {
    if (paramsJson.isNullOrBlank()) {
      return PhotosLatestRequest(
        limit = DEFAULT_PHOTOS_LIMIT,
        maxWidth = DEFAULT_PHOTOS_MAX_WIDTH,
        quality = DEFAULT_PHOTOS_QUALITY,
      )
    }
    val params =
      try {
        Json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null

    val limitRaw = (params["limit"] as? JsonPrimitive)?.content?.toIntOrNull()
    val maxWidthRaw = (params["maxWidth"] as? JsonPrimitive)?.content?.toIntOrNull()
    val qualityRaw = (params["quality"] as? JsonPrimitive)?.content?.toDoubleOrNull()

    val limit = (limitRaw ?: DEFAULT_PHOTOS_LIMIT).coerceIn(1, 20)
    val maxWidth = (maxWidthRaw ?: DEFAULT_PHOTOS_MAX_WIDTH).coerceIn(240, 4096)
    val quality = (qualityRaw ?: DEFAULT_PHOTOS_QUALITY).coerceIn(0.1, 1.0)
    return PhotosLatestRequest(limit = limit, maxWidth = maxWidth, quality = quality)
  }

  companion object {
    internal fun forTesting(
      appContext: Context,
      dataSource: PhotosDataSource,
    ): PhotosHandler = PhotosHandler(appContext = appContext, dataSource = dataSource)
  }
}
