package ai.openclaw.app.gateway

import android.annotation.SuppressLint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.EOFException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLException
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

/** TLS pinning inputs for a discovered or manually configured gateway endpoint. */
data class GatewayTlsParams(
  val required: Boolean,
  val expectedFingerprint: String?,
  val allowTOFU: Boolean,
  val stableId: String,
)

/** SSL primitives installed into OkHttp when a gateway needs TLS pinning/TOFU. */
data class GatewayTlsConfig(
  val sslSocketFactory: SSLSocketFactory,
  val trustManager: X509TrustManager,
  val hostnameVerifier: HostnameVerifier,
)

/** Distinguishes non-TLS endpoints from unreachable endpoints during probing. */
enum class GatewayTlsProbeFailure {
  TLS_UNAVAILABLE,
  TLS_HANDSHAKE_TIMEOUT,
  ENDPOINT_UNREACHABLE,
}

/** Result of probing a gateway TLS endpoint for first-use fingerprint capture. */
data class GatewayTlsProbeResult(
  val fingerprintSha256: String? = null,
  val failure: GatewayTlsProbeFailure? = null,
)

internal const val GATEWAY_TLS_PROBE_CONNECT_TIMEOUT_MS = 3_000
internal const val GATEWAY_TLS_PROBE_HANDSHAKE_TIMEOUT_MS = 10_000

/** Builds a TLS config that supports pinned fingerprints and trust-on-first-use. */
fun buildGatewayTlsConfig(
  params: GatewayTlsParams?,
  onStore: ((String) -> Unit)? = null,
): GatewayTlsConfig? {
  if (params == null) return null
  return buildGatewayTlsConfig(
    params = params,
    defaultTrust = defaultTrustManager(),
    onStore = onStore,
  )
}

internal fun buildGatewayTlsConfig(
  params: GatewayTlsParams,
  defaultTrust: X509TrustManager,
  onStore: ((String) -> Unit)? = null,
): GatewayTlsConfig {
  val expected =
    params.expectedFingerprint
      ?.let(::normalizeGatewayTlsFingerprint)
      ?.takeIf { it.isNotBlank() }
  val usesPlatformTrust = expected == null && !params.allowTOFU

  @SuppressLint("CustomX509TrustManager")
  val trustManager =
    object : X509ExtendedTrustManager() {
      override fun checkClientTrusted(
        chain: Array<X509Certificate>,
        authType: String,
      ) {
        defaultTrust.checkClientTrusted(chain, authType)
      }

      override fun checkClientTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        socket: Socket,
      ) {
        if (defaultTrust is X509ExtendedTrustManager) {
          defaultTrust.checkClientTrusted(chain, authType, socket)
        } else {
          checkClientTrusted(chain, authType)
        }
      }

      override fun checkClientTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        engine: SSLEngine,
      ) {
        if (defaultTrust is X509ExtendedTrustManager) {
          defaultTrust.checkClientTrusted(chain, authType, engine)
        } else {
          checkClientTrusted(chain, authType)
        }
      }

      override fun checkServerTrusted(
        chain: Array<X509Certificate>,
        authType: String,
      ) {
        if (chain.isEmpty()) throw CertificateException("empty certificate chain")
        val fingerprint = sha256Hex(chain[0].encoded)
        if (expected != null) {
          if (fingerprint != expected) {
            throw CertificateException("gateway TLS fingerprint mismatch")
          }
          return
        }
        if (params.allowTOFU) {
          // Store only after the TLS stack presents a concrete server cert; the
          // caller persists the fingerprint against the endpoint's stable id,
          // and later connects must come back through the pinned branch above.
          onStore?.invoke(fingerprint)
          return
        }
        defaultTrust.checkServerTrusted(chain, authType)
      }

      override fun checkServerTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        socket: Socket,
      ) {
        if (usesPlatformTrust && defaultTrust is X509ExtendedTrustManager) {
          // Preserve the connected hostname for Android's domain-aware platform trust manager.
          defaultTrust.checkServerTrusted(chain, authType, socket)
        } else {
          checkServerTrusted(chain, authType)
        }
      }

      override fun checkServerTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        engine: SSLEngine,
      ) {
        if (usesPlatformTrust && defaultTrust is X509ExtendedTrustManager) {
          defaultTrust.checkServerTrusted(chain, authType, engine)
        } else {
          checkServerTrusted(chain, authType)
        }
      }

      override fun getAcceptedIssuers(): Array<X509Certificate> = defaultTrust.acceptedIssuers
    }

  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(trustManager), SecureRandom())
  val verifier =
    if (expected != null || params.allowTOFU) {
      // When pinning, we intentionally ignore hostname mismatch (service discovery often yields IPs).
      HostnameVerifier { _, _ -> true }
    } else {
      HttpsURLConnection.getDefaultHostnameVerifier()
    }
  return GatewayTlsConfig(
    sslSocketFactory = context.socketFactory,
    trustManager = trustManager,
    hostnameVerifier = verifier,
  )
}

