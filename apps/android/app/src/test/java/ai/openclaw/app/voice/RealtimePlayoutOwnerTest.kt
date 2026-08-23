package ai.openclaw.app.voice

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.testDeviceIdentityStore
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Proves the realtime playout ownership boundary: Gateway ingress enqueues and returns, and one
 * owner coroutine is the only code that reaches the output device.
 *
 * The device is injected as a [RealtimeAudioSink] so partial writes, refused writes, and device
 * exceptions are deterministic. The owner, the command queue, and every generation rule under
 * test are the production ones.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RealtimePlayoutOwnerTest {
  @Test
  fun gatewayAudioEventReturnsBeforeTheDeviceIsEverTouched() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))

      // The owner has not been dispatched, yet the Gateway frame is already handled: the device
      // was never opened, played, or written to on the ingress path.
      assertEquals(0, sinks.openCount)

      runCurrent()

      assertEquals(1, sinks.openCount)
      assertEquals(480, sinks.last.acceptedBytes().size)
      talk.shutdown()
    }

  @Test
  fun gatewayKeepsAcceptingFramesWhileTheOwnerIsStalledOnTheDevice() =
    runTest {
      // Every write is refused, so the owner sits in its retry backoff for the whole test.
      val sinks = FakeRealtimeAudioSinkFactory { _, _ -> 0 }
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      runCurrent()
      assertTrue(sinks.last.writeCalls > 0)

      // No lock is shared with the owner, so these complete while it is stalled on hardware.
      talk.audioEvent(pcm(480))
      talk.markEvent("audio-1")

      assertFalse(talk.talkFailed())
      talk.shutdown()
    }

  @Test
  fun partialWritesContinueFromTheAcceptedByteCount() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory { offered, _ -> minOf(offered, 100) }
      val talk = realtimePlayoutHarness(sinks)
      val audio = pcm(480)

      talk.audioEvent(audio)
      runCurrent()

      assertArrayEquals(audio, sinks.last.acceptedBytes())
      assertEquals(listOf(480, 380, 280, 180, 80), sinks.last.offeredLengths)
      talk.shutdown()
    }

  @Test
  fun aNegativeWriteAfterPartialProgressFailsPlaybackInsteadOfBankingThePrefix() =
    runTest {
      // AudioTrack.ERROR_DEAD_OBJECT. Any negative result is a terminal device error, not
      // backpressure -- the distinction the retry loop above depends on.
      val deviceError = -6
      // call 0: the first frame is accepted whole. call 1: the second frame is accepted in part.
      // call 2: the device dies mid-frame, so a strict prefix of that frame reached it.
      val sinks =
        FakeRealtimeAudioSinkFactory { offered, call ->
          when (call) {
            0 -> offered
            1 -> 100
            else -> deviceError
          }
        }
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(200))
      runCurrent()
      talk.markEvent("audio-1")
      runCurrent()
      // The barrier is pending against the first frame and has not been released yet.
      assertEquals(emptyList<Pair<String, String>>(), talk.acknowledgements)
      assertEquals(100L, talk.writtenFrames())

      talk.audioEvent(pcm(480))
      runCurrent()

      // The device error is a playback failure, not a logged break that leaves the relay running.
      assertTrue(talk.talkFailed())
      // The truncated frame is not banked. Were it counted, a later barrier could clear a target
      // frame the device never presented.
      assertEquals(0L, talk.writtenFrames())
      assertFalse(talk.sinkInstalled())
      assertEquals(1, sinks.last.closeCalls)
      assertFalse(talk.isSpeaking())
      assertFalse(talk.idleTickerActive())
      // The stranded barrier is released exactly once, by the failure path, so the provider's
      // playback gate does not hang -- and it is released because the relay failed, not because
      // the partial frame was treated as fully played.
      assertEquals(listOf("relay-1" to "audio-1"), talk.acknowledgements)
      // The owner survives its own failure: later commands are still drained, not swallowed.
      talk.audioEvent(pcm(200))
      runCurrent()
      assertEquals(0, talk.queuedProviderCommands())
      assertEquals(0L, talk.queuedAudioBytes())
      talk.shutdown()
    }

  @Test
  fun aNegativeWriteOnTheFirstAttemptFailsPlaybackAndRetiresTheDevice() =
    runTest {
      // No partial progress at all: the very first write reports the device is gone.
      val sinks = FakeRealtimeAudioSinkFactory { _, _ -> -6 }
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      runCurrent()

      assertTrue(talk.talkFailed())
      assertFalse(talk.sinkInstalled())
      assertEquals(1, sinks.last.closeCalls)
      assertFalse(talk.isSpeaking())
      assertFalse(talk.idleTickerActive())
      // One write, then the failure: a dead device is never retried on the stall budget.
      assertEquals(1, sinks.last.writeCalls)
      talk.shutdown()
    }

  @Test
  fun refusedWritesRetryOnABoundedDelayInsteadOfSpinning() =
    runTest {
      // Two refusals, then the device drains.
      val sinks = FakeRealtimeAudioSinkFactory { offered, call -> if (call < 2) 0 else offered }
      val talk = realtimePlayoutHarness(sinks)
      val audio = pcm(480)

      talk.audioEvent(audio)
      runCurrent()

      // The retry is a delay, not a spin: one attempt has happened and the owner is parked.
      assertEquals(1, sinks.last.writeCalls)
      assertEquals(0, sinks.last.acceptedBytes().size)

      advanceTimeBy(realtimePlaybackWriteRetryDelayMs(FAKE_BUFFER_DURATION_MS) * 5)
      runCurrent()

      assertArrayEquals(audio, sinks.last.acceptedBytes())
      assertEquals(3, sinks.last.writeCalls)
      talk.shutdown()
    }

  @Test
  fun aDeviceThatNeverDrainsFailsTheSessionInsteadOfRetryingForever() =
    runTest {
      // The first write drains, so a barrier can be positioned behind real audio; every write
      // after it is refused.
      val sinks = FakeRealtimeAudioSinkFactory { offered, call -> if (call == 0) offered else 0 }
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      talk.markEvent("audio-1")
      talk.audioEvent(pcm(64))
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), talk.acknowledgements)

      advanceTimeBy(realtimePlaybackWriteStallBudgetMs(FAKE_BUFFER_DURATION_MS) * 2)
      runCurrent()

      assertTrue(talk.talkFailed())
      // Cleanup is part of the failure, not a later step: the device is released, and the barrier
      // whose target frame the retirement just invalidated is answered instead of holding the
      // provider's playback gate open forever.
      assertEquals(1, sinks.last.closeCalls)
      assertEquals(listOf("relay-1" to "audio-1"), talk.acknowledgements)
      talk.shutdown()
    }

  @Test
  fun aQueueFullOfTinyFramesFailsTheSessionAtTheSlotBound() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      // The owner is never dispatched, so nothing drains. Two-byte frames reach no byte ceiling,
      // so this pins the slot bound specifically.
      var enqueued = 0
      while (!talk.talkFailed() && enqueued < 8_192) {
        talk.audioEvent(pcm(2))
        enqueued += 1
      }

      assertTrue(talk.talkFailed())
      assertEquals(REALTIME_PLAYBACK_PROVIDER_QUEUE_CAPACITY + 1, enqueued)
      assertEquals(0, sinks.openCount)
      talk.shutdown()
    }

  @Test
  fun aQueueFullOfLargeFramesFailsTheSessionAtTheAudioByteCeiling() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)
      val oneMebibyte = 1024 * 1024

      // Twelve frames of one mebibyte reach the ceiling exactly; the thirteenth crosses it, long
      // before the slot bound. Memory, not depth, is what this bound protects.
      var enqueued = 0
      while (!talk.talkFailed() && enqueued < 64) {
        talk.audioEvent(pcm(oneMebibyte))
        enqueued += 1
      }

      assertTrue(talk.talkFailed())
      assertEquals(REALTIME_PLAYBACK_QUEUED_AUDIO_CEILING_BYTES / oneMebibyte + 1, enqueued.toLong())
      talk.shutdown()
    }

  @Test
  fun aLongAssistantResponseStreamedFasterThanItPlaysDoesNotFailTheSession() =
    runTest {
      // The relay forwards provider audio unpaced, so a real response backlogs while the speaker
      // catches up. 1,000 frames of 100 ms is 100 s of audio: far past any depth-shaped bound,
      // and nowhere near the memory ceiling.
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      repeat(1_000) {
        talk.audioEvent(pcm(4_800))
        talk.markEvent("audio-$it")
      }

      assertFalse(talk.talkFailed())
      assertEquals(2_000, talk.queuedProviderCommands())

      runCurrent()

      assertFalse(talk.talkFailed())
      // Both bounds release on drain; a counter that latched high would fail every later submit.
      assertEquals(0, talk.queuedProviderCommands())
      assertEquals(0L, talk.queuedAudioBytes())
      talk.shutdown()
    }

  @Test
  fun aBargeInDuringAPartialWriteLeavesTheCaptureGateOpen() =
    runTest {
      // The first frame drains, so playback state is published and the capture gate is shut. The
      // next one is taken in part and then refused, parking the owner *inside* its write loop --
      // the shape a real barge-in has once the hardware buffer is full, and the only shape that
      // reaches the loop's own generation check.
      val sinks =
        FakeRealtimeAudioSinkFactory { offered, call ->
          when {
            call == 0 -> offered
            call % 2 == 1 -> minOf(offered, 100)
            else -> 0
          }
        }
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(48_000))
      runCurrent()
      assertFalse(talk.shouldAppendCapturedFrame(4_800))

      talk.audioEvent(pcm(48_000))
      runCurrent()
      assertTrue(sinks.last.writeCalls > 1)

      talk.clearEvent()
      advanceTimeBy(realtimePlaybackWriteRetryDelayMs(FAKE_BUFFER_DURATION_MS) * 5)
      runCurrent()

      // The frames already handed to the device are discarded with it, so nothing may still be
      // reporting playback -- otherwise the uplink stays gated with no ticker left to reopen it.
      assertFalse(talk.isSpeaking())
      assertTrue(talk.shouldAppendCapturedFrame(4_800))
      assertFalse(talk.idleTickerActive())
      talk.shutdown()
    }

  @Test
  fun disablingPlaybackAnswersBarriersItCanNoLongerReach() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      talk.markEvent("audio-1")
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), talk.acknowledgements)

      // Unlike a TTS stop or a PTT pause, this is a local toggle with no provider round-trip, so
      // no later clear will arrive to answer the barrier. Retiring the device also resets the
      // frame counter its target was measured against, so keeping it would strand it forever.
      talk.setPlaybackEnabled(false)
      runCurrent()

      assertEquals(listOf("relay-1" to "audio-1"), talk.acknowledgements)

      // And nothing is left polling for a barrier that can never complete.
      talk.assistantFinalTranscriptEvent()
      runCurrent()
      advanceTimeBy(1_000)
      runCurrent()
      assertFalse(talk.idleTickerActive())
      talk.shutdown()
    }

  @Test
  fun aBarrierIsAnsweredOnlyAfterTheAudioQueuedBeforeItHasBeenPresented() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      talk.markEvent("audio-1")
      runCurrent()

      // 480 bytes is 240 frames, and the device has presented none of them.
      assertEquals(emptyList<Pair<String, String>>(), talk.acknowledgements)

      sinks.last.presentedFrames = 240L
      talk.assistantFinalTranscriptEvent()
      runCurrent()

      assertEquals(listOf("relay-1" to "audio-1"), talk.acknowledgements)
      talk.shutdown()
    }

  @Test
  fun clearDiscardsAudioAlreadyQueuedForTheCancelledResponseAndKeepsTheNextOne() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)
      val cancelled = pcm(480)
      val next = pcm(64)

      // All three reach the queue before the owner runs, so the stale command is still ahead of
      // the clear that invalidates it and of the next generation's audio behind it.
      talk.audioEvent(cancelled)
      talk.clearEvent()
      talk.audioEvent(next)
      runCurrent()

      assertEquals(1, sinks.openCount)
      assertArrayEquals(next, sinks.last.acceptedBytes())
      talk.shutdown()
    }

  @Test
  fun aStaleGenerationBarrierIsAnsweredWithoutTouchingTheNewGeneration() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      talk.markEvent("cancelled-1")
      talk.clearEvent()
      talk.audioEvent(pcm(64))
      runCurrent()

      // The cancelled barrier is released so the provider's gate does not stay shut, and it never
      // becomes a target frame measured against the new generation's device.
      assertEquals(listOf("relay-1" to "cancelled-1"), talk.acknowledgements)
      assertEquals(64, sinks.last.acceptedBytes().size)
      assertEquals(0L, sinks.last.presentedFrames)
      talk.shutdown()
    }

  @Test
  fun clearReleasesTheDeviceAndTheNextResponseOpensAFreshOne() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      runCurrent()
      val cancelledSink = sinks.last

      talk.clearEvent()
      runCurrent()
      assertEquals(1, cancelledSink.closeCalls)

      talk.audioEvent(pcm(64))
      runCurrent()

      assertEquals(2, sinks.openCount)
      assertEquals(64, sinks.last.acceptedBytes().size)
      talk.shutdown()
    }

  @Test
  fun relayTeardownReleasesTheDeviceAndDropsPendingBarriers() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      talk.markEvent("audio-1")
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), talk.acknowledgements)

      talk.stopRelay()
      runCurrent()

      assertEquals(1, sinks.last.closeCalls)
      // Terminal teardown has no provider left to release, so the barrier is dropped rather than
      // acknowledged; a plain playback stop keeps it for the provider's own clear.
      assertEquals(emptyList<Pair<String, String>>(), talk.acknowledgements)
      talk.shutdown()
    }

  @Test
  fun aDeviceExceptionFailsTheSessionAndTheOwnerKeepsServingLaterCommands() =
    runTest {
      var deviceBroken = true
      val sinks =
        FakeRealtimeAudioSinkFactory { offered, _ ->
          if (deviceBroken) throw IllegalStateException("device exploded")
          offered
        }
      val talk = realtimePlayoutHarness(sinks)

      talk.audioEvent(pcm(480))
      runCurrent()

      assertTrue(talk.talkFailed())
      assertEquals(1, sinks.last.closeCalls)

      // The command channel is long-lived and never recreated, so an owner that died here would
      // swallow every later command in silence.
      deviceBroken = false
      talk.startSession()
      talk.audioEvent(pcm(64))
      runCurrent()

      assertEquals(2, sinks.openCount)
      assertEquals(64, sinks.last.acceptedBytes().size)
      talk.shutdown()
    }

  @Test
  fun repeatedStartAndStopOpensAndReleasesOneDeviceEachTime() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      repeat(3) {
        talk.startSession()
        talk.audioEvent(pcm(64))
        runCurrent()
        talk.stopRelay()
        runCurrent()
      }

      assertEquals(3, sinks.openCount)
      assertEquals(3, sinks.opened.sumOf { it.closeCalls })
      talk.shutdown()
    }

  @Test
  fun halfDuplexCaptureSuppressionIsUnchangedByTheNewOwner() =
    runTest {
      val sinks = FakeRealtimeAudioSinkFactory()
      val talk = realtimePlayoutHarness(sinks)

      assertTrue(talk.shouldAppendCapturedFrame(4_800))

      // One second of audio at the realtime rate. The capture gate closes for its duration
      // exactly as it did before playout moved behind the owner.
      talk.audioEvent(pcm(48_000))
      runCurrent()
      assertFalse(talk.shouldAppendCapturedFrame(4_800))

      // A barge-in reopens it immediately, not after the remaining second of audio.
      talk.clearEvent()
      assertTrue(talk.shouldAppendCapturedFrame(4_800))
      runCurrent()
      assertTrue(talk.shouldAppendCapturedFrame(4_800))

      talk.audioEvent(pcm(48_000))
      runCurrent()
      assertFalse(talk.shouldAppendCapturedFrame(4_800))

      talk.stopRelay()
      assertTrue(talk.shouldAppendCapturedFrame(4_800))
      assertFalse(talk.shouldAppendCapturedFrame(0))

      runCurrent()
      talk.shutdown()
    }

  /**
   * The virtual-time tests above cannot prove the absence of a shared monitor: Java monitors are
   * reentrant per thread, so a single-threaded test passes even if ingress and the owner take the
   * same lock. This one uses real threads and a device call that genuinely blocks.
   */
  @Test
  fun gatewayIngressDoesNotWaitOnAnOwnerBlockedInsideTheDevice() {
    val insideTheDevice = CountDownLatch(1)
    val releaseTheDevice = CountDownLatch(1)
    val sinks =
      FakeRealtimeAudioSinkFactory { offered, _ ->
        insideTheDevice.countDown()
        releaseTheDevice.await(10, TimeUnit.SECONDS)
        offered
      }
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val talk = realThreadedPlayoutHarness(sinks, scope)
    try {
      talk.audioEvent(pcm(480))
      assertTrue("owner never reached the device", insideTheDevice.await(10, TimeUnit.SECONDS))

      val startedAtNanos = System.nanoTime()
      repeat(16) { talk.audioEvent(pcm(480)) }
      talk.markEvent("audio-1")
      talk.clearEvent()
      val elapsedMs = (System.nanoTime() - startedAtNanos) / 1_000_000

      assertTrue("ingress waited ${elapsedMs}ms on a blocked owner", elapsedMs < 1_000)
    } finally {
      releaseTheDevice.countDown()
      // Cancelling the scope must also end the owner, which is deliberately not one of its
      // children; if that wiring were missing the coroutine would outlive every test.
      scope.cancel()
    }
  }

  /**
   * FIX-3. The owner is the only code allowed to touch the device, so it is also the only code
   * that can release it. Before the finally, a cancelled owner left the AudioTrack alive with
   * residual audio still presenting, and left the capture gate believing the assistant was
   * speaking with nothing left running to clear it.
   */
  @Test
  fun cancellingTheOwnerReleasesTheDeviceInsteadOfLeakingIt() {
    val insideTheDevice = CountDownLatch(1)
    val releaseTheDevice = CountDownLatch(1)
    val sinks =
      FakeRealtimeAudioSinkFactory { offered, _ ->
        insideTheDevice.countDown()
        releaseTheDevice.await(10, TimeUnit.SECONDS)
        offered
      }
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val talk = realThreadedPlayoutHarness(sinks, scope)

    talk.audioEvent(pcm(480))
    assertTrue("owner never reached the device", insideTheDevice.await(10, TimeUnit.SECONDS))
    assertEquals(1, sinks.openCount)
    assertTrue("playback must be published before the write", talk.isSpeaking())

    // No Stop, no Clear: the scope simply completes, which is what app/node teardown does.
    scope.cancel()
    releaseTheDevice.countDown()

    val released = awaitCondition(5_000) { sinks.last.closeCalls == 1 }
    assertTrue("the cancelled owner leaked its AudioTrack (closeCalls=${sinks.last.closeCalls})", released)
    assertTrue("speaking must not survive the owner", awaitCondition(5_000) { !talk.isSpeaking() })
  }

  /** The finally shares its cleanup with Stop, so a normal teardown must not double-release. */
  @Test
  fun aNormalStopFollowedByCancellationReleasesTheDeviceExactlyOnce() {
    val sinks = FakeRealtimeAudioSinkFactory()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val talk = realThreadedPlayoutHarness(sinks, scope)

    talk.audioEvent(pcm(480))
    assertTrue("device never opened", awaitCondition(5_000) { sinks.openCount == 1 })
    talk.stopRelay()
    assertTrue("stop must release the device", awaitCondition(5_000) { sinks.last.closeCalls == 1 })

    scope.cancel()

    // Idempotent: the sink was already nulled by Stop, so the finally has nothing left to close.
    Thread.sleep(200)
    assertEquals("cancellation must not re-close an already released device", 1, sinks.last.closeCalls)
  }
}

