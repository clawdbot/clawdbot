package ai.openclaw.app.gateway

import ai.openclaw.app.NotificationNodeEventOutbox
import ai.openclaw.app.PendingNotificationNodeEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.lang.management.ManagementFactory
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

private const val LIFECYCLE_TEST_TIMEOUT_MS = 8_000L
private const val LIFECYCLE_CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce","ts":1700000000123}}"""

private class ReconnectDeviceAuthStore(
  private val entry: DeviceAuthEntry? = null,
) : DeviceAuthTokenStore {
  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = entry

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) = Unit

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ) = Unit
}

private class BlockingSaveDeviceAuthStore : DeviceAuthTokenStore {
  val saveStarted = CountDownLatch(1)
  val allowSave = CountDownLatch(1)
  val savedToken = CompletableDeferred<String>()

  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) {
    saveStarted.countDown()
    allowSave.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    savedToken.complete(token)
  }

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ) = Unit
}

private class RecordingDeviceAuthStore : DeviceAuthTokenStore {
  val savedToken = CompletableDeferred<String>()

  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) {
    savedToken.complete(token)
  }

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ) = Unit
}

private data class ReconnectHarness(
  val session: GatewaySession,
  val sessionJob: Job,
)

private data class TerminalCallbackObservation(
  val inFlightHandlerCompleted: Boolean,
  val issuedTokenPersisted: Boolean,
)

