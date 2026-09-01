package ai.openclaw.app.ui.design

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI

/** Guards the exact constants ported from TalkWaveformView.swift. */
class TalkWaveformMathTest {
  @Test
  fun idlePowerIsStaticRegardlessOfTime() {
    assertEquals(0.05, TalkWaveformMath.power(TalkWaveformPhase.Idle, 0.0), 1e-9)
    assertEquals(0.05, TalkWaveformMath.power(TalkWaveformPhase.Idle, 42.5), 1e-9)
  }

  @Test
  fun thinkingBreathesInsideItsBand() {
    assertEquals(0.21, TalkWaveformMath.power(TalkWaveformPhase.Thinking, 0.0), 1e-9)
    var time = 0.0
    while (time < 10.0) {
      val power = TalkWaveformMath.power(TalkWaveformPhase.Thinking, time)
      assertTrue(power in 0.16..0.26)
      time += 0.1
    }
  }

  @Test
  fun listeningClampsLevelAndSpeechRaisesFloor() {
    assertEquals(0.30, TalkWaveformMath.power(TalkWaveformPhase.Listening(level = -0.5f, speechActive = false), 0.0), 1e-9)
    assertEquals(0.95, TalkWaveformMath.power(TalkWaveformPhase.Listening(level = 1.5f, speechActive = false), 0.0), 1e-9)
    assertEquals(0.56, TalkWaveformMath.power(TalkWaveformPhase.Listening(level = 0.4f, speechActive = false), 0.0), 1e-6)
    assertEquals(0.73, TalkWaveformMath.power(TalkWaveformPhase.Listening(level = 0.4f, speechActive = true), 0.0), 1e-6)
    assertEquals(1.0, TalkWaveformMath.power(TalkWaveformPhase.Listening(level = 2f, speechActive = true), 0.0), 1e-9)
  }

  @Test
  fun speakingClampsMeteredLevel() {
    assertEquals(0.25, TalkWaveformMath.power(TalkWaveformPhase.Speaking(level = -1f), 0.0), 1e-9)
    assertEquals(1.0, TalkWaveformMath.power(TalkWaveformPhase.Speaking(level = 2f), 0.0), 1e-9)
    assertEquals(0.70, TalkWaveformMath.power(TalkWaveformPhase.Speaking(level = 0.6f), 0.0), 1e-6)
  }

  @Test
  fun speakingWithoutEnvelopePulsesSynthetically() {
    val trough = TalkWaveformMath.power(TalkWaveformPhase.Speaking(level = null), 0.0)
    val peak = TalkWaveformMath.power(TalkWaveformPhase.Speaking(level = null), PI / 10.0)
    assertEquals(0.70 * 0.55, trough, 1e-9)
    assertEquals(0.70, peak, 1e-9)
    var time = 0.0
    while (time < 5.0) {
      val power = TalkWaveformMath.power(TalkWaveformPhase.Speaking(level = null), time)
      assertTrue(power in trough..peak)
      time += 0.05
    }
  }

  @Test
  fun lobesAreDeterministicWithFixedShapeConstants() {
    val lobes = TalkWaveformMath.lobes(time = 1.25, seed = 7.31)
    assertEquals(lobes, TalkWaveformMath.lobes(time = 1.25, seed = 7.31))
    assertEquals(3, lobes.size)
    assertEquals(0.62, lobes[0].k, 1e-9)
    assertEquals(0.73, lobes[1].k, 1e-9)
    assertEquals(0.84, lobes[2].k, 1e-9)
    for (lobe in lobes) {
      assertTrue(lobe.amplitude in 0.30..1.0)
      assertTrue(lobe.t in -2.8..2.8)
    }
  }

  @Test
  fun attenuatedSinePeaksAtFullAmplitudeAndStaysNonNegative() {
    // At kx − t = −π/2 the bell envelope is exactly 1 and |sin| is 1.
    assertEquals(3.0, TalkWaveformMath.attenuatedSine(x = -PI / 2, amplitude = 3.0, k = 1.0, t = 0.0), 1e-9)
    var x = -9.0
    while (x <= 9.0) {
      assertTrue(TalkWaveformMath.attenuatedSine(x = x, amplitude = 1.0, k = 0.73, t = 1.4) >= 0.0)
      x += 0.25
    }
  }
}
