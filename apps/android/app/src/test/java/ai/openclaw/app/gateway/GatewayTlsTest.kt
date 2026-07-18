package ai.openclaw.app.gateway

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedTrustManager
import kotlin.concurrent.thread

class GatewayTlsTest {
  @Test
  fun buildGatewayTlsConfig_exposesNormalizedExpectedRouteFingerprint() {
    val expected = "ab".repeat(32)
    val config: GatewayTlsConfig =
      buildGatewayTlsConfig(
        params =
          GatewayTlsParams(
            required = true,
            expectedFingerprint = "SHA-256: $expected",
            allowTOFU = false,
            stableId = "gateway-1",
          ),
        defaultTrust = RecordingExtendedTrustManager(),
      )

    assertEquals(expected, config.effectiveFingerprintSha256)
  }

  @Test
  fun buildGatewayTlsConfig_forwardsPlatformTrustWithSocketAndEngineContext() {
    val defaultTrust = RecordingExtendedTrustManager()
    val config =
      buildGatewayTlsConfig(
        params =
          GatewayTlsParams(
            required = true,
            expectedFingerprint = null,
            allowTOFU = false,
            stableId = "gateway-1",
          ),
        defaultTrust = defaultTrust,
      )
    val extendedTrust = config.trustManager as X509ExtendedTrustManager

    Socket().use { socket ->
      extendedTrust.checkServerTrusted(emptyArray(), "RSA", socket)
    }
    extendedTrust.checkServerTrusted(
      emptyArray(),
      "RSA",
      SSLContext.getDefault().createSSLEngine(),
    )

    assertEquals(1, defaultTrust.serverSocketCalls)
    assertEquals(1, defaultTrust.serverEngineCalls)
    assertEquals(0, defaultTrust.serverTwoArgumentCalls)
  }

  @Test
  fun probeGatewayTlsFingerprint_reportsHandshakeTimeoutAfterTcpConnect() =
    runBlocking {
      TcpTestServer { socket ->
        socket.soTimeout = 1_000
        runCatching { socket.getInputStream().read(ByteArray(512)) }
        Thread.sleep(700)
      }.use { server ->
        val result =
          probeGatewayTlsFingerprint(
            host = LOOPBACK_HOST,
            port = server.port,
            connectTimeoutMs = 250,
            handshakeTimeoutMs = 250,
          )

        assertEquals(GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT, result.failure)
      }
    }

  @Test
  fun probeGatewayTlsFingerprint_reportsTlsUnavailableForPlainHttpEndpoint() =
    runBlocking {
      TcpTestServer { socket ->
        socket.soTimeout = 1_000
        runCatching { socket.getInputStream().read(ByteArray(512)) }
        socket.getOutputStream().write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n".toByteArray())
        socket.getOutputStream().flush()
      }.use { server ->
        val result =
          probeGatewayTlsFingerprint(
            host = LOOPBACK_HOST,
            port = server.port,
            connectTimeoutMs = 250,
            handshakeTimeoutMs = 1_000,
          )

        assertEquals(GatewayTlsProbeFailure.TLS_UNAVAILABLE, result.failure)
      }
    }

  @Test
  fun probeGatewayTlsFingerprint_reportsTlsUnavailableForConnectedReset() =
    runBlocking {
      TcpTestServer { socket ->
        socket.close()
      }.use { server ->
        val result =
          probeGatewayTlsFingerprint(
            host = LOOPBACK_HOST,
            port = server.port,
            connectTimeoutMs = 250,
            handshakeTimeoutMs = 1_000,
          )

        assertEquals(GatewayTlsProbeFailure.TLS_UNAVAILABLE, result.failure)
      }
    }

  @Test
  fun probeGatewayTlsFingerprint_reportsUnreachableWhenTcpConnectFails() =
    runBlocking {
      val result =
        probeGatewayTlsFingerprint(
          host = LOOPBACK_HOST,
          port = unusedLoopbackPort(),
          connectTimeoutMs = 250,
          handshakeTimeoutMs = 250,
        )

      assertEquals(GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE, result.failure)
    }

  private class TcpTestServer(
    private val handler: (Socket) -> Unit,
  ) : AutoCloseable {
    private val serverSocket = ServerSocket(0, 50, LOOPBACK_ADDRESS)
    private var acceptedSocket: Socket? = null
    private val worker =
      thread(start = true, isDaemon = true, name = "openclaw-tls-probe-test-server") {
        try {
          serverSocket.accept().use { socket ->
            acceptedSocket = socket
            handler(socket)
          }
        } catch (_: SocketException) {
          // Closing the server during test cleanup interrupts accept/read.
        }
      }

    val port: Int = serverSocket.localPort

    override fun close() {
      runCatching { acceptedSocket?.close() }
      runCatching { serverSocket.close() }
      worker.join(1_000)
    }
  }

  private class RecordingExtendedTrustManager : X509ExtendedTrustManager() {
    var serverTwoArgumentCalls = 0
    var serverSocketCalls = 0
    var serverEngineCalls = 0

    override fun checkClientTrusted(
      chain: Array<X509Certificate>,
      authType: String,
    ) = Unit

    override fun checkClientTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      socket: Socket,
    ) = Unit

    override fun checkClientTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      engine: SSLEngine,
    ) = Unit

    override fun checkServerTrusted(
      chain: Array<X509Certificate>,
      authType: String,
    ) {
      serverTwoArgumentCalls += 1
    }

    override fun checkServerTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      socket: Socket,
    ) {
      serverSocketCalls += 1
    }

    override fun checkServerTrusted(
      chain: Array<X509Certificate>,
      authType: String,
      engine: SSLEngine,
    ) {
      serverEngineCalls += 1
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }

  private companion object {
    const val LOOPBACK_HOST = "127.0.0.1"
    val LOOPBACK_ADDRESS: InetAddress = InetAddress.getByName(LOOPBACK_HOST)

    fun unusedLoopbackPort(): Int =
      ServerSocket(0, 50, LOOPBACK_ADDRESS).use { server ->
        server.localPort
      }
  }
}
