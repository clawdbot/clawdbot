package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.ChatWidgetUrlResolver
import ai.openclaw.app.node.NodeHostStatsReporter
import android.content.Context
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ThreadContextElement
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

private const val TEST_TIMEOUT_MS = 8_000L
private const val CONNECT_CHALLENGE_TS = 1_700_000_000_123L
private const val CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce","ts":$CONNECT_CHALLENGE_TS}}"""

private class InMemoryDeviceAuthStore : DeviceAuthTokenStore {
  private val tokens = mutableMapOf<String, DeviceAuthEntry>()
  private val lock = Any()
  var saveResult: (String, String) -> Boolean = { _, _ -> true }

  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = synchronized(lock) { tokens["${gatewayId.trim()}|${deviceId.trim()}|${role.trim()}"] }

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
    replacesStoredToken: String?,
  ): Boolean =
    synchronized(lock) {
      if (replacesStoredToken != null && loadEntry(gatewayId, deviceId, role)?.token != replacesStoredToken.trim()) {
        return@synchronized false
      }
      if (!saveResult(role, token)) return@synchronized false
      tokens["${gatewayId.trim()}|${deviceId.trim()}|${role.trim()}"] =
        DeviceAuthEntry(
          token = token.trim(),
          role = role.trim(),
          scopes = scopes,
          updatedAtMs = System.currentTimeMillis(),
        )
      true
    }

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    onlyIfToken: String?,
  ) {
    synchronized(lock) {
      if (onlyIfToken != null && loadEntry(gatewayId, deviceId, role)?.token != onlyIfToken.trim()) return
      tokens.remove("${gatewayId.trim()}|${deviceId.trim()}|${role.trim()}")
    }
  }
}

