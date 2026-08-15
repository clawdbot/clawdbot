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

/** SSL primitives and accepted route trust installed into OkHttp. */
class GatewayTlsConfig internal constructor(
  val sslSocketFactory: SSLSocketFactory,
  val trustManager: X509TrustManager,
  val hostnameVerifier: HostnameVerifier,
  private val effectiveFingerprint: AtomicReference<String?>,
) {
  val effectiveFingerprintSha256: String?
    get() = effectiveFingerprint.get()
}

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
  val systemTrusted: Boolean = false,
)

/** Final trust policy selected before opening gateway sessions. */
sealed interface GatewayTlsTrustDecision {
  data object SystemTrusted : GatewayTlsTrustDecision

  data class PinnedTrust(
    val fingerprintSha256: String,
  ) : GatewayTlsTrustDecision

  data class PromptRequired(
    val fingerprintSha256: String?,
    val previousFingerprintSha256: String?,
    val probeFailure: GatewayTlsProbeFailure? = null,
    val systemTrustAvailable: Boolean = false,
  ) : GatewayTlsTrustDecision

  data class Failed(
    val reason: GatewayTlsProbeFailure,
  ) : GatewayTlsTrustDecision
}

internal const val GATEWAY_TLS_PROBE_CONNECT_TIMEOUT_MS = 3_000
internal const val GATEWAY_TLS_PROBE_HANDSHAKE_TIMEOUT_MS = 10_000
private const val GATEWAY_TLS_FALLBACK_TIMEOUT_FLOOR_MS = 250

internal data class GatewayTlsProbeTimeouts(
  val connectTimeoutMs: Int,
  val handshakeTimeoutMs: Int,
)

internal fun splitGatewayTlsFallbackProbeTimeouts(
  connectTimeoutMs: Int,
  handshakeTimeoutMs: Int,
  elapsedMs: Long,
): GatewayTlsProbeTimeouts? {
  val totalBudgetMs = connectTimeoutMs.toLong() + handshakeTimeoutMs.toLong()
  val remainingBudgetMs = (totalBudgetMs - elapsedMs).coerceIn(0, totalBudgetMs)
  val minimumBudgetMs = GATEWAY_TLS_FALLBACK_TIMEOUT_FLOOR_MS.toLong() * 2
  if (remainingBudgetMs < minimumBudgetMs) return null
  val remainingMs = remainingBudgetMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
  val proportionalConnectMs = ((remainingMs.toLong() * connectTimeoutMs) / totalBudgetMs).toInt()
  val fallbackConnectMs =
    proportionalConnectMs.coerceIn(
      GATEWAY_TLS_FALLBACK_TIMEOUT_FLOOR_MS,
      remainingMs - GATEWAY_TLS_FALLBACK_TIMEOUT_FLOOR_MS,
    )
  return GatewayTlsProbeTimeouts(
    connectTimeoutMs = fallbackConnectMs,
    handshakeTimeoutMs = remainingMs - fallbackConnectMs,
  )
}

/** Public-DNS candidates may use Android's CA store and HTTPS hostname validation. */
internal fun isGatewayTlsSystemTrustCandidate(rawHost: String): Boolean = normalizedGatewayTlsDnsHost(rawHost) != null