private fun awaitCondition(
  timeoutMs: Long,
  condition: () -> Boolean,
): Boolean {
  val deadline = System.nanoTime() + timeoutMs * 1_000_000
  while (System.nanoTime() < deadline) {
    if (condition()) return true
    Thread.sleep(10)
  }
  return condition()
}

internal const val FAKE_BUFFER_DURATION_MS = 240L

// Mirrors of the production bounds. Pinned rather than derived: these numbers are the contract
// the two overflow tests exist to protect, so a change to either must fail here first.
private const val REALTIME_PLAYBACK_PROVIDER_QUEUE_CAPACITY = 4_096
private const val REALTIME_PLAYBACK_QUEUED_AUDIO_CEILING_BYTES = 12L * 1024L * 1024L

private fun pcm(byteCount: Int): ByteArray = ByteArray(byteCount) { index -> (index % 251).toByte() }

internal class FakeRealtimeAudioSink(
  private val onWrite: (offered: Int, callIndex: Int) -> Int,
) : RealtimeAudioSink {
  override val bufferDurationMs: Long = FAKE_BUFFER_DURATION_MS

  @Volatile override var presentedFrames: Long = 0L
  var playCalls = 0
  var closeCalls = 0
  var writeCalls = 0
  val offeredLengths = mutableListOf<Int>()
  private val accepted = ByteArrayOutputStream()

  fun acceptedBytes(): ByteArray = accepted.toByteArray()

  override fun play() {
    playCalls += 1
  }

  override fun write(
    bytes: ByteArray,
    offset: Int,
    length: Int,
  ): Int {
    offeredLengths += length
    val callIndex = writeCalls
    writeCalls += 1
    val result = onWrite(length, callIndex)
    if (result > 0) accepted.write(bytes, offset, result)
    return result
  }

  override fun close() {
    closeCalls += 1
  }
}

