package ai.openclaw.app.voice

import android.Manifest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The half-duplex fallback has no canceller, so its uplink gate is the only
 * thing keeping assistant audio out of the microphone stream. These cover the
 * two places that gate and the payload boundary can be wrong.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LegacyRealtimeMediaEngineTest {
  private val context = RuntimeEnvironment.getApplication()
  private val engines = mutableListOf<LegacyRealtimeMediaEngine>()

  @Before
  fun setUp() {
    shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
  }

  @After
  fun tearDown() {
    engines.forEach { it.release() }
    engines.clear()
    setDeviceWorkers(0)
    ShadowAudioTrack.resetTest()
  }

  @Test
  fun theUplinkGateIsClosedBeforeTheFirstSampleReachesTheTrack() {
    val fallback = newEngine()
    val presentingDuringWrite = LinkedBlockingQueue<Boolean>()
    val listener =
      ShadowAudioTrack.OnAudioDataWrittenListener { _, _, _ ->
        presentingDuringWrite.offer(fallback.snapshot().renderPresenting)
      }
    ShadowAudioTrack.addAudioDataListener(listener)
    try {
      assertTrue(fallback.start(config()))
      fallback.submitAssistantAudio(fallback.beginRenderGeneration(), ByteArray(4_800))

      // `AudioTrack.write` blocks until the buffer accepts. A gate that only
      // closes once it returns leaves the microphone open while the speaker is
      // already presenting, and this path has no canceller to clean what it
      // captures.
      assertEquals(true, presentingDuringWrite.poll(5, TimeUnit.SECONDS))
    } finally {
      ShadowAudioTrack.removeAudioDataListener(listener)
    }
  }

  @Test
  fun anUplinkPayloadNeverSpansADroppedInterval() {
    val fallback = newEngine()
    // Two frames of one utterance, then the frame that followed a queue
    // overflow: the audio between them was dropped and never sent.
    enqueueUplink(fallback, ByteArray(4) { 1 }, contiguousWithPrevious = false)
    enqueueUplink(fallback, ByteArray(4) { 2 }, contiguousWithPrevious = true)
    enqueueUplink(fallback, ByteArray(4) { 3 }, contiguousWithPrevious = false)

    val buffer = ByteArray(64)
    // Concatenating all three would hand the provider a missing interval
    // presented as continuous speech.
    assertEquals(8, fallback.drainUplink(buffer))
    assertEquals(4, fallback.drainUplink(buffer))
    assertEquals(0, fallback.drainUplink(buffer))
  }

  @Test
  fun aSecondEngineRefusesToOpenWhileTheFirstStillOwnsTheDevice() {
    val first = newEngine()
    assertTrue(first.start(config()))
    // A worker that outlived its join still holds the recorder and the track.
    setDeviceWorkers(1)
    try {
      // Opening a second pair against the same device gives a microphone that
      // fails to open or two overlapping playbacks; refusing lets the owner
      // report a media failure instead.
      assertFalse(newEngine().start(config()))
    } finally {
      setDeviceWorkers(0)
    }
  }

  @Test
  fun teardownStillReleasesTheDeviceAfterAWorkerStoppedItself() {
    val fallback = newEngine()
    assertTrue(fallback.start(config()))
    // The render worker clears `running` itself when its track dies.
    setRunning(fallback, false)

    fallback.stop()

    // Gated on `running`, this would return before joining the workers and
    // releasing the microphone, and every later start would be refused.
    assertEquals(0, deviceWorkers())
  }

  @Test
  fun aRenderWorkerKilledByItsTrackReportsAStreamErrorInsteadOfGoingQuiet() {
    val fallback = newEngine()
    // Counted down before the throw, so a failure says which half broke: the
    // worker never reaching the track, or the handler not recording the fault.
    val reachedTrack = java.util.concurrent.CountDownLatch(1)
    val listener =
      ShadowAudioTrack.OnAudioDataWrittenListener { _, _, _ ->
        reachedTrack.countDown()
        // What the platform does to a track it has invalidated: `write` throws
        // rather than returning an error code.
        throw IllegalStateException("track invalidated")
      }
    ShadowAudioTrack.addAudioDataListener(listener)
    try {
      assertTrue(fallback.start(config()))
      fallback.submitAssistantAudio(fallback.beginRenderGeneration(), ByteArray(4_800))

      assertTrue(
        "the render worker never reached the track",
        reachedTrack.await(WORKER_TIMEOUT_SECONDS, TimeUnit.SECONDS),
      )
      // Without the handler the worker thread just ends. The engine keeps
      // advertising a live session, the control loop keeps queueing audio and
      // barriers into it, and the Gateway waits on a turn nothing can finish.
      // `StreamError` is what makes the control loop end the session, because
      // the fallback has no stream restart to recover with.
      assertTrue(
        "the render worker died without reporting a StreamError",
        awaitStreamError(fallback),
      )
    } finally {
      ShadowAudioTrack.removeAudioDataListener(listener)
    }
  }

  private fun awaitStreamError(fallback: LegacyRealtimeMediaEngine): Boolean {
    // Generous on purpose: this waits on a worker thread starting under a cold
    // JVM on a shared CI runner, not on anything the engine paces.
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WORKER_TIMEOUT_SECONDS)
    while (System.nanoTime() < deadline) {
      if (fallback.drainTelemetry().any { it.kind == RealtimeMediaEventKind.StreamError }) return true
      Thread.sleep(10)
    }
    return false
  }

  private fun setRunning(
    fallback: LegacyRealtimeMediaEngine,
    value: Boolean,
  ) {
    val field = LegacyRealtimeMediaEngine::class.java.getDeclaredField("running")
    field.isAccessible = true
    (field.get(fallback) as java.util.concurrent.atomic.AtomicBoolean).set(value)
  }

  private fun deviceWorkers(): Int {
    val field = LegacyRealtimeMediaEngine::class.java.getDeclaredField("deviceWorkers")
    field.isAccessible = true
    return (field.get(null) as java.util.concurrent.atomic.AtomicInteger).get()
  }

  private fun setDeviceWorkers(value: Int) {
    val field = LegacyRealtimeMediaEngine::class.java.getDeclaredField("deviceWorkers")
    field.isAccessible = true
    (field.get(null) as java.util.concurrent.atomic.AtomicInteger).set(value)
  }

  @Test
  fun aStoppedEngineNoLongerReportsAnAppliedMicrophone() {
    val applied = mutableListOf<String?>()
    val fallback =
      LegacyRealtimeMediaEngine(
        context = context,
        preferredAudioInputDevice = { null },
        onAppliedAudioInputChanged = { applied += it },
        onInputLevel = {},
        onOutputLevel = {},
      ).also { engines += it }
    assertTrue(fallback.start(config()))
    fallback.stop()
    applied.clear()

    // A routing callback that arrives after teardown belongs to a session that
    // is over; letting it through would overwrite the microphone the next
    // session applied.
    reportAppliedInput(fallback, "usb|mic")

    assertEquals(emptyList<String?>(), applied)
  }

  private fun reportAppliedInput(
    fallback: LegacyRealtimeMediaEngine,
    key: String,
  ) {
    val method = LegacyRealtimeMediaEngine::class.java.getDeclaredMethod("reportAppliedInput", String::class.java)
    method.isAccessible = true
    method.invoke(fallback, key)
  }

  @Test
  fun aBarrierTheWorkerHadAlreadyTakenIsStillCancelled() {
    val fallback = newEngine()
    assertTrue(fallback.start(config()))
    fallback.beginRenderGeneration()
    // The clear drained the queue; this barrier was already in the worker's
    // hand, so `invalidatePendingMarks` never saw it.
    fallback.clearRender()
    submitStaleMark(fallback, markId = 42L, generation = 1L)

    val outcomes = pollMarkOutcome(fallback, 42L)
    // Dropping it silently leaves the Gateway waiting on a turn that cannot
    // finish.
    assertEquals(RealtimeMarkOutcome.Cancelled, outcomes)
  }

  private fun submitStaleMark(
    fallback: LegacyRealtimeMediaEngine,
    markId: Long,
    generation: Long,
  ) {
    val itemClass = Class.forName("ai.openclaw.app.voice.LegacyRealtimeMediaEngine\$RenderItem")
    val ctor = itemClass.declaredConstructors.first()
    ctor.isAccessible = true
    val item = ctor.newInstance(generation, null, markId)
    val field = LegacyRealtimeMediaEngine::class.java.getDeclaredField("renderQueue")
    field.isAccessible = true
    val queue = field.get(fallback)
    val offer = queue.javaClass.getMethod("offer", Any::class.java)
    offer.invoke(queue, item)
  }

  private fun pollMarkOutcome(
    fallback: LegacyRealtimeMediaEngine,
    markId: Long,
  ): RealtimeMarkOutcome? {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (System.nanoTime() < deadline) {
      val event = fallback.drainMarkEvents().firstOrNull { it.markId == markId }
      if (event != null) return event.outcome
      Thread.sleep(10)
    }
    return null
  }

  private companion object {
    const val WORKER_TIMEOUT_SECONDS = 30L
  }

  private fun newEngine(): LegacyRealtimeMediaEngine =
    LegacyRealtimeMediaEngine(
      context = context,
      preferredAudioInputDevice = { null },
      onAppliedAudioInputChanged = {},
      onInputLevel = {},
      onOutputLevel = {},
    ).also { engines += it }

  private fun config(): RealtimeMediaConfig =
    RealtimeMediaConfig(
      wireInputHz = 24_000,
      wireOutputHz = 24_000,
      requestedDeviceHz = 24_000,
      route = RealtimeRouteProfile.BuiltInSpeaker,
      inputPreset = RealtimeInputPreset.VoiceCommunication,
    )

  private fun enqueueUplink(
    fallback: LegacyRealtimeMediaEngine,
    pcm: ByteArray,
    contiguousWithPrevious: Boolean,
  ) {
    val frameClass = Class.forName("ai.openclaw.app.voice.LegacyRealtimeMediaEngine\$UplinkFrame")
    val ctor = frameClass.declaredConstructors.first()
    ctor.isAccessible = true
    val frame = ctor.newInstance(pcm, contiguousWithPrevious)
    val field = LegacyRealtimeMediaEngine::class.java.getDeclaredField("uplinkQueue")
    field.isAccessible = true
    val queue = field.get(fallback)
    val offer = queue.javaClass.getMethod("offer", Any::class.java)
    offer.isAccessible = true
    offer.invoke(queue, frame)
  }
}
