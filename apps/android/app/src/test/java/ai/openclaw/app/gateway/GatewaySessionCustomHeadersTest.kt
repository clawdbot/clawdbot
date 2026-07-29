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
import okio.Buffer
import org.junit.Assert.assertArrayEquals
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
  fun managedMediaDownload_usesArtifactTicketWithoutGatewayBearer() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val imageRequest = CompletableDeferred<RecordedRequest>()
      val imageBytes = byteArrayOf(1, 2, 3, 4)
      val attachmentId = "11111111-1111-4111-8111-111111111111"
      val artifactId = "artifact_managed_image_$attachmentId"
      val imagePath = "/api/chat/media/outgoing/main/$attachmentId/full?mediaTicket=ticket"
      val videoAttachmentId = "22222222-2222-4222-8222-222222222222"
      val videoArtifactId = "artifact_managed_media_$videoAttachmentId"
      val videoPath = "/api/chat/media/outgoing/main/$videoAttachmentId/full?mediaTicket=video-ticket"
      val server =
        MockWebServer().apply {
          dispatcher =
            object : Dispatcher() {
              override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == imagePath) {
                  imageRequest.complete(request)
                  return MockResponse()
                    .setHeader("Content-Type", "image/png")
                    .setBody(Buffer().write(imageBytes))
                }
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
                      when (frame["method"]?.jsonPrimitive?.content) {
                        "connect" ->
                          webSocket.send(
                            """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                          )
                        "artifacts.download" ->
                          if (frame["params"]
                              ?.jsonObject
                              ?.get("artifactId")
                              ?.jsonPrimitive
                              ?.content == videoArtifactId
                          ) {
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"artifact":{"id":"$videoArtifactId","type":"video","mimeType":"video/mp4","download":{"mode":"url"}},"url":"$videoPath"}}""",
                            )
                          } else {
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"url":"$imagePath"}}""",
                            )
                          }
                      }
                    }
                  },
                )
              }
            }
          start()
        }
      val stableId = "manual|127.0.0.1|${server.port}"
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val session =
        GatewaySession(
          scope = scope,
          identityStore = testDeviceIdentityStore(app),
          deviceAuthStore = NoopDeviceAuthStore(),
          onConnected = { if (!connected.isCompleted) connected.complete(Unit) },
          onDisconnected = {},
          onEvent = { _, _ -> },
        )

      try {
        session.connect(
          endpoint = GatewayEndpoint(stableId, "test", "127.0.0.1", server.port, tlsEnabled = false),
          token = "bootstrap-token",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "operator",
              scopes = listOf("operator.read"),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client =
                GatewayClientInfo(
                  id = "openclaw-android-test",
                  displayName = "Android Test",
                  version = "1.0.0-test",
                  platform = "android",
                  mode = "ui",
                  instanceId = "android-test-instance",
                  deviceFamily = "android",
                  modelIdentifier = "test",
                ),
            ),
          tls = null,
        )
        withTimeout(TEST_TIMEOUT_MS) { connected.await() }

        val loaded = session.loadImageArtifact(stableId, "main", "main", artifactId)
        assertArrayEquals(imageBytes, loaded?.bytes)
        assertEquals("image/png", loaded?.mimeType)
        val request = withTimeout(TEST_TIMEOUT_MS) { imageRequest.await() }
        assertNull(request.getHeader("Authorization"))
        assertEquals("image/*", request.getHeader("Accept"))

        val streamed =
          session.loadMediaArtifact(stableId, "main", "main", videoArtifactId, GatewayMediaKind.Video) as GatewayLoadedMedia.Streaming
        assertEquals("http://127.0.0.1:${server.port}$videoPath", streamed.url)
        assertEquals("video/*", streamed.headers["Accept"])
        assertEquals("video/mp4", streamed.mimeType)
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
        server.shutdown()
      }
    }

  @Test
  fun tlsUpgradeRequest_carriesLatestSanitizedHeadersForOnlyThisGateway() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefsBacking =
      app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefsBacking)
    val stableId = "manual|gateway.example|443"
    val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 443)
    val tls = GatewayTlsParams(required = true, expectedFingerprint = "aa".repeat(32), allowTOFU = false, stableId = stableId)

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
