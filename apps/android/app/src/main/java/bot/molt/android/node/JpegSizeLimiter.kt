package bot.molt.android.node

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

internal data class JpegSizeLimiterResult(
  val bytes: ByteArray,
  val width: Int,
  val height: Int,
  val quality: Int,
)

internal object JpegSizeLimiter {
  fun compressToLimit(
    initialWidth: Int,
    initialHeight: Int,
    startQuality: Int,
    maxBytes: Int,
    minQuality: Int = 20,
    minSize: Int = 256,
    scaleStep: Double = 0.85,
    maxScaleAttempts: Int = 6,
    maxQualityAttempts: Int = 6,
    encode: (width: Int, height: Int, quality: Int) -> ByteArray,
  ): JpegSizeLimiterResult {
    require(initialWidth > 0 && initialHeight > 0) { "Invalid image size" }
    require(maxBytes > 0) { "Invalid maxBytes" }

    var width = initialWidth
    var height = initialHeight
    val clampedStartQuality = startQuality.coerceIn(minQuality, 100)
    var best = JpegSizeLimiterResult(bytes = encode(width, height, clampedStartQuality), width = width, height = height, quality = clampedStartQuality)
    if (best.bytes.size <= maxBytes) return best

    repeat(maxScaleAttempts) {
      var quality = clampedStartQuality
      repeat(maxQualityAttempts) {
        val bytes = encode(width, height, quality)
        best = JpegSizeLimiterResult(bytes = bytes, width = width, height = height, quality = quality)
        if (bytes.size <= maxBytes) return best
        if (quality <= minQuality) return@repeat
        quality = max(minQuality, (quality * 0.75).roundToInt())
      }

      val minScale = (minSize.toDouble() / min(width, height).toDouble()).coerceAtMost(1.0)
      val nextScale = max(scaleStep, minScale)
      val nextWidth = max(minSize, (width * nextScale).roundToInt())
      val nextHeight = max(minSize, (height * nextScale).roundToInt())
      if (nextWidth == width && nextHeight == height) return@repeat
      width = min(nextWidth, width)
      height = min(nextHeight, height)
    }

    if (best.bytes.size > maxBytes) {
      throw IllegalStateException("CAMERA_TOO_LARGE: ${best.bytes.size} bytes > $maxBytes bytes")
    }

    return best
  }
}
