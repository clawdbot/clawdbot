package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.min

class JpegSizeLimiterTest {
  @Test
  fun compressesLargePayloadsUnderLimit() {
    val maxBytes = 5 * 1024 * 1024
    val result =
      JpegSizeLimiter.compressToLimit(
        initialWidth = 4000,
        initialHeight = 3000,
        startQuality = 95,
        maxBytes = maxBytes,
        encode = { width, height, quality ->
          val estimated = (width.toLong() * height.toLong() * quality.toLong()) / 100
          val size = min(maxBytes.toLong() * 2, estimated).toInt()
          ByteArray(size)
        },
      )

    assertTrue(result.bytes.size <= maxBytes)
    assertTrue(result.width <= 4000)
    assertTrue(result.height <= 3000)
    assertTrue(result.quality <= 95)
  }

  @Test
  fun keepsSmallPayloadsAsIs() {
    val maxBytes = 5 * 1024 * 1024
    val result =
      JpegSizeLimiter.compressToLimit(
        initialWidth = 800,
        initialHeight = 600,
        startQuality = 90,
        maxBytes = maxBytes,
        encode = { _, _, _ -> ByteArray(120_000) },
      )

    assertEquals(800, result.width)
    assertEquals(600, result.height)
    assertEquals(90, result.quality)
  }

  @Test
  fun triesFinalScaledImageBeforeFailing() {
    val result =
      JpegSizeLimiter.compressToLimit(
        initialWidth = 1000,
        initialHeight = 800,
        startQuality = 90,
        maxBytes = 100,
        minSize = 1,
        scaleStep = 0.5,
        maxScaleAttempts = 1,
        maxQualityAttempts = 1,
        encode = { width, _, _ ->
          if (width == 500) ByteArray(80) else ByteArray(120)
        },
      )

    assertEquals(500, result.width)
    assertEquals(400, result.height)
    assertEquals(90, result.quality)
    assertEquals(80, result.bytes.size)
  }
}