internal class FakeRealtimeAudioSinkFactory(
  private val onWrite: (offered: Int, callIndex: Int) -> Int = { offered, _ -> offered },
) : RealtimeAudioSinkFactory {
  val opened = mutableListOf<FakeRealtimeAudioSink>()
  val openCount: Int get() = opened.size
  val last: FakeRealtimeAudioSink get() = opened.last()

  override fun open(
    sampleRateHz: Int,
    playbackBufferMs: Int,
    firstWriteBytes: Int,
  ): RealtimeAudioSink = FakeRealtimeAudioSink(onWrite).also { opened += it }
}

/** A manager with an open realtime session, an injected output device, and Gateway-side helpers. */
private class RealtimePlayoutHarness(
  private val manager: TalkModeManager,
  val acknowledgements: List<Pair<String, String>>,
) {
  fun startSession() {
    setPrivateField(manager, "realtimeSessionId", "relay-1")
  }

  fun audioEvent(bytes: ByteArray) {
    val audioBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
    manager.handleGatewayEvent(
      "talk.event",
      """{"relaySessionId":"relay-1","type":"audio","audioBase64":"$audioBase64"}""",
    )
  }

  fun markEvent(markName: String) {
    manager.handleGatewayEvent("talk.event", """{"relaySessionId":"relay-1","type":"mark","markName":"$markName"}""")
  }

  fun clearEvent() {
    manager.handleGatewayEvent("talk.event", """{"relaySessionId":"relay-1","type":"clear"}""")
  }

  fun assistantFinalTranscriptEvent() {
    manager.handleGatewayEvent(
      "talk.event",
      """{"relaySessionId":"relay-1","type":"transcript","role":"assistant","text":"done","final":true}""",
    )
  }

  fun stopRelay() {
    val method =
      manager.javaClass.getDeclaredMethod(
        "stopRealtimeRelay",
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
      )
    method.isAccessible = true
    method.invoke(manager, false, true, true, false)
  }

  fun talkFailed(): Boolean = manager.statusText.value.startsWith("Talk failed:")

  fun isSpeaking(): Boolean = manager.isSpeaking.value

  fun setPlaybackEnabled(enabled: Boolean) = manager.setPlaybackEnabled(enabled)

  fun idleTickerActive(): Boolean = (readPrivateField(manager, "realtimePlaybackIdleJob") as Job?)?.isActive == true

  /** Frames the owner has banked as written. Retirement resets it, so a failed frame leaves 0. */
  fun writtenFrames(): Long = readPrivateField(manager, "realtimeWrittenFrames") as Long

  fun sinkInstalled(): Boolean = readPrivateField(manager, "realtimeAudioSink") != null

  fun queuedProviderCommands(): Int = (readPrivateField(manager, "queuedRealtimeProviderCommands") as AtomicInteger).get()

  fun queuedAudioBytes(): Long = (readPrivateField(manager, "queuedRealtimeAudioBytes") as AtomicLong).get()

  fun shouldAppendCapturedFrame(length: Int): Boolean {
    val method = manager.javaClass.getDeclaredMethod("shouldAppendRealtimeCapturedFrame", Int::class.javaPrimitiveType)
    method.isAccessible = true
    return method.invoke(manager, length) as Boolean
  }

  /** Ends the intentionally long-lived owner so no coroutine outlives the test. */
  fun shutdown() {
    (readPrivateField(manager, "realtimePlaybackOwnerJob") as Job).cancel()
  }
}

