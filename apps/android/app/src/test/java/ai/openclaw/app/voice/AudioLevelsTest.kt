package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioLevelsTest {
  @Test
  fun silenceMetersToZero() {
    val silence = ByteArray(640)
    assertEquals(0.0, TalkAudioLevel.pcm16Rms(silence, silence.size), 0.0)
    assertEquals(0f, TalkAudioLevel.pcm16Level(silence, silence.size), 0f)
  }

  @Test
  fun fullScaleMetersToOne() {
    val frame = pcm16Frame(samples = 160, sample = Short.MAX_VALUE)
    assertEquals(1.0, TalkAudioLevel.pcm16Rms(frame, frame.size), 1e-6)
    assertEquals(1f, TalkAudioLevel.pcm16Level(frame, frame.size), 1e-6f)
  }

  @Test
  fun negativeFullScaleClampsToOne() {
    // abs(-32768) exceeds Short.MAX_VALUE by one; the level must stay in 0..1.
    val frame = pcm16Frame(samples = 160, sample = Short.MIN_VALUE)
    assertEquals(1f, TalkAudioLevel.pcm16Level(frame, frame.size), 0f)
  }

  @Test
  fun midScaleFollowsTheSharedDecibelCurve() {
    // Same 50 dB window as OpenClawKit's TalkAudioLevel: half amplitude is
    // -6.02 dBFS, so the normalized level is (50 - 6.02) / 50 = 0.8796.
    val frame = pcm16Frame(samples = 160, sample = (Short.MAX_VALUE / 2).toShort())
    assertEquals(0.5, TalkAudioLevel.pcm16Rms(frame, frame.size), 1e-3)
    assertEquals(0.8796f, TalkAudioLevel.pcm16Level(frame, frame.size), 1e-3f)
  }

  @Test
  fun quietSignalsStayVisibleOnTheDecibelCurve() {
    // -40 dBFS (1% amplitude) still reads at 0.2 instead of vanishing, which is
    // what makes the wave feel alive at conversational distance on iOS/macOS.
    assertEquals(0.2f, TalkAudioLevel.normalized(rms = 0.01), 1e-3f)
    assertEquals(0f, TalkAudioLevel.normalized(rms = 0.0), 0f)
    assertEquals(1f, TalkAudioLevel.normalized(rms = 1.0), 0f)
  }

  @Test
  fun trailingOddByteAndEmptyLengthAreIgnored() {
    val frame = pcm16Frame(samples = 2, sample = Short.MAX_VALUE) + byteArrayOf(0x7F)
    assertEquals(1f, TalkAudioLevel.pcm16Level(frame, frame.size), 1e-6f)
    assertEquals(0f, TalkAudioLevel.pcm16Level(frame, 0), 0f)
    assertEquals(0f, TalkAudioLevel.pcm16Level(frame, 1), 0f)
  }

  @Test
  fun smoothingMatchesIosWeighting() {
    assertEquals(0.2f, TalkAudioLevel.smoothed(previous = 0f, raw = 1f), 1e-6f)
    assertEquals(0.36f, TalkAudioLevel.smoothed(previous = 0.2f, raw = 1f), 1e-6f)
    assertEquals(0.8f, TalkAudioLevel.smoothed(previous = 1f, raw = 0f), 1e-6f)
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