/** Resolves probe evidence and any stored pin into one exhaustive trust decision. */
internal fun decideGatewayTlsTrust(
  storedFingerprint: String?,
  systemTrustCandidate: Boolean,
  probeResult: GatewayTlsProbeResult,
): GatewayTlsTrustDecision {
  val stored =
    storedFingerprint
      ?.takeIf { it.isNotBlank() }
      ?.let(::normalizeGatewayTlsFingerprintInput)
      ?: if (storedFingerprint.isNullOrBlank()) {
        null
      } else {
        return GatewayTlsTrustDecision.Failed(probeResult.failure ?: GatewayTlsProbeFailure.TLS_UNAVAILABLE)
      }
  val observed =
    probeResult.fingerprintSha256?.let { raw ->
      normalizeGatewayTlsFingerprintInput(raw)
        ?: return GatewayTlsTrustDecision.Failed(probeResult.failure ?: GatewayTlsProbeFailure.TLS_UNAVAILABLE)
    }

  if (stored == null && systemTrustCandidate && probeResult.systemTrusted) {
    return GatewayTlsTrustDecision.SystemTrusted
  }

  if (observed != null) {
    return if (stored == observed) {
      GatewayTlsTrustDecision.PinnedTrust(observed)
    } else {
      GatewayTlsTrustDecision.PromptRequired(
        fingerprintSha256 = observed,
        previousFingerprintSha256 = stored,
        systemTrustAvailable = stored != null && systemTrustCandidate && probeResult.systemTrusted,
      )
    }
  }
  if (stored != null) return GatewayTlsTrustDecision.PinnedTrust(stored)
  return GatewayTlsTrustDecision.PromptRequired(
    fingerprintSha256 = null,
    previousFingerprintSha256 = null,
    probeFailure = probeResult.failure,
  )
}

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
  val expectedInput = params.expectedFingerprint?.takeIf { it.isNotBlank() }
  val expected =
    expectedInput
      ?.let(::normalizeGatewayTlsFingerprint)
      ?.takeIf { it.isNotBlank() }
  val effectiveFingerprint = AtomicReference(expected)
  val usesPlatformTrust = expectedInput == null && !params.allowTOFU

  fun recordAcceptedFingerprint(chain: Array<X509Certificate>) {
    val certificate = chain.firstOrNull() ?: return
    effectiveFingerprint.set(sha256Hex(certificate.encoded))
  }

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
        if (expectedInput != null) {
          if (expected == null) {
            throw CertificateException("invalid gateway TLS fingerprint")
          }
          if (fingerprint != expected) {
            throw CertificateException("gateway TLS fingerprint mismatch")
          }
          effectiveFingerprint.set(fingerprint)
          return
        }
        if (params.allowTOFU) {
          // Store only after the TLS stack presents a concrete server cert; the
          // caller persists the fingerprint against the endpoint's stable id,
          // and later connects must come back through the pinned branch above.
          onStore?.invoke(fingerprint)
          effectiveFingerprint.set(fingerprint)
          return
        }
        defaultTrust.checkServerTrusted(chain, authType)
        effectiveFingerprint.set(fingerprint)
      }

      override fun checkServerTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        socket: Socket,
      ) {
        if (usesPlatformTrust && defaultTrust is X509ExtendedTrustManager) {
          // Preserve the connected hostname for Android's domain-aware platform trust manager.
          defaultTrust.checkServerTrusted(chain, authType, socket)
          recordAcceptedFingerprint(chain)
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
          recordAcceptedFingerprint(chain)
        } else {
          checkServerTrusted(chain, authType)
        }
      }

      override fun getAcceptedIssuers(): Array<X509Certificate> = defaultTrust.acceptedIssuers
    }

  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(trustManager), SecureRandom())
  val verifier =
    if (expectedInput != null || params.allowTOFU) {
      // When pinning, we intentionally ignore hostname mismatch (service discovery often yields IPs).
      HostnameVerifier { _, _ -> true }
    } else {
      HttpsURLConnection.getDefaultHostnameVerifier()
    }
  return GatewayTlsConfig(
    sslSocketFactory = context.socketFactory,
    trustManager = trustManager,
    hostnameVerifier = verifier,
    effectiveFingerprint = effectiveFingerprint,
  )
}