private data class ReconnectServer(
  val server: MockWebServer,
  val sockets: ConcurrentLinkedQueue<WebSocket>,
  val requestFrames: ConcurrentLinkedQueue<JsonObject>,
) {
  val port: Int
    get() = server.port

  val requestCount: Int
    get() = server.requestCount

  fun shutdown() {
    server.shutdown()
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionReconnectTest {
  @Test
  fun networkAttachmentPreservesReadyTransport() =
    runBlocking {
      val connected = CompletableDeferred<Unit>()
      val server =
        startGatewayServer(json = Json) { socket, id, method ->
          if (method == "connect") socket.send(connectResponseFrame(id))
        }
      val harness = createReconnectHarness(onConnected = { connected.complete(Unit) })
      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        harness.session.retryAfterNetworkRestore()
        assertTrue("An unrelated available network must not retire a ready socket", harness.session.isReady())
        assertEquals(1, server.requestCount)
        harness.session.disconnectAndJoin()
        harness.session.retryAfterNetworkRestore()
        assertFalse(harness.session.isReady())
        assertNull(harness.session.currentEndpointStableId())
        assertEquals(1, server.requestCount)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun persistentFailuresGrowPastTheOldEightSecondTimerCap() =
    runBlocking {
      val starts = ConcurrentLinkedQueue<Long>()
      val eighthAttempt = CompletableDeferred<Unit>()
      val server = startGatewayServer(json = Json) { _, _, _ -> }
      server.server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse = MockResponse().setResponseCode(503)
        }
      val harness =
        createReconnectHarness(onDisconnected = { message ->
          if (message == "Connecting…" || message == "Reconnecting…") {
            starts += System.nanoTime()
            if (starts.size == 8) eighthAttempt.complete(Unit)
          }
        })
      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(60_000) { eighthAttempt.await() }
        val attempts = starts.toList()
        val intervalMs = TimeUnit.NANOSECONDS.toMillis(attempts[7] - attempts[6])
        assertTrue("Persistent per-session attempt interval was ${intervalMs}ms", intervalMs > 9_000)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun manualReconnectResetsTheSameRetryLadder() = assertWakeResetsRetryLadder(manual = true)

  @Test
  fun networkAttachmentResetsTheSameRetryLadder() = assertWakeResetsRetryLadder(manual = false)

  private fun assertWakeResetsRetryLadder(manual: Boolean) =
    runBlocking {
      val fourthAttempt = CompletableDeferred<Unit>()
      val sixthAttempt = CompletableDeferred<Unit>()
      val attempts = AtomicInteger()
      val server = startGatewayServer(json = Json) { _, _, _ -> }
      server.server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse = MockResponse().setResponseCode(503)
        }
      val harness =
        createReconnectHarness(onDisconnected = { message ->
          if (message == "Connecting…" || message == "Reconnecting…") {
            when (attempts.incrementAndGet()) {
              4 -> fourthAttempt.complete(Unit)
              6 -> sixthAttempt.complete(Unit)
            }
          }
        })
      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { fourthAttempt.await() }
        if (manual) harness.session.reconnect() else harness.session.retryAfterNetworkRestore()
        // The wake starts an immediate attempt; its failure gets the initial 595ms wait,
        // not the old target's next multi-second slot. No new loop is introduced.
        withTimeout(2_000) { sixthAttempt.await() }
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun serverAcknowledgesPeerCloseBeforeTeardown() =
    runBlocking {
      val opened = CompletableDeferred<Unit>()
      val peerClosed = CompletableDeferred<Pair<Int, String>>()
      val serverClosed = CompletableDeferred<Unit>()
      val terminalCallbacks = AtomicInteger()
      val server =
        startGatewayServer(
          json = Json,
          onClosed = {
            terminalCallbacks.incrementAndGet()
            serverClosed.complete(Unit)
          },
        ) { _, _, _ -> }
      val client = OkHttpClient()
      val socket =
        client.newWebSocket(
          Request.Builder().url("ws://127.0.0.1:${server.port}/").build(),
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              opened.complete(Unit)
            }

            override fun onClosed(
              webSocket: WebSocket,
              code: Int,
              reason: String,
            ) {
              peerClosed.complete(code to reason)
            }

            override fun onFailure(
              webSocket: WebSocket,
              t: Throwable,
              response: Response?,
            ) {
              opened.completeExceptionally(t)
              peerClosed.completeExceptionally(t)
            }
          },
        )

      try {
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { opened.await() }
        assertTrue(socket.close(1000, "test complete"))
        assertEquals(1000 to "test complete", withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { peerClosed.await() })
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { serverClosed.await() }
        server.shutdown()
        assertEquals(1, terminalCallbacks.get())
      } finally {
        // A missing acknowledgment must fail the test without leaving the server writer open.
        server.sockets.forEach { it.close(1000, "test complete") }
        socket.cancel()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
      }
    }

  @Test
  fun sequenceGapSignalsRecoveryBeforeAdmittingTheNextEvent() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val finalEvent = CompletableDeferred<Unit>()
      val received = ConcurrentLinkedQueue<String>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = { connected.complete(Unit) },
          onEvent = { event, payload ->
            val marker =
              payload?.let { value ->
                json
                  .parseToJsonElement(value)
                  .jsonObject["marker"]
                  ?.jsonPrimitive
                  ?.content
              }
            received += marker ?: event
            if (marker == "after-gap") finalEvent.complete(Unit)
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val socket = checkNotNull(server.sockets.peek())
        socket.send("""{"type":"event","event":"health","payload":{"marker":"first"},"seq":41}""")
        socket.send("""{"type":"event","event":"health","payload":{"marker":"unsequenced"}}""")
        socket.send("""{"type":"event","event":"health","payload":{"marker":"contiguous"},"seq":42}""")
        socket.send("""{"type":"event","event":"health","payload":{"marker":"duplicate"},"seq":42}""")
        socket.send("""{"type":"event","event":"health","payload":{"marker":"older"},"seq":41}""")
        socket.send("""{"type":"event","event":"health","payload":{"marker":"after-older"},"seq":42}""")
        socket.send("""{"type":"event","event":"chat","payload":{"marker":"after-gap"},"seq":44}""")
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { finalEvent.await() }

        assertEquals(
          listOf("first", "unsequenced", "contiguous", "duplicate", "older", "after-older", "seqGap", "after-gap"),
          received.toList(),
        )
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun sequenceGapSignalsRecoveryBeforeInvokingTheNextCommand() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val invoked = CompletableDeferred<Unit>()
      val received = ConcurrentLinkedQueue<String>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = { connected.complete(Unit) },
          onEvent = { event, _ -> received += event },
          onInvoke = {
            received += "invoke"
            invoked.complete(Unit)
            GatewaySession.InvokeResult.ok("{}")
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val socket = checkNotNull(server.sockets.peek())
        socket.send("""{"type":"event","event":"health","payload":{},"seq":1}""")
        socket.send(
          """{"type":"event","event":"node.invoke.request","payload":{"id":"gap-invoke","nodeId":"node-1","command":"calendar.events"},"seq":3}""",
        )
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { invoked.await() }

        assertEquals(listOf("health", "seqGap", "invoke"), received.toList())
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun sequenceGapCallbackCannotAdmitAnEventAfterDisconnect() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val disconnected = CompletableDeferred<Unit>()
      val decision = CompletableDeferred<String>()
      val received = ConcurrentLinkedQueue<String>()
      var currentSession: GatewaySession? = null
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = { connected.complete(Unit) },
          onDisconnected = { disconnected.complete(Unit) },
          onEvent = { event, _ ->
            received += event
            if (event == "seqGap") {
              checkNotNull(currentSession).disconnect()
              decision.complete(event)
            } else if (event == "chat") {
              decision.complete(event)
            }
          },
        )
      currentSession = harness.session

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val socket = checkNotNull(server.sockets.peek())
        socket.send("""{"type":"event","event":"health","payload":{},"seq":1}""")
        socket.send("""{"type":"event","event":"chat","payload":{},"seq":3}""")

        assertEquals("seqGap", withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { decision.await() })
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { disconnected.await() }
        assertEquals(listOf("health", "seqGap"), received.toList())
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun sequenceTrackingStartsFreshAfterReconnect() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val firstConnected = CompletableDeferred<Unit>()
      val secondConnected = CompletableDeferred<Unit>()
      val firstSocketEvent = CompletableDeferred<Unit>()
      val finalEvent = CompletableDeferred<Unit>()
      val connections = AtomicInteger()
      val received = ConcurrentLinkedQueue<String>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = {
            if (connections.incrementAndGet() == 1) firstConnected.complete(Unit) else secondConnected.complete(Unit)
          },
          onEvent = { event, payload ->
            val marker =
              payload?.let { value ->
                json
                  .parseToJsonElement(value)
                  .jsonObject["marker"]
                  ?.jsonPrimitive
                  ?.content
              }
            received += marker ?: event
            if (marker == "first-socket") firstSocketEvent.complete(Unit)
            if (marker == "second-after-gap") finalEvent.complete(Unit)
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstConnected.await() }
        checkNotNull(server.sockets.peek())
          .send("""{"type":"event","event":"health","payload":{"marker":"first-socket"},"seq":1}""")
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstSocketEvent.await() }

        harness.session.reconnect()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondConnected.await() }
        val secondSocket = checkNotNull(server.sockets.lastOrNull())
        secondSocket.send("""{"type":"event","event":"health","payload":{"marker":"second-first"},"seq":100}""")
        secondSocket.send("""{"type":"event","event":"chat","payload":{"marker":"second-after-gap"},"seq":102}""")
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { finalEvent.await() }

        assertEquals(listOf("first-socket", "second-first", "seqGap", "second-after-gap"), received.toList())
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun capturedRequestLeaseRejectsReplacementSocketBeforeEnqueue() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val reconnected = CompletableDeferred<Unit>()
      val connectionCount = AtomicInteger()
      val unexpectedRequest = CompletableDeferred<Unit>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(connectResponseFrame(id))
          } else {
            unexpectedRequest.complete(Unit)
          }
        }
      val harness =
        createReconnectHarness(
          onConnected = {
            if (connectionCount.incrementAndGet() == 1) {
              connected.complete(Unit)
            } else {
              reconnected.complete(Unit)
            }
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val lease =
          requireNotNull(
            harness.session.captureRequestLease("manual|127.0.0.1|${server.port}"),
          )
        assertTrue(lease.isCurrent())
        harness.session.reconnect()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { reconnected.await() }
        assertFalse(lease.isCurrent())
        var committed = false
        assertFalse(lease.commitIfCurrent { committed = true })
        assertFalse(committed)
        val result =
          runCatching {
            lease.request(
              method = "sessions.patch",
              paramsJson = "{}",
            )
          }

        assertTrue(result.exceptionOrNull() is GatewayRequestNotEnqueued)
        assertNull(withTimeoutOrNull(200) { unexpectedRequest.await() })
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun retiringConnectionRejectsQueuedRequestsBeforeSocketCancellation() =
    runBlocking {
      for (fireAndForget in listOf(false, true)) {
        val connected = CompletableDeferred<Unit>()
        val cancelStarted = CompletableDeferred<Unit>()
        val allowCancel = CountDownLatch(1)
        val requestSeen = CompletableDeferred<Unit>()
        val errors = ConcurrentLinkedQueue<GatewaySession.ErrorShape>()
        val server =
          startGatewayServer(json = Json) { webSocket, id, method ->
            if (method == "connect") {
              webSocket.send(connectResponseFrame(id))
            } else {
              requestSeen.complete(Unit)
            }
          }
        val harness = createReconnectHarness(onConnected = { connected.complete(Unit) })
        var replacement: Job? = null
        var pending: Job? = null
        var writeLock: Mutex? = null
        val lockOwner = Any()
        try {
          connectNodeSession(harness.session, server.port)
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
          val connection = readField<Any>(harness.session, "currentConnection")
          val socketField = connection.javaClass.getDeclaredField("socket").apply { isAccessible = true }
          val socket = socketField.get(connection) as WebSocket
          socketField.set(
            connection,
            object : WebSocket by socket {
              override fun cancel() {
                // Hold only the interval after logical retirement and before physical cancellation.
                // All sends still reach the real OkHttp socket and MockWebServer peer.
                cancelStarted.complete(Unit)
                check(allowCancel.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
                socket.cancel()
              }
            },
          )
          val heldWriteLock = readField<Mutex>(harness.session, "writeLock").also { writeLock = it }
          heldWriteLock.lock(lockOwner)
          val queued =
            async(start = CoroutineStart.UNDISPATCHED) {
              runCatching {
                if (fireAndForget) {
                  harness.session.sendRequestFrame("transport-fence-test", null, onError = errors::add)
                } else {
                  harness.session.request("transport-fence-test", null)
                }
              }
            }.also { pending = it }
          assertTrue(queued.isActive)
          replacement = launch(Dispatchers.IO) { connectNodeSession(harness.session, server.port) }
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { cancelStarted.await() }
          assertFalse(harness.session.isReady())
          heldWriteLock.unlock(lockOwner)
          val result = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { queued.await() }
          if (result.isSuccess) withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { requestSeen.await() }
          assertTrue(
            "Retired request reached peer=${requestSeen.isCompleted}; fireAndForget=$fireAndForget",
            result.exceptionOrNull() is GatewayRequestNotEnqueued,
          )
          assertFalse(requestSeen.isCompleted)
        } finally {
          allowCancel.countDown()
          writeLock?.takeIf { it.holdsLock(lockOwner) }?.unlock(lockOwner)
          pending?.cancelAndJoin()
          replacement?.join()
          shutdownReconnectHarness(harness, server)
        }
        assertTrue("Rejected enqueue must not create an asynchronous reply watcher", errors.isEmpty())
      }
    }

  @Test
  fun replacementLeaseCannotObserveUnpublishedHelloMetadata() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val threads = ManagementFactory.getThreadMXBean()
      val initialMethods = setOf("health", "users.prefs.get", "users.prefs.set")
      val replacementMethods = setOf("health", "users.prefs.get")
      val connectRequests = AtomicInteger()
      val publishedMethods = AtomicReference<Set<String>?>(null)
      val connected = CompletableDeferred<Unit>()
      val replacementPublished = CompletableDeferred<Unit>()
      val replacementHelloStarted = CountDownLatch(1)
      val publicationThread = AtomicReference<Thread?>(null)
      val allowReplacementHello = CountDownLatch(1)
      val observerStarted = CountDownLatch(1)
      val observation = CompletableDeferred<Pair<GatewaySession.RequestLease?, Set<String>?>>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          when (method) {
            "connect" -> {
              val methods = if (connectRequests.incrementAndGet() == 1) initialMethods else replacementMethods
              webSocket.send(connectResponseFrame(id, methods))
            }

            "health" -> {
              webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{}}""")
            }
          }
        }
      val harness =
        createReconnectHarness(
          onHello = { hello ->
            if (hello.methods == replacementMethods) {
              publicationThread.set(Thread.currentThread())
              replacementHelloStarted.countDown()
              try {
                check(allowReplacementHello.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                  "Replacement hello publication was not released"
                }
              } catch (err: Throwable) {
                replacementPublished.completeExceptionally(err)
                throw err
              }
            }
            publishedMethods.set(hello.methods)
            if (hello.methods == initialMethods) connected.complete(Unit) else replacementPublished.complete(Unit)
          },
        )
      val gatewayId = "manual|127.0.0.1|${server.port}"
      val captureLease = harness.session::captureRequestLease
      val captureMethodName = captureLease.name.substringBefore('$')
      val observer =
        Thread {
          try {
            observerStarted.countDown()
            val lease = captureLease(gatewayId)
            observation.complete(lease to publishedMethods.get())
          } catch (err: Throwable) {
            observation.completeExceptionally(err)
          }
        }

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val initialLease = requireNotNull(captureLease(gatewayId))
        assertEquals(initialMethods, publishedMethods.get())

        harness.session.reconnect()
        assertTrue(replacementHelloStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        assertFalse(initialLease.isCurrent())
        observer.start()
        assertTrue(observerStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        val observerThreadId = observer.threadId()
        val publicationThreadId = requireNotNull(publicationThread.get()).threadId()
        // Unrelated parking or class loading must not release hello early. Require
        // the capture call to be waiting on a lock owned by the paused publisher.
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) {
          while (!observation.isCompleted) {
            val read = threads.getThreadInfo(observerThreadId, Int.MAX_VALUE)
            if (
              read != null &&
              read.lockOwnerId == publicationThreadId &&
              read.stackTrace.any {
                it.className == GatewaySession::class.java.name &&
                  it.methodName.substringBefore('$') == captureMethodName
              }
            ) {
              break
            }
            delay(10)
          }
        }

        allowReplacementHello.countDown()
        val (observedLease, observedMethods) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { observation.await() }
        if (observedLease != null) {
          assertEquals("A ready replacement must expose its own hello metadata", replacementMethods, observedMethods)
          assertTrue(observedLease.isCurrent())
        }
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { replacementPublished.await() }
        val currentLease = requireNotNull(captureLease(gatewayId))
        assertEquals(replacementMethods, publishedMethods.get())
        assertEquals("{}", currentLease.request("health", null))
      } finally {
        allowReplacementHello.countDown()
        try {
          observer.join(LIFECYCLE_TEST_TIMEOUT_MS)
          assertFalse("The hello observer must finish before teardown", observer.isAlive)
        } finally {
          shutdownReconnectHarness(harness, server)
        }
      }
    }

  @Test
  fun connectedHelloPublishesCanonicalAndLegacyApprovalMethods() =
    runBlocking {
      val catalogs =
        listOf(
          setOf("approval.get", "approval.resolve"),
          setOf("exec.approval.get", "exec.approval.resolve"),
        )

      for (methods in catalogs) {
        val json = Json { ignoreUnknownKeys = true }
        val hello = CompletableDeferred<GatewayHelloSummary>()
        val server =
          startGatewayServer(json = json) { webSocket, id, method ->
            if (method == "connect") webSocket.send(connectResponseFrame(id, methods))
          }
        val harness = createReconnectHarness(onHello = hello::complete)

        try {
          connectNodeSession(harness.session, server.port)
          assertEquals(methods, withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { hello.await() }.methods)
        } finally {
          shutdownReconnectHarness(harness, server)
        }
      }
    }

  @Test
  fun connectedHelloPublishesServerCapabilities() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val hello = CompletableDeferred<GatewayHelloSummary>()
      val capabilities = setOf("session-unread-ack-contract", "session-scoped-chat-metadata")
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(connectResponseFrame(id, capabilities = capabilities))
          }
        }
      val harness = createReconnectHarness(onHello = hello::complete)

      try {
        connectNodeSession(harness.session, server.port)
        assertEquals(capabilities, withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { hello.await() }.capabilities)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun connectedHelloScopesGlobalSessionsOnlyForTheCurrentConnection() =
    runBlocking {
      for (mainSessionKey in listOf("global", "agent:main:conversation")) {
        val hello = CompletableDeferred<GatewayHelloSummary>()
        val server =
          startGatewayServer(json = Json { ignoreUnknownKeys = true }) { webSocket, id, method ->
            if (method == "connect") webSocket.send(connectResponseFrame(id, mainSessionKey = mainSessionKey, mainKey = "conversation"))
          }
        val harness = createReconnectHarness(onHello = hello::complete)
        try {
          assertNull(harness.session.sessionRouting)
          connectNodeSession(harness.session, server.port)
          assertEquals(mainSessionKey, withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { hello.await() }.mainSessionKey)
          assertEquals(GatewaySessionRouting(mainSessionKey, "conversation"), harness.session.sessionRouting)
          harness.session.disconnectAndJoin()
          assertNull(harness.session.sessionRouting)
        } finally {
          shutdownReconnectHarness(harness, server)
        }
      }
    }

  @Test
  fun connectedHelloKeepsMethodCatalogUnknownWhenHelloOmitsFeatures() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val hello = CompletableDeferred<GatewayHelloSummary>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id, methods = null))
        }
      val harness = createReconnectHarness(onHello = hello::complete)

      try {
        connectNodeSession(harness.session, server.port)
        assertNull(withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { hello.await() }.methods)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun disconnectAndJoinWaitsForNaturalFailureCallback() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val terminalCallbackStarted = CountDownLatch(1)
      val allowTerminalCallback = CountDownLatch(1)
      val blockNextTerminalCallback = AtomicBoolean(true)
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = { connected.complete(Unit) },
          onDisconnected = { message ->
            val shouldBlock =
              message.startsWith("Gateway ") &&
                blockNextTerminalCallback.compareAndSet(true, false)
            if (shouldBlock) {
              terminalCallbackStarted.countDown()
              allowTerminalCallback.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            }
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val connection = readField<Any>(harness.session, "currentConnection")
        val socket = readField<WebSocket>(connection, "socket")
        socket.cancel()
        assertTrue(
          terminalCallbackStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS),
        )

        val disconnect = async { harness.session.disconnectAndJoin() }
        delay(100)
        assertFalse(disconnect.isCompleted)

        allowTerminalCallback.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { disconnect.await() }
      } finally {
        allowTerminalCallback.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun disconnectAndJoinWaitsForTerminalCallback() =
    runBlocking {
      val disconnected = CompletableDeferred<String>()
      val harness = createReconnectHarness(onDisconnected = { disconnected.complete(it) })

      try {
        harness.session.disconnectAndJoin()

        assertEquals("Offline", disconnected.await())
      } finally {
        harness.sessionJob.cancelAndJoin()
      }
    }

  @Test
  fun disconnectAndJoinWaitsForInFlightIssuedTokenPersistence() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val authStore = BlockingSaveDeviceAuthStore()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"issued-token","role":"node","scopes":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
            )
          }
        }
      val harness = createReconnectHarness(deviceAuthStore = authStore)

      try {
        connectNodeSession(harness.session, server.port)
        assertTrue(authStore.saveStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))

        val disconnect = async { harness.session.disconnectAndJoin() }
        delay(100)
        assertFalse(disconnect.isCompleted)

        authStore.allowSave.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { disconnect.await() }
      } finally {
        authStore.allowSave.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun reconnectDoesNotRetireConnectionBeforeIssuedTokenPersistenceFinishes() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val authStore = BlockingSaveDeviceAuthStore()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"issued-token","role":"node","scopes":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
            )
          }
        }
      val harness = createReconnectHarness(deviceAuthStore = authStore)

      try {
        connectNodeSession(harness.session, server.port)
        assertTrue(authStore.saveStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        val connection = readField<Any>(harness.session, "currentConnection")

        harness.session.reconnect()
        delay(200)

        assertTrue(readField<Any?>(harness.session, "currentConnection") === connection)
        authStore.allowSave.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { harness.session.disconnectAndJoin() }
      } finally {
        authStore.allowSave.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun disconnectDrainsConnectionCancelledBeforeInstallation() =
    runBlocking {
      val threads = ManagementFactory.getThreadMXBean()
      val connectingStarted = CountDownLatch(1)
      val allowConstruction = CountDownLatch(1)
      val connectionThread = AtomicReference<Thread?>(null)
      val server =
        startGatewayServer(json = Json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onDisconnected = { message ->
            if (message == "Connecting…") {
              connectionThread.set(Thread.currentThread())
              connectingStarted.countDown()
              check(allowConstruction.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                "Connection construction was not released"
              }
            }
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        assertTrue(connectingStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        val lifecycleLock = readField<Any>(harness.session, "lifecycleLock")
        val previousChildren = harness.sessionJob.children.toSet()
        lateinit var constructedOwner: Job
        lateinit var disconnect: Job
        synchronized(lifecycleLock) {
          val observerThreadId = Thread.currentThread().threadId()
          val connectionThreadId = requireNotNull(connectionThread.get()).threadId()
          val lockIdentity = System.identityHashCode(lifecycleLock)
          val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(LIFECYCLE_TEST_TIMEOUT_MS)
          allowConstruction.countDown()
          var waitingToInstall = false
          // The callback already passed the loop's first lifecycle read. Blocking on this
          // exact monitor now proves construction finished before cancellation retires it.
          while (System.nanoTime() < deadline) {
            val observed = threads.getThreadInfo(connectionThreadId)
            if (
              observed != null &&
              observed.lockOwnerId == observerThreadId &&
              observed.lockInfo?.identityHashCode == lockIdentity
            ) {
              waitingToInstall = true
              break
            }
            Thread.sleep(1)
          }
          assertTrue("The constructed connection must be waiting to install", waitingToInstall)
          constructedOwner = harness.sessionJob.children.single { it !in previousChildren }
          assertTrue(constructedOwner.isActive)
          assertNull(readField<Any?>(harness.session, "currentConnection"))
          harness.session.disconnect()
          disconnect = readField(harness.session, "disconnectTail")
        }

        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { disconnect.join() }
        assertTrue("Disconnect must retire even a connection that never installed", constructedOwner.isCompleted)
        assertEquals(0, server.requestCount)
      } finally {
        allowConstruction.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun retiredDisconnectCleanupCannotOverwriteReplacementConnectionState() =
    runBlocking {
      assertRetiredConnectionCannotOverwriteReplacementState(failTransportBeforeDisconnect = false)
    }

  @Test
  fun retiredTransportFailureCannotOverwriteReplacementConnectionState() =
    runBlocking {
      assertRetiredConnectionCannotOverwriteReplacementState(failTransportBeforeDisconnect = true)
    }

  private suspend fun assertRetiredConnectionCannotOverwriteReplacementState(failTransportBeforeDisconnect: Boolean) {
    val json = Json { ignoreUnknownKeys = true }
    val authStore = BlockingSaveDeviceAuthStore()
    val replacementConnected = CompletableDeferred<Unit>()
    val observedState = AtomicReference("Offline")
    val firstServer =
      startGatewayServer(json = json) { webSocket, id, method ->
        if (method == "connect") {
          webSocket.send(
            """{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"issued-token","role":"node","scopes":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
          )
        }
      }
    val secondServer =
      startGatewayServer(json = json) { webSocket, id, method ->
        when (method) {
          "connect" -> webSocket.send(connectResponseFrame(id))
          "health" -> webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"connection":2}}""")
        }
      }
    val harness =
      createReconnectHarness(
        onConnected = {
          observedState.set("Connected")
          replacementConnected.complete(Unit)
        },
        onDisconnected = observedState::set,
        deviceAuthStore = authStore,
      )

    try {
      connectNodeSession(harness.session, firstServer.port)
      assertTrue(authStore.saveStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
      if (failTransportBeforeDisconnect) {
        val retiredConnection = readField<Any>(harness.session, "currentConnection")
        val terminalClaimed = readField<AtomicBoolean>(retiredConnection, "terminalCallbackClaimed")
        val transportState = readField<AtomicReference<*>>(retiredConnection, "state")
        // Server WebSockets have no client Call for cancel(); shutdown closes the actual peer socket.
        firstServer.shutdown()
        // Observe the real peer failure before disconnect; its callback is still held by token persistence.
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) {
          while (!terminalClaimed.get() || transportState.get().toString() != "CLOSED") {
            delay(10)
          }
        }
      }

      harness.session.disconnect()
      val retiredCleanup = readField<Job>(harness.session, "disconnectTail")
      connectNodeSession(harness.session, secondServer.port)
      withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { replacementConnected.await() }
      assertFalse(retiredCleanup.isCompleted)

      authStore.allowSave.countDown()
      withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { retiredCleanup.join() }
      assertEquals("issued-token", withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { authStore.savedToken.await() })
      assertEquals("""{"connection":2}""", harness.session.request("health", null))
      assertEquals("Connected", observedState.get())
    } finally {
      authStore.allowSave.countDown()
      shutdownReconnectHarness(harness, firstServer, secondServer)
    }
  }

  @Test
  fun retiredAuthenticationFailureCannotPauseReplacementConnection() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val originalFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val replacementConnected = CompletableDeferred<Unit>()
      var currentSession: GatewaySession? = null
      val firstServer =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """{"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"authentication failed","details":{"code":"AUTH_TOKEN_MISMATCH"}}}""",
            )
          }
        }
      val secondServer =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = { replacementConnected.complete(Unit) },
          onConnectFailure = { error, pauseReconnect ->
            if (originalFailure.complete(error to pauseReconnect)) {
              connectNodeSession(checkNotNull(currentSession), secondServer.port)
            }
          },
        )
      currentSession = harness.session

      try {
        connectNodeSession(harness.session, firstServer.port)
        val (error, pauseReconnect) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { originalFailure.await() }
        assertEquals("AUTH_TOKEN_MISMATCH", error.details?.code)
        assertTrue(pauseReconnect)
        assertTrue(
          "The retired authentication failure must not pause the replacement requested by its callback",
          withTimeoutOrNull(LIFECYCLE_TEST_TIMEOUT_MS) { replacementConnected.await() } != null,
        )
      } finally {
        shutdownReconnectHarness(harness, firstServer, secondServer)
      }
    }

  @Test
  fun passwordMissingFromStoredDeviceTokenPausesAndExplicitReconnectSucceeds() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connectFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val secondAttempt = CompletableDeferred<Unit>()
      val reconnected = CompletableDeferred<Unit>()
      val connectAttempts = AtomicInteger()
      val storedToken = "stored-device-token"
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method != "connect") return@startGatewayServer
          when (connectAttempts.incrementAndGet()) {
            1 -> {
              webSocket.send(
                """{"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"gateway password required","details":{"code":"AUTH_PASSWORD_MISSING"}}}""",
              )
            }

            else -> {
              secondAttempt.complete(Unit)
              webSocket.send(connectResponseFrame(id))
            }
          }
        }
      val authStore =
        ReconnectDeviceAuthStore(
          DeviceAuthEntry(
            token = storedToken,
            role = "node",
            scopes = listOf("node:invoke"),
            updatedAtMs = 1,
          ),
        )
      val harness =
        createReconnectHarness(
          onConnected = { reconnected.complete(Unit) },
          deviceAuthStore = authStore,
          onConnectFailure = { error, pauseReconnect ->
            connectFailure.complete(error to pauseReconnect)
          },
        )

      try {
        connectNodeSession(harness.session, server.port, token = null)
        val (error, pauseReconnect) =
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectFailure.await() }
        val desiredConnection = readField<Any>(harness.session, "desired")

        assertEquals("AUTH_PASSWORD_MISSING", error.details?.code)
        assertTrue(pauseReconnect)
        assertTrue(readField<Boolean>(desiredConnection, "reconnectPausedForAuthFailure"))
        val firstAuth =
          server.requestFrames
            .first { it["method"]?.jsonPrimitive?.content == "connect" }
            .getValue("params")
            .jsonObject
            .getValue("auth")
            .jsonObject
        assertEquals(storedToken, firstAuth.getValue("token").jsonPrimitive.content)
        assertNull(firstAuth["deviceToken"])
        assertNull(firstAuth["password"])

        harness.session.retryAfterNetworkRestore()
        assertNull(
          "Terminal authentication failure must suppress automatic reconnects",
          withTimeoutOrNull(LIFECYCLE_TEST_TIMEOUT_MS) { secondAttempt.await() },
        )
        assertTrue(readField<Boolean>(desiredConnection, "reconnectPausedForAuthFailure"))
        assertEquals(1, connectAttempts.get())

        harness.session.reconnect()
        assertFalse(readField<Boolean>(desiredConnection, "reconnectPausedForAuthFailure"))
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondAttempt.await() }
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { reconnected.await() }

        assertEquals(2, connectAttempts.get())
        val reconnectAuth =
          server.requestFrames
            .filter { it["method"]?.jsonPrimitive?.content == "connect" }
            .last()
            .getValue("params")
            .jsonObject
            .getValue("auth")
            .jsonObject
        assertEquals(storedToken, reconnectAuth.getValue("token").jsonPrimitive.content)
        assertNull(reconnectAuth["deviceToken"])
        assertNull(reconnectAuth["password"])
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun failureOrdersDisconnectAfterInFlightHandlerAndAcceptedConnectResponse() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val authStore = RecordingDeviceAuthStore()
      val connectRequestId = CompletableDeferred<String>()
      val blockEventStarted = CountDownLatch(1)
      val allowBlockEvent = CountDownLatch(1)
      val blockEventCompleted = AtomicBoolean()
      val terminalCallback = CompletableDeferred<TerminalCallbackObservation>()
      val allowTerminalCallback = CountDownLatch(1)
      val retiredInvokeCount = AtomicInteger()
      var clientSocket: WebSocket? = null
      val server =
        startGatewayServer(json = json) { _, id, method ->
          if (method == "connect") connectRequestId.complete(id)
        }
      val harness =
        createReconnectHarness(
          onDisconnected = { message ->
            if (message.startsWith("Gateway error:")) {
              terminalCallback.complete(
                TerminalCallbackObservation(
                  inFlightHandlerCompleted = blockEventCompleted.get(),
                  issuedTokenPersisted = authStore.savedToken.isCompleted,
                ),
              )
              allowTerminalCallback.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            }
          },
          deviceAuthStore = authStore,
          onEvent = { event, _ ->
            if (event == "block") {
              blockEventStarted.countDown()
              try {
                allowBlockEvent.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
              } finally {
                blockEventCompleted.set(true)
              }
            }
          },
          onInvoke = {
            retiredInvokeCount.incrementAndGet()
            GatewaySession.InvokeResult.ok("{}")
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        val requestId = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectRequestId.await() }
        val connection = readField<Any>(harness.session, "currentConnection")
        val listener = readField<WebSocketListener>(connection, "listener")
        val socket = readField<WebSocket>(connection, "socket").also { clientSocket = it }
        listener.onMessage(socket, """{"type":"event","event":"block","payload":{}}""")
        assertTrue(blockEventStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        listener.onMessage(
          socket,
          """{"type":"event","event":"node.invoke.request","payload":{"id":"retired-invoke","nodeId":"node-1","command":"notification.action"}}""",
        )
        listener.onMessage(
          socket,
          """{"type":"res","id":"$requestId","ok":true,"payload":{"auth":{"deviceToken":"issued-token","role":"node","scopes":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
        )
        listener.onFailure(socket, IOException("test failure"), null)
        assertNull(withTimeoutOrNull(100) { terminalCallback.await() })

        allowBlockEvent.countDown()

        val observation = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { terminalCallback.await() }
        assertTrue(observation.inFlightHandlerCompleted)
        assertTrue(observation.issuedTokenPersisted)
        assertEquals("issued-token", withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { authStore.savedToken.await() })
        assertEquals(0, retiredInvokeCount.get())
        val messagePumpJob = readField<Job>(connection, "messagePumpJob")
        assertTrue(withTimeoutOrNull(1_000) { messagePumpJob.join() } != null)

        allowTerminalCallback.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { harness.session.disconnectAndJoin() }
      } finally {
        allowBlockEvent.countDown()
        allowTerminalCallback.countDown()
        // The synthetic failure bypasses OkHttp cleanup and lets the session forget this socket.
        clientSocket?.cancel()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun definitelyUnsentNodeEventRemainsQueued() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val rejectedNodeEvent = CompletableDeferred<Unit>()
      val receivedNodeEvent = CompletableDeferred<Unit>()
      val receivedNodeEventCount = AtomicInteger()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
            }

            "node.event" -> {
              receivedNodeEventCount.incrementAndGet()
              receivedNodeEvent.complete(Unit)
              webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{}}""")
            }
          }
        }
      val harness = createReconnectHarness(onConnected = { connected.complete(Unit) })

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val connection = readField<Any>(harness.session, "currentConnection")
        val socketField = connection.javaClass.getDeclaredField("socket").apply { isAccessible = true }
        val socket = socketField.get(connection) as WebSocket
        socketField.set(connection, RejectFirstSendWebSocket(socket) { rejectedNodeEvent.complete(Unit) })
        val outbox =
          NotificationNodeEventOutbox {
            harness.session.sendNodeEventWithOutcome(it.event, it.payloadJson)
          }
        val deliveryJob = launch { outbox.deliver() }

        try {
          outbox.enqueue(PendingNotificationNodeEvent("notifications.changed", "{}"))
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { rejectedNodeEvent.await() }
          outbox.onConnected()
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { receivedNodeEvent.await() }
          delay(100)
          assertEquals(1, receivedNodeEventCount.get())
        } finally {
          deliveryJob.cancelAndJoin()
        }
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun connectedCallbackFailureClosesSocketBeforeRetry() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val firstClosed = CompletableDeferred<Unit>()
      val secondConnected = CompletableDeferred<Unit>()
      val callbackCount = AtomicInteger()
      val server =
        startGatewayServer(
          json = json,
          onClosed = { firstClosed.complete(Unit) },
        ) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = {
            if (callbackCount.incrementAndGet() == 1) {
              throw IllegalStateException("callback failed")
            }
            secondConnected.complete(Unit)
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstClosed.await() }
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondConnected.await() }
        assertEquals(2, callbackCount.get())
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun staleConnectionDrainCannotCancelReplacementRpc() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val firstConnected = CompletableDeferred<Unit>()
      val secondConnected = CompletableDeferred<Unit>()
      val replacementRequest = CompletableDeferred<Pair<WebSocket, String>>()
      val connectionCount = AtomicInteger(0)
      val firstServer =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val secondServer =
        startGatewayServer(json = json) { webSocket, id, method ->
          when (method) {
            "connect" -> webSocket.send(connectResponseFrame(id))
            "slow.method" -> replacementRequest.complete(webSocket to id)
          }
        }
      val harness =
        createReconnectHarness(
          onConnected = {
            when (connectionCount.incrementAndGet()) {
              1 -> firstConnected.complete(Unit)
              2 -> secondConnected.complete(Unit)
            }
          },
        )

      try {
        connectNodeSession(harness.session, firstServer.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstConnected.await() }
        val oldConnection = readField<Any>(harness.session, "currentConnection")

        connectNodeSession(harness.session, secondServer.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondConnected.await() }
        val newRequest =
          async {
            harness.session.requestDetailed("slow.method", null, timeoutMs = 30_000)
          }
        val (replacementSocket, requestId) =
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { replacementRequest.await() }

        val failPending = oldConnection.javaClass.getDeclaredMethod("failPending")
        failPending.isAccessible = true
        failPending.invoke(oldConnection)

        assertNull(withTimeoutOrNull(200) { newRequest.await() })
        replacementSocket.send(
          """{"type":"res","id":"$requestId","ok":true,"payload":{"connection":2}}""",
        )
        val newResult = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { newRequest.await() }
        assertTrue(newResult.ok)
        assertEquals("""{"connection":2}""", newResult.payloadJson)
      } finally {
        shutdownReconnectHarness(harness, firstServer, secondServer)
      }
    }

  @Suppress("UNCHECKED_CAST")
  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    return field.get(target) as T
  }

  @Test
  fun connectToNewGatewayClosesActiveConnectionAndStartsReplacement() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val firstConnect = CompletableDeferred<Unit>()
      val firstClosed = CompletableDeferred<Unit>()
      val secondConnect = CompletableDeferred<Unit>()
      val secondClosed = CompletableDeferred<Unit>()
      val firstServer =
        startGatewayServer(
          json = json,
          onClosed = { firstClosed.complete(Unit) },
        ) { webSocket, id, method ->
          if (method == "connect") {
            firstConnect.complete(Unit)
            webSocket.send(connectResponseFrame(id))
          }
        }
      val secondServer =
        startGatewayServer(
          json = json,
          onClosed = { secondClosed.complete(Unit) },
        ) { webSocket, id, method ->
          if (method == "connect") {
            secondConnect.complete(Unit)
            webSocket.send(connectResponseFrame(id))
          }
        }
      val harness = createReconnectHarness()

      try {
        connectNodeSession(harness.session, firstServer.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstConnect.await() }

        connectNodeSession(harness.session, secondServer.port)

        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstClosed.await() }
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondConnect.await() }
        assertEquals(1, secondServer.requestCount)
        harness.session.disconnect()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondClosed.await() }
      } finally {
        shutdownReconnectHarness(harness, firstServer, secondServer)
      }
    }

  @Test
  fun bootstrapNodePairingRequiredKeepsReconnectActive() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            pauseReconnect = false,
            reason = "not-paired",
          ),
      )

    assertFalse(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun bootstrapNodePairingRequiredWithoutRetryHintPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            reason = "not-paired",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun nonBootstrapPairingRequiredStillPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            reason = "not-paired",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun tokenFailuresPauseUnlessOneDeviceTokenRetryIsPending() {
    val cases =
      listOf(
        Triple("AUTH_TOKEN_MISMATCH", false, true),
        Triple("AUTH_TOKEN_MISMATCH", true, false),
        Triple("AUTH_DEVICE_TOKEN_MISMATCH", false, true),
        Triple("AUTH_TOKEN_NOT_CONFIGURED", false, true),
        Triple("AUTH_PASSWORD_MISSING", false, true),
        Triple("AUTH_PASSWORD_NOT_CONFIGURED", false, true),
        Triple("AUTH_SCOPE_MISMATCH", false, true),
        Triple("AUTH_VERIFIED_USER_REQUIRED", false, true),
      )

    for ((code, pendingDeviceTokenRetry, expected) in cases) {
      val error =
        GatewaySession.ErrorShape(
          code = "INVALID_REQUEST",
          message = "authentication failed",
          details =
            GatewayErrorDetails(
              code = code,
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
            ),
        )
      val actual =
        shouldPauseGatewayReconnectAfterAuthFailure(
          error = error,
          hasBootstrapToken = false,
          role = "operator",
          scopes = listOf("operator.read"),
          pendingDeviceTokenRetry = pendingDeviceTokenRetry,
        )

      assertEquals("$code pending=$pendingDeviceTokenRetry", expected, actual)
    }
  }

  @Test
  fun structuredRecoveryAdviceControlsReconnectPause() {
    val cases =
      listOf(
        Triple("wait_then_retry", false, false),
        Triple("retry_with_device_token", true, false),
        Triple("retry_with_device_token", false, true),
        Triple("update_auth_configuration", false, true),
        Triple("update_auth_credentials", false, true),
        Triple("review_auth_configuration", false, true),
      )

    for ((nextStep, pendingDeviceTokenRetry, expected) in cases) {
      val error =
        GatewaySession.ErrorShape(
          code = "INVALID_REQUEST",
          message = "authentication failed",
          details =
            GatewayErrorDetails(
              code = "AUTH_UNAUTHORIZED",
              canRetryWithDeviceToken = nextStep == "retry_with_device_token",
              recommendedNextStep = nextStep,
            ),
        )
      val actual =
        shouldPauseGatewayReconnectAfterAuthFailure(
          error = error,
          hasBootstrapToken = false,
          role = "operator",
          scopes = listOf("operator.read"),
          pendingDeviceTokenRetry = pendingDeviceTokenRetry,
        )

      assertEquals("$nextStep pending=$pendingDeviceTokenRetry", expected, actual)
    }
  }

  @Test
  fun authRateLimitPausesDespiteRetryAdvice() {
    val error =
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "authentication rate limited",
        details =
          GatewayErrorDetails(
            code = "AUTH_RATE_LIMITED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "operator",
        scopes = listOf("operator.read"),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun protocolMismatchPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "protocol mismatch",
        details =
          GatewayErrorDetails(
            code = "PROTOCOL_MISMATCH",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            clientMinProtocol = 4,
            clientMaxProtocol = 4,
            expectedProtocol = 5,
            minimumProbeProtocol = 4,
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun bootstrapRoleUpgradeStillPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            reason = "role-upgrade",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun pairingRequiredFailureNotifiesPauseReconnectProblem() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connectFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """
              {"type":"res","id":"$id","ok":false,"error":{"code":"NOT_PAIRED","message":"pairing required: device approval is required","details":{"code":"PAIRING_REQUIRED","reason":"not-paired","requestId":"request-1"}}}
              """.trimIndent(),
            )
          }
        }
      val harness =
        createReconnectHarness { error, pauseReconnect ->
          connectFailure.complete(error to pauseReconnect)
        }

      try {
        connectNodeSession(harness.session, server.port)
        val (error, pauseReconnect) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectFailure.await() }

        assertEquals("PAIRING_REQUIRED", error.details?.code)
        assertEquals("not-paired", error.details?.reason)
        assertEquals("request-1", error.details?.requestId)
        assertTrue(pauseReconnect)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun pairingRequiredFailureDropsUnsafeRequestId() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connectFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """
              {"type":"res","id":"$id","ok":false,"error":{"code":"NOT_PAIRED","message":"pairing required: device approval is required","details":{"code":"PAIRING_REQUIRED","reason":"not-paired","requestId":"request-1;echo unsafe"}}}
              """.trimIndent(),
            )
          }
        }
      val harness =
        createReconnectHarness { error, pauseReconnect ->
          connectFailure.complete(error to pauseReconnect)
        }

      try {
        connectNodeSession(harness.session, server.port)
        val (error, pauseReconnect) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectFailure.await() }

        assertEquals("PAIRING_REQUIRED", error.details?.code)
        assertEquals("not-paired", error.details?.reason)
        assertNull(error.details?.requestId)
        assertTrue(pauseReconnect)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun protocolMismatchFailurePreservesProtocolDetailsAndPausesReconnect() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connectFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """
              {"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"protocol mismatch","details":{"code":"PROTOCOL_MISMATCH","clientMinProtocol":4,"clientMaxProtocol":4,"expectedProtocol":5,"minimumProbeProtocol":4}}}
              """.trimIndent(),
            )
          }
        }
      val harness =
        createReconnectHarness { error, pauseReconnect ->
          connectFailure.complete(error to pauseReconnect)
        }

      try {
        connectNodeSession(harness.session, server.port)
        val (error, pauseReconnect) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectFailure.await() }

        assertEquals("PROTOCOL_MISMATCH", error.details?.code)
        assertEquals(4, error.details?.clientMinProtocol)
        assertEquals(4, error.details?.clientMaxProtocol)
        assertEquals(5, error.details?.expectedProtocol)
        assertEquals(4, error.details?.minimumProbeProtocol)
        assertTrue(pauseReconnect)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun methodFailurePreservesMissingScopeDetails() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
            }

            "question.list" -> {
              webSocket.send(
                """
                {"type":"res","id":"$id","ok":false,"error":{"code":"FORBIDDEN","message":"permission denied","details":{"code":"MISSING_SCOPE","missingScope":"operator.questions","requiredScopes":["operator.questions"]}}}
                """.trimIndent(),
              )
            }
          }
        }
      val harness = createReconnectHarness(onConnected = { connected.complete(Unit) })

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }

        val result = harness.session.requestDetailed("question.list", "{}")

        assertFalse(result.ok)
        assertEquals("MISSING_SCOPE", result.error?.details?.code)
        assertEquals("operator.questions", result.error?.details?.missingScope)
        assertEquals(listOf("operator.questions"), result.error?.details?.requiredScopes)
        assertEquals("operator.questions", result.error?.missingScope())
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  private fun createReconnectHarness(
    onConnected: () -> Unit = {},
    onHello: (GatewayHelloSummary) -> Unit = {},
    onDisconnected: (String) -> Unit = {},
    deviceAuthStore: DeviceAuthTokenStore = ReconnectDeviceAuthStore(),
    onEvent: (String, String?) -> Unit = { _, _ -> },
    onInvoke: suspend (GatewaySession.InvokeRequest) -> GatewaySession.InvokeResult = {
      GatewaySession.InvokeResult.ok("""{"handled":true}""")
    },
    onConnectFailure: (GatewaySession.ErrorShape, Boolean) -> Unit = { _, _ -> },
  ): ReconnectHarness {
    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = testDeviceIdentityStore(app),
        deviceAuthStore = deviceAuthStore,
        onConnected = { summary ->
          onConnected()
          onHello(summary)
        },
        onDisconnected = onDisconnected,
        onConnectFailure = onConnectFailure,
        onEvent = onEvent,
        onInvoke = onInvoke,
      )
    return ReconnectHarness(session = session, sessionJob = sessionJob)
  }

  private fun connectNodeSession(
    session: GatewaySession,
    port: Int,
    token: String? = "test-token",
  ) {
    session.connect(
      endpoint =
        GatewayEndpoint(
          stableId = "manual|127.0.0.1|$port",
          name = "test",
          host = "127.0.0.1",
          port = port,
          tlsEnabled = false,
        ),
      token = token,
      bootstrapToken = null,
      password = null,
      options =
        GatewayConnectOptions(
          role = "node",
          scopes = listOf("node:invoke"),
          caps = emptyList(),
          commands = emptyList(),
          permissions = emptyMap(),
          client =
            GatewayClientInfo(
              id = "openclaw-android-test",
              displayName = "Android Test",
              version = "1.0.0-test",
              platform = "android",
              mode = "node",
              instanceId = "android-test-instance",
              deviceFamily = "android",
              modelIdentifier = "test",
            ),
        ),
      tls = null,
    )
  }

  private suspend fun shutdownReconnectHarness(
    harness: ReconnectHarness,
    vararg servers: ReconnectServer,
  ) {
    val failures = mutableListOf<Throwable>()
    runCatching { harness.session.disconnectAndJoin() }.exceptionOrNull()?.let(failures::add)
    runCatching { harness.sessionJob.cancelAndJoin() }.exceptionOrNull()?.let(failures::add)
    servers.forEach { server ->
      runCatching { server.shutdown() }.exceptionOrNull()?.let(failures::add)
    }
    failures.firstOrNull()?.let { failure ->
      failures.drop(1).forEach(failure::addSuppressed)
      throw failure
    }
  }

  private fun connectResponseFrame(
    id: String,
    methods: Set<String>? = emptySet(),
    capabilities: Set<String> = emptySet(),
    mainSessionKey: String = "main",
    mainKey: String = "main",
  ): String {
    val encodedMainSessionKey = JsonPrimitive(mainSessionKey)
    val encodedMainKey = JsonPrimitive(mainKey)
    if (methods == null) {
      return """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":$encodedMainSessionKey,"mainKey":$encodedMainKey}}}}"""
    }
    val encodedMethods = methods.joinToString(",") { JsonPrimitive(it).toString() }
    val encodedCapabilities = capabilities.joinToString(",") { JsonPrimitive(it).toString() }
    return """{"type":"res","id":"$id","ok":true,"payload":{"features":{"methods":[$encodedMethods],"capabilities":[$encodedCapabilities]},"snapshot":{"sessionDefaults":{"mainSessionKey":$encodedMainSessionKey,"mainKey":$encodedMainKey}}}}"""
  }

  private fun startGatewayServer(
    json: Json,
    onClosed: () -> Unit = {},
    onRequestFrame: (webSocket: WebSocket, id: String, method: String) -> Unit,
  ): ReconnectServer {
    val sockets = ConcurrentLinkedQueue<WebSocket>()
    val requestFrames = ConcurrentLinkedQueue<JsonObject>()
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    sockets += webSocket
                    webSocket.send(LIFECYCLE_CONNECT_CHALLENGE_FRAME)
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = json.parseToJsonElement(text).jsonObject
                    requestFrames += frame
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val method = frame["method"]?.jsonPrimitive?.content ?: return
                    onRequestFrame(webSocket, id, method)
                  }

                  override fun onClosing(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    // Acknowledge the peer so MockWebServer can close both streams and drain its queue.
                    webSocket.close(code, reason)
                  }

                  override fun onClosed(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    onClosed()
                  }

                  override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                  ) {
                    onClosed()
                  }
                },
              )
          }
        start()
      }
    return ReconnectServer(
      server = server,
      sockets = sockets,
      requestFrames = requestFrames,
    )
  }
}

private class RejectFirstSendWebSocket(
  private val delegate: WebSocket,
  private val onReject: () -> Unit,
) : WebSocket by delegate {
  private var rejectNext = true

  override fun send(text: String): Boolean {
    if (rejectNext) {
      rejectNext = false
      onReject()
      return false
    }
    return delegate.send(text)
  }

  override fun send(bytes: ByteString): Boolean = delegate.send(bytes)

  override fun request(): Request = delegate.request()
}
