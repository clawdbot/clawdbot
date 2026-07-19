package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private const val TEST_TIMEOUT_MS = 8_000L
private const val CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}"""

private class NoopDeviceAuthStore : DeviceAuthTokenStore {
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionCustomHeadersTest {
  @Test
  fun tlsUpgradeRequest_carriesLatestSanitizedHeadersForOnlyThisGateway() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefsBacking =
      app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefsBacking)
    val stableId = "manual|gateway.example|443"
    val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 443)
    val tls = GatewayTlsParams(required = true, expectedFingerprint = "aa", allowTOFU = false, stableId = stableId)

    prefs.saveGatewayCustomHeaders(stableId, mapOf("CF-Access-Client-Id" to "client-id"))
    securePrefsBacking
      .edit()
      .putString(
        "gateway.customHeaders.$stableId",
        """{"CF-Access-Client-Id":"client-id","Host":"smuggled.example"}""",
      ).commit()
    prefs.saveGatewayCustomHeaders("manual|other.example|443", mapOf("X-Other-Gateway" to "leak"))

    val first = buildGatewayWebSocketUpgradeRequest(endpoint, tls, prefs::loadGatewayCustomHeaders)
    assertTrue(first.url.isHttps)
    assertEquals("client-id", first.header("CF-Access-Client-Id"))
    assertNull(first.header("Host"))
    assertNull(first.header("X-Other-Gateway"))

    prefs.saveGatewayCustomHeaders(stableId, mapOf("CF-Access-Client-Id" to "updated-id"))
    val reconnected = buildGatewayWebSocketUpgradeRequest(endpoint, tls, prefs::loadGatewayCustomHeaders)
    assertEquals("updated-id", reconnected.header("CF-Access-Client-Id"))
  }

  @Test
  fun cleartextUpgrade_neverReadsOrSendsStoredCustomHeaders() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefsBacking =
        app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", Context.MODE_PRIVATE)
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefsBacking)

      val handshake = AtomicReference<RecordedRequest?>(null)
      val server = startCapturingGatewayServer { request -> handshake.compareAndSet(null, request) }
      val stableId = "manual|127.0.0.1|${server.port}"
      prefs.saveGatewayCustomHeaders(
        stableId,
        mapOf("CF-Access-Client-Id" to "client-id", "CF-Access-Client-Secret" to "client-secret"),
      )
      val providerRead = AtomicBoolean(false)

      val sessionJob = SupervisorJob()
      val scope = CoroutineScope(sessionJob + Dispatchers.Default)
      val connected = CompletableDeferred<Unit>()
      val session =
        GatewaySession(
          scope = scope,
          identityStore = testDeviceIdentityStore(app),
          deviceAuthStore = NoopDeviceAuthStore(),
          onConnected = { if (!connected.isCompleted) connected.complete(Unit) },
          onDisconnected = {},
          onEvent = { _, _ -> },
          customHeadersProvider = { id ->
            providerRead.set(true)
            prefs.loadGatewayCustomHeaders(id)
          },
        )

      try {
        session.connect(
          endpoint =
            GatewayEndpoint(
              stableId = stableId,
              name = "test",
              host = "127.0.0.1",
              port = server.port,
              tlsEnabled = false,
            ),
          token = "test-token",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "node",
              scopes = emptyList(),
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
        withTimeout(TEST_TIMEOUT_MS) { connected.await() }

        val request = requireNotNull(handshake.get()) { "no websocket upgrade recorded" }
        assertEquals(false, providerRead.get())
        assertNull(request.getHeader("CF-Access-Client-Id"))
        assertNull(request.getHeader("CF-Access-Client-Secret"))
        assertEquals("127.0.0.1:${server.port}", request.getHeader("Host"))
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
        server.shutdown()
      }
    }

  private fun startCapturingGatewayServer(onHandshake: (RecordedRequest) -> Unit): MockWebServer {
    val json = Json { ignoreUnknownKeys = true }
    return MockWebServer().apply {
      dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            onHandshake(request)
            return MockResponse().withWebSocketUpgrade(
              object : WebSocketListener() {
                override fun onOpen(
                  webSocket: WebSocket,
                  response: Response,
                ) {
                  webSocket.send(CONNECT_CHALLENGE_FRAME)
                }

                override fun onMessage(
                  webSocket: WebSocket,
                  text: String,
                ) {
                  val frame = json.parseToJsonElement(text).jsonObject
                  if (frame["type"]?.jsonPrimitive?.content != "req") return
                  val id = frame["id"]?.jsonPrimitive?.content ?: return
                  if (frame["method"]?.jsonPrimitive?.content != "connect") return
                  webSocket.send(
                    """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                  )
                }
              },
            )
          }
        }
      start()
    }
  }
}
