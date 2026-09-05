package ai.openclaw.app.voice

import android.media.AudioFormat
import android.media.AudioTimestamp
import android.media.AudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadows.ShadowAudioTrack
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [PlayoutAudioTrack::class])
class RealtimePlayoutTest {
  private val scheduler = TestCoroutineScheduler()
  private val job = SupervisorJob()
  private val acknowledgements = mutableListOf<String>()
  private val failures = mutableListOf<String>()
  private val statusOwner = Any()
  private val playout =
    RealtimePlayout(
      scope = CoroutineScope(job + StandardTestDispatcher(scheduler)),
      dispatcher = StandardTestDispatcher(scheduler),
      sampleRate = 24_000,
    )

  private fun session(id: String) =
    RealtimePlayout.Session(
      onState = { _, _, _ -> },
      onMark = { mark -> acknowledgements += "$id/$mark" },
      onFailure = { error -> failures += "$id/$error" },
    )

  private val session = session("session")

  @After
  fun cleanup() {
    job.cancel()
    scheduler.runCurrent()
    PlayoutAudioTrack.reset()
  }

  @Test
  fun ingressOnlyQueuesAndClearCompletesAfterTheActualTrackIsReleased() {
    playout.audio(session, ByteArray(4_800), statusOwner)
    assertEquals(0, PlayoutAudioTrack.writes)
    scheduler.runCurrent()
    val track = checkNotNull(PlayoutAudioTrack.track)
    assertEquals(24_000, track.sampleRate)
    assertEquals(AudioFormat.ENCODING_PCM_16BIT, track.audioFormat)
    assertTrue(playout.isPlaying)
    val cleared = playout.clear(session)
    assertFalse(cleared.isCompleted)
    scheduler.runCurrent()
    assertTrue(cleared.isCompleted)
    assertFalse(cleared.isCancelled)
    assertEquals(AudioTrack.STATE_UNINITIALIZED, track.state)
    assertFalse(playout.isPlaying)
  }

  @Test
  fun zeroWriteYieldsSoClearCanDiscardTheOldAudio() {
    PlayoutAudioTrack.result = 0
    playout.audio(session, ByteArray(4_800), statusOwner)
    scheduler.runCurrent()
    assertEquals(1, PlayoutAudioTrack.writes)
    val cleared = playout.clear(session)
    scheduler.advanceTimeBy(10)
    scheduler.runCurrent()
    assertTrue(cleared.isCompleted)
    assertEquals(1, PlayoutAudioTrack.writes)
    assertTrue(failures.isEmpty())
    assertFalse(playout.isPlaying)
  }

  @Test
  fun negativeDeviceWriteFailsAndRetiresTheTrack() {
    PlayoutAudioTrack.result = AudioTrack.ERROR_DEAD_OBJECT
    playout.audio(session, ByteArray(4_800), statusOwner)
    scheduler.runCurrent()
    assertEquals(1, failures.size)
    assertTrue(failures.single().contains("device error"))
    assertEquals(AudioTrack.STATE_UNINITIALIZED, checkNotNull(PlayoutAudioTrack.track).state)
    assertFalse(playout.isPlaying)
  }

  @Test
  fun aDeviceThatNeverAcceptsAudioFailsWithinTheBoundedBudget() {
    PlayoutAudioTrack.result = 0
    playout.audio(session, ByteArray(4_800), statusOwner)
    scheduler.advanceTimeBy(2_000)
    scheduler.runCurrent()
    assertEquals(listOf("session/audio playback stalled"), failures)
    assertFalse(playout.isPlaying)
  }

