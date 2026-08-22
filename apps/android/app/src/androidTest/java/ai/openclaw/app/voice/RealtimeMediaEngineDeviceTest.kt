package ai.openclaw.app.voice

import android.Manifest
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs the shipped native engine on a real Android runtime.
 *
 * The host tests drive the same objects with synthetic callbacks; this one
 * opens real device streams through Oboe, so what it adds is everything the
 * host cannot reach: that `libopenclaw_media.so` loads and maps on the device,
 * that the JNI bulk transfer contract holds, that the platform negotiates a
 * device configuration the engine converts against, and that a barrier resolves
 * against a real device presentation clock.
 *
 * It says nothing about acoustics. An emulator has no room, no loudspeaker and
 * no microphone, so no assertion here is about echo.
 */
@RunWith(AndroidJUnit4::class)
class RealtimeMediaEngineDeviceTest {
  @get:Rule
  val microphonePermission: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

  private fun assistantPcm(millis: Int): ByteArray {
    val samples = WIRE_HZ * millis / 1000
    val pcm = ByteArray(samples * 2)
    for (index in 0 until samples) {
      val value = (12_000 * kotlin.math.sin(2.0 * Math.PI * 330.0 * index / WIRE_HZ)).toInt().toShort()
      pcm[index * 2] = (value.toInt() and 0xff).toByte()
      pcm[index * 2 + 1] = ((value.toInt() shr 8) and 0xff).toByte()
    }
    return pcm
  }

  private fun startedEngine(route: RealtimeRouteProfile): NativeRealtimeMediaEngine {
    val engine = NativeRealtimeMediaEngine.createOrNull()
    assertNotNull("native media engine failed to load on this device", engine)
    val started =
      engine!!.start(
        RealtimeMediaConfig(
          wireInputHz = WIRE_HZ,
          wireOutputHz = WIRE_HZ,
          requestedDeviceHz = 48_000,
          route = route,
          inputPreset = realtimeInputPresetForRoute(route, unprocessedSupported = false),
        ),
      )
    assertTrue("device streams did not start", started)
    return engine
  }

  @Test
  fun theEngineOpensRealDeviceStreamsAndReportsTheNegotiatedConfiguration() {
    val engine = startedEngine(RealtimeRouteProfile.BuiltInSpeaker)
    try {
      val snapshot = engine.snapshot()
      assertTrue("device streams not running", snapshot.device.running)
      // The wire rate and the device rate are independent facts. What matters is
      // that the engine recorded what the platform actually negotiated rather
      // than assuming its request took effect.
      assertEquals(WIRE_HZ, snapshot.rates.wireInputHz)
      assertTrue("no negotiated input rate", snapshot.rates.deviceInputHz > 0)
      assertTrue("no negotiated output rate", snapshot.rates.deviceOutputHz > 0)
      assertTrue("processor rate not native", snapshot.rates.apmCaptureHz in listOf(16_000, 32_000, 48_000))
      assertTrue("no device clock epoch", snapshot.deviceClockEpoch > 0)
      assertTrue("no burst size reported", snapshot.device.outputBurstFrames > 0)
      // Software echo control owns the loudspeaker route.
      assertEquals(RealtimeEchoControlOwner.SoftwareAcousticProcessor, snapshot.echoControlOwner)
      assertTrue("acoustic processor not running", snapshot.acoustic.active)
    } finally {
      engine.release()
    }
  }

  @Test
  fun assistantAudioIsPresentedAndItsBarrierResolvesOnTheDeviceClock() {
    val engine = startedEngine(RealtimeRouteProfile.BuiltInSpeaker)
    try {
      val generation = engine.beginRenderGeneration()
      assertTrue(engine.submitAssistantAudio(generation, assistantPcm(millis = 400)))
      assertTrue(engine.submitMark(MARK_ID))

      var presentedSeen = false
      var outcome: RealtimeMarkOutcome? = null
      val deadline = System.currentTimeMillis() + 8_000
      while (System.currentTimeMillis() < deadline && outcome == null) {
        if (engine.snapshot().renderPresenting) presentedSeen = true
        outcome = engine.drainMarkEvents().firstOrNull { it.markId == MARK_ID }?.outcome
        Thread.sleep(20)
      }

      assertTrue("assistant audio never reached the device", presentedSeen)
      // The barrier must resolve because the device presented the audio in
      // front of it, not because a buffer accepted a write.
      assertEquals(RealtimeMarkOutcome.Completed, outcome)
      assertTrue("nothing was presented", engine.snapshot().render.presentedSamples > 0)
    } finally {
      engine.release()
    }
  }

