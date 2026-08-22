package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The snapshot layout is a hand-written contract between the JNI bridge and
 * Kotlin. A field added on one side without the other would shift every value
 * after it into the wrong name, so the decode is pinned by index here.
 */
class RealtimeMediaSnapshotTest {
  private fun buffer(vararg overrides: Pair<Int, Long>): LongArray {
    val values = LongArray(RealtimeMediaSnapshot.NATIVE_FIELD_COUNT)
    // Distinct per-index values make a shifted field obvious instead of
    // accidentally matching a neighbour.
    for (index in values.indices) values[index] = index.toLong() + 100L
    values[0] = RealtimeMediaReadiness.FullDuplexReady.ordinal.toLong()
    values[1] = RealtimeRouteProfile.BuiltInSpeaker.ordinal.toLong()
    values[2] = RealtimeEchoControlOwner.SoftwareAcousticProcessor.ordinal.toLong()
    values[3] = 1
    values[4] = 0
    for ((index, value) in overrides) values[index] = value
    return values
  }

  @Test
  fun decodesEveryFieldAtItsDeclaredIndex() {
    val snapshot = RealtimeMediaSnapshot.fromNative(buffer())
    assertEquals(RealtimeMediaReadiness.FullDuplexReady, snapshot.readiness)
    assertEquals(RealtimeRouteProfile.BuiltInSpeaker, snapshot.route)
    assertEquals(RealtimeEchoControlOwner.SoftwareAcousticProcessor, snapshot.echoControlOwner)
    assertTrue(snapshot.renderPresenting)
    assertEquals(false, snapshot.captureEligibleNow)
    assertEquals(105, snapshot.rates.wireInputHz)
    assertEquals(110, snapshot.rates.apmRenderHz)
    assertEquals(111L, snapshot.deviceClockEpoch)
    assertEquals(112L, snapshot.renderContentGeneration)
    assertEquals(113L, snapshot.captureEligibilityGeneration)
    assertEquals(114L, snapshot.acousticProcessorLifetime)
    assertEquals(115, snapshot.measuredStreamDelayMs)
    assertEquals(116L, snapshot.render.submittedSamples)
    assertEquals(124L, snapshot.render.markEventOverflows)
    assertEquals(125L, snapshot.capture.capturedFrames)
    assertEquals(132L, snapshot.capture.sentFrames)
    assertEquals(145L, snapshot.referenceRingDroppedSamples)
    assertEquals(146L, snapshot.telemetryDroppedEvents)
    assertEquals(147, snapshot.device.inputBurstFrames)
    assertTrue(snapshot.device.running)
    assertEquals(0.152f, snapshot.renderLevel!!, 0.0001f)
    assertEquals(0.153f, snapshot.captureLevel, 0.0001f)
    assertEquals(154, snapshot.device.inputDeviceId)
  }

  @Test
  fun anAbsentEchoMetricStaysAbsentRatherThanBecomingZero() {
    // "The processor has not measured an echo return loss" and "the echo return
    // loss is 0 dB" are different facts, and a readiness decision made from the
    // second when the first is true is exactly the wrong decision.
    val present = RealtimeMediaSnapshot.fromNative(buffer(39 to 1L, 40 to 12_500L, 43 to 1L, 44 to 42L))
    assertEquals(12.5, present.acoustic.echoReturnLossDb!!, 0.0001)
    assertEquals(42, present.acoustic.delayMs)

    val absent = RealtimeMediaSnapshot.fromNative(buffer(39 to 0L, 40 to 12_500L, 43 to 0L, 44 to 42L))
    assertNull(absent.acoustic.echoReturnLossDb)
    assertNull(absent.acoustic.delayMs)
  }

  @Test
  fun aShortBufferIsRejectedRatherThanDecodedPartially() {
    val short = LongArray(RealtimeMediaSnapshot.NATIVE_FIELD_COUNT - 1)
    val failure = runCatching { RealtimeMediaSnapshot.fromNative(short) }.exceptionOrNull()
    assertTrue(failure is IllegalArgumentException)
  }
}