private fun TestScope.realtimePlayoutHarness(sinks: FakeRealtimeAudioSinkFactory): RealtimePlayoutHarness {
  val app = RuntimeEnvironment.getApplication()
  val acknowledgements = mutableListOf<Pair<String, String>>()
  val session =
    GatewaySession(
      scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
      identityStore = testDeviceIdentityStore(app),
      deviceAuthStore =
        DeviceAuthStore(
          SecurePrefs(app, app.getSharedPreferences("playout-test-${System.nanoTime()}", 0)),
        ),
      onConnected = {},
      onDisconnected = {},
      onEvent = { _, _ -> },
    )
  val manager =
    TalkModeManager(
      context = app,
      scope = this,
      session = session,
      isConnected = { true },
      realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
      realtimePlaybackDispatcher = StandardTestDispatcher(testScheduler),
      realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
      realtimeAudioSinkFactory = sinks,
    )
  setMutableStateFlow(manager, "_isEnabled", true)
  return RealtimePlayoutHarness(manager, acknowledgements).also { it.startSession() }
}

private fun realThreadedPlayoutHarness(
  sinks: FakeRealtimeAudioSinkFactory,
  scope: CoroutineScope,
): RealtimePlayoutHarness {
  val app = RuntimeEnvironment.getApplication()
  val session =
    GatewaySession(
      scope = scope,
      identityStore = testDeviceIdentityStore(app),
      deviceAuthStore =
        DeviceAuthStore(
          SecurePrefs(app, app.getSharedPreferences("playout-thread-test-${System.nanoTime()}", 0)),
        ),
      onConnected = {},
      onDisconnected = {},
      onEvent = { _, _ -> },
    )
  val manager =
    TalkModeManager(
      context = app,
      scope = scope,
      session = session,
      isConnected = { true },
      realtimePlaybackDispatcher = Dispatchers.IO,
      realtimeMarkAcknowledger = { _, _ -> },
      realtimeAudioSinkFactory = sinks,
    )
  setMutableStateFlow(manager, "_isEnabled", true)
  return RealtimePlayoutHarness(manager, emptyList()).also { it.startSession() }
}

private fun setPrivateField(
  target: Any,
  name: String,
  value: Any?,
) {
  val field = target.javaClass.getDeclaredField(name)
  field.isAccessible = true
  field.set(target, value)
}

private fun readPrivateField(
  target: Any,
  name: String,
): Any? {
  val field = target.javaClass.getDeclaredField(name)
  field.isAccessible = true
  return field.get(target)
}

@Suppress("UNCHECKED_CAST")
private fun <T> setMutableStateFlow(
  target: Any,
  name: String,
  value: T,
) {
  (readPrivateField(target, name) as MutableStateFlow<T>).value = value
}
