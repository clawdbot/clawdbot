package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioLevelsTest {
  @Test
  fun silenceMetersToZero() {
    val silence = ByteArray(640)
    assertEquals(0f, pcm16MeanAbsLevel(silence, silence.size), 0f)
  }

  @Test
  fun fullScaleMetersToOne() {
    val frame = pcm16Frame(samples = 160, sample = Short.MAX_VALUE)
    assertEquals(1f, pcm16MeanAbsLevel(frame, frame.size), 1e-6f)
  }

  @Test
  fun negativeFullScaleClampsToOne() {
    // abs(-32768) exceeds Short.MAX_VALUE by one; the level must stay in 0..1.
    val frame = pcm16Frame(samples = 160, sample = Short.MIN_VALUE)
    assertEquals(1f, pcm16MeanAbsLevel(frame, frame.size), 0f)
  }

  @Test
  fun midScaleMetersToHalf() {
    val frame = pcm16Frame(samples = 160, sample = (Short.MAX_VALUE / 2).toShort())
    assertEquals(0.5f, pcm16MeanAbsLevel(frame, frame.size), 1e-3f)
  }

  @Test
  fun trailingOddByteAndEmptyLengthAreIgnored() {
    val frame = pcm16Frame(samples = 2, sample = Short.MAX_VALUE) + byteArrayOf(0x7F)
    assertEquals(1f, pcm16MeanAbsLevel(frame, frame.size), 1e-6f)
    assertEquals(0f, pcm16MeanAbsLevel(frame, 0), 0f)
    assertEquals(0f, pcm16MeanAbsLevel(frame, 1), 0f)
  }

  @Test
  fun smoothingMatchesIosWeighting() {
    assertEquals(0.2f, smoothedAudioLevel(previous = 0f, raw = 1f), 1e-6f)
    assertEquals(0.36f, smoothedAudioLevel(previous = 0.2f, raw = 1f), 1e-6f)
    assertEquals(0.8f, smoothedAudioLevel(previous = 1f, raw = 0f), 1e-6f)
  }

  private fun pcm16Frame(
    samples: Int,
    sample: Short,
  ): ByteArray {
    val frame = ByteArray(samples * 2)
    for (index in 0 until samples) {
      frame[index * 2] = (sample.toInt() and 0xff).toByte()
      frame[index * 2 + 1] = ((sample.toInt() shr 8) and 0xff).toByte()
    }
    return frame
  }
}
