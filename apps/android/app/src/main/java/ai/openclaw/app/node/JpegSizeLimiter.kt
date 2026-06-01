package ai.openclaw.app.node

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Result of a JPEG compression attempt after quality and scale reductions.
 */
internal data class JpegSizeLimiterResult(
  val bytes: ByteArray,
  val width: Int,
  val height: Int,
  val quality: Int,
)

/**
 * Utility that searches quality/scale combinations until a JPEG fits a byte budget.
 */
internal object JpegSizeLimiter {
  /** Compresses with the caller-provided encoder, reducing quality before image dimensions. */
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

    val clampedStartQuality = startQuality.coerceIn(minQuality, 100)
    var width = initialWidth
    var height = initialHeight
    var best: JpegSizeLimiterResult? = null

    repeat(maxScaleAttempts + 1) { scaleAttempt ->
      var quality = clampedStartQuality
      repeat(maxQualityAttempts) {
        val bytes = encode(width, height, quality)
        val attempt = JpegSizeLimiterResult(bytes = bytes, width = width, height = height, quality = quality)
        best = attempt
        if (bytes.size <= maxBytes) return best
        if (quality <= minQuality) return@repeat
        quality = max(minQuality, (quality * 0.75).roundToInt())
      }

      if (scaleAttempt == maxScaleAttempts) return@repeat
      val minScale = (minSize.toDouble() / min(width, height).toDouble()).coerceAtMost(1.0)
      val nextScale = max(scaleStep, minScale)
      val nextWidth = max(minSize, (width * nextScale).roundToInt())
      val nextHeight = max(minSize, (height * nextScale).roundToInt())
      if (nextWidth == width && nextHeight == height) return@repeat
      width = min(nextWidth, width)
      height = min(nextHeight, height)
    }

    val failed = checkNotNull(best)
    if (failed.bytes.size > maxBytes) {
      throw IllegalStateException("CAMERA_TOO_LARGE: ${failed.bytes.size} bytes > $maxBytes bytes")
    }

    return failed
  }
}