  @Test
  fun marksWaitForPresentedFramesAndClearReleasesPendingMarks() {
    PlayoutAudioTrack.presentedFrames = 0
    PlayoutAudioTrack.timestampFrames = 0
    playout.audio(session, ByteArray(4_800), statusOwner)
    playout.mark(session, "first")
    scheduler.runCurrent()
    assertTrue(acknowledgements.isEmpty())
    PlayoutAudioTrack.presentedFrames = 2_400
    PlayoutAudioTrack.timestampFrames = 2_400
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertEquals(listOf("session/first"), acknowledgements)
    playout.audio(session, ByteArray(4_800), statusOwner)
    playout.mark(session, "second")
    scheduler.runCurrent()
    playout.clear(session)
    scheduler.runCurrent()
    assertEquals(listOf("session/first", "session/second"), acknowledgements)
  }

  @Test
  fun interruptedQueuedMarkWaitsForPhysicalTrackRelease() {
    PlayoutAudioTrack.presentedFrames = 0
    var releasedAtAcknowledgement = false
    val owner =
      RealtimePlayout.Session({ _, _, _ -> }, {
        releasedAtAcknowledgement = PlayoutAudioTrack.track?.state == AudioTrack.STATE_UNINITIALIZED
      }, { error(it) })
    playout.audio(owner, ByteArray(100), statusOwner)
    scheduler.runCurrent()
    playout.mark(owner, "interrupted")
    playout.clear(owner)
    scheduler.runCurrent()
    assertTrue(releasedAtAcknowledgement)
  }

  @Test
  fun aShortFinalReplyStartsWithoutFillingTheDeviceBuffer() {
    PlayoutAudioTrack.timestampFrames = 50
    playout.audio(session, ByteArray(100), statusOwner)
    playout.mark(session, "short-reply")
    scheduler.runCurrent()
    assertEquals(listOf("session/short-reply"), acknowledgements)
    ShadowSystemClock.advanceBy(Duration.ofMillis(20))
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertFalse(playout.isPlaying)
    assertTrue(failures.isEmpty())
  }

  @Test
  fun consumedFramesWaitForTheirFuturePresentationTimestamp() {
    PlayoutAudioTrack.presentedFrames = 2_400
    PlayoutAudioTrack.timestampFrames = 2_400L
    PlayoutAudioTrack.timestampNanos = System.nanoTime() + 10_000_000_000L
    playout.audio(session, ByteArray(4_800), statusOwner)
    playout.mark(session, "reply")
    scheduler.runCurrent()
    assertTrue("Consumed frames are still committed to future presentation", playout.isPlaying)
    assertTrue(acknowledgements.isEmpty())
    PlayoutAudioTrack.timestampFrames = null
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertTrue("Temporary timestamp loss cannot forget known future presentation", acknowledgements.isEmpty())
    PlayoutAudioTrack.timestampFrames = 2_400L
    scheduler.advanceTimeBy(2_000)
    scheduler.runCurrent()
    assertTrue("Known future presentation is not a stalled device", failures.isEmpty())
    PlayoutAudioTrack.timestampNanos = System.nanoTime()
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertEquals(listOf("session/reply"), acknowledgements)
    assertFalse(playout.isPlaying)
  }

  @Test
  fun unavailableTimestampPreservesTheNominalAudioDurationGate() {
    playout.audio(session, ByteArray(24_000), statusOwner)
    playout.mark(session, "reply")
    scheduler.runCurrent()
    assertTrue(acknowledgements.isEmpty())
    assertTrue("Approximate head progress must not remove the existing duration floor", playout.isPlaying)
    ShadowSystemClock.advanceBy(Duration.ofMillis(499))
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertTrue(playout.isPlaying)
    ShadowSystemClock.advanceBy(Duration.ofMillis(1))
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertEquals(listOf("session/reply"), acknowledgements)
    assertFalse(playout.isPlaying)
    assertTrue(failures.isEmpty())
  }