/** Uses platform trust for public DNS, otherwise captures the presented cert hash. */
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
    val probeDeadlineNanos =
      System.nanoTime() +
        (connectTimeoutMs.toLong() + handshakeTimeoutMs.toLong()) * 1_000_000L
    var fallbackTimeouts = GatewayTlsProbeTimeouts(connectTimeoutMs, handshakeTimeoutMs)
    if (isGatewayTlsSystemTrustCandidate(trimmedHost)) {
      val fingerprintSha256 =
        probeGatewayTlsSystemTrust(
          host = trimmedHost,
          port = port,
          connectTimeoutMs = connectTimeoutMs,
          handshakeTimeoutMs = handshakeTimeoutMs,
        )
      if (fingerprintSha256 != null) {
        return@withContext GatewayTlsProbeResult(fingerprintSha256 = fingerprintSha256, systemTrusted = true)
      }
      // One probe budget total, not one budget for each trust attempt.
      val totalBudgetMs = connectTimeoutMs.toLong() + handshakeTimeoutMs.toLong()
      val remainingBudgetMs = ((probeDeadlineNanos - System.nanoTime()) / 1_000_000L).coerceAtLeast(0)
      fallbackTimeouts =
        splitGatewayTlsFallbackProbeTimeouts(
          connectTimeoutMs = connectTimeoutMs,
          handshakeTimeoutMs = handshakeTimeoutMs,
          elapsedMs = totalBudgetMs - remainingBudgetMs,
        ) ?: return@withContext GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT)
    }

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
      socket.soTimeout = fallbackTimeouts.handshakeTimeoutMs
      socket.connect(InetSocketAddress(trimmedHost, port), fallbackTimeouts.connectTimeoutMs)
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

private fun probeGatewayTlsSystemTrust(
  host: String,
  port: Int,
  connectTimeoutMs: Int,
  handshakeTimeoutMs: Int,
): String? {
  val dnsHost = normalizedGatewayTlsDnsHost(host) ?: return null
  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(defaultTrustManager()), SecureRandom())
  val socket = context.socketFactory.createSocket() as SSLSocket
  return try {
    socket.soTimeout = handshakeTimeoutMs
    val parameters = socket.sslParameters
    parameters.endpointIdentificationAlgorithm = "HTTPS"
    parameters.serverNames = listOf(SNIHostName(dnsHost))
    socket.sslParameters = parameters
    socket.connect(InetSocketAddress(dnsHost, port), connectTimeoutMs)
    socket.startHandshake()
    val certificate = socket.session.peerCertificates.firstOrNull() as? X509Certificate ?: return null
    sha256Hex(certificate.encoded)
  } catch (_: Exception) {
    null
  } finally {
    runCatching { socket.close() }
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

/** Normalizes accepted fingerprint text to lowercase bare SHA-256 hex. */
fun normalizeGatewayTlsFingerprintInput(raw: String): String? {
  val stripped =
    raw
      .trim()
      .replace(Regex("^sha-?256\\s*:\\s*", RegexOption.IGNORE_CASE), "")
  val compact =
    stripped
      .filterNot { it == ':' || it.isWhitespace() }
      .lowercase(Locale.US)
  return compact.takeIf { value ->
    value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }
  }
}

/** Normalizes internal fingerprint text; invalid values become empty. */
fun normalizeGatewayTlsFingerprint(raw: String): String = normalizeGatewayTlsFingerprintInput(raw).orEmpty()

private fun normalizedGatewayTlsDnsHost(rawHost: String): String? {
  val trimmed = rawHost.trim()
  if (trimmed.startsWith('[') || trimmed.endsWith(']')) return null
  val host = trimmed.trimEnd('.').lowercase(Locale.US)
  if (host.isEmpty() || host.length > 253 || host.endsWith(".local")) return null
  if (host.contains(':')) return null
  val labels = host.split('.')
  if (labels.size < 2 || labels.any { !isGatewayTlsDnsLabel(it) }) return null
  if (labels.all { label -> label.all { it in '0'..'9' } }) return null
  return host
}

private fun isGatewayTlsDnsLabel(label: String): Boolean {
  if (label.isEmpty() || label.length > 63 || label.first() == '-' || label.last() == '-') return false
  return label.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }
}
