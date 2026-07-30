package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import android.os.Parcel
import com.google.android.gms.wearable.ChannelClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
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
        withTimeout(2_000L) {
          while (transport.closeCount(first) != 1 || synchronized(stoppedOwners) { stoppedOwners.size } != 1) {
            kotlinx.coroutines.yield()
          }
        }

        val secondClaim = checkNotNull(registry.claim("watch-a", "attempt-b"))
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

        registry.close(retryOwner, stopTalk)
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
        withTimeout(1_000L) { closeStarted.await() }

        val secondOwner = withTimeout(1_000L) { registry.claim("watch-a", "attempt-b") }?.owner
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
        registry.close(checkNotNull(secondOwner), stopTalk)
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
        registry.close(replacementOwner, stopTalk)
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
        withTimeout(1_000L) { stopStarted.await() }
        registry.accept(third, appendAudio = { _, _ -> }, stopTalk = stopTalk)
        transport.awaitOpened(third)
        val newestClaim = async { registry.claim("watch-a", "attempt-c") }
        delay(100L)
        assertFalse(newestClaim.isCompleted)

        releaseStop.complete(Unit)
        val newestOwner = checkNotNull(withTimeout(1_000L) { newestClaim.await() }).owner
        registry.close(newestOwner, stopTalk)
      } finally {
        releaseStop.complete(Unit)
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
        withTimeout(1_000L) {
          while (transport.closeCount(first) != 1) yield()
        }

        val repeated = checkNotNull(registry.claim("watch-a", "attempt-b"))
        assertFalse(repeated.newlyAcquired)
        assertSame(secondOwner, repeated.owner)
        registry.close(secondOwner, stopTalk = {})
      } finally {
        releaseFirst.complete(Unit)
        scope.cancel()
      }
    }
}

private class FakeChannelTransport : WearRealtimeChannelTransport {
  private val opened = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val openGates = ConcurrentHashMap<ChannelClient.Channel, CompletableDeferred<Unit>>()
  private val closeCounts = ConcurrentHashMap<ChannelClient.Channel, Int>()
  private val openedResources = ConcurrentHashMap<ChannelClient.Channel, WearRealtimeChannelResources>()

  override suspend fun open(channel: ChannelClient.Channel): WearRealtimeChannelResources {
    openGates[channel]?.await()
    val resources = WearRealtimeChannelResources(ClosingInputStream(), ByteArrayOutputStream())
    openedResources[channel] = resources
    opened.computeIfAbsent(channel) { CompletableDeferred() }.complete(Unit)
    return resources
  }

  override suspend fun close(
    channel: ChannelClient.Channel,
    resources: WearRealtimeChannelResources?,
  ) {
    resources?.input?.close()
    resources?.output?.close()
    closeCounts.compute(channel) { _, count -> (count ?: 0) + 1 }
  }

  suspend fun awaitOpened(channel: ChannelClient.Channel) {
    opened.computeIfAbsent(channel) { CompletableDeferred() }.await()
  }

  fun holdOpen(channel: ChannelClient.Channel): CompletableDeferred<Unit> {
    val gate = CompletableDeferred<Unit>()
    openGates[channel] = gate
    return gate
  }

  fun finishInput(channel: ChannelClient.Channel) {
    openedResources[channel]?.input?.close()
  }

  fun closeCount(channel: ChannelClient.Channel): Int = closeCounts[channel] ?: 0
}

private class ClosingInputStream : InputStream() {
  private val closed = CountDownLatch(1)

  override fun read(): Int {
    closed.await()
    return -1
  }

  override fun close() {
    closed.countDown()
  }
}

private data class FakeChannel(
  private val nodeId: String,
  private val label: String,
  private val attemptId: String,
) : ChannelClient.Channel {
  override fun getNodeId(): String = nodeId

  override fun getPath(): String = WearProtocol.realtimeAudioChannelPath(attemptId)

  override fun describeContents(): Int = 0

  override fun writeToParcel(
    dest: Parcel,
    flags: Int,
  ) {
    dest.writeString(label)
  }
}