private class RpcCallbackEntryGate :
  AbstractCoroutineContextElement(Key),
  ThreadContextElement<Job?> {
  companion object Key : CoroutineContext.Key<RpcCallbackEntryGate>

  val currentJob = ThreadLocal<Job?>()
  val select = AtomicReference<(Job) -> Boolean> { false }
  val paused = CompletableDeferred<Job>()
  val release = CountDownLatch(1)
  val released = CompletableDeferred<Boolean>()
  private val claimed = AtomicBoolean(false)

  override fun updateThreadContext(context: CoroutineContext): Job? {
    val previous = currentJob.get()
    val job = context[Job]
    currentJob.set(job)
    if (job != null && select.get()(job) && claimed.compareAndSet(false, true)) {
      paused.complete(job)
      val opened =
        try {
          release.await(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          false
        }
      released.complete(opened)
    }
    return previous
  }

  override fun restoreThreadContext(
    context: CoroutineContext,
    oldState: Job?,
  ) {
    currentJob.set(oldState)
  }
}

private data class NodeHarness(
  val session: GatewaySession,
  val sessionJob: Job,
  val deviceAuthStore: DeviceAuthTokenStore,
)

private data class InvokeScenarioResult(
  val request: GatewaySession.InvokeRequest,
  val resultParams: JsonObject,
)

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionInvokeTest {
  @Test
  fun connect_usesGatewayChallengeTimestamp() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          if (method == "connect") {
            assertEquals(
              CONNECT_CHALLENGE_TS,
              frame["params"]
                ?.jsonObject
                ?.get("device")
                ?.jsonObject
                ?.get("signedAt")
                ?.jsonPrimitive
                ?.content
                ?.toLong(),
            )
            webSocket.send(connectResponseFrame(id))
          }
        }
      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun connect_rejectsChallengeWithoutTimestamp() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val lastDisconnect = AtomicReference("")
      val connectRequests = AtomicInteger()
      val server =
        startGatewayServer(
          json = json,
          challengeFrame =
            """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}""",
        ) { _, _, method, _ ->
          if (method == "connect") connectRequests.incrementAndGet()
        }
      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(TEST_TIMEOUT_MS) {
          while (lastDisconnect.get().isEmpty()) delay(10)
        }
        assertFalse(connected.isCompleted)
        assertEquals(0, connectRequests.get())
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun canvasRoutePinsOnlyTheConnectedTlsEndpoint() {
    val fingerprint = "ab".repeat(32)

    data class RouteCase(
      val host: String,
      val surfaceOrigin: String,
      val matches: Boolean,
      val port: Int = 7443,
      val tls: Boolean = true,
      val pin: String? = fingerprint,
    )
    val cases =
      listOf(
        RouteCase("gateway.example", "https://gateway.example:7443", true),
        RouteCase("GATEWAY.example.", "https://gateway.EXAMPLE:7443", true),
        RouteCase(" gateway.example. ", "https://gateway.example.:7443", true),
        RouteCase("gateway.example", "https://gateway.example", true, port = 443),
        RouteCase("192.0.2.10", "https://192.0.2.10:7443", true),
        RouteCase("[2001:db8::10]", "https://[2001:db8::10]:7443", true),
        RouteCase("gateway.example", "https://canvas.example:7443", false),
        RouteCase("gateway.example", "https://gateway.example:9443", false),
        RouteCase("gateway.example", "http://gateway.example:7443", false),
        RouteCase("localhost", "https://127.0.0.1:7443", false),
        RouteCase("bücher.example", "https://xn--bcher-kva.example:7443", false),
        RouteCase("192.0.2.10", "https://192.0.2.11:7443", false),
        RouteCase("2001:db8::10", "https://[2001:db8::11]:7443", false),
        RouteCase("::ffff:192.0.2.10", "https://192.0.2.11:7443", false),
        RouteCase("gateway.example", "https://gateway.example:7443", false, tls = false),
        RouteCase("gateway.example", "https://gateway.example:7443", false, pin = null),
        RouteCase("::ffff:192.0.2.10", "https://192.0.2.10:7443", true),
        RouteCase("192.0.2.10", "https://[::ffff:192.0.2.10]:7443", true),
        RouteCase("2001:db8::10", "https://[2001:db8::10]:7443", true),
        RouteCase("2001:0db8:0:0:0:0:0:10", "https://[2001:db8::10]:7443", true),
      )
    for (case in cases) {
      assertEquals(
        "Gateway ${case.host}:${case.port}, surface ${case.surfaceOrigin}",
        fingerprint.takeIf { case.matches },
        gatewayTlsFingerprintForCanvasSurface(
          fingerprint = case.pin,
          surfaceUrl = "${case.surfaceOrigin}/__openclaw__/cap/token",
          endpoint = GatewayEndpoint.manual(host = case.host, port = case.port),
          isTlsConnection = case.tls,
        ),
      )
    }
  }

  @Test
  fun refreshCanvasHostUrl_usesNodeRefreshMethod() =
    runBlocking {
      for (contextPath in listOf("", "/tenant%20gateway/gw", "/tenant%2Fgateway", "//tenant/gw", "/__openclaw__")) {
        assertCanvasHostRefreshMethod(role = "node", expectedMethod = "node.pluginSurface.refresh", contextPath = contextPath)
      }
    }

  @Test
  fun refreshCanvasHostUrl_usesOperatorRefreshMethod() =
    runBlocking {
      for (contextPath in listOf("", "/tenant%20gateway/gw", "/tenant%2Fgateway", "//tenant/gw", "/__openclaw__")) {
        assertCanvasHostRefreshMethod(role = "operator", expectedMethod = "plugin.surface.refresh", contextPath = contextPath)
      }
    }

  private suspend fun assertCanvasHostRefreshMethod(
    role: String,
    expectedMethod: String,
    contextPath: String,
  ) {
    val json = testJson()
    val connected = CompletableDeferred<Unit>()
    val lastDisconnect = AtomicReference("")
    val refreshRequests = AtomicInteger()
    val documentPath = "/__openclaw__/canvas/documents/widget-1/index.html"
    val documentBody = "<html><body>Gateway widget</body></html>"
    val documentPaths =
      listOf("old-token", "new-token").map { "$contextPath/__openclaw__/cap/$it$documentPath" }
    val activeDocumentPath = AtomicReference(documentPaths.first())
    val requestedPaths = CopyOnWriteArrayList<String>()
    val httpClient = OkHttpClient()

    fun loadDocument(surfaceUrl: String): Pair<Int, String> {
      val url = requireNotNull(ChatWidgetUrlResolver.resolve(surfaceUrl, documentPath))
      return httpClient.newCall(Request.Builder().url(url).build()).execute().use { response ->
        response.code to response.body.string()
      }
    }
    val server =
      startGatewayServer(
        json,
        onHandshake = { assertEquals(contextPath.ifEmpty { "/" }, it.path) },
        onHttpRequest = { request ->
          val path = requireNotNull(request.path)
          requestedPaths.add(path)
          assertNull(request.getHeader("Authorization"))
          if (path == activeDocumentPath.get()) {
            MockResponse().setHeader("Content-Type", "text/html").setBody(documentBody)
          } else {
            MockResponse().setResponseCode(404)
          }
        },
      ) { webSocket, id, method, frame ->
        when (method) {
          "connect" -> {
            webSocket.send(
              connectResponseFrame(
                id,
                pluginSurfaceUrls =
                  mapOf("canvas" to "http://127.0.0.1:18789/__openclaw__/cap/old-token"),
              ),
            )
          }

          expectedMethod -> {
            refreshRequests.incrementAndGet()
            activeDocumentPath.set(documentPaths.last())
            assertEquals(
              "canvas",
              frame["params"]
                ?.jsonObject
                ?.get("surface")
                ?.jsonPrimitive
                ?.content,
            )
            assertTrue(
              frame["params"]
                ?.jsonObject
                ?.get("observedUrl")
                ?.jsonPrimitive
                ?.content
                ?.endsWith("/old-token") == true,
            )
            webSocket.send(
              """{"type":"res","id":"$id","ok":true,"payload":{"surface":"canvas","pluginSurfaceUrls":{"canvas":"http://127.0.0.1:18789/__openclaw__/cap/new-token"}}}""",
            )
          }
        }
      }
    val harness =
      createNodeHarness(connected = connected, lastDisconnect = lastDisconnect) {
        GatewaySession.InvokeResult.ok("""{"handled":true}""")
      }

    try {
      connectNodeSession(
        session = harness.session,
        port = server.port,
        role = role,
        scopes = if (role == "operator") listOf("operator.read") else listOf("node:invoke"),
        contextPath = contextPath,
      )
      awaitConnectedOrThrow(connected, lastDisconnect, server)
      val oldUrl = requireNotNull(harness.session.currentCanvasHostUrl())
      val beforeRefresh = loadDocument(oldUrl)
      val refreshed = harness.session.refreshCanvasHostUrlIfCurrent(oldUrl)
      val lagging = harness.session.refreshCanvasHostUrlIfCurrent(oldUrl)
      val afterRefresh = loadDocument(requireNotNull(refreshed))
      val expiredDocument = loadDocument(oldUrl)
      val responses = listOf(beforeRefresh, afterRefresh)

      assertEquals("hello and refresh document responses for $role at $contextPath; paths=$requestedPaths", listOf(200 to documentBody, 200 to documentBody), responses)
      assertEquals(documentPaths + documentPaths.first(), requestedPaths)
      assertEquals(404, expiredDocument.first)
      assertTrue(oldUrl.endsWith("/old-token"))
      assertTrue(refreshed.endsWith("/new-token"))
      assertEquals(refreshed, harness.session.currentCanvasHostUrl())
      assertEquals(refreshed, lagging)
      assertEquals(1, refreshRequests.get())
    } finally {
      httpClient.connectionPool.evictAll()
      httpClient.dispatcher.executorService.shutdown()
      shutdownHarness(harness, server)
    }
  }

  @Test
  fun refreshCanvasHostUrl_preservesExplicitSurfaceRoutes() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val lastDisconnect = AtomicReference("")
      val contextPath = "/tenant%20gateway/gw"
      val capabilityPath = "/__openclaw__/cap/token"
      val advertised = AtomicReference("https://canvas.example:9443$capabilityPath")
      val server =
        startGatewayServer(json) { webSocket, id, method, _ ->
          if (method == "connect") {
            webSocket.send(connectResponseFrame(id, pluginSurfaceUrls = mapOf("canvas" to advertised.get())))
          } else if (method == "plugin.surface.refresh") {
            webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"pluginSurfaceUrls":{"canvas":"${advertised.get()}"}}}""")
          }
        }
      val harness = createNodeHarness(connected, lastDisconnect) { GatewaySession.InvokeResult.ok(null) }
      try {
        connectNodeSession(harness.session, server.port, role = "operator", scopes = listOf("operator.read"), contextPath = contextPath)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
        assertEquals(advertised.get(), harness.session.currentCanvasHostUrl())
        val origin = "http://127.0.0.1:${server.port}"
        val explicitRoutes =
          listOf(
            "https://canvas.example:9443$capabilityPath",
            "https://CANVAS.example.:443$capabilityPath",
            "http://CANVAS.example.:80$capabilityPath",
            "http://canvas.example:${server.port}$capabilityPath",
            "$origin$contextPath$capabilityPath",
            "$origin/custom$capabilityPath",
            "$origin$capabilityPath?variant=raw%2Fvalue",
            "$origin$capabilityPath#fragment",
            "$origin/__openclaw__/cap/",
            "$origin/__openclaw__/canvas/documents/widget/index.html",
          )
        for (route in explicitRoutes) {
          advertised.set(route)
          assertEquals(route, harness.session.refreshCanvasHostUrl())
        }
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun connect_advertisesCompatibleProtocolRange() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val connectParams = CompletableDeferred<JsonObject>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          when (method) {
            "connect" -> {
              if (!connectParams.isCompleted) {
                connectParams.complete(frame["params"]!!.jsonObject)
              }
              webSocket.send(connectResponseFrame(id))
              webSocket.close(1000, "done")
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val params = withTimeout(TEST_TIMEOUT_MS) { connectParams.await() }
        assertEquals(
          GATEWAY_MIN_PROTOCOL_VERSION,
          params["minProtocol"]?.jsonPrimitive?.content?.toInt(),
        )
        assertEquals(
          GATEWAY_PROTOCOL_VERSION,
          params["maxProtocol"]?.jsonPrimitive?.content?.toInt(),
        )
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun disconnectFailsPendingRpcWithUnknownOutcomeWithoutWaitingForTimeout() {
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val slowRequestSeen = CompletableDeferred<Unit>()
      val requestResult = CompletableDeferred<Result<GatewaySession.RpcResult>>()
      val lastDisconnect = AtomicReference("")
      val serverWebSocket = AtomicReference<WebSocket?>(null)
      val server =
        startGatewayServer(json) { webSocket, id, method, _ ->
          serverWebSocket.set(webSocket)
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
            }

            "slow.method" -> {
              if (!slowRequestSeen.isCompleted) slowRequestSeen.complete(Unit)
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }
      var requestJob: Job? = null

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
        requestJob =
          launch {
            requestResult.complete(
              runCatching {
                harness.session.requestDetailed("slow.method", null, timeoutMs = 30_000)
              },
            )
          }
        withTimeout(TEST_TIMEOUT_MS) { slowRequestSeen.await() }

        harness.session.disconnect()

        val result = withTimeout(2_000) { requestResult.await() }
        assertEquals(true, result.exceptionOrNull() is GatewayRequestOutcomeUnknown)
        serverWebSocket.get()?.close(1000, "done")
        withTimeoutOrNull(2_000) {
          while (lastDisconnect.get().isEmpty()) delay(10)
        }
      } finally {
        requestJob?.cancelAndJoin()
        runCatching { serverWebSocket.get()?.close(1000, "done") }
        delay(100)
        harness.session.disconnect()
        harness.sessionJob.cancelAndJoin()
        server.shutdown()
      }
    }
  }

  @Test
  fun disconnectReportsFireAndForgetErrorsAfterAcceptedFramesDrain() =
    runBlocking {
      for (peerRejects in listOf(false, true)) {
        val json = testJson()
        val connected = CompletableDeferred<Unit>()
        val requestSeen = CompletableDeferred<Pair<WebSocket, String>>()
        val errors = CopyOnWriteArrayList<GatewaySession.ErrorShape>()
        val entryGate = RpcCallbackEntryGate()
        val responsePumpHeld = CompletableDeferred<Job?>()
        val releaseResponsePump = CountDownLatch(1)
        val responsePumpReleased = CompletableDeferred<Boolean>()
        val lastDisconnect = AtomicReference("")
        val serverWebSocket = AtomicReference<WebSocket?>(null)
        val server =
          startGatewayServer(json) { webSocket, id, method, _ ->
            serverWebSocket.set(webSocket)
            when (method) {
              "connect" -> webSocket.send(connectResponseFrame(id))
              "fire.and.forget" -> requestSeen.complete(webSocket to id)
            }
          }
        val harness =
          createNodeHarness(
            connected = connected,
            lastDisconnect = lastDisconnect,
            extraContext = entryGate,
            onEvent = { event, _ ->
              if (event == "test.block.responses") {
                responsePumpHeld.complete(entryGate.currentJob.get())
                responsePumpReleased.complete(releaseResponsePump.await(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
              }
            },
          ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }
        try {
          connectNodeSession(harness.session, server.port)
          awaitConnectedOrThrow(connected, lastDisconnect, server)
          val lease = requireNotNull(harness.session.captureRequestLease())
          assertTrue(
            requireNotNull(serverWebSocket.get()).send("""{"type":"event","event":"test.block.responses","payload":{}}"""),
          )
          val pump = requireNotNull(withTimeout(TEST_TIMEOUT_MS) { responsePumpHeld.await() })
          // Locate the waiter only to schedule this race; the assertions below use the public result and join.
          val connectionOwner = harness.sessionJob.children.single { owner -> owner.children.any { it === pump } }
          val previousChildren = connectionOwner.children.toSet()
          entryGate.select.set { candidate ->
            candidate !in previousChildren && connectionOwner.children.any { it === candidate }
          }
          harness.session.sendRequestFrame(
            method = "fire.and.forget",
            paramsJson = null,
            timeoutMs = 30_000,
            onError = { errors.add(it) },
          )
          val (peer, id) = withTimeout(TEST_TIMEOUT_MS) { requestSeen.await() }
          val callbackWatcher = withTimeout(TEST_TIMEOUT_MS) { entryGate.paused.await() }

          if (peerRejects) {
            assertTrue(
              peer.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"RATE_LIMITED","message":"slow down"}}"""),
            )
          }
          assertTrue(peer.close(1000, "done"))
          // Peer frame order plus this close checkpoint puts the accepted reply behind the held pump.
          withTimeout(TEST_TIMEOUT_MS) {
            while (lease.isCurrent()) yield()
          }
          harness.session.disconnect()
          releaseResponsePump.countDown()
          // Wait for cancellation to reach this waiter, not just for its owner to start cancelling.
          withTimeout(TEST_TIMEOUT_MS) {
            while (!callbackWatcher.isCancelled) yield()
          }
          entryGate.release.countDown()
          withTimeout(TEST_TIMEOUT_MS) { harness.session.disconnectAndJoin() }

          assertTrue("response pump timed out", withTimeout(TEST_TIMEOUT_MS) { responsePumpReleased.await() })
          assertTrue("callback entry gate timed out", withTimeout(TEST_TIMEOUT_MS) { entryGate.released.await() })
          assertTrue("app scope must remain alive until after callback verification", harness.sessionJob.isActive)
          assertEquals("onError must be delivered exactly once; peerRejects=$peerRejects", 1, errors.size)
          val error = errors.single()
          assertEquals(if (peerRejects) "RATE_LIMITED" else "UNAVAILABLE", error.code)
          assertEquals(if (peerRejects) "slow down" else "Gateway disconnected before response", error.message)
        } finally {
          releaseResponsePump.countDown()
          entryGate.release.countDown()
          shutdownHarness(harness, server)
        }
      }
    }

  @Test
  fun eventsAreDispatchedInWebSocketFrameOrder() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val firstEventStarted = CompletableDeferred<Unit>()
      val releaseFirstEvent = CompletableDeferred<Unit>()
      val secondEventHandled = CompletableDeferred<Unit>()
      val events = CopyOnWriteArrayList<String>()
      val lastDisconnect = AtomicReference("")
      val serverWebSocket = AtomicReference<WebSocket?>(null)
      val server =
        startGatewayServer(json) { webSocket, id, method, _ ->
          serverWebSocket.set(webSocket)
          if (method == "connect") {
            webSocket.send(connectResponseFrame(id))
            webSocket.send("""{"type":"event","event":"voice.first","payload":{}}""")
            webSocket.send("""{"type":"event","event":"voice.second","payload":{}}""")
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
          onEvent = { event, _ ->
            if (event == "voice.first") {
              firstEventStarted.complete(Unit)
              runBlocking { releaseFirstEvent.await() }
            }
            events += event
            if (event == "voice.second") {
              secondEventHandled.complete(Unit)
            }
          },
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
        withTimeout(TEST_TIMEOUT_MS) { firstEventStarted.await() }

        assertNull(withTimeoutOrNull(200) { secondEventHandled.await() })

        releaseFirstEvent.complete(Unit)
        withTimeout(TEST_TIMEOUT_MS) { secondEventHandled.await() }
        assertEquals(listOf("voice.first", "voice.second"), events.toList())
      } finally {
        releaseFirstEvent.complete(Unit)
        runCatching { serverWebSocket.get()?.close(1000, "done") }
        delay(100)
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun explicitNullPayloadsRemainPresentForResponsesAndEvents() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val eventPayload = CompletableDeferred<String?>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, _ ->
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
              webSocket.send("""{"type":"event","event":"health","payload":null}""")
            }

            "test.null-payload" -> {
              webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":null}""")
            }
          }
        }
      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
          onEvent = { event, payload ->
            if (event == GatewayEvent.Health.rawValue) eventPayload.complete(payload)
          },
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val response = harness.session.requestDetailed("test.null-payload", null)

        assertEquals("null", response.payloadJson)
        assertEquals("null", withTimeout(TEST_TIMEOUT_MS) { eventPayload.await() })
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun connect_usesBootstrapTokenWhenSharedAndDeviceTokensAreAbsent() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val connectAuth = CompletableDeferred<JsonObject?>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          when (method) {
            "connect" -> {
              if (!connectAuth.isCompleted) {
                connectAuth.complete(frame["params"]?.jsonObject?.get("auth")?.jsonObject)
              }
              webSocket.send(connectResponseFrame(id))
              webSocket.close(1000, "done")
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(
          session = harness.session,
          port = server.port,
          token = null,
          bootstrapToken = "bootstrap-token",
        )
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val auth = withTimeout(TEST_TIMEOUT_MS) { connectAuth.await() }
        assertEquals("bootstrap-token", auth?.get("bootstrapToken")?.jsonPrimitive?.content)
        assertNull(auth?.get("token"))
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun connect_prefersFreshBootstrapTokenOverStoredDeviceToken() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val connectAuth = CompletableDeferred<JsonObject?>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          when (method) {
            "connect" -> {
              if (!connectAuth.isCompleted) {
                connectAuth.complete(frame["params"]?.jsonObject?.get("auth")?.jsonObject)
              }
              webSocket.send(connectResponseFrame(id))
              webSocket.close(1000, "done")
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        harness.deviceAuthStore.saveToken(gatewayIdForPort(server.port), deviceId, "node", "device-token")

        connectNodeSession(
          session = harness.session,
          port = server.port,
          token = null,
          bootstrapToken = "bootstrap-token",
        )
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val auth = withTimeout(TEST_TIMEOUT_MS) { connectAuth.await() }
        assertEquals("bootstrap-token", auth?.get("bootstrapToken")?.jsonPrimitive?.content)
        assertNull(auth?.get("token"))
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun connect_reusesStoredDeviceTokenScopes() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val connectParams = CompletableDeferred<JsonObject>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          if (method == "connect") {
            if (!connectParams.isCompleted) {
              connectParams.complete(frame["params"]!!.jsonObject)
            }
            webSocket.send(connectResponseFrame(id))
            webSocket.close(1000, "done")
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        harness.deviceAuthStore.saveToken(
          gatewayId = gatewayIdForPort(server.port),
          deviceId = deviceId,
          role = "operator",
          token = "operator-device-token",
          scopes = listOf("operator.pairing", "operator.write"),
        )

        connectNodeSession(
          session = harness.session,
          port = server.port,
          token = null,
          role = "operator",
          scopes = listOf("operator.approvals", "operator.read", "operator.write"),
        )
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val params = withTimeout(TEST_TIMEOUT_MS) { connectParams.await() }
        assertEquals(
          "operator-device-token",
          params["auth"]
            ?.jsonObject
            ?.get("token")
            ?.jsonPrimitive
            ?.content,
        )
        assertEquals(listOf("operator.pairing", "operator.write"), params.scopes())
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun bootstrapConnect_requestsCanonicalLimitedOperatorHandoffScopes() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val connectParams = CompletableDeferred<JsonObject>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          if (method == "connect") {
            if (!connectParams.isCompleted) {
              connectParams.complete(frame["params"]!!.jsonObject)
            }
            webSocket.send(connectResponseFrame(id))
            webSocket.close(1000, "done")
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(
          session = harness.session,
          port = server.port,
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          role = "operator",
          scopes =
            listOf(
              "operator.approvals",
              "operator.pairing",
              "operator.questions",
              "operator.read",
              "operator.talk.secrets",
              "operator.write",
            ),
        )
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val params = withTimeout(TEST_TIMEOUT_MS) { connectParams.await() }
        assertEquals(
          "setup-bootstrap-token",
          params["auth"]
            ?.jsonObject
            ?.get("bootstrapToken")
            ?.jsonPrimitive
            ?.content,
        )
        assertEquals(
          listOf(
            "operator.approvals",
            "operator.questions",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ),
          params.scopes(),
        )
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun connect_retriesWithStoredDeviceTokenAfterSharedTokenMismatch() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val firstConnectAuth = CompletableDeferred<JsonObject?>()
      val secondConnectAuth = CompletableDeferred<JsonObject?>()
      val connectAttempts = AtomicInteger(0)
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          when (method) {
            "connect" -> {
              val auth = frame["params"]?.jsonObject?.get("auth")?.jsonObject
              when (connectAttempts.incrementAndGet()) {
                1 -> {
                  if (!firstConnectAuth.isCompleted) {
                    firstConnectAuth.complete(auth)
                  }
                  webSocket.send(
                    """{"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"unauthorized","details":{"code":"AUTH_TOKEN_MISMATCH","canRetryWithDeviceToken":true,"recommendedNextStep":"retry_with_device_token"}}}""",
                  )
                  webSocket.close(1000, "retry")
                }

                else -> {
                  if (!secondConnectAuth.isCompleted) {
                    secondConnectAuth.complete(auth)
                  }
                  webSocket.send(connectResponseFrame(id))
                }
              }
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        harness.deviceAuthStore.saveToken(gatewayIdForPort(server.port), deviceId, "node", "stored-device-token")

        connectNodeSession(
          session = harness.session,
          port = server.port,
          token = "shared-auth-token",
          bootstrapToken = null,
        )
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val firstAuth = withTimeout(TEST_TIMEOUT_MS) { firstConnectAuth.await() }
        val secondAuth = withTimeout(TEST_TIMEOUT_MS) { secondConnectAuth.await() }
        assertEquals("shared-auth-token", firstAuth?.get("token")?.jsonPrimitive?.content)
        assertNull(firstAuth?.get("deviceToken"))
        assertEquals("shared-auth-token", secondAuth?.get("token")?.jsonPrimitive?.content)
        assertEquals("stored-device-token", secondAuth?.get("deviceToken")?.jsonPrimitive?.content)
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun connect_preservesStoredScopesOnlyWhenHelloReturnsSamePrimaryDeviceToken() =
    runBlocking {
      listOf(
        Triple(
          "same token preserves stored grant",
          "stored-operator-token",
          listOf("operator.admin", "operator.read"),
        ),
        Triple("rotated token uses hello scopes", "rotated-operator-token", listOf("operator.read")),
      ).forEach { (caseName, returnedToken, expectedScopes) ->
        val json = testJson()
        val connected = CompletableDeferred<Unit>()
        val lastDisconnect = AtomicReference("")
        val server =
          startGatewayServer(json) { webSocket, id, method, _ ->
            if (method == "connect") {
              webSocket.send(
                connectResponseFrame(
                  id,
                  authJson =
                    """{"deviceToken":"$returnedToken","role":"operator","scopes":["operator.read"]}""",
                ),
              )
              webSocket.close(1000, "done")
            }
          }

        val harness =
          createNodeHarness(
            connected = connected,
            lastDisconnect = lastDisconnect,
          ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

        try {
          val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
          harness.deviceAuthStore.saveToken(
            gatewayId = gatewayIdForPort(server.port),
            deviceId = deviceId,
            role = "operator",
            token = "stored-operator-token",
            scopes = listOf("operator.admin", "operator.read"),
          )
          connectNodeSession(
            session = harness.session,
            port = server.port,
            token = "shared-auth-token",
            bootstrapToken = null,
            role = "operator",
            scopes = listOf("operator.read"),
          )
          awaitConnectedOrThrow(connected, lastDisconnect, server)

          val entry = harness.deviceAuthStore.loadEntry(gatewayIdForPort(server.port), deviceId, "operator")
          assertEquals(caseName, returnedToken, entry?.token)
          assertEquals(caseName, expectedScopes, entry?.scopes)
        } finally {
          shutdownHarness(harness, server)
        }
      }
    }

  @Test
  fun bootstrapConnect_storesAdditionalBoundedDeviceTokensOnTrustedTransport() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, _ ->
          when (method) {
            "connect" -> {
              webSocket.send(
                connectResponseFrame(
                  id,
                  authJson =
                    """{"deviceToken":"bootstrap-node-token","role":"node","scopes":[],"deviceTokens":[{"deviceToken":"bootstrap-operator-token","role":"operator","scopes":["operator.admin","operator.approvals","operator.pairing","operator.read","operator.talk.secrets","operator.write"]}]}""",
                ),
              )
              webSocket.close(1000, "done")
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(
          session = harness.session,
          port = server.port,
          token = null,
          bootstrapToken = "bootstrap-token",
        )
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        val nodeEntry = harness.deviceAuthStore.loadEntry(gatewayIdForPort(server.port), deviceId, "node")
        val operatorEntry = harness.deviceAuthStore.loadEntry(gatewayIdForPort(server.port), deviceId, "operator")
        assertEquals("bootstrap-node-token", nodeEntry?.token)
        assertEquals(emptyList<String>(), nodeEntry?.scopes)
        assertEquals("bootstrap-operator-token", operatorEntry?.token)
        assertEquals(
          listOf(
            "operator.admin",
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ),
          operatorEntry?.scopes,
        )
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun bootstrapHandoff_staleStoredOperatorHelloCannotOverwriteFreshOperatorToken() =
    runBlocking {
      for (operatorHelloToken in listOf("old-operator", "rotated-operator")) {
        val prefs = testPrefs(RuntimeEnvironment.getApplication())
        val store = DeviceAuthStore(prefs)
        val operatorConnect = CompletableDeferred<JsonObject>()
        val releaseOperatorHello = CountDownLatch(1)
        val operatorConnected = CompletableDeferred<Unit>()
        val operatorDisconnected = AtomicReference("")
        val nodeConnected = CompletableDeferred<Unit>()
        val nodeDisconnected = AtomicReference("")
        val server =
          startGatewayServer(testJson()) { socket, id, method, frame ->
            if (method == "connect") {
              val params = frame["params"]!!.jsonObject
              if (params["role"]?.jsonPrimitive?.content == "operator") {
                operatorConnect.complete(params)
                releaseOperatorHello.await()
                socket.send(
                  connectResponseFrame(
                    id,
                    authJson = """{"deviceToken":"$operatorHelloToken","role":"operator","scopes":["operator.read"]}""",
                  ),
                )
              } else {
                socket.send(
                  connectResponseFrame(
                    id,
                    authJson =
                      """{"deviceToken":"new-node","role":"node","scopes":[],"deviceTokens":[{"deviceToken":"new-operator","role":"operator","scopes":["operator.read"]}]}""",
                  ),
                )
              }
            }
          }
        val gatewayId = gatewayIdForPort(server.port)
        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        assertTrue(operatorHelloToken, store.saveToken(gatewayId, deviceId, "operator", "old-operator", listOf("operator.read")))
        prefs.saveGatewayCredentials(gatewayId, bootstrapToken = "setup")
        val handoff = prefs.prepareGatewayBootstrapHandoff(gatewayId, "setup", false)
        val operator = createNodeHarness(operatorConnected, operatorDisconnected, deviceAuthStore = store) { GatewaySession.InvokeResult.ok(null) }
        val node = createNodeHarness(nodeConnected, nodeDisconnected, deviceAuthStore = store) { GatewaySession.InvokeResult.ok(null) }
        try {
          connectNodeSession(operator.session, server.port, token = null, role = "operator", scopes = listOf("operator.read"))
          val params = withTimeout(TEST_TIMEOUT_MS) { operatorConnect.await() }
          assertEquals(operatorHelloToken, "old-operator", params["auth"]!!.jsonObject["token"]?.jsonPrimitive?.content)

          connectNodeSession(node.session, server.port, token = null, bootstrapToken = "setup", bootstrapHandoff = handoff)
          awaitConnectedOrThrow(nodeConnected, nodeDisconnected, server)
          assertEquals(operatorHelloToken, "new-operator", store.loadEntry(gatewayId, deviceId, "operator")?.token)
          assertEquals(operatorHelloToken, "new-node", store.loadEntry(gatewayId, deviceId, "node")?.token)
          assertTrue(operatorHelloToken, handoff.completed)
          assertNull(operatorHelloToken, prefs.loadGatewayCredentials(gatewayId).bootstrapToken)

          releaseOperatorHello.countDown()
          awaitConnectedOrThrow(operatorConnected, operatorDisconnected, server)
          assertEquals(operatorHelloToken, "new-operator", store.loadEntry(gatewayId, deviceId, "operator")?.token)
          assertEquals(operatorHelloToken, "new-node", store.loadEntry(gatewayId, deviceId, "node")?.token)
          assertTrue(operatorHelloToken, operator.session.isReady())
        } finally {
          releaseOperatorHello.countDown()
          operator.session.disconnectAndJoin()
          operator.sessionJob.cancelAndJoin()
          node.session.disconnectAndJoin()
          node.sessionJob.cancelAndJoin()
          server.shutdown()
        }
      }
    }

  @Test
  fun bootstrapHandoff_staleOperatorRetryMismatchCannotClearFreshOperatorToken() =
    runBlocking {
      val prefs = testPrefs(RuntimeEnvironment.getApplication())
      val store = DeviceAuthStore(prefs)
      val operatorAuthFrames = Channel<JsonObject>(Channel.UNLIMITED)
      val releaseMismatch = CountDownLatch(1)
      val retryRejected = CompletableDeferred<Unit>()
      val nodeConnected = CompletableDeferred<Unit>()
      val nodeDisconnected = AtomicReference("")
      val server =
        startGatewayServer(testJson()) { socket, id, method, frame ->
          if (method == "connect") {
            val params = frame["params"]!!.jsonObject
            if (params["role"]?.jsonPrimitive?.content == "operator") {
              val auth = params["auth"]!!.jsonObject
              operatorAuthFrames.trySend(auth)
              if (auth["deviceToken"] == null) {
                socket.send(
                  """{"type":"res","id":"$id","ok":false,"error":{"code":"UNAUTHORIZED","message":"shared token mismatch","details":{"code":"AUTH_TOKEN_MISMATCH","canRetryWithDeviceToken":true}}}""",
                )
              } else {
                releaseMismatch.await()
                socket.send(
                  """{"type":"res","id":"$id","ok":false,"error":{"code":"UNAUTHORIZED","message":"device token mismatch","details":{"code":"AUTH_DEVICE_TOKEN_MISMATCH"}}}""",
                )
              }
            } else {
              socket.send(
                connectResponseFrame(
                  id,
                  authJson =
                    """{"deviceToken":"new-node","role":"node","scopes":[],"deviceTokens":[{"deviceToken":"new-operator","role":"operator","scopes":["operator.read"]}]}""",
                ),
              )
            }
          }
        }
      val gatewayId = gatewayIdForPort(server.port)
      val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
      assertTrue(store.saveToken(gatewayId, deviceId, "operator", "old-operator", listOf("operator.read")))
      prefs.saveGatewayCredentials(gatewayId, bootstrapToken = "setup")
      val handoff = prefs.prepareGatewayBootstrapHandoff(gatewayId, "setup", false)
      val operator =
        createNodeHarness(
          CompletableDeferred(),
          AtomicReference(""),
          deviceAuthStore = store,
          onConnectFailure = { error, _ ->
            if (error.details?.code == "AUTH_DEVICE_TOKEN_MISMATCH") retryRejected.complete(Unit)
          },
        ) { GatewaySession.InvokeResult.ok(null) }
      val node = createNodeHarness(nodeConnected, nodeDisconnected, deviceAuthStore = store) { GatewaySession.InvokeResult.ok(null) }
      try {
        connectNodeSession(operator.session, server.port, token = "shared-token", role = "operator", scopes = listOf("operator.read"))
        val firstAuth = withTimeout(TEST_TIMEOUT_MS) { operatorAuthFrames.receive() }
        assertEquals("shared-token", firstAuth["token"]?.jsonPrimitive?.content)
        assertNull(firstAuth["deviceToken"])
        val retryAuth = withTimeout(TEST_TIMEOUT_MS) { operatorAuthFrames.receive() }
        assertEquals("shared-token", retryAuth["token"]?.jsonPrimitive?.content)
        assertEquals("old-operator", retryAuth["deviceToken"]?.jsonPrimitive?.content)

        connectNodeSession(node.session, server.port, token = null, bootstrapToken = "setup", bootstrapHandoff = handoff)
        awaitConnectedOrThrow(nodeConnected, nodeDisconnected, server)
        val freshOperatorEntry = store.loadEntry(gatewayId, deviceId, "operator")
        assertEquals("new-operator", freshOperatorEntry?.token)
        assertTrue(handoff.completed)
        assertNull(prefs.loadGatewayCredentials(gatewayId).bootstrapToken)

        releaseMismatch.countDown()
        withTimeout(TEST_TIMEOUT_MS) { retryRejected.await() }
        assertEquals(freshOperatorEntry, store.loadEntry(gatewayId, deviceId, "operator"))
        assertEquals("new-node", store.loadEntry(gatewayId, deviceId, "node")?.token)
      } finally {
        releaseMismatch.countDown()
        operator.session.disconnectAndJoin()
        operator.sessionJob.cancelAndJoin()
        node.session.disconnectAndJoin()
        node.sessionJob.cancelAndJoin()
        server.shutdown()
      }
    }

  @Test
  fun bootstrapHandoff_reconnectsAndRelaunchesOnlyAfterDurableRoles() =
    runBlocking {
      val prefs = testPrefs(RuntimeEnvironment.getApplication())
      val store = DeviceAuthStore(prefs)
      val authFrames = Channel<JsonObject>(Channel.UNLIMITED)
      val server =
        startGatewayServer(testJson()) { socket, id, method, frame ->
          if (method == "connect") {
            authFrames.trySend(frame["params"]!!.jsonObject["auth"]!!.jsonObject)
            socket.send(
              connectResponseFrame(
                id,
                authJson =
                  """{"deviceToken":"new-node","role":"node","scopes":[],"deviceTokens":[{"deviceToken":"new-operator","role":"operator","scopes":["operator.read"]}]}""",
              ),
            )
          }
        }
      val gatewayId = gatewayIdForPort(server.port)
      prefs.saveGatewayCredentials(gatewayId, bootstrapToken = "setup")
      var harness: NodeHarness? = null
      try {
        repeat(2) { launch ->
          val connected = CompletableDeferred<Unit>()
          val disconnected = AtomicReference("")
          val current = createNodeHarness(connected, disconnected, deviceAuthStore = store) { GatewaySession.InvokeResult.ok(null) }
          harness = current
          val bootstrap = prefs.loadGatewayCredentials(gatewayId).bootstrapToken
          connectNodeSession(
            current.session,
            server.port,
            token = null,
            bootstrapToken = bootstrap,
            bootstrapHandoff = bootstrap?.let { prefs.prepareGatewayBootstrapHandoff(gatewayId, it, false) },
          )
          val auth = withTimeout(TEST_TIMEOUT_MS) { authFrames.receive() }
          assertEquals(if (launch == 0) "setup" else "new-node", auth[if (launch == 0) "bootstrapToken" else "token"]?.jsonPrimitive?.content)
          awaitConnectedOrThrow(connected, disconnected, server)
          assertNull(prefs.loadGatewayCredentials(gatewayId).bootstrapToken)
          current.session.reconnect()
          val reconnectAuth = withTimeout(TEST_TIMEOUT_MS) { authFrames.receive() }
          assertEquals("new-node", reconnectAuth["token"]?.jsonPrimitive?.content)
          assertNull(reconnectAuth["bootstrapToken"])
          current.session.disconnectAndJoin()
          current.sessionJob.cancelAndJoin()
          harness = null
        }
      } finally {
        harness?.let {
          it.session.disconnectAndJoin()
          it.sessionJob.cancelAndJoin()
        }
        server.shutdown()
      }
    }

  @Test
  fun bootstrapHandoff_retainsBootstrapForMissingOrFailedFinalRoleWrites() =
    runBlocking {
      for (failure in listOf("node", "operator", "missing-operator", "duplicate-operator")) {
        val prefs = testPrefs(RuntimeEnvironment.getApplication())
        val store = InMemoryDeviceAuthStore()
        val connected = CompletableDeferred<Unit>()
        val disconnected = AtomicReference("")
        val authFrames = Channel<JsonObject>(Channel.UNLIMITED)
        val operatorTokens =
          when (failure) {
            "missing-operator" -> "[]"
            "duplicate-operator" -> """[{"deviceToken":"new-operator","role":"operator","scopes":[]},{"deviceToken":"failed-operator","role":"operator","scopes":[]}]"""
            else -> """[{"deviceToken":"new-operator","role":"operator","scopes":[]}]"""
          }
        val server =
          startGatewayServer(testJson()) { socket, id, method, frame ->
            if (method == "connect") {
              authFrames.trySend(frame["params"]!!.jsonObject["auth"]!!.jsonObject)
              socket.send(
                connectResponseFrame(
                  id,
                  authJson =
                    """{"deviceToken":"new-node","role":"node","scopes":[],"deviceTokens":$operatorTokens}""",
                ),
              )
            }
          }
        val gatewayId = gatewayIdForPort(server.port)
        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        for (role in listOf("node", "operator")) store.saveToken(gatewayId, deviceId, role, "old-$role")
        store.saveResult = { role, token -> role != failure && token != "failed-operator" }
        prefs.saveGatewayCredentials(gatewayId, bootstrapToken = "setup")
        val handoff = prefs.prepareGatewayBootstrapHandoff(gatewayId, "setup", false)
        val harness = createNodeHarness(connected, disconnected, deviceAuthStore = store) { GatewaySession.InvokeResult.ok(null) }
        try {
          connectNodeSession(harness.session, server.port, token = null, bootstrapToken = "setup", bootstrapHandoff = handoff)
          withTimeout(TEST_TIMEOUT_MS) { authFrames.receive() }
          awaitConnectedOrThrow(connected, disconnected, server)
          assertFalse(failure, handoff.completed)
          assertEquals(failure, "setup", prefs.loadGatewayCredentials(gatewayId).bootstrapToken)
          harness.session.reconnect()
          val retry = withTimeout(TEST_TIMEOUT_MS) { authFrames.receive() }
          assertEquals(failure, "setup", retry["bootstrapToken"]?.jsonPrimitive?.content)
          assertNull(retry["token"])
        } finally {
          shutdownHarness(harness, server)
        }
      }
    }

  @Test
  fun bootstrapHandoff_cannotRetireAfterNewSetupOrDisconnectDuringRoleWrite() =
    runBlocking {
      for (replacement in listOf(true, false)) {
        val prefs = testPrefs(RuntimeEnvironment.getApplication())
        val store = InMemoryDeviceAuthStore()
        val connected = CompletableDeferred<Unit>()
        val disconnected = AtomicReference("")
        val authFrames = Channel<JsonObject>(Channel.UNLIMITED)
        val retired = CompletableDeferred<Unit>()
        val attempts = AtomicInteger()
        val server =
          startGatewayServer(testJson()) { socket, id, method, frame ->
            if (method == "connect") {
              authFrames.trySend(frame["params"]!!.jsonObject["auth"]!!.jsonObject)
              val auth =
                if (attempts.incrementAndGet() == 1) {
                  """{"deviceToken":"new-node","role":"node","scopes":[],"deviceTokens":[{"deviceToken":"new-operator","role":"operator","scopes":[]}]}"""
                } else {
                  null
                }
              socket.send(connectResponseFrame(id, authJson = auth))
            }
          }
        val gatewayId = gatewayIdForPort(server.port)
        prefs.saveGatewayCredentials(gatewayId, bootstrapToken = "setup")
        val oldHandoff = prefs.prepareGatewayBootstrapHandoff(gatewayId, "setup", false)
        val harness = createNodeHarness(connected, disconnected, deviceAuthStore = store) { GatewaySession.InvokeResult.ok(null) }
        store.saveResult = { role, _ ->
          if (role == "operator") {
            if (replacement) {
              prefs.saveGatewayCredentials(gatewayId, bootstrapToken = "new-setup")
              connectNodeSession(
                harness.session,
                server.port,
                token = null,
                bootstrapToken = "new-setup",
                bootstrapHandoff = prefs.prepareGatewayBootstrapHandoff(gatewayId, "new-setup", false),
              )
            } else {
              harness.session.disconnect()
            }
            retired.complete(Unit)
          }
          true
        }
        try {
          connectNodeSession(harness.session, server.port, token = null, bootstrapToken = "setup", bootstrapHandoff = oldHandoff)
          withTimeout(TEST_TIMEOUT_MS) {
            authFrames.receive()
            retired.await()
          }
          if (replacement) {
            val next = withTimeout(TEST_TIMEOUT_MS) { authFrames.receive() }
            assertEquals("new-setup", next["bootstrapToken"]?.jsonPrimitive?.content)
            awaitConnectedOrThrow(connected, disconnected, server)
          }
          harness.session.disconnectAndJoin()
          assertFalse(oldHandoff.completed)
          assertEquals(if (replacement) "new-setup" else "setup", prefs.loadGatewayCredentials(gatewayId).bootstrapToken)
        } finally {
          shutdownHarness(harness, server)
        }
      }
    }

  @Test
  fun savedBootstrapRecovery_neverOverridesExplicitSetupOrMissingRole() =
    runBlocking {
      for ((explicit, hasOperator) in listOf(false to true, true to true, false to false)) {
        val prefs = testPrefs(RuntimeEnvironment.getApplication())
        val store = InMemoryDeviceAuthStore()
        val connected = CompletableDeferred<Unit>()
        val disconnected = AtomicReference("")
        val authFrames = Channel<JsonObject>(Channel.UNLIMITED)
        val attempts = AtomicInteger()
        val server =
          startGatewayServer(testJson()) { socket, id, method, frame ->
            if (method == "connect") {
              authFrames.trySend(frame["params"]!!.jsonObject["auth"]!!.jsonObject)
              if (attempts.incrementAndGet() == 1) {
                socket.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"UNAUTHORIZED","message":"bootstrap token invalid or expired","details":{"code":"AUTH_BOOTSTRAP_TOKEN_INVALID"}}}""")
              } else {
                socket.send(connectResponseFrame(id, authJson = """{"deviceToken":"old-node","role":"node","scopes":[]}"""))
              }
            }
          }
        val gatewayId = gatewayIdForPort(server.port)
        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        store.saveToken(gatewayId, deviceId, "node", "old-node")
        if (hasOperator) store.saveToken(gatewayId, deviceId, "operator", "old-operator")
        prefs.saveGatewayCredentials(gatewayId, bootstrapToken = "setup")
        val handoff = prefs.prepareGatewayBootstrapHandoff(gatewayId, "setup", !explicit)
        val harness = createNodeHarness(connected, disconnected, deviceAuthStore = store) { GatewaySession.InvokeResult.ok(null) }
        try {
          connectNodeSession(harness.session, server.port, token = null, bootstrapToken = "setup", bootstrapHandoff = handoff)
          assertEquals("setup", withTimeout(TEST_TIMEOUT_MS) { authFrames.receive() }["bootstrapToken"]?.jsonPrimitive?.content)
          withTimeout(TEST_TIMEOUT_MS) { while (!disconnected.get().contains("bootstrap token invalid")) yield() }
          harness.session.reconnect()
          val retry = withTimeout(TEST_TIMEOUT_MS) { authFrames.receive() }
          val recovered = !explicit && hasOperator
          assertEquals(if (recovered) "old-node" else null, retry["token"]?.jsonPrimitive?.content)
          assertEquals(if (recovered) null else "setup", retry["bootstrapToken"]?.jsonPrimitive?.content)
          awaitConnectedOrThrow(connected, disconnected, server)
          assertEquals(recovered, handoff.completed)
          assertEquals(if (recovered) null else "setup", prefs.loadGatewayCredentials(gatewayId).bootstrapToken)
        } finally {
          shutdownHarness(harness, server)
        }
      }
    }

  @Test
  fun nonBootstrapConnect_ignoresAdditionalBootstrapDeviceTokens() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, _ ->
          when (method) {
            "connect" -> {
              webSocket.send(
                connectResponseFrame(
                  id,
                  authJson =
                    """{"deviceToken":"shared-node-token","role":"node","scopes":["node.exec"],"deviceTokens":[{"deviceToken":"shared-operator-token","role":"operator","scopes":["operator.approvals","operator.read"]}]}""",
                ),
              )
              webSocket.close(1000, "done")
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(
          session = harness.session,
          port = server.port,
          token = "shared-auth-token",
          bootstrapToken = null,
        )
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val deviceId = testDeviceIdentityStore(RuntimeEnvironment.getApplication()).loadOrCreate().deviceId
        val nodeEntry = harness.deviceAuthStore.loadEntry(gatewayIdForPort(server.port), deviceId, "node")
        assertEquals("shared-node-token", nodeEntry?.token)
        assertEquals(listOf("node.exec"), nodeEntry?.scopes)
        assertNull(harness.deviceAuthStore.loadToken(gatewayIdForPort(server.port), deviceId, "operator"))
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun nodeInvokeRequest_roundTripsInvokeResult() =
    runBlocking {
      val handshakeOrigin = AtomicReference<String?>(null)
      val result =
        runInvokeScenario(
          invokeEventFrame =
            """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-1","nodeId":"node-1","command":"debug.ping","params":{"ping":"pong"},"timeoutMs":5000}}""",
          onHandshake = { request -> handshakeOrigin.compareAndSet(null, request.getHeader("Origin")) },
        ) {
          GatewaySession.InvokeResult.ok("""{"handled":true}""")
        }

      assertEquals("invoke-1", result.request.id)
      assertEquals("node-1", result.request.nodeId)
      assertEquals("debug.ping", result.request.command)
      assertEquals("""{"ping":"pong"}""", result.request.paramsJson)
      assertNull(handshakeOrigin.get())
      assertEquals("invoke-1", result.resultParams["id"]?.jsonPrimitive?.content)
      assertEquals("node-1", result.resultParams["nodeId"]?.jsonPrimitive?.content)
      assertEquals(
        true,
        result.resultParams["ok"]
          ?.jsonPrimitive
          ?.content
          ?.toBooleanStrict(),
      )
      assertEquals(
        true,
        result.resultParams["payload"]
          ?.jsonObject
          ?.get("handled")
          ?.jsonPrimitive
          ?.content
          ?.toBooleanStrict(),
      )
    }

  @Test
  fun nodeInvokeRequest_usesParamsJsonWhenProvided() =
    runBlocking {
      val result =
        runInvokeScenario(
          invokeEventFrame =
            """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-2","nodeId":"node-2","command":"debug.raw","paramsJSON":"{\"raw\":true}","params":{"ignored":1},"timeoutMs":5000}}""",
        ) {
          GatewaySession.InvokeResult.ok("""{"handled":true}""")
        }

      assertEquals("invoke-2", result.request.id)
      assertEquals("node-2", result.request.nodeId)
      assertEquals("debug.raw", result.request.command)
      assertEquals("""{"raw":true}""", result.request.paramsJson)
      assertEquals("invoke-2", result.resultParams["id"]?.jsonPrimitive?.content)
      assertEquals("node-2", result.resultParams["nodeId"]?.jsonPrimitive?.content)
      assertEquals(
        true,
        result.resultParams["ok"]
          ?.jsonPrimitive
          ?.content
          ?.toBooleanStrict(),
      )
    }

  @Test
  fun nodeInvokeRequest_mapsCodePrefixedErrorsIntoInvokeResult() =
    runBlocking {
      val result =
        runInvokeScenario(
          invokeEventFrame =
            """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-3","nodeId":"node-3","command":"camera.snap","params":{"facing":"front"},"timeoutMs":5000}}""",
        ) {
          throw IllegalStateException("CAMERA_PERMISSION_REQUIRED: grant Camera permission")
        }

      assertEquals("invoke-3", result.resultParams["id"]?.jsonPrimitive?.content)
      assertEquals("node-3", result.resultParams["nodeId"]?.jsonPrimitive?.content)
      assertEquals(
        false,
        result.resultParams["ok"]
          ?.jsonPrimitive
          ?.content
          ?.toBooleanStrict(),
      )
      assertEquals(
        "CAMERA_PERMISSION_REQUIRED",
        result.resultParams["error"]
          ?.jsonObject
          ?.get("code")
          ?.jsonPrimitive
          ?.content,
      )
      assertEquals(
        "grant Camera permission",
        result.resultParams["error"]
          ?.jsonObject
          ?.get("message")
          ?.jsonPrimitive
          ?.content,
      )
    }

  @Test
  fun nodeInvokeRequest_cancelsHandlerWhenExecutionTimeoutExpires() =
    runBlocking {
      val handlerCancelled = CompletableDeferred<Unit>()
      val result =
        runInvokeScenario(
          invokeEventFrame =
            """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-timeout","nodeId":"node-1","command":"camera.clip","timeoutMs":100}}""",
        ) {
          try {
            awaitCancellation()
          } finally {
            handlerCancelled.complete(Unit)
          }
        }

      withTimeout(TEST_TIMEOUT_MS) { handlerCancelled.await() }
      assertEquals(
        false,
        result.resultParams["ok"]
          ?.jsonPrimitive
          ?.content
          ?.toBooleanStrict(),
      )
      assertEquals(
        "TIMEOUT",
        result.resultParams["error"]
          ?.jsonObject
          ?.get("code")
          ?.jsonPrimitive
          ?.content,
      )
      assertEquals(
        "node invoke timed out",
        result.resultParams["error"]
          ?.jsonObject
          ?.get("message")
          ?.jsonPrimitive
          ?.content,
      )
    }

  @Test
  fun nodeInvokeRequest_sendsResultForHandlerOwnedTimeout() =
    runBlocking {
      val result =
        runInvokeScenario(
          invokeEventFrame =
            """{"type":"event","event":"node.invoke.request","payload":{"id":"handler-timeout","nodeId":"node-1","command":"camera.snap","timeoutMs":5000}}""",
        ) {
          withTimeout(10) { awaitCancellation() }
        }

      assertEquals(
        false,
        result.resultParams["ok"]
          ?.jsonPrimitive
          ?.content
          ?.toBooleanStrict(),
      )
      assertEquals(
        "TIMEOUT",
        result.resultParams["error"]
          ?.jsonObject
          ?.get("code")
          ?.jsonPrimitive
          ?.content,
      )
    }

  @Test
  fun nodeInvokeRequest_sendsTimeoutWhileBlockingHandlerIsStillRunning() =
    runBlocking {
      val releaseHandler = CountDownLatch(1)
      val handlerFinished = CompletableDeferred<Unit>()
      val result =
        runInvokeScenario(
          invokeEventFrame =
            """{"type":"event","event":"node.invoke.request","payload":{"id":"blocking-timeout","nodeId":"node-1","command":"camera.clip","timeoutMs":100}}""",
          afterResult = {
            assertFalse(handlerFinished.isCompleted)
            releaseHandler.countDown()
            withTimeout(TEST_TIMEOUT_MS) { handlerFinished.await() }
          },
        ) {
          try {
            check(releaseHandler.await(5, TimeUnit.SECONDS)) { "blocking handler was not released" }
            GatewaySession.InvokeResult.ok(null)
          } finally {
            handlerFinished.complete(Unit)
          }
        }

      assertEquals(
        false,
        result.resultParams["ok"]
          ?.jsonPrimitive
          ?.content
          ?.toBooleanStrict(),
      )
      assertEquals(
        "TIMEOUT",
        result.resultParams["error"]
          ?.jsonObject
          ?.get("code")
          ?.jsonPrimitive
          ?.content,
      )
    }

  @Test
  fun nodeInvokeRequest_doesNotSendResultAfterCancellation() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val invokeStarted = CompletableDeferred<Unit>()
      val invokeResult = CompletableDeferred<Unit>()
      val lastDisconnect = AtomicReference("")
      val serverWebSocket = AtomicReference<WebSocket?>(null)
      val server =
        startGatewayServer(json) { webSocket, id, method, _ ->
          serverWebSocket.set(webSocket)
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
              webSocket.send(
                """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-cancelled","nodeId":"node-1","command":"camera.snap","timeoutMs":5000}}""",
              )
            }

            "node.invoke.result" -> {
              invokeResult.complete(Unit)
            }
          }
        }
      val harness =
        createNodeHarness(connected = connected, lastDisconnect = lastDisconnect) {
          invokeStarted.complete(Unit)
          throw CancellationException("cancelled")
        }

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
        withTimeout(TEST_TIMEOUT_MS) { invokeStarted.await() }

        assertNull(withTimeoutOrNull(250) { invokeResult.await() })
      } finally {
        serverWebSocket.get()?.close(1000, "done")
        delay(100)
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun sendNodeEventDetailed_sendsPresenceAlivePayloadAndReturnsStructuredResponse() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val nodeEventParams = CompletableDeferred<JsonObject>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
            }

            "node.event" -> {
              if (!nodeEventParams.isCompleted) {
                nodeEventParams.complete(frame["params"]?.jsonObject ?: JsonObject(emptyMap()))
              }
              val payload =
                """{"ok":true,"event":"node.presence.alive","handled":true,"reason":"persisted"}"""
              webSocket.send(
                """{"type":"res","id":"$id","ok":true,"payload":$payload}""",
              )
              webSocket.close(1000, "done")
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)

        val result =
          harness.session.sendNodeEventDetailed(
            event = "node.presence.alive",
            payloadJson = """{"trigger":"connect","sentAtMs":123}""",
            timeoutMs = TEST_TIMEOUT_MS,
          )
        val params = withTimeout(TEST_TIMEOUT_MS) { nodeEventParams.await() }
        val response = json.parseToJsonElement(result.payloadJson.orEmpty()).jsonObject
        val payload = json.parseToJsonElement(params["payloadJSON"]?.jsonPrimitive?.content.orEmpty()).jsonObject

        assertEquals(true, result.ok)
        assertEquals("node.presence.alive", params["event"]?.jsonPrimitive?.content)
        assertEquals("connect", payload["trigger"]?.jsonPrimitive?.content)
        assertEquals("123", payload["sentAtMs"]?.jsonPrimitive?.content)
        assertEquals(true, response["handled"]?.jsonPrimitive?.content?.toBooleanStrict())
        assertEquals("persisted", response["reason"]?.jsonPrimitive?.content)
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun sendNodeEventForEndpoint_sendsHostStatsAndAcceptsUnhandledAck() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val nodeEventParams = CompletableDeferred<JsonObject>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
            }

            "node.event" -> {
              nodeEventParams.complete(frame["params"]!!.jsonObject)
              webSocket.send(
                """{"type":"res","id":"$id","ok":true,"payload":{"ok":true,"event":"node.host.stats","handled":false}}""",
              )
            }
          }
        }
      val harness =
        createNodeHarness(connected, lastDisconnect) { GatewaySession.InvokeResult.ok("{}") }
      val payloadJson =
        NodeHostStatsReporter.makePayloadJson(
          NodeHostStatsReporter.Sample(8, 8_000_000_000, 3_000_000_000, 128_000_000_000, 64_000_000_000),
        )

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
        assertFalse(
          harness.session.sendNodeEventForEndpoint("another-gateway", NodeHostStatsReporter.EVENT_NAME, payloadJson),
        )
        assertTrue(
          harness.session.sendNodeEventForEndpoint(
            gatewayIdForPort(server.port),
            NodeHostStatsReporter.EVENT_NAME,
            payloadJson,
          ),
        )
        val params = withTimeout(TEST_TIMEOUT_MS) { nodeEventParams.await() }
        assertEquals("node.host.stats", params["event"]?.jsonPrimitive?.content)
        assertEquals(payloadJson, params["payloadJSON"]?.jsonPrimitive?.content)
      } finally {
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun sendNodeEventForEndpoint_canDelegateFailureLoggingToCaller() =
    runBlocking {
      for (suppressLog in listOf(false, true)) {
        val connected = CompletableDeferred<Unit>()
        val nodeEventSeen = CompletableDeferred<Unit>()
        val sent = CompletableDeferred<Boolean>()
        val lastDisconnect = AtomicReference("")
        val server =
          startGatewayServer(testJson()) { webSocket, id, method, _ ->
            when (method) {
              "connect" -> webSocket.send(connectResponseFrame(id))
              "node.event" -> nodeEventSeen.complete(Unit)
            }
          }
        val harness =
          createNodeHarness(connected, lastDisconnect) { GatewaySession.InvokeResult.ok("{}") }

        fun failureLogs(): Int =
          ShadowLog.getLogsForTag("OpenClawGateway").count {
            it.type == Log.WARN && it.msg.startsWith("node.event failed:")
          }
        var sendJob: Job? = null

        try {
          connectNodeSession(harness.session, server.port)
          awaitConnectedOrThrow(connected, lastDisconnect, server)
          val logsBefore = failureLogs()
          val gatewayId = gatewayIdForPort(server.port)
          sendJob =
            launch {
              sent.complete(
                if (suppressLog) {
                  harness.session.sendNodeEventForEndpoint(gatewayId, NodeHostStatsReporter.EVENT_NAME, "{}", logFailure = false)
                } else {
                  harness.session.sendNodeEventForEndpoint(gatewayId, NodeHostStatsReporter.EVENT_NAME, "{}")
                },
              )
            }
          withTimeout(TEST_TIMEOUT_MS) { nodeEventSeen.await() }
          harness.session.disconnect()
          assertFalse(withTimeout(TEST_TIMEOUT_MS) { sent.await() })
          assertEquals(if (suppressLog) 0 else 1, failureLogs() - logsBefore)
        } finally {
          sendJob?.cancelAndJoin()
          shutdownHarness(harness, server)
        }
      }
    }

  @Test
  fun sendNodeEvent_preservesCompletedRpcAsSuccessWhenGatewayReturnsError() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val nodeEventParams = CompletableDeferred<JsonObject>()
      val responseQueued = CompletableDeferred<Boolean>()
      val responsePumpHeld = CompletableDeferred<Unit>()
      val releaseResponsePump = CountDownLatch(1)
      val responsePumpReleased = CompletableDeferred<Boolean>()
      val lastDisconnect = AtomicReference("")
      val serverWebSocket = AtomicReference<WebSocket?>(null)
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          serverWebSocket.set(webSocket)
          when (method) {
            "connect" -> {
              webSocket.send(connectResponseFrame(id))
            }

            "node.event" -> {
              if (!nodeEventParams.isCompleted) {
                nodeEventParams.complete(frame["params"]?.jsonObject ?: JsonObject(emptyMap()))
              }
              responseQueued.complete(
                webSocket.send(
                  """{"type":"res","id":"$id","ok":false,"error":{"code":"RATE_LIMITED","message":"slow down"}}""",
                ),
              )
              webSocket.close(1000, "done")
            }
          }
        }

      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
          onEvent = { event, _ ->
            if (event == "test.block.responses") {
              responsePumpHeld.complete(Unit)
              responsePumpReleased.complete(releaseResponsePump.await(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
            }
          },
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
        val lease = requireNotNull(harness.session.captureRequestLease())
        assertTrue(
          requireNotNull(serverWebSocket.get()).send("""{"type":"event","event":"test.block.responses","payload":{}}"""),
        )
        withTimeout(TEST_TIMEOUT_MS) { responsePumpHeld.await() }

        val sent =
          async {
            harness.session.sendNodeEvent(
              event = "agent.request",
              payloadJson = """{"message":"restore"}""",
            )
          }
        val params = withTimeout(TEST_TIMEOUT_MS) { nodeEventParams.await() }
        assertTrue("The response must enter the peer's outgoing queue", withTimeout(TEST_TIMEOUT_MS) { responseQueued.await() })
        // The held callback prevents loop retirement, so this observes physical close
        // before the already-received response can leave the message queue.
        withTimeout(TEST_TIMEOUT_MS) {
          while (lease.isCurrent()) yield()
        }
        releaseResponsePump.countDown()
        assertTrue("The message-pump gate must be released", withTimeout(TEST_TIMEOUT_MS) { responsePumpReleased.await() })

        assertEquals(true, withTimeout(TEST_TIMEOUT_MS) { sent.await() })
        assertEquals("agent.request", params["event"]?.jsonPrimitive?.content)
      } finally {
        releaseResponsePump.countDown()
        shutdownHarness(harness, server)
      }
    }

  @Test
  fun sendNodeEvent_waitsForCompletedConnectHandshake() =
    runBlocking {
      val json = testJson()
      val connected = CompletableDeferred<Unit>()
      val connectRequestSeen = CompletableDeferred<Unit>()
      val releaseConnectResponse = CompletableDeferred<Unit>()
      val nodeEvents = CopyOnWriteArrayList<String>()
      val eventAfterConnect = CompletableDeferred<Unit>()
      val lastDisconnect = AtomicReference("")
      val server =
        startGatewayServer(json) { webSocket, id, method, frame ->
          when (method) {
            "connect" -> {
              connectRequestSeen.complete(Unit)
              launch(Dispatchers.Default) {
                releaseConnectResponse.await()
                webSocket.send(connectResponseFrame(id))
              }
            }

            "node.event" -> {
              val event =
                frame["params"]
                  ?.jsonObject
                  ?.get("event")
                  ?.jsonPrimitive
                  ?.content
                  .orEmpty()
              nodeEvents += event
              eventAfterConnect.complete(Unit)
              webSocket.send(
                """{"type":"res","id":"$id","ok":true,"payload":{"ok":true}}""",
              )
              webSocket.close(1000, "done")
            }
          }
        }
      val harness =
        createNodeHarness(
          connected = connected,
          lastDisconnect = lastDisconnect,
        ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(TEST_TIMEOUT_MS) { connectRequestSeen.await() }

        assertFalse(
          harness.session.sendNodeEvent(
            event = "notifications.changed",
            payloadJson = """{"change":"posted","key":"before"}""",
          ),
        )
        assertTrue(nodeEvents.isEmpty())

        releaseConnectResponse.complete(Unit)
        awaitConnectedOrThrow(connected, lastDisconnect, server)
        assertTrue(
          harness.session.sendNodeEvent(
            event = "notifications.changed",
            payloadJson = """{"change":"posted","key":"after"}""",
          ),
        )
        withTimeout(TEST_TIMEOUT_MS) { eventAfterConnect.await() }
        assertEquals(listOf("notifications.changed"), nodeEvents.toList())
      } finally {
        releaseConnectResponse.complete(Unit)
        shutdownHarness(harness, server)
      }
    }

  private fun testJson(): Json = Json { ignoreUnknownKeys = true }

  private fun testPrefs(context: Context): SecurePrefs = SecurePrefs(context, context.getSharedPreferences("handoff-test-${UUID.randomUUID()}", Context.MODE_PRIVATE))

  private fun JsonObject.scopes(): List<String> =
    (this["scopes"] as? JsonArray)
      ?.map { it.jsonPrimitive.content }
      ?: emptyList()

  private fun createNodeHarness(
    connected: CompletableDeferred<Unit>,
    lastDisconnect: AtomicReference<String>,
    onEvent: (event: String, payloadJson: String?) -> Unit = { _, _ -> },
    extraContext: CoroutineContext = EmptyCoroutineContext,
    deviceAuthStore: DeviceAuthTokenStore = InMemoryDeviceAuthStore(),
    onConnectFailure: (GatewaySession.ErrorShape, Boolean) -> Unit = { _, _ -> },
    onInvoke: suspend (GatewaySession.InvokeRequest) -> GatewaySession.InvokeResult,
  ): NodeHarness {
    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default + extraContext),
        identityStore = testDeviceIdentityStore(app),
        deviceAuthStore = deviceAuthStore,
        onConnected = {
          if (!connected.isCompleted) connected.complete(Unit)
        },
        onDisconnected = { message ->
          lastDisconnect.set(message)
        },
        onConnectFailure = onConnectFailure,
        onEvent = onEvent,
        onInvoke = onInvoke,
      )

    return NodeHarness(session = session, sessionJob = sessionJob, deviceAuthStore = deviceAuthStore)
  }

  private fun connectNodeSession(
    session: GatewaySession,
    port: Int,
    token: String? = "test-token",
    bootstrapToken: String? = null,
    role: String = "node",
    scopes: List<String> = listOf("node:invoke"),
    contextPath: String = "",
    bootstrapHandoff: GatewayBootstrapHandoff? = null,
  ) {
    session.connect(
      endpoint =
        GatewayEndpoint(
          stableId = gatewayIdForPort(port),
          name = "test",
          host = "127.0.0.1",
          port = port,
          tlsEnabled = false,
          contextPath = contextPath,
        ),
      token = token,
      bootstrapToken = bootstrapToken,
      password = null,
      options =
        GatewayConnectOptions(
          role = role,
          scopes = scopes,
          caps = emptyList(),
          commands = emptyList(),
          permissions = emptyMap(),
          client =
            GatewayClientInfo(
              id = "openclaw-android-test",
              displayName = "Android Test",
              version = "1.0.0-test",
              platform = "android",
              mode = role,
              instanceId = "android-test-instance",
              deviceFamily = "android",
              modelIdentifier = "test",
            ),
        ),
      tls = null,
      bootstrapHandoff = bootstrapHandoff,
    )
  }

  private fun gatewayIdForPort(port: Int): String = "manual|127.0.0.1|$port"

  private suspend fun awaitConnectedOrThrow(
    connected: CompletableDeferred<Unit>,
    lastDisconnect: AtomicReference<String>,
    server: MockWebServer,
  ) {
    val connectedWithinTimeout =
      withTimeoutOrNull(TEST_TIMEOUT_MS) {
        connected.await()
        true
      } == true
    if (!connectedWithinTimeout) {
      throw AssertionError("never connected; lastDisconnect=${lastDisconnect.get()}; requests=${server.requestCount}")
    }
  }

  private suspend fun shutdownHarness(
    harness: NodeHarness,
    server: MockWebServer,
  ) {
    harness.session.disconnect()
    harness.sessionJob.cancelAndJoin()
    server.shutdown()
  }

  private suspend fun runInvokeScenario(
    invokeEventFrame: String,
    onHandshake: ((RecordedRequest) -> Unit)? = null,
    afterResult: suspend (InvokeScenarioResult) -> Unit = {},
    onInvoke: suspend (GatewaySession.InvokeRequest) -> GatewaySession.InvokeResult,
  ): InvokeScenarioResult {
    val json = testJson()
    val connected = CompletableDeferred<Unit>()
    val invokeRequest = CompletableDeferred<GatewaySession.InvokeRequest>()
    val invokeResultParams = CompletableDeferred<String>()
    val lastDisconnect = AtomicReference("")
    val server =
      startGatewayServer(
        json = json,
        onHandshake = onHandshake,
      ) { webSocket, id, method, frame ->
        when (method) {
          "connect" -> {
            webSocket.send(connectResponseFrame(id))
            webSocket.send(invokeEventFrame)
          }

          "node.invoke.result" -> {
            if (!invokeResultParams.isCompleted) {
              invokeResultParams.complete(frame["params"]?.toString().orEmpty())
            }
            webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"ok":true}}""")
            webSocket.close(1000, "done")
          }
        }
      }
    val harness =
      createNodeHarness(
        connected = connected,
        lastDisconnect = lastDisconnect,
      ) { req ->
        if (!invokeRequest.isCompleted) invokeRequest.complete(req)
        onInvoke(req)
      }

    try {
      connectNodeSession(harness.session, server.port)
      awaitConnectedOrThrow(connected, lastDisconnect, server)
      val request = withTimeout(TEST_TIMEOUT_MS) { invokeRequest.await() }
      val resultParamsJson = withTimeout(TEST_TIMEOUT_MS) { invokeResultParams.await() }
      val resultParams = json.parseToJsonElement(resultParamsJson).jsonObject
      val result = InvokeScenarioResult(request = request, resultParams = resultParams)
      afterResult(result)
      return result
    } finally {
      shutdownHarness(harness, server)
    }
  }

  private fun connectResponseFrame(
    id: String,
    pluginSurfaceUrls: Map<String, String> = emptyMap(),
    authJson: String? = null,
  ): String {
    val surfaces =
      pluginSurfaceUrls.entries
        .joinToString(",") { (key, value) -> """"$key":"$value"""" }
        .takeIf { it.isNotEmpty() }
        ?.let { """"pluginSurfaceUrls":{$it},""" }
        ?: ""
    val auth = authJson?.let { "\"auth\":$it," } ?: ""
    return """{"type":"res","id":"$id","ok":true,"payload":{$surfaces$auth"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}"""
  }

  private fun startGatewayServer(
    json: Json,
    challengeFrame: String = CONNECT_CHALLENGE_FRAME,
    onHandshake: ((RecordedRequest) -> Unit)? = null,
    onHttpRequest: ((RecordedRequest) -> MockResponse)? = null,
    onRequestFrame: (webSocket: WebSocket, id: String, method: String, frame: JsonObject) -> Unit,
  ): MockWebServer =
    MockWebServer().apply {
      dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            if (!request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
              return onHttpRequest?.invoke(request) ?: MockResponse().setResponseCode(404)
            }
            onHandshake?.invoke(request)
            return MockResponse().withWebSocketUpgrade(
              object : WebSocketListener() {
                override fun onOpen(
                  webSocket: WebSocket,
                  response: Response,
                ) {
                  webSocket.send(challengeFrame)
                }

                override fun onMessage(
                  webSocket: WebSocket,
                  text: String,
                ) {
                  val frame = json.parseToJsonElement(text).jsonObject
                  if (frame["type"]?.jsonPrimitive?.content != "req") return
                  val id = frame["id"]?.jsonPrimitive?.content ?: return
                  val method = frame["method"]?.jsonPrimitive?.content ?: return
                  onRequestFrame(webSocket, id, method, frame)
                }
              },
            )
          }
        }
      start()
    }
}