  @Test
  fun drainedAudioDoesNotFailWhenTheLastTimestampRemainsBehindTheHead() {
    PlayoutAudioTrack.timestampFrames = 0
    playout.audio(session, ByteArray(4_800), statusOwner)
    playout.mark(session, "reply")
    scheduler.runCurrent()
    PlayoutAudioTrack.timestampFrames = 2_160
    PlayoutAudioTrack.timestampNanos = System.nanoTime()
    // AudioTimestamp uses the real monotonic clock, not the coroutine scheduler.
    Thread.sleep(20)
    ShadowSystemClock.advanceBy(Duration.ofMillis(100))
    scheduler.advanceTimeBy(2_000)
    scheduler.runCurrent()
    assertTrue("A final server timestamp can remain behind consumed frames", failures.isEmpty())
    assertEquals(listOf("session/reply"), acknowledgements)
    assertFalse(playout.isPlaying)
  }

  @Test
  fun aTimestampFromBeforeAnIdleGapCannotFinishNewAudio() {
    PlayoutAudioTrack.timestampFrames = 2_400
    playout.audio(session, ByteArray(4_800), statusOwner)
    playout.mark(session, "first")
    scheduler.runCurrent()
    assertFalse(playout.isPlaying)
    PlayoutAudioTrack.timestampNanos = System.nanoTime()
    ShadowSystemClock.advanceBy(Duration.ofSeconds(10))
    playout.audio(session, ByteArray(4_800), statusOwner)
    playout.mark(session, "second")
    scheduler.runCurrent()
    assertTrue("An old clock anchor cannot present newly submitted audio", playout.isPlaying)
    assertEquals(listOf("session/first"), acknowledgements)
    ShadowSystemClock.advanceBy(Duration.ofMillis(100))
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertFalse(playout.isPlaying)
    assertTrue(failures.isEmpty())
  }

  @Test
  fun pacedWritesDoNotCountElapsedPlaybackTwice() {
    PlayoutAudioTrack.acceptedChunkBytes = 4_800
    playout.audio(session, ByteArray(48_000), statusOwner)
    scheduler.runCurrent()
    assertEquals(10, PlayoutAudioTrack.writes)
    assertTrue(playout.isPlaying)
    // Nine paced intervals consumed 900 ms; only the final 100 ms remains buffered.
    ShadowSystemClock.advanceBy(Duration.ofMillis(100))
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertFalse("A one-second reply must not suppress input for another whole second", playout.isPlaying)
    assertTrue(failures.isEmpty())
  }

  @Test
  fun unavailableTimestampKeepsFramesAfterAnIntermediateFutureAnchorPending() {
    playout.audio(session, ByteArray(2_400), statusOwner)
    playout.mark(session, "middle")
    playout.audio(session, ByteArray(2_400), statusOwner)
    playout.mark(session, "reply")
    scheduler.runCurrent()
    PlayoutAudioTrack.timestampFrames = 1_200
    PlayoutAudioTrack.timestampNanos = System.nanoTime() + 200_000_000L
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertTrue(acknowledgements.isEmpty())
    PlayoutAudioTrack.timestampFrames = null
    // Pass the actual monotonic anchor time, but not the additional 50 ms of queued PCM.
    Thread.sleep(220)
    ShadowSystemClock.advanceBy(Duration.ofMillis(220))
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertEquals("Only the intermediate mark has presented", listOf("session/middle"), acknowledgements)
    assertTrue(playout.isPlaying)
    ShadowSystemClock.advanceBy(Duration.ofMillis(50))
    scheduler.advanceTimeBy(20)
    scheduler.runCurrent()
    assertEquals(listOf("session/middle", "session/reply"), acknowledgements)
    assertFalse(playout.isPlaying)
  }

  @Test
  fun terminalClearDiscardsQueuedMarksButAnInterruptionAcknowledgesThem() {
    playout.mark(session, "discarded")
    playout.clear(session, acknowledge = false)
    val replacement = session("replacement")
    playout.mark(replacement, "interrupted")
    playout.clear(replacement)
    scheduler.runCurrent()
    assertEquals(listOf("replacement/interrupted"), acknowledgements)
  }

