package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Hold only the factory return; the real OkHttp socket and callbacks keep running. */
@Implements(value = OkHttpClient::class, isInAndroidSdk = false)
class HeldWebSocketFactory {
  @RealObject
  private lateinit var client: OkHttpClient

  @Implementation
  fun newWebSocket(
    request: Request,
    listener: WebSocketListener,
  ): WebSocket {
    val socket: WebSocket =
      Shadow.directlyOn(
        client,
        OkHttpClient::class.java,
        "newWebSocket",
        ClassParameter.from(Request::class.java, request),
        ClassParameter.from(WebSocketListener::class.java, listener),
      )
    entered.countDown()
    check(release.await(5, TimeUnit.SECONDS)) { "Factory return was not released" }
    return socket
  }

  companion object {
    var entered = CountDownLatch(1)
    var release = CountDownLatch(1)
  }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], instrumentedPackages = ["okhttp3"], shadows = [HeldWebSocketFactory::class])
class GatewaySocketPublicationTest {
  @Test
  fun earlyOpenCallbackCannotSendBeforeTheSocketIsPublished() = verifyPublication(disconnectBeforeReturn = false)

  @Test
  fun disconnectWhileTheFactoryReturnsDoesNotPublishTheConnection() = verifyPublication(disconnectBeforeReturn = true)

  private fun verifyPublication(disconnectBeforeReturn: Boolean) =
    runBlocking {
      HeldWebSocketFactory.entered = CountDownLatch(1)
      HeldWebSocketFactory.release = CountDownLatch(1)
      val app = RuntimeEnvironment.getApplication()
      val scheduler = TestCoroutineScheduler()
      val sessionJob = SupervisorJob()
      val connected = CompletableDeferred<Unit>()
      val preparingHandshake = AtomicBoolean()
      val statuses = ConcurrentLinkedQueue<String>()
      val methods = ConcurrentLinkedQueue<String>()
      val store = DeviceAuthStore(SecurePrefs(app, app.getSharedPreferences("socket-publication", 0)))
      val auth =
        object : DeviceAuthTokenStore by store {
          override fun loadEntry(
            gatewayId: String,
            deviceId: String,
            role: String,
          ): DeviceAuthEntry? {
            preparingHandshake.set(true)
            return store.loadEntry(gatewayId, deviceId, role)
          }
        }
      val session =
        GatewaySession(
          scope = CoroutineScope(sessionJob + StandardTestDispatcher(scheduler)),
          identityStore = testDeviceIdentityStore(app),
          deviceAuthStore = auth,
          onConnected = { connected.complete(Unit) },
          onDisconnected = { statuses.add(it) },
          onEvent = { _, _ -> },
        )
      val server = MockWebServer()
      server.enqueue(
        MockResponse().withWebSocketUpgrade(
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"socket-publication","ts":1700000000123}}""")
            }

            override fun onMessage(
              webSocket: WebSocket,
              text: String,
            ) {
              val request = Json.parseToJsonElement(text).jsonObject
              methods.add(request.getValue("method").jsonPrimitive.content)
              val id = request.getValue("id").jsonPrimitive.content
              webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""")
            }
          },
        ),
      )
      server.start()
      try {
        session.connect(
          endpoint = GatewayEndpoint.manual("127.0.0.1", server.port),
          token = "test-token",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "operator",
              scopes = listOf("operator.read"),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client = GatewayClientInfo("openclaw-android", "Test", "1.0.0-test", "android", "ui", "socket-publication", "android", "test"),
            ),
        )
        withTimeout(5_000) {
          while (HeldWebSocketFactory.entered.count != 0L || !preparingHandshake.get()) {
            scheduler.runCurrent()
            delay(1)
          }
        }
        assertEquals("The handshake must run before the factory returns", 0L, HeldWebSocketFactory.entered.count)
        assertEquals(1L, HeldWebSocketFactory.release.count)
        scheduler.runCurrent()
        if (disconnectBeforeReturn) session.disconnect()
        HeldWebSocketFactory.release.countDown()
        if (disconnectBeforeReturn) {
          withTimeout(5_000) {
            while (!statuses.contains("Offline")) {
              scheduler.runCurrent()
              delay(1)
            }
          }
          assertTrue("A retired connection must not publish readiness", !connected.isCompleted)
          assertTrue("A retired connection must not send its handshake", methods.isEmpty())
        } else {
          withTimeout(5_000) {
            while (!connected.isCompleted && statuses.none { it.startsWith("Gateway error:") }) {
              scheduler.runCurrent()
              delay(1)
            }
          }
          assertTrue("The first socket must connect without a retry: $statuses", connected.isCompleted)
          assertEquals(listOf("connect"), methods.toList())
          assertEquals(1, server.requestCount)
        }
      } finally {
        HeldWebSocketFactory.release.countDown()
        val cleanup =
          async(Dispatchers.Default) {
            session.disconnectAndJoin()
            sessionJob.cancelAndJoin()
          }
        try {
          withTimeout(5_000) {
            while (!cleanup.isCompleted) {
              scheduler.runCurrent()
              delay(1)
            }
          }
          cleanup.await()
        } finally {
          server.shutdown()
        }
      }
    }
}
