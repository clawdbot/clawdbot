package ai.openclaw.app.wear

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearRpcMethod
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

private const val WEAR_GATEWAY_READY_TIMEOUT_MS = 15_000L
private const val WEAR_SESSIONS_SEARCH = "wear-runtime-proof"

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeWearProxyTest {
  @Test
  fun wearRequestsRecoverOnlyAfterThePhoneOperatorSessionIsReady() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val gateway = NodeRuntimeWearGateway()
      val prefs =
        SecurePrefs(
          app,
          app.getSharedPreferences("wear-runtime-${UUID.randomUUID()}", Context.MODE_PRIVATE),
        )
      prefs.setManualEnabled(true)
      prefs.setManualHost(gateway.endpoint.host)
      prefs.setManualPort(gateway.endpoint.port)
      prefs.setManualTls(false)
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(
          stableId = gateway.endpoint.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = gateway.endpoint.name,
          host = gateway.endpoint.host,
          port = gateway.endpoint.port,
          tls = false,
        ),
      )
      prefs.gatewayRegistry.setActive(gateway.endpoint.stableId)
      prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-wear-runtime-token")
      val runtime = NodeRuntime.forGatewayAuthReset(app, prefs)

      try {
        gateway.holdNodeHellos()
        runtime.connect(gateway.endpoint)
        awaitOperatorReady(runtime, gateway.endpoint)
        assertTrue(runtime.handleWearProxyRequest("watch-1", sessionsRequest()).ok)
        gateway.releaseNodeHellos()
        awaitPhoneSessionsReady(runtime, gateway.endpoint)

        gateway.holdOperatorHellos()
        gateway.holdNodeHellos()
        val disconnected = runtime.handleWearProxyRequest("watch-1", request(WearRpcMethod.GatewayDisconnect))
        assertFalse(
          checkNotNull(disconnected.result)
            .jsonObject
            .getValue("connected")
            .jsonPrimitive.content
            .toBoolean(),
        )
        assertUnavailable(runtime.handleWearProxyRequest("watch-1", sessionsRequest()))

        val reconnecting = runtime.handleWearProxyRequest("watch-1", request(WearRpcMethod.GatewayConnect))
        assertFalse(
          checkNotNull(reconnecting.result)
            .jsonObject
            .getValue("connected")
            .jsonPrimitive.content
            .toBoolean(),
        )
        gateway.awaitHeldOperatorHello()
        assertUnavailable(runtime.handleWearProxyRequest("watch-1", sessionsRequest()))

        gateway.releaseOperatorHellos()
        awaitOperatorReady(runtime, gateway.endpoint)
        val recovered = runtime.handleWearProxyRequest("watch-1", sessionsRequest())

        assertTrue(recovered.ok)
        assertEquals(
          0,
          checkNotNull(recovered.result)
            .jsonObject
            .getValue("sessions")
            .jsonArray.size,
        )
        assertEquals(2, gateway.wearSessionsRequests.get())
      } finally {
        gateway.releaseOperatorHellos()
        gateway.releaseNodeHellos()
        closeNodeRuntimeTestFixture(runtime)
        gateway.close()
      }
    }

  private suspend fun awaitOperatorReady(
    runtime: NodeRuntime,
    endpoint: GatewayEndpoint,
  ) {
    val session = readGatewaySession(runtime, "operatorSession")
    val statusLock = ReflectionHelpers.getField<Any>(runtime, "gatewayStatusLock")
    withTimeout(WEAR_GATEWAY_READY_TIMEOUT_MS) {
      while (
        session.captureRequestLease(endpoint.stableId)?.isCurrent() != true ||
        !synchronized(statusLock) {
          ReflectionHelpers.getField<Boolean>(runtime, "operatorConnected")
        }
      ) {
        delay(10)
      }
    }
  }

  private suspend fun awaitPhoneSessionsReady(
    runtime: NodeRuntime,
    endpoint: GatewayEndpoint,
  ) {
    awaitSessionReady(runtime, endpoint, "nodeSession")
    awaitOperatorReady(runtime, endpoint)
  }

  private suspend fun awaitSessionReady(
    runtime: NodeRuntime,
    endpoint: GatewayEndpoint,
    fieldName: String,
  ) {
    val session = readGatewaySession(runtime, fieldName)
    withTimeout(WEAR_GATEWAY_READY_TIMEOUT_MS) {
      while (session.captureRequestLease(endpoint.stableId)?.isCurrent() != true) {
        delay(10)
      }
    }
  }

  private fun readGatewaySession(
    runtime: NodeRuntime,
    fieldName: String,
  ): GatewaySession = ReflectionHelpers.getField(runtime, fieldName)

  private fun assertUnavailable(response: WearMessage.Response) {
    assertFalse(response.ok)
    assertEquals("unavailable", response.error?.code)
  }

  private fun request(method: WearRpcMethod): WearMessage.Request =
    WearMessage.Request(
      requestId = UUID.randomUUID().toString(),
      method = method,
      params = buildJsonObject {},
    )

  private fun sessionsRequest(): WearMessage.Request =
    WearMessage.Request(
      requestId = UUID.randomUUID().toString(),
      method = WearRpcMethod.SessionsList,
      params = buildJsonObject { put("search", WEAR_SESSIONS_SEARCH) },
    )
}

