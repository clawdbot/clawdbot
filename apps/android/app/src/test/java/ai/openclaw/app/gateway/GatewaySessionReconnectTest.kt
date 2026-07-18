package ai.openclaw.app.gateway

import ai.openclaw.app.NotificationNodeEventOutbox
import ai.openclaw.app.PendingNotificationNodeEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

private const val LIFECYCLE_TEST_TIMEOUT_MS = 8_000L
private const val LIFECYCLE_CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}"""

private class ReconnectDeviceAuthStore : DeviceAuthTokenStore {
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
) {
  val port: Int
    get() = server.port

  val requestCount: Int
    get() = server.requestCount

  fun shutdown() {
    sockets.forEach { runCatching { it.cancel() } }
    runCatching { server.shutdown() }
      .onFailure { err ->
        if (err.message != "Gave up waiting for queue to shut down") throw err
      }
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionReconnectTest {
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
        val listener = readField<WebSocketListener>(connection, "listener")
        val socket = readField<WebSocket>(connection, "socket")
        val failure =
          launch(Dispatchers.IO) {
            listener.onFailure(socket, IOException("test failure"), null)
          }
        assertTrue(
          terminalCallbackStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS),
        )

        val disconnect = async { harness.session.disconnectAndJoin() }
        delay(100)
        assertFalse(disconnect.isCompleted)

        allowTerminalCallback.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { disconnect.await() }
        failure.join()
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
        val socket = readField<WebSocket>(connection, "socket")
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
            "connect" -> webSocket.send(connectResponseFrame(id))
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
          GatewayConnectErrorDetails(
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
          GatewayConnectErrorDetails(
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
          GatewayConnectErrorDetails(
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
        Triple("AUTH_PASSWORD_NOT_CONFIGURED", false, true),
        Triple("AUTH_SCOPE_MISMATCH", false, true),
      )

    for ((code, pendingDeviceTokenRetry, expected) in cases) {
      val error =
        GatewaySession.ErrorShape(
          code = "INVALID_REQUEST",
          message = "authentication failed",
          details =
            GatewayConnectErrorDetails(
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
            GatewayConnectErrorDetails(
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
          GatewayConnectErrorDetails(
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
          GatewayConnectErrorDetails(
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
          GatewayConnectErrorDetails(
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
        identityStore = DeviceIdentityStore(app),
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

  private suspend fun connectNodeSession(
    session: GatewaySession,
    port: Int,
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
      token = "test-token",
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
    harness.session.disconnect()
    harness.sessionJob.cancelAndJoin()
    servers.forEach { it.shutdown() }
  }

  private fun connectResponseFrame(
    id: String,
    methods: Set<String> = emptySet(),
  ): String {
    val encodedMethods = methods.joinToString(",") { JsonPrimitive(it).toString() }
    return """{"type":"res","id":"$id","ok":true,"payload":{"features":{"methods":[$encodedMethods]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}"""
  }

  private fun startGatewayServer(
    json: Json,
    onClosed: () -> Unit = {},
    onRequestFrame: (webSocket: WebSocket, id: String, method: String) -> Unit,
  ): ReconnectServer {
    val sockets = ConcurrentLinkedQueue<WebSocket>()
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
                    onClosed()
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
    return ReconnectServer(server = server, sockets = sockets)
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
