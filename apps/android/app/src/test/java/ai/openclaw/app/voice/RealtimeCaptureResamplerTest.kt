package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

class RealtimeCaptureResamplerTest {
  @Test
  fun rejectsRatiosThatArentAnExactIntegerDownsample() {
    assertNull(resolveRealtimeCaptureResampler(captureRateHz = 48_000, wireRateHz = 22_050))
    assertNull(resolveRealtimeCaptureResampler(captureRateHz = 16_000, wireRateHz = 24_000))
    assertNull(resolveRealtimeCaptureResampler(captureRateHz = 48_000, wireRateHz = 0))
    assertNull(resolveRealtimeCaptureResampler(captureRateHz = 0, wireRateHz = 24_000))
  }

  @Test
  fun equalRatePassesThroughUnchanged() {
    val resampler = resolveRealtimeCaptureResampler(captureRateHz = 24_000, wireRateHz = 24_000)!!
    val input = sineSamples(freqHz = 440.0, sampleRateHz = 24_000, count = 480)
    val bytes = pcm16Bytes(input)

    val output = resampler.process(bytes, bytes.size)

    assertEquals(bytes.size, output.size)
    assertTrue(bytes.contentEquals(output))
  }

  @Test
  fun downsample48kTo24kHalvesTheSampleCount() {
    val resampler = resolveRealtimeCaptureResampler(captureRateHz = 48_000, wireRateHz = 24_000)!!
    val chunk = pcm16Bytes(sineSamples(freqHz = 1_000.0, sampleRateHz = 48_000, count = 4_800))

    val output = resampler.process(chunk, chunk.size)

    // 100ms of 48kHz capture (4,800 samples) must become 100ms of 24kHz wire
    // audio (2,400 samples) -- the frame represents the Gateway-advertised
    // rate, not the capture rate.
    assertEquals(2_400 * 2, output.size)
  }

  @Test
  fun chunkBoundariesProduceNoGapsOrDuplicationVersusOneShotProcessing() {
    val signal = sineSamples(freqHz = 300.0, sampleRateHz = 48_000, count = 9_600)
    val bytes = pcm16Bytes(signal)

    val wholeChunk = resolveRealtimeCaptureResampler(48_000, 24_000)!!.process(bytes, bytes.size)

    val piecemeal = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val out = java.io.ByteArrayOutputStream()
    var offset = 0
    // Odd, uneven chunk sizes -- not a clean divisor of the frame or the
    // decimation factor -- exercise both chunk-boundary continuity and
    // odd-sized input handling in one pass.
    val chunkSizesBytes = intArrayOf(37, 501, 2, 1200, 4001, 999)
    var chunkIndex = 0
    while (offset < bytes.size) {
      val size = minOf(chunkSizesBytes[chunkIndex % chunkSizesBytes.size], bytes.size - offset)
      chunkIndex += 1
      val piece = bytes.copyOfRange(offset, offset + size)
      out.write(piecemeal.process(piece, piece.size))
      offset += size
    }

    assertTrue(wholeChunk.contentEquals(out.toByteArray()))
  }

  @Test
  fun constantSignalReachesASteadyStateConstantOutput() {
    val resampler = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val level = 5_000
    val bytes = pcm16Bytes(IntArray(9_600) { level })

    val output = pcm16Samples(resampler.process(bytes, bytes.size))

    // Skip the filter's warm-up transient (zero-initialized history); the
    // rest of a sustained DC input must settle back to the input level.
    for (sample in output.drop(64)) {
      assertEquals(level.toDouble(), sample.toDouble(), 3.0)
    }
  }

  @Test
  fun belowNyquistToneKeepsItsFrequencyAfterDecimation() {
    val resampler = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val freqHz = 1_000.0
    val durationSamples = 48_000 // 1 second, safely below the 12kHz output Nyquist
    val bytes = pcm16Bytes(sineSamples(freqHz, 48_000, durationSamples))

    val output = pcm16Samples(resampler.process(bytes, bytes.size))

    val steadyState = output.drop(64)
    val crossings = zeroCrossings(steadyState)
    val steadySeconds = steadyState.size / 24_000.0
    val estimatedHz = crossings / 2.0 / steadySeconds

    assertEquals(freqHz, estimatedHz, 25.0)
  }

  @Test
  fun aliasSensitiveHighFrequencyIsAttenuatedNotAliasedThrough() {
    // 20kHz at 48kHz capture is above the 12kHz output Nyquist; naive
    // drop-every-other-sample decimation aliases it into the 4kHz audible
    // band. The anti-alias filter must suppress it instead.
    val freqHz = 20_000.0
    val captureCount = 9_600
    val samples = sineSamples(freqHz, 48_000, captureCount)
    val bytes = pcm16Bytes(samples)

    val filtered = pcm16Samples(resolveRealtimeCaptureResampler(48_000, 24_000)!!.process(bytes, bytes.size))
    val naive = DoubleArray(samples.size / 2) { samples[it * 2].toDouble() }

    assertTrue(rms(filtered.map { it.toDouble() }) < rms(naive.toList()) * 0.25)
  }

  @Test
  fun fullScaleSquareEdgesStayWithinPcm16Bounds() {
    val resampler = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val samples = IntArray(4_800) { if (it % 2 == 0) Short.MAX_VALUE.toInt() else Short.MIN_VALUE.toInt() }
    val bytes = pcm16Bytes(samples)

    val output = pcm16Samples(resampler.process(bytes, bytes.size))

    for (sample in output) {
      assertTrue(sample >= Short.MIN_VALUE.toInt() && sample <= Short.MAX_VALUE.toInt())
    }
  }

  @Test
  fun freshInstancesDoNotShareStateAcrossSessions() {
    val leftoverOddByte = byteArrayOf(0x11, 0x22, 0x33)
    resolveRealtimeCaptureResampler(48_000, 24_000)!!.process(leftoverOddByte, leftoverOddByte.size)

    // A brand new instance for a new capture session (as startRealtimeCaptureLocked
    // creates on every start/PTT-resume) must behave identically to the very
    // first instance ever created, regardless of what a prior session did.
    val a = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val b = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val bytes = pcm16Bytes(sineSamples(500.0, 48_000, 4_800))

    assertTrue(a.process(bytes, bytes.size).contentEquals(b.process(bytes, bytes.size)))
  }

  private fun sineSamples(
    freqHz: Double,
    sampleRateHz: Int,
    count: Int,
    amplitude: Int = 16_000,
  ): IntArray = IntArray(count) { n -> (amplitude * sin(2.0 * PI * freqHz * n / sampleRateHz)).roundToInt() }

  private fun pcm16Bytes(samples: IntArray): ByteArray {
    val bytes = ByteArray(samples.size * 2)
    for (i in samples.indices) {
      bytes[i * 2] = (samples[i] and 0xff).toByte()
      bytes[i * 2 + 1] = ((samples[i] shr 8) and 0xff).toByte()
    }
    return bytes
  }

  private fun pcm16Samples(bytes: ByteArray): IntArray =
    IntArray(bytes.size / 2) { i ->
      val lo = bytes[i * 2].toInt() and 0xff
      val hi = bytes[i * 2 + 1].toInt()
      ((lo) or (hi shl 8)).toShort().toInt()
    }

  private fun zeroCrossings(samples: List<Int>): Int {
    var count = 0
    for (i in 1 until samples.size) {
      if ((samples[i - 1] < 0) != (samples[i] < 0)) count += 1
    }
    return count
  }

  private fun rms(samples: List<Double>): Double = sqrt(samples.sumOf { it * it } / samples.size)
}