private class NodeRuntimeWearGateway : AutoCloseable {
  private val json = Json { ignoreUnknownKeys = true }
  private val server = MockWebServer()
  private val operatorHelloGate = GatewayHelloGate()
  private val nodeHelloGate = GatewayHelloGate()
  val wearSessionsRequests = AtomicInteger()
  val endpoint: GatewayEndpoint

  init {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          if (request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
            MockResponse().withWebSocketUpgrade(listener())
          } else {
            MockResponse().setResponseCode(404)
          }
      }
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  fun holdOperatorHellos() {
    operatorHelloGate.hold()
  }

  fun holdNodeHellos() {
    nodeHelloGate.hold()
  }

  suspend fun awaitHeldOperatorHello() {
    operatorHelloGate.awaitHeld()
  }

  fun releaseOperatorHellos() {
    operatorHelloGate.release { socket, id -> sendHello(socket, id, role = "operator") }
  }

  fun releaseNodeHellos() {
    nodeHelloGate.release { socket, id -> sendHello(socket, id, role = "node") }
  }

  private fun listener() =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send(
          """{"type":"event","event":"connect.challenge","payload":{"nonce":"wear-runtime-proof","ts":1700000000123}}""",
        )
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = checkNotNull(frame["id"]?.jsonPrimitive?.content)
        val method = frame["method"]?.jsonPrimitive?.content
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
        if (method == "connect") {
          val role = checkNotNull(params["role"]?.jsonPrimitive?.content)
          val gate = if (role == "operator") operatorHelloGate else nodeHelloGate
          if (gate.capture(webSocket, id)) return
          sendHello(webSocket, id, role)
          return
        }
        val payload =
          if (method == "sessions.list") {
            if (params["search"]?.jsonPrimitive?.content == WEAR_SESSIONS_SEARCH) {
              wearSessionsRequests.incrementAndGet()
            }
            """{"sessions":[]}"""
          } else {
            "{}"
          }
        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":$payload}""")
      }
    }

  private fun sendHello(
    webSocket: WebSocket,
    id: String,
    role: String,
  ) {
    val scopes = if (role == "operator") """["operator.read","operator.write"]""" else "[]"
    webSocket.send(
      """{"type":"res","id":"$id","ok":true,"payload":{"type":"hello-ok","protocol":3,"server":{"host":"wear-runtime","version":"proof"},"features":{"methods":["sessions.list"],"events":[]},"auth":{"role":"$role","scopes":$scopes},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}}""",
    )
  }

  override fun close() {
    server.shutdown()
  }
}

private class GatewayHelloGate {
  private val lock = Any()
  private var held = false
  private var observed = CompletableDeferred<Unit>()
  private val pending = mutableListOf<Pair<WebSocket, String>>()

  fun hold() {
    synchronized(lock) {
      check(!held)
      check(pending.isEmpty())
      observed = CompletableDeferred()
      held = true
    }
  }

  suspend fun awaitHeld() {
    val signal = synchronized(lock) { observed }
    withTimeout(WEAR_GATEWAY_READY_TIMEOUT_MS) {
      signal.await()
    }
  }

  fun capture(
    webSocket: WebSocket,
    id: String,
  ): Boolean =
    synchronized(lock) {
      if (!held) return@synchronized false
      pending += webSocket to id
      observed.complete(Unit)
      true
    }

  fun release(sendHello: (WebSocket, String) -> Unit) {
    val captured =
      synchronized(lock) {
        held = false
        pending.toList().also { pending.clear() }
      }
    captured.forEach { (socket, id) -> sendHello(socket, id) }
  }
}
