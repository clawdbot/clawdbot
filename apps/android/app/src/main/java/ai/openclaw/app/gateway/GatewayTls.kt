package ai.openclaw.app.gateway

import android.annotation.SuppressLint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.EOFException
import java.net.ConnectException
import java.net.InetSocketAddress
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
import javax.net.ssl.SSLException
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

data class GatewayTlsParams(
  val required: Boolean,
  val expectedFingerprint: String?,
  val allowTOFU: Boolean,
  val stableId: String,
)

data class GatewayTlsConfig(
  val sslSocketFactory: SSLSocketFactory,
  val trustManager: X509TrustManager,
  val hostnameVerifier: HostnameVerifier,
)

enum class GatewayTlsProbeFailure {
  TLS_UNAVAILABLE,
  ENDPOINT_UNREACHABLE,
}

data class GatewayTlsProbeResult(
  val fingerprintSha256: String? = null,
  val failure: GatewayTlsProbeFailure? = null,
)

fun buildGatewayTlsConfig(
  params: GatewayTlsParams?,
  onStore: ((String) -> Unit)? = null,
): GatewayTlsConfig? {
  if (params == null) return null
  val expected =
    params.expectedFingerprint
      ?.let(::normalizeGatewayTlsFingerprint)
      ?.takeIf { it.isNotBlank() }
  val defaultTrust = defaultTrustManager()

  @SuppressLint("CustomX509TrustManager")
  val trustManager =
    object : X509TrustManager {
      override fun checkClientTrusted(
        chain: Array<X509Certificate>,
        authType: String,
      ) {
        defaultTrust.checkClientTrusted(chain, authType)
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
          onStore?.invoke(fingerprint)
          return
        }
        defaultTrust.checkServerTrusted(chain, authType)
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

suspend fun probeGatewayTlsFingerprint(
  host: String,
  port: Int,
  timeoutMs: Int = 3_000,
): GatewayTlsProbeResult {
  val trimmedHost = host.trim()
  if (trimmedHost.isEmpty()) return GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE)
  if (port !in 1..65535) return GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE)

  return withContext(Dispatchers.IO) {
    val fingerprintRef = AtomicReference<String?>(null)
    val probeTrustManager =
      @SuppressLint("CustomX509TrustManager")
      object : X509TrustManager {
        override fun checkClientTrusted(
          chain: Array<X509Certificate>,
          authType: String,
        ): Unit = throw CertificateException("gateway TLS probe does not accept client certificates")

        override fun checkServerTrusted(
          chain: Array<X509Certificate>,
          authType: String,
        ) {
          if (chain.isEmpty()) throw CertificateException("empty certificate chain")
          fingerprintRef.set(sha256Hex(chain[0].encoded))
          throw CertificateException("gateway TLS probe captured fingerprint")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }

    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(probeTrustManager), SecureRandom())

    val socket = (context.socketFactory.createSocket() as SSLSocket)
    try {
      socket.soTimeout = timeoutMs
      socket.connect(InetSocketAddress(trimmedHost, port), timeoutMs)

      // Best-effort SNI for hostnames (avoid crashing on IP literals).
      try {
        if (trimmedHost.any { it.isLetter() }) {
          val params = SSLParameters()
          params.serverNames = listOf(SNIHostName(trimmedHost))
          socket.sslParameters = params
        }
      } catch (_: Throwable) {
        // ignore
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
          is ConnectException,
          is SocketTimeoutException,
          is UnknownHostException,
          -> GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE
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

fun normalizeGatewayTlsFingerprint(raw: String): String {
  val stripped =
    raw
      .trim()
      .replace(Regex("^sha-?256\\s*:?\\s*", RegexOption.IGNORE_CASE), "")
  return stripped.lowercase(Locale.US).filter { it in '0'..'9' || it in 'a'..'f' }
}