/** Connects with a probe trust manager that captures the presented cert hash. */
suspend fun probeGatewayTlsFingerprint(
  host: String,
  port: Int,
): GatewayTlsProbeResult =
  probeGatewayTlsFingerprint(
    host = host,
    port = port,
    connectTimeoutMs = GATEWAY_TLS_PROBE_CONNECT_TIMEOUT_MS,
    handshakeTimeoutMs = GATEWAY_TLS_PROBE_HANDSHAKE_TIMEOUT_MS,
  )

internal suspend fun probeGatewayTlsFingerprint(
  host: String,
  port: Int,
  connectTimeoutMs: Int,
  handshakeTimeoutMs: Int,
): GatewayTlsProbeResult {
  val trimmedHost = host.trim()
  if (trimmedHost.isEmpty()) return GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE)
  if (port !in 1..65535) return GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE)
  if (connectTimeoutMs <= 0 || handshakeTimeoutMs <= 0) return GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE)

  return withContext(Dispatchers.IO) {
    val fingerprintRef = AtomicReference<String?>(null)
    val probeTrustManager =
      @SuppressLint("CustomX509TrustManager")
      object : X509ExtendedTrustManager() {
        override fun checkClientTrusted(
          chain: Array<X509Certificate>,
          authType: String,
        ): Unit = throw CertificateException("gateway TLS probe does not accept client certificates")

        override fun checkClientTrusted(
          chain: Array<X509Certificate>,
          authType: String,
          socket: Socket,
        ) = checkClientTrusted(chain, authType)

        override fun checkClientTrusted(
          chain: Array<X509Certificate>,
          authType: String,
          engine: SSLEngine,
        ) = checkClientTrusted(chain, authType)

        override fun checkServerTrusted(
          chain: Array<X509Certificate>,
          authType: String,
        ) {
          if (chain.isEmpty()) throw CertificateException("empty certificate chain")
          fingerprintRef.set(sha256Hex(chain[0].encoded))
          // Abort validation after capture; the probe is not deciding trust.
          throw CertificateException("gateway TLS probe captured fingerprint")
        }

        override fun checkServerTrusted(
          chain: Array<X509Certificate>,
          authType: String,
          socket: Socket,
        ) = checkServerTrusted(chain, authType)

        override fun checkServerTrusted(
          chain: Array<X509Certificate>,
          authType: String,
          engine: SSLEngine,
        ) = checkServerTrusted(chain, authType)

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }

    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(probeTrustManager), SecureRandom())

    val socket = (context.socketFactory.createSocket() as SSLSocket)
    var connected = false
    try {
      // TCP reachability and TLS handshake progress fail differently on mobile
      // tailnets; keep the budgets separate so a reachable-but-slow secure
      // endpoint does not collapse into generic gateway unreachable guidance.
      socket.soTimeout = handshakeTimeoutMs
      socket.connect(InetSocketAddress(trimmedHost, port), connectTimeoutMs)
      connected = true

      // Best-effort SNI for hostnames (avoid crashing on IP literals).
      try {
        if (trimmedHost.any { it.isLetter() }) {
          val params = SSLParameters()
          params.serverNames = listOf(SNIHostName(trimmedHost))
          socket.sslParameters = params
        }
      } catch (_: Throwable) {
        // SNI is only a probe hint. IP literals and odd Bonjour names should
        // still be probed instead of failing before the TLS handshake.
      }

      socket.startHandshake()
      val cert =
        socket.session.peerCertificates.firstOrNull() as? X509Certificate
          ?: return@withContext GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_UNAVAILABLE)
      GatewayTlsProbeResult(fingerprintSha256 = sha256Hex(cert.encoded))
    } catch (err: Throwable) {
      fingerprintRef.get()?.let { return@withContext GatewayTlsProbeResult(fingerprintSha256 = it) }
      val failure =
        when (err) {
          is SSLException,
          is EOFException,
          -> GatewayTlsProbeFailure.TLS_UNAVAILABLE
          is SocketTimeoutException ->
            if (connected) {
              GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT
            } else {
              GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE
            }
          is ConnectException,
          is UnknownHostException,
          -> GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE
          is SocketException ->
            if (connected) {
              GatewayTlsProbeFailure.TLS_UNAVAILABLE
            } else {
              GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE
            }
          else -> GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE
        }
      GatewayTlsProbeResult(failure = failure)
    } finally {
      try {
        socket.close()
      } catch (_: Throwable) {
        // ignore
      }
    }
  }
}

private fun defaultTrustManager(): X509TrustManager {
  val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
  factory.init(null as java.security.KeyStore?)
  val trust =
    factory.trustManagers.firstOrNull { it is X509TrustManager } as? X509TrustManager
  return trust ?: throw IllegalStateException("No default X509TrustManager found")
}

private fun sha256Hex(data: ByteArray): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(data)
  val out = StringBuilder(digest.size * 2)
  for (byte in digest) {
    out.append(String.format(Locale.US, "%02x", byte))
  }
  return out.toString()
}

/** Normalizes user-visible fingerprint text to lowercase bare SHA-256 hex. */
fun normalizeGatewayTlsFingerprint(raw: String): String {
  val stripped =
    raw
      .trim()
      .replace(Regex("^sha-?256\\s*:?\\s*", RegexOption.IGNORE_CASE), "")
  return stripped.lowercase(Locale.US).filter { it in '0'..'9' || it in 'a'..'f' }
}