  @Test
  fun capturedAudioReachesTheUplinkOnARouteThatAllowsConcurrentCapture() {
    val engine = startedEngine(RealtimeRouteProfile.DeviceOwnedVoiceProcessing)
    try {
      val buffer = ByteArray(NativeRealtimeMediaEngine.UPLINK_DRAIN_BYTES)
      var uplinkBytes = 0
      val deadline = System.currentTimeMillis() + 8_000
      while (System.currentTimeMillis() < deadline && uplinkBytes == 0) {
        uplinkBytes = engine.drainUplink(buffer)
        Thread.sleep(20)
      }
      assertTrue("no captured audio reached the uplink", uplinkBytes > 0)
      // Wire frames, not device frames: the uplink carries what the provider
      // protocol expects after conversion.
      assertEquals(0, uplinkBytes % (WIRE_HZ * 2 * 10 / 1000))
      val snapshot = engine.snapshot()
      assertTrue("capture never ran", snapshot.capture.capturedFrames > 0)
      assertTrue("uplink reported nothing sent", snapshot.capture.sentFrames > 0)
    } finally {
      engine.release()
    }
  }

  @Test
  fun clearingARenderGenerationInvalidatesItsBarrierRatherThanStrandingIt() {
    val engine = startedEngine(RealtimeRouteProfile.BuiltInSpeaker)
    try {
      val generation = engine.beginRenderGeneration()
      assertTrue(engine.submitAssistantAudio(generation, assistantPcm(millis = 2_000)))
      assertTrue(engine.submitMark(MARK_ID))
      engine.clearRender()

      var outcome: RealtimeMarkOutcome? = null
      val deadline = System.currentTimeMillis() + 5_000
      while (System.currentTimeMillis() < deadline && outcome == null) {
        outcome = engine.drainMarkEvents().firstOrNull { it.markId == MARK_ID }?.outcome
        Thread.sleep(20)
      }
      // An unresolved barrier reads to the Gateway exactly like an assistant
      // turn that never finished, so a cancelled one still gets an outcome.
      assertEquals(RealtimeMarkOutcome.Cancelled, outcome)

      // Waited for separately: a barrier the consumer had already reached is
      // cancelled as soon as the clear lands, which is before the render
      // callback has walked the audio spans behind it and dropped them.
      var cancelledSamples = 0L
      val discardDeadline = System.currentTimeMillis() + 5_000
      while (System.currentTimeMillis() < discardDeadline && cancelledSamples == 0L) {
        cancelledSamples = engine.snapshot().render.cancelledSamples
        if (cancelledSamples == 0L) Thread.sleep(20)
      }
      assertTrue("cancelled audio was not discarded", cancelledSamples > 0)
    } finally {
      engine.release()
    }
  }

  @Test
  fun theTelemetrySinkCarriesTheTransitionsAnAssertionWouldRelyOn() {
    // Absence is evidence only when the observation path can carry the event.
    val engine = startedEngine(RealtimeRouteProfile.BuiltInSpeaker)
    try {
      // A route change also reopens the input stream with the preset the new
      // route implies, so this exercises the restart path on a real device.
      assertTrue(
        engine.setRoute(
          route = RealtimeRouteProfile.DeviceOwnedVoiceProcessing,
          inputPreset = RealtimeInputPreset.VoiceCommunication,
          preferredInputDeviceId = RealtimeMediaConfig.UNSPECIFIED_DEVICE_ID,
        ),
      )
      val kinds = engine.drainTelemetry().map { it.kind }.toSet()
      assertTrue("engine start not recorded", RealtimeMediaEventKind.EngineStarted in kinds)
      assertTrue("device epoch not recorded", RealtimeMediaEventKind.DeviceEpochBegan in kinds)
      assertTrue("route change not recorded", RealtimeMediaEventKind.RouteChanged in kinds)
      assertEquals(0L, engine.snapshot().telemetryDroppedEvents)
    } finally {
      engine.release()
    }
  }

  private companion object {
    const val WIRE_HZ = 24_000
    const val MARK_ID = 4_242L
  }
}