  @Test
  fun oldClearCannotFlushTheReplacementTrack() {
    val replacement = session("replacement")
    playout.audio(replacement, ByteArray(100), statusOwner)
    playout.clear(session, acknowledge = false)
    scheduler.runCurrent()
    assertEquals(AudioTrack.STATE_INITIALIZED, checkNotNull(PlayoutAudioTrack.track).state)
    assertTrue(playout.isPlaying)
  }

  @Test
  fun clearBeforeActorStartsIsCancelledWhenItsScopeIsCancelled() {
    val clear = playout.clear(session)
    job.cancel()
    scheduler.runCurrent()
    assertTrue(clear.isCancelled)
  }

  @Test
  fun cancellationStopsAlreadyQueuedAcknowledgements() {
    val acknowledged = mutableListOf<String>()
    val owner =
      RealtimePlayout.Session({ _, _, _ -> }, { name ->
        acknowledged += name
        job.cancel()
      }, { error(it) })
    playout.mark(owner, "first")
    playout.mark(owner, "second")
    scheduler.runCurrent()
    assertEquals(listOf("first"), acknowledged)
  }

  @Test
  fun cancellingAfterClearDeliveryStillCompletesItsWaiter() {
    playout.audio(session, ByteArray(100), statusOwner)
    scheduler.runCurrent()
    val clear = playout.clear(session)
    job.cancel()
    scheduler.runCurrent()
    assertTrue(clear.isCancelled)
  }

  @Test
  fun acceptedAudioThatNeverPresentsFailsInsteadOfHangingMarks() {
    PlayoutAudioTrack.presentedFrames = 0
    playout.audio(session, ByteArray(100), statusOwner)
    playout.mark(session, "short-reply")
    scheduler.runCurrent()
    ShadowSystemClock.advanceBy(Duration.ofMillis(2_000))
    scheduler.advanceTimeBy(2_000)
    scheduler.runCurrent()
    assertEquals(listOf("session/audio playback stalled"), failures)
    assertTrue(acknowledgements.isEmpty())
    assertFalse(playout.isPlaying)
  }
}

@Implements(AudioTrack::class)
class PlayoutAudioTrack : ShadowAudioTrack() {
  @RealObject private lateinit var realTrack: AudioTrack
  private var startThreshold: Int? = null

  companion object {
    var result: Int? = null
    var acceptedChunkBytes: Int? = null
    var presentedFrames: Int? = null
    var timestampFrames: Long? = null
    var timestampNanos: Long? = null
    var track: AudioTrack? = null
    var writes = 0

    fun reset() {
      result = null
      acceptedChunkBytes = null
      presentedFrames = null
      timestampFrames = null
      timestampNanos = null
      track = null
      writes = 0
    }
  }

  @Implementation(minSdk = 23)
  override fun native_write_byte(
    audioData: ByteArray,
    offsetInBytes: Int,
    sizeInBytes: Int,
    format: Int,
    isBlocking: Boolean,
  ): Int {
    assertFalse("The owner must not block on AudioTrack writes", isBlocking)
    track = realTrack
    if (acceptedChunkBytes != null && writes > 0) ShadowSystemClock.advanceBy(Duration.ofMillis(100))
    writes += 1
    return result ?: super.native_write_byte(audioData, offsetInBytes, minOf(sizeInBytes, acceptedChunkBytes ?: sizeInBytes), format, isBlocking)
  }

  @Implementation(minSdk = 31)
  fun native_setStartThresholdInFrames(frames: Int): Int {
    startThreshold = frames
    return frames
  }

  @Implementation
  fun getTimestamp(timestamp: AudioTimestamp): Boolean {
    timestamp.framePosition = timestampFrames ?: return false
    timestamp.nanoTime = timestampNanos ?: System.nanoTime()
    return true
  }

  @Implementation
  override fun getPlaybackHeadPosition(): Int =
    presentedFrames ?: super.getPlaybackHeadPosition().let {
      if (it >= (startThreshold ?: realTrack.bufferSizeInFrames)) it else 0
    }
}
