package ai.openclaw.app.gateway

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
  fun splitGatewayTlsFallbackProbeTimeouts_skipsFallbackAfterBudgetExpires() {
    assertNull(
      splitGatewayTlsFallbackProbeTimeouts(
        connectTimeoutMs = 3_000,
        handshakeTimeoutMs = 10_000,
        elapsedMs = 13_001,
      ),
    )
  }

  @Test
  fun splitGatewayTlsFallbackProbeTimeouts_preservesNearFullBudgetAfterFastFailure() {
    val timeouts =
      splitGatewayTlsFallbackProbeTimeouts(
        connectTimeoutMs = 3_000,
        handshakeTimeoutMs = 10_000,
        elapsedMs = 50,
      ) ?: error("expected fallback timeouts")

    assertEquals(2_988, timeouts.connectTimeoutMs)
    assertEquals(9_962, timeouts.handshakeTimeoutMs)
    assertEquals(12_950, timeouts.connectTimeoutMs + timeouts.handshakeTimeoutMs)
  }

  @Test
  fun normalizeGatewayTlsFingerprintInput_acceptsPrefixColonsWhitespaceAndCase() {
    val expected = "ab".repeat(32)
    val colonSeparated = expected.uppercase().chunked(2).joinToString(":")

    assertEquals(expected, normalizeGatewayTlsFingerprintInput("  SHA256:  $colonSeparated\n"))
    assertEquals(expected, normalizeGatewayTlsFingerprintInput("sha-256:\t${expected.uppercase()}"))
    assertEquals(expected, normalizeGatewayTlsFingerprintInput(expected))
  }

  @Test
  fun normalizeGatewayTlsFingerprintInput_rejectsWrongLengthAndGarbage() {
    assertNull(normalizeGatewayTlsFingerprintInput("ab".repeat(31)))
    assertNull(normalizeGatewayTlsFingerprintInput("ab".repeat(32) + "00"))
    assertNull(normalizeGatewayTlsFingerprintInput("sha256: ${"ab".repeat(31)}:gg"))
    assertNull(normalizeGatewayTlsFingerprintInput("not-a-fingerprint"))
  }

  @Test
  fun isGatewayTlsSystemTrustCandidate_classifiesPublicDnsOnly() {
    assertFalse(isGatewayTlsSystemTrustCandidate("gateway.local"))
    assertFalse(isGatewayTlsSystemTrustCandidate("gateway.local."))
    assertFalse(isGatewayTlsSystemTrustCandidate("192.0.2.10"))
    assertFalse(isGatewayTlsSystemTrustCandidate("127.1"))
    assertFalse(isGatewayTlsSystemTrustCandidate("[2001:db8::10]"))
    assertFalse(isGatewayTlsSystemTrustCandidate("2001:db8::10"))
    assertFalse(isGatewayTlsSystemTrustCandidate("[gateway.example.com]"))
    assertFalse(isGatewayTlsSystemTrustCandidate("gateway"))
    assertTrue(isGatewayTlsSystemTrustCandidate("gateway.example.com"))
    assertTrue(isGatewayTlsSystemTrustCandidate("node.tailnet-name.ts.net"))
  }

  @Test
  fun decideGatewayTlsTrust_coversStoredPinSystemTrustCandidateMatrix() {
    val stored = "aa".repeat(32)
    val observed = "bb".repeat(32)
    for (hasStoredPin in listOf(false, true)) {
      for (systemTrusted in listOf(false, true)) {
        for (candidate in listOf(false, true)) {
          val decision =
            decideGatewayTlsTrust(
              storedFingerprint = stored.takeIf { hasStoredPin },
              systemTrustCandidate = candidate,
              probeResult = GatewayTlsProbeResult(fingerprintSha256 = observed, systemTrusted = systemTrusted),
            )
          if (!hasStoredPin && systemTrusted && candidate) {
            assertEquals(GatewayTlsTrustDecision.SystemTrusted, decision)
          } else {
            val prompt = decision as GatewayTlsTrustDecision.PromptRequired
            assertEquals(observed, prompt.fingerprintSha256)
            assertEquals(stored.takeIf { hasStoredPin }, prompt.previousFingerprintSha256)
            assertEquals(hasStoredPin && systemTrusted && candidate, prompt.systemTrustAvailable)
          }
        }
      }
    }
  }

  @Test
  fun decideGatewayTlsTrust_keepsPinWhenSystemTrustDoesNotReplaceIt() {
    val stored = "aa".repeat(32)

    assertEquals(
      GatewayTlsTrustDecision.PinnedTrust(stored),
      decideGatewayTlsTrust(
        storedFingerprint = stored,
        systemTrustCandidate = true,
        probeResult = GatewayTlsProbeResult(fingerprintSha256 = stored, systemTrusted = true),
      ),
    )
    assertEquals(
      GatewayTlsTrustDecision.PinnedTrust(stored),
      decideGatewayTlsTrust(
        storedFingerprint = stored,
        systemTrustCandidate = true,
        probeResult = GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_UNAVAILABLE),
      ),
    )
    assertEquals(
      GatewayTlsTrustDecision.PromptRequired(
        fingerprintSha256 = null,
        previousFingerprintSha256 = null,
        probeFailure = GatewayTlsProbeFailure.TLS_UNAVAILABLE,
      ),
      decideGatewayTlsTrust(
        storedFingerprint = null,
        systemTrustCandidate = true,
        probeResult = GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_UNAVAILABLE),
      ),
    )
  }

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
  fun buildGatewayTlsConfig_rejectsInvalidStoredFingerprintInsteadOfUsingPlatformTrust() {
    val defaultTrust = RecordingExtendedTrustManager()
    val config =
      buildGatewayTlsConfig(
        params =
          GatewayTlsParams(
            required = true,
            expectedFingerprint = "not-a-sha256-fingerprint",
            allowTOFU = false,
            stableId = "gateway-1",
          ),
        defaultTrust = defaultTrust,
      )

    val failure =
      runCatching {
        Socket().use { socket ->
          (config.trustManager as X509ExtendedTrustManager).checkServerTrusted(
            emptyArray(),
            "RSA",
            socket,
          )
        }
      }.exceptionOrNull()

    assertTrue(failure is java.security.cert.CertificateException)
    assertEquals(0, defaultTrust.serverSocketCalls)
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
