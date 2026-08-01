package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeAudioFrameType
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import android.os.Parcel
import com.google.android.gms.wearable.ChannelClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class WearRealtimeChannelRegistryTest {
  @Test
  fun `replacement stops displaced owner once before its finalizer`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        synchronized(stoppedOwners) { stoppedOwners += owner }
      }
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val second = FakeChannel("watch-a", "channel-b", "attempt-b")

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        val firstClaim = checkNotNull(registry.claim("watch-a", "attempt-a"))
        val firstOwner = firstClaim.owner
        assertTrue(firstClaim.newlyAcquired)

        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(second)
        assertTrue(registry.isCurrent(firstOwner))
        assertTrue(synchronized(stoppedOwners) { stoppedOwners.isEmpty() })

        val secondClaim = checkNotNull(registry.claim("watch-a", "attempt-b"))
        withTimeout(2_000L) {
          transport.awaitClosed(first)
          while (synchronized(stoppedOwners) { stoppedOwners.size } != 1) {
            kotlinx.coroutines.yield()
          }
        }

        val secondOwner = secondClaim.owner
        assertTrue(secondClaim.newlyAcquired)
        assertEquals(listOf(firstOwner), synchronized(stoppedOwners) { stoppedOwners.toList() })
        assertEquals(1, transport.closeCount(first))

        registry.release(firstOwner)
        val repeatedClaim = checkNotNull(registry.claim("watch-a", "attempt-b"))
        assertFalse(repeatedClaim.newlyAcquired)
        assertSame(secondOwner, repeatedClaim.owner)

        registry.release(secondOwner)
        val staleClaim = async { registry.claim("watch-a", "attempt-c") }
        delay(100L)
        assertFalse(staleClaim.isCompleted)
        staleClaim.cancel()
        val retryClaim = checkNotNull(registry.claim("watch-a", "attempt-b"))
        val retryOwner = retryClaim.owner
        assertTrue(retryClaim.newlyAcquired)
        assertEquals(secondOwner.channelGeneration, retryOwner.channelGeneration)

        registry.close(retryOwner)
        assertEquals(listOf(firstOwner, retryOwner), synchronized(stoppedOwners) { stoppedOwners.toList() })
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `replacement claim waits for owner retirement but not delayed gateway close`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val closeStarted = CompletableDeferred<Unit>()
      val releaseClose = CompletableDeferred<Unit>()
      val closeFinished = CompletableDeferred<Unit>()
      var createCount = 0
      val controller =
        WearRealtimeTalkController(
          scope = scope,
          isConnected = { true },
          requestGateway = { method, _, _ ->
            when (method) {
              "talk.session.create" -> {
                createCount += 1
                """{"relaySessionId":"relay-$createCount"}"""
              }
              "talk.session.close" -> {
                closeStarted.complete(Unit)
                releaseClose.await()
                closeFinished.complete(Unit)
                """{"ok":true}"""
              }
              else -> """{"ok":true}"""
            }
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> },
        )
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        controller.stop(owner)
      }
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val second = FakeChannel("watch-a", "channel-b", "attempt-b")

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        val firstOwner = checkNotNull(registry.claim("watch-a", "attempt-a")).owner
        assertTrue(controller.start(firstOwner, "session-main", "de"))

        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(second)
        val secondClaim = async { registry.claim("watch-a", "attempt-b") }
        withTimeout(1_000L) { closeStarted.await() }

        val secondOwner = withTimeout(1_000L) { secondClaim.await() }?.owner
        assertNotNull(secondOwner)
        assertFalse(releaseClose.isCompleted)
        assertEquals(WearRealtimeTalkStatus.OFF, controller.snapshot.value.status)

        val replacementStart =
          async {
            controller.start(checkNotNull(secondOwner), "session-main", "de")
          }
        assertTrue(withTimeout(1_000L) { replacementStart.await() })
        assertFalse(releaseClose.isCompleted)
        controller.handleGatewayEvent(
          "talk.event",
          """{"relaySessionId":"relay-1","type":"close"}""",
        )
        assertEquals(WearRealtimeTalkStatus.LISTENING, controller.snapshot.value.status)
        assertEquals("attempt-b", controller.snapshot.value.attemptId)

        releaseClose.complete(Unit)
        withTimeout(1_000L) { closeFinished.await() }
        registry.close(checkNotNull(secondOwner))
      } finally {
        releaseClose.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `reader retirement blocks replacement claim until owner stops`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stopStarted = CompletableDeferred<Unit>()
      val releaseStop = CompletableDeferred<Unit>()
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val second = FakeChannel("watch-a", "channel-b", "attempt-b")
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = {
        stopStarted.complete(Unit)
        releaseStop.await()
      }

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        checkNotNull(registry.claim("watch-a", "attempt-a"))

        transport.finishInput(first)
        withTimeout(1_000L) { stopStarted.await() }
        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(second)
        val replacementClaim = async { registry.claim("watch-a", "attempt-b") }
        delay(100L)
        assertFalse(replacementClaim.isCompleted)

        releaseStop.complete(Unit)
        val replacementOwner = checkNotNull(withTimeout(1_000L) { replacementClaim.await() }).owner
        registry.close(replacementOwner)
      } finally {
        releaseStop.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `rapid replacements preserve transitive owner retirement`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stopStarted = CompletableDeferred<Unit>()
      val releaseStop = CompletableDeferred<Unit>()
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val second = FakeChannel("watch-a", "channel-b", "attempt-b")
      val third = FakeChannel("watch-a", "channel-c", "attempt-c")
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = {
        stopStarted.complete(Unit)
        releaseStop.await()
      }

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        checkNotNull(registry.claim("watch-a", "attempt-a"))

        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(second)
        registry.accept(third, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(third)
        val newestClaim = async { registry.claim("watch-a", "attempt-c") }
        withTimeout(1_000L) { stopStarted.await() }
        delay(100L)
        assertFalse(newestClaim.isCompleted)

        releaseStop.complete(Unit)
        val newestOwner = checkNotNull(withTimeout(1_000L) { newestClaim.await() }).owner
        registry.close(newestOwner)
      } finally {
        releaseStop.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `delayed unclaimed channel cannot retire the active attempt`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        synchronized(stoppedOwners) { stoppedOwners += owner }
      }
      val active = FakeChannel("watch-a", "channel-b", "attempt-b")
      val delayed = FakeChannel("watch-a", "channel-a", "attempt-a")

      try {
        registry.accept(active, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(active)
        val activeClaim = checkNotNull(registry.claim("watch-a", "attempt-b"))

        registry.accept(delayed, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(delayed)
        delay(100L)

        assertTrue(registry.isCurrent(activeClaim.owner))
        assertTrue(synchronized(stoppedOwners) { stoppedOwners.isEmpty() })
        val repeated = checkNotNull(registry.claim("watch-a", "attempt-b"))
        assertFalse(repeated.newlyAcquired)
        assertSame(activeClaim.owner, repeated.owner)
        registry.close(activeClaim.owner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `same path reconnect inherits the active attempt owner`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        synchronized(stoppedOwners) { stoppedOwners += owner }
      }
      val active = FakeChannel("watch-a", "channel-a", "attempt-a")
      val reconnect = FakeChannel("watch-a", "channel-a-reconnect", "attempt-a")

      try {
        registry.accept(active, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(active)
        val owner = checkNotNull(registry.claim("watch-a", "attempt-a")).owner

        registry.accept(reconnect, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(reconnect)
        withTimeout(1_000L) {
          transport.awaitClosed(active)
          while (!transport.hasStartedReading(reconnect)) yield()
        }

        val repeated = checkNotNull(registry.claim("watch-a", "attempt-a"))
        assertFalse(repeated.newlyAcquired)
        assertSame(owner, repeated.owner)
        assertTrue(registry.isCurrent(owner))
        assertTrue(synchronized(stoppedOwners) { stoppedOwners.isEmpty() })
        registry.close(owner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `same path reconnect waits for an in flight frame before retiring its channel`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val active = FakeChannel("watch-a", "channel-a", "attempt-a")
      val reconnect = FakeChannel("watch-a", "channel-a-reconnect", "attempt-a")
      val releaseWrite = transport.holdWrite(active)

      try {
        registry.accept(active, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(active)
        val owner = checkNotNull(registry.claim("watch-a", "attempt-a")).owner
        val send =
          async(Dispatchers.IO) {
            registry.send(owner, WearRealtimeAudioFrameType.OUTPUT_PCM, byteArrayOf(1, 2, 3, 4))
          }
        transport.awaitWriteStarted(active)

        registry.accept(reconnect, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(reconnect)
        delay(100L)
        assertFalse(send.isCompleted)
        assertEquals(0, transport.closeCount(active))

        releaseWrite.countDown()
        withTimeout(1_000L) { send.await() }
        withTimeout(1_000L) {
          transport.awaitClosed(active)
          while (!transport.hasStartedReading(reconnect)) yield()
        }
        assertTrue(registry.isCurrent(owner))
        registry.close(owner)
      } finally {
        releaseWrite.countDown()
        scope.cancel()
      }
    }

  @Test
  fun `missing stale claim does not block a valid attempt on the same watch`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val current = FakeChannel("watch-a", "channel-b", "attempt-b")

      try {
        registry.accept(current, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(current)
        val missingClaim = async { registry.claim("watch-a", "attempt-a") }
        delay(100L)

        val currentOwner =
          withTimeout(1_000L) {
            checkNotNull(registry.claim("watch-a", "attempt-b")).owner
          }
        assertFalse(missingClaim.isCompleted)
        missingClaim.cancel()
        registry.close(currentOwner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `replacement claim bounds a stalled owner stop callback`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val second = FakeChannel("watch-a", "channel-b", "attempt-b")
      val stopStarted = CompletableDeferred<Unit>()
      val releaseStop = CompletableDeferred<Unit>()
      val stopFinished = CompletableDeferred<Unit>()
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        if (owner.attemptId == "attempt-a") {
          stopStarted.complete(Unit)
          releaseStop.await()
          stopFinished.complete(Unit)
        }
      }

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        checkNotNull(registry.claim("watch-a", "attempt-a"))
        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(second)

        val replacementClaim = async { registry.claim("watch-a", "attempt-b") }
        withTimeout(1_000L) { stopStarted.await() }
        val replacement = checkNotNull(withTimeout(2_500L) { replacementClaim.await() }).owner
        assertFalse(stopFinished.isCompleted)
        releaseStop.complete(Unit)
        withTimeout(1_000L) { stopFinished.await() }
        registry.close(replacement)
      } finally {
        releaseStop.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `retirement timeout keeps transport cleanup running`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry =
        WearRealtimeChannelRegistry(
          scope = scope,
          transport = transport,
          retireCallbackTimeoutMillis = 100L,
        )
      val channel = FakeChannel("watch-a", "channel-a", "attempt-a")
      val releaseClose = transport.holdClose(channel)

      try {
        registry.accept(channel, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(channel)
        val owner = checkNotNull(registry.claim("watch-a", "attempt-a")).owner

        withTimeout(1_000L) { registry.close(owner) }
        assertEquals(0, transport.closeCount(channel))
        scope.cancel()
        releaseClose.complete(Unit)
        withTimeout(1_000L) { transport.awaitClosed(channel) }
      } finally {
        releaseClose.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `old path reconnect cannot inherit an owner reserved for retirement`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry =
        WearRealtimeChannelRegistry(
          scope = scope,
          transport = transport,
          pendingConnectionTimeoutMillis = 100L,
        )
      val stopStarted = CompletableDeferred<Unit>()
      val releaseStop = CompletableDeferred<Unit>()
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()
      val active = FakeChannel("watch-a", "channel-a", "attempt-a")
      val replacement = FakeChannel("watch-a", "channel-b", "attempt-b")
      val staleReconnect = FakeChannel("watch-a", "channel-a-reconnect", "attempt-a")
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        stopStarted.complete(Unit)
        releaseStop.await()
        synchronized(stoppedOwners) { stoppedOwners += owner }
      }

      try {
        registry.accept(active, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(active)
        val activeOwner = checkNotNull(registry.claim("watch-a", "attempt-a")).owner
        registry.accept(replacement, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(replacement)
        val replacementClaim = async { registry.claim("watch-a", "attempt-b") }
        withTimeout(1_000L) { stopStarted.await() }

        registry.accept(staleReconnect, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(staleReconnect)
        releaseStop.complete(Unit)

        val replacementOwner = checkNotNull(withTimeout(1_000L) { replacementClaim.await() }).owner
        assertEquals(listOf(activeOwner), synchronized(stoppedOwners) { stoppedOwners.toList() })
        assertTrue(registry.isCurrent(replacementOwner))
        withTimeout(1_000L) { transport.awaitClosed(staleReconnect) }
        registry.close(replacementOwner)
      } finally {
        releaseStop.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `promotion reserved before discovery timeout commits after bounded cleanup`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry =
        WearRealtimeChannelRegistry(
          scope = scope,
          transport = transport,
          connectionReadyTimeoutMillis = 200L,
          pendingConnectionTimeoutMillis = 1_000L,
          retireCallbackTimeoutMillis = 100L,
        )
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val replacement = FakeChannel("watch-a", "channel-b", "attempt-b")
      val releaseReplacement = transport.holdOpen(replacement)
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        if (owner.attemptId == "attempt-a") awaitCancellation()
      }

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        checkNotNull(registry.claim("watch-a", "attempt-a"))
        registry.accept(replacement, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        val replacementClaim = async { registry.claim("watch-a", "attempt-b") }
        delay(150L)
        releaseReplacement.complete(Unit)
        transport.awaitOpened(replacement)

        val replacementOwner =
          withTimeout(1_000L) {
            checkNotNull(replacementClaim.await()).owner
          }
        assertTrue(registry.isCurrent(replacementOwner))
        registry.close(replacementOwner)
      } finally {
        releaseReplacement.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `claim keeps polling after an unclaimed channel expires`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry =
        WearRealtimeChannelRegistry(
          scope = scope,
          transport = transport,
          connectionReadyTimeoutMillis = 1_000L,
          pendingConnectionTimeoutMillis = 100L,
        )
      val expired = FakeChannel("watch-a", "channel-a-expired", "attempt-a")
      val replacement = FakeChannel("watch-a", "channel-a-replacement", "attempt-a")

      try {
        registry.accept(expired, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(expired)
        withTimeout(1_000L) { transport.awaitClosed(expired) }

        val claim = async { registry.claim("watch-a", "attempt-a") }
        delay(100L)
        assertFalse(claim.isCompleted)
        registry.accept(replacement, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(replacement)

        val owner = checkNotNull(withTimeout(1_000L) { claim.await() }).owner
        assertTrue(registry.isCurrent(owner))
        registry.close(owner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `older polling claim cannot replace a newer active attempt`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        synchronized(stoppedOwners) { stoppedOwners += owner }
      }
      val newer = FakeChannel("watch-a", "channel-b", "attempt-b")
      val delayedOlder = FakeChannel("watch-a", "channel-a", "attempt-a")

      try {
        val olderClaim = async { registry.claim("watch-a", "attempt-a") }
        delay(100L)
        registry.accept(newer, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(newer)
        val newerOwner = checkNotNull(registry.claim("watch-a", "attempt-b")).owner

        registry.accept(delayedOlder, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(delayedOlder)

        assertEquals(null, withTimeout(1_000L) { olderClaim.await() })
        assertTrue(registry.isCurrent(newerOwner))
        assertTrue(synchronized(stoppedOwners) { stoppedOwners.isEmpty() })
        registry.close(newerOwner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `newer waiting channel survives an older promotion`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stopStarted = CompletableDeferred<Unit>()
      val releaseStop = CompletableDeferred<Unit>()
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val second = FakeChannel("watch-a", "channel-b", "attempt-b")
      val third = FakeChannel("watch-a", "channel-c", "attempt-c")
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        if (owner.attemptId == "attempt-a") {
          stopStarted.complete(Unit)
          releaseStop.await()
        }
      }

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        checkNotNull(registry.claim("watch-a", "attempt-a"))
        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(second)
        val secondClaim = async { registry.claim("watch-a", "attempt-b") }
        withTimeout(1_000L) { stopStarted.await() }

        registry.accept(third, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(third)
        val thirdClaim = async { registry.claim("watch-a", "attempt-c") }
        releaseStop.complete(Unit)

        assertNotNull(withTimeout(1_000L) { secondClaim.await() })
        val thirdOwner = checkNotNull(withTimeout(1_000L) { thirdClaim.await() }).owner
        assertTrue(registry.isCurrent(thirdOwner))
        registry.close(thirdOwner)
      } finally {
        releaseStop.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `same path reconnect replaces a reserved channel before promotion`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stopStarted = CompletableDeferred<Unit>()
      val releaseStop = CompletableDeferred<Unit>()
      val active = FakeChannel("watch-a", "channel-a", "attempt-a")
      val reserved = FakeChannel("watch-a", "channel-b-reserved", "attempt-b")
      val supersededReconnect = FakeChannel("watch-a", "channel-b-superseded", "attempt-b")
      val reconnect = FakeChannel("watch-a", "channel-b-reconnect", "attempt-b")
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        if (owner.attemptId == "attempt-a") {
          stopStarted.complete(Unit)
          releaseStop.await()
        }
      }

      try {
        registry.accept(active, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(active)
        checkNotNull(registry.claim("watch-a", "attempt-a"))
        registry.accept(reserved, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(reserved)
        val replacementClaim = async { registry.claim("watch-a", "attempt-b") }
        withTimeout(1_000L) { stopStarted.await() }

        registry.accept(supersededReconnect, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(supersededReconnect)
        registry.accept(reconnect, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(reconnect)
        // The older reconnect cannot close until the newest channel is published in the registry.
        withTimeout(1_000L) { transport.awaitClosed(supersededReconnect) }
        releaseStop.complete(Unit)

        val owner = checkNotNull(withTimeout(1_000L) { replacementClaim.await() }).owner
        assertEquals(4L, owner.channelGeneration)
        assertEquals(1, transport.closeCount(reserved))
        assertEquals(1, transport.closeCount(supersededReconnect))
        assertEquals(0, transport.closeCount(reconnect))
        assertTrue(registry.isCurrent(owner))
        registry.close(owner)
      } finally {
        releaseStop.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `latest reconnect wins while an older promotion candidate retires`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stopStarted = CompletableDeferred<Unit>()
      val releaseStop = CompletableDeferred<Unit>()
      val active = FakeChannel("watch-a", "channel-a", "attempt-a")
      val reserved = FakeChannel("watch-a", "channel-b-reserved", "attempt-b")
      val firstReconnect = FakeChannel("watch-a", "channel-b-first-reconnect", "attempt-b")
      val latestReconnect = FakeChannel("watch-a", "channel-b-latest-reconnect", "attempt-b")
      val releaseReservedClose = transport.holdClose(reserved)
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        if (owner.attemptId == "attempt-a") {
          stopStarted.complete(Unit)
          releaseStop.await()
        }
      }

      try {
        registry.accept(active, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(active)
        checkNotNull(registry.claim("watch-a", "attempt-a"))
        registry.accept(reserved, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(reserved)
        val replacementClaim = async { registry.claim("watch-a", "attempt-b") }
        withTimeout(1_000L) { stopStarted.await() }

        registry.accept(firstReconnect, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(firstReconnect)
        releaseStop.complete(Unit)
        transport.awaitCloseStarted(reserved)

        registry.accept(latestReconnect, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(latestReconnect)
        releaseReservedClose.complete(Unit)

        val owner = checkNotNull(withTimeout(1_000L) { replacementClaim.await() }).owner
        withTimeout(1_000L) {
          transport.awaitClosed(reserved)
          transport.awaitClosed(firstReconnect)
          while (!transport.hasStartedReading(latestReconnect)) yield()
        }
        assertEquals("attempt-b", owner.attemptId)
        assertEquals(0, transport.closeCount(latestReconnect))
        assertTrue(registry.isCurrent(owner))
        registry.close(owner)
      } finally {
        releaseStop.complete(Unit)
        releaseReservedClose.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `cancelled promotion retires its reserved channel before retry`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry =
        WearRealtimeChannelRegistry(
          scope = scope,
          transport = transport,
          connectionReadyTimeoutMillis = 500L,
          pendingConnectionTimeoutMillis = 1_000L,
          retireCallbackTimeoutMillis = 100L,
        )
      val stopStarted = CompletableDeferred<Unit>()
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val cancelled = FakeChannel("watch-a", "channel-b", "attempt-b")
      val retry = FakeChannel("watch-a", "channel-b-retry", "attempt-b")
      val stopTalk: suspend (WearRealtimeAttemptOwner) -> Unit = { owner ->
        if (owner.attemptId == "attempt-a") {
          stopStarted.complete(Unit)
          awaitCancellation()
        }
      }

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(first)
        checkNotNull(registry.claim("watch-a", "attempt-a"))
        registry.accept(cancelled, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(cancelled)

        val cancelledClaim = async { registry.claim("watch-a", "attempt-b") }
        withTimeout(1_000L) { stopStarted.await() }
        cancelledClaim.cancelAndJoin()
        withTimeout(1_000L) { transport.awaitClosed(cancelled) }

        registry.accept(retry, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(retry)
        val retryOwner = checkNotNull(withTimeout(1_000L) { registry.claim("watch-a", "attempt-b") }).owner
        registry.close(retryOwner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `pending channel does not read pcm before promotion`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val channel = FakeChannel("watch-a", "channel-a", "attempt-a")

      try {
        registry.accept(channel, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(channel)
        delay(100L)
        assertFalse(transport.hasStartedReading(channel))

        val owner = checkNotNull(registry.claim("watch-a", "attempt-a")).owner
        withTimeout(1_000L) {
          while (!transport.hasStartedReading(channel)) yield()
        }
        registry.close(owner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `older channel setup cannot displace a newer published channel`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val first = FakeChannel("watch-a", "channel-a", "attempt-a")
      val second = FakeChannel("watch-a", "channel-b", "attempt-b")
      val releaseFirst = transport.holdOpen(first)

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = {})
        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(second)
        val secondOwner = checkNotNull(registry.claim("watch-a", "attempt-b")).owner

        releaseFirst.complete(Unit)
        transport.awaitOpened(first)
        withTimeout(1_000L) { transport.awaitClosed(first) }

        val repeated = checkNotNull(registry.claim("watch-a", "attempt-b"))
        assertFalse(repeated.newlyAcquired)
        assertSame(secondOwner, repeated.owner)
        registry.close(secondOwner)
      } finally {
        releaseFirst.complete(Unit)
        scope.cancel()
      }
    }

  @Test
  fun `legacy channel replacement binds the new attempt instead of inheriting the old owner`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry = WearRealtimeChannelRegistry(scope, transport)
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()
      val first =
        FakeChannel(
          nodeId = "watch-a",
          label = "legacy-a",
          attemptId = "ignored-a",
          pathOverride = WearProtocol.LEGACY_REALTIME_AUDIO_CHANNEL_PATH,
        )
      val second =
        FakeChannel(
          nodeId = "watch-a",
          label = "legacy-b",
          attemptId = "ignored-b",
          pathOverride = WearProtocol.LEGACY_REALTIME_AUDIO_CHANNEL_PATH,
        )

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = { stoppedOwners += it })
        transport.awaitOpened(first)
        val firstOwner =
          checkNotNull(
            registry.claim(
              nodeId = "watch-a",
              attemptId = "attempt-a",
              attemptScopedAudio = false,
            ),
          ).owner

        registry.accept(second, appendAudio = { _, _ -> }, stopTalk = { stoppedOwners += it })
        transport.awaitOpened(second)
        val secondOwner =
          checkNotNull(
            registry.claim(
              nodeId = "watch-a",
              attemptId = "attempt-b",
              attemptScopedAudio = false,
            ),
          ).owner

        assertEquals("attempt-b", secondOwner.attemptId)
        assertTrue(secondOwner.channelGeneration > firstOwner.channelGeneration)
        assertEquals(listOf(firstOwner), stoppedOwners)
        registry.close(secondOwner)
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun `staged channel limits reject excess connections before opening streams`() =
    runBlocking {
      val scope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val transport = FakeChannelTransport()
      val registry =
        WearRealtimeChannelRegistry(
          scope = scope,
          transport = transport,
          maxStagedConnectionsPerNode = 1,
          maxStagedConnections = 2,
        )
      val first = FakeChannel("watch-a", "first", "attempt-a")
      val sameNodeExcess = FakeChannel("watch-a", "same-node-excess", "attempt-b")
      val secondNode = FakeChannel("watch-b", "second-node", "attempt-c")
      val globalExcess = FakeChannel("watch-c", "global-excess", "attempt-d")

      try {
        registry.accept(first, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(first)

        registry.accept(sameNodeExcess, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitClosed(sameNodeExcess)
        assertFalse(transport.wasOpened(sameNodeExcess))
        assertEquals(1, transport.closeCount(sameNodeExcess))

        registry.accept(secondNode, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitOpened(secondNode)

        registry.accept(globalExcess, appendAudio = { _, _ -> }, stopTalk = {})
        transport.awaitClosed(globalExcess)
        assertFalse(transport.wasOpened(globalExcess))
        assertEquals(1, transport.closeCount(globalExcess))
      } finally {
        scope.cancel()
      }
    }
}

private class FakeChannelTransport : WearRealtimeChannelTransport {
  private val opened = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val openGates = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val closeGates = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val closeStarted = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val closeCompleted = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val closeCounts = ConcurrentHashMap<ChannelClient.Channel, Int>()
  private val writeGates = ConcurrentHashMap<ChannelClient.Channel, CountDownLatch>()
  private val writeStarted = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val openedResources = ConcurrentHashMap<ChannelClient.Channel, WearRealtimeChannelResources>()

  override suspend fun open(channel: ChannelClient.Channel): WearRealtimeChannelResources {
    openGates[channel]?.await()
    val resources =
      WearRealtimeChannelResources(
        ClosingInputStream(),
        GatedOutputStream(
          gate = writeGates[channel],
          started = writeStarted.computeIfAbsent(channel) { CompletableDeferred() },
        ),
      )
    openedResources[channel] = resources
    opened.computeIfAbsent(channel) { CompletableDeferred() }.complete(Unit)
    return resources
  }

  override suspend fun close(
    channel: ChannelClient.Channel,
    resources: WearRealtimeChannelResources?,
  ) {
    closeStarted.computeIfAbsent(channel) { CompletableDeferred() }.complete(Unit)
    closeGates[channel]?.await()
    resources?.input?.close()
    resources?.output?.close()
    closeCounts.compute(channel) { _, count -> (count ?: 0) + 1 }
    closeCompleted.computeIfAbsent(channel) { CompletableDeferred() }.complete(Unit)
  }

  suspend fun awaitOpened(channel: ChannelClient.Channel) {
    opened.computeIfAbsent(channel) { CompletableDeferred() }.await()
  }

  fun holdOpen(channel: ChannelClient.Channel): CompletableDeferred<Unit> {
    val gate = CompletableDeferred<Unit>()
    openGates[channel] = gate
    return gate
  }

  fun holdClose(channel: ChannelClient.Channel): CompletableDeferred<Unit> {
    val gate = CompletableDeferred<Unit>()
    closeGates[channel] = gate
    return gate
  }

  suspend fun awaitCloseStarted(channel: ChannelClient.Channel) {
    closeStarted.computeIfAbsent(channel) { CompletableDeferred() }.await()
  }

  suspend fun awaitClosed(channel: ChannelClient.Channel) {
    closeCompleted.computeIfAbsent(channel) { CompletableDeferred() }.await()
  }

  fun holdWrite(channel: ChannelClient.Channel): CountDownLatch =
    CountDownLatch(1).also { gate ->
      writeGates[channel] = gate
    }

  suspend fun awaitWriteStarted(channel: ChannelClient.Channel) {
    writeStarted.computeIfAbsent(channel) { CompletableDeferred() }.await()
  }

  fun finishInput(channel: ChannelClient.Channel) {
    openedResources[channel]?.input?.close()
  }

  fun closeCount(channel: ChannelClient.Channel): Int = closeCounts[channel] ?: 0

  fun wasOpened(channel: ChannelClient.Channel): Boolean = openedResources.containsKey(channel)

  fun hasStartedReading(channel: ChannelClient.Channel): Boolean = (openedResources[channel]?.input as? ClosingInputStream)?.hasStartedReading() == true
}

private class ClosingInputStream : InputStream() {
  private val started = CountDownLatch(1)
  private val closed = CountDownLatch(1)

  override fun read(): Int {
    started.countDown()
    closed.await()
    return -1
  }

  override fun close() {
    closed.countDown()
  }

  fun hasStartedReading(): Boolean = started.count == 0L
}

private class GatedOutputStream(
  private val gate: CountDownLatch?,
  private val started: CompletableDeferred<Unit>,
) : ByteArrayOutputStream() {
  override fun write(
    buffer: ByteArray,
    offset: Int,
    length: Int,
  ) {
    started.complete(Unit)
    gate?.let { check(it.await(5, TimeUnit.SECONDS)) }
    super.write(buffer, offset, length)
  }
}

private data class FakeChannel(
  private val nodeId: String,
  private val label: String,
  private val attemptId: String,
  private val pathOverride: String? = null,
) : ChannelClient.Channel {
  override fun getNodeId(): String = nodeId

  override fun getPath(): String = pathOverride ?: WearProtocol.realtimeAudioChannelPath(attemptId)

  override fun describeContents(): Int = 0

  override fun writeToParcel(
    dest: Parcel,
    flags: Int,
  ) {
    dest.writeString(label)
  }
}
