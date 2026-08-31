package ai.openclaw.app.ui.image

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.math.max

internal const val REMOTE_IMAGE_BODY_MAX_BYTES = 1024 * 1024
internal const val REMOTE_IMAGE_MAX_DIMENSION = 600
private const val SAFE_WEB_MAX_REDIRECTS = 3
private const val SAFE_WEB_TIMEOUT_MILLIS = 6_000L
private const val REMOTE_IMAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024
private const val REMOTE_IMAGE_CACHE_ENTRIES = 32
private const val REMOTE_IMAGE_ACCEPT = "image/*"
private val remoteImageContentTypes =
  setOf("image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp")

internal data class SafeWebBody(
  val url: HttpUrl,
  val bytes: ByteArray,
  val charset: java.nio.charset.Charset,
  val contentType: String,
)

internal class SafeWebFetcher(
  private val client: OkHttpClient = safePublicHttpClient,
  private val timeoutMillis: Long = SAFE_WEB_TIMEOUT_MILLIS,
  private val hostPolicy: (HttpUrl) -> Boolean = ::isPubliclyRoutableHost,
) {
  suspend fun fetch(
    originalUrl: String,
    accept: String,
    allowedContentTypes: Set<String>,
    maxBytes: Int,
    rejectOversizedBody: Boolean,
  ): SafeWebBody? =
    withContext(Dispatchers.IO) {
      fetchBlocking(
        originalUrl = originalUrl,
        accept = accept,
        allowedContentTypes = allowedContentTypes,
        maxBytes = maxBytes,
        rejectOversizedBody = rejectOversizedBody,
      )
    }

  private suspend fun fetchBlocking(
    originalUrl: String,
    accept: String,
    allowedContentTypes: Set<String>,
    maxBytes: Int,
    rejectOversizedBody: Boolean,
  ): SafeWebBody? {
    var currentUrl =
      originalUrl
        .toHttpUrlOrNull()
        ?.takeIf(::isSafeWebUrl)
        ?.takeIf(hostPolicy)
        ?: return null
    val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
    var redirects = 0

    while (true) {
      val remainingNanos = deadlineNanos - System.nanoTime()
      if (remainingNanos <= 0L) return null
      val request =
        Request
          .Builder()
          .url(currentUrl)
          .header("Accept", accept)
          .get()
          .build()
      val call = client.newCall(request)
      call.timeout().timeout(remainingNanos, TimeUnit.NANOSECONDS)

      val response = call.executeCancellable() ?: return null
      response.use {
        if (it.isRedirect) {
          if (redirects >= SAFE_WEB_MAX_REDIRECTS) return null
          currentUrl = resolveRedirect(currentUrl, it.header("Location"), hostPolicy) ?: return null
          redirects += 1
          continue
        }
        if (!it.isSuccessful) return null
        val contentType = it.body.contentType() ?: return null
        val contentTypeName = "${contentType.type}/${contentType.subtype}".lowercase(Locale.US)
        if (contentTypeName !in allowedContentTypes) return null

        val bytes = call.awaitBodyRead { readBody(it.body, maxBytes, rejectOversizedBody) } ?: return null
        return SafeWebBody(
          url = currentUrl,
          bytes = bytes,
          charset = contentType.charset(Charsets.UTF_8) ?: Charsets.UTF_8,
          contentType = contentTypeName,
        )
      }
    }
  }
}

internal sealed interface RemoteImageResult {
  data class Raster(
    val bitmap: Bitmap,
  ) : RemoteImageResult

  data class Svg(
    val bytes: ByteArray,
  ) : RemoteImageResult

  data object Failed : RemoteImageResult
}

internal class SafeRemoteImageFetcher(
  private val webFetcher: SafeWebFetcher = SafeWebFetcher(),
) {
  suspend fun fetch(url: String): RemoteImageResult {
    val response =
      webFetcher.fetch(
        originalUrl = url,
        accept = REMOTE_IMAGE_ACCEPT,
        allowedContentTypes = remoteImageContentTypes,
        maxBytes = REMOTE_IMAGE_BODY_MAX_BYTES,
        rejectOversizedBody = true,
      ) ?: return RemoteImageResult.Failed
    if (response.contentType == "image/svg+xml") {
      return RemoteImageResult.Svg(response.bytes)
    }
    val bitmap =
      decodeRemoteImageBitmap(
        bytes = response.bytes,
        expectedContentType = response.contentType,
      ) ?: return RemoteImageResult.Failed
    return RemoteImageResult.Raster(bitmap)
  }
}

internal class SafeRemoteImageStore(
  private val fetcher: suspend (String) -> RemoteImageResult,
  maxBytes: Int = REMOTE_IMAGE_CACHE_MAX_BYTES,
) {
  private val minimumResultBytes = max(1, maxBytes / REMOTE_IMAGE_CACHE_ENTRIES)
  private val cache =
    object : LruCache<String, RemoteImageResult>(maxBytes) {
      override fun sizeOf(
        key: String,
        value: RemoteImageResult,
      ): Int =
        when (value) {
          is RemoteImageResult.Raster -> value.bitmap.allocationByteCount.coerceAtLeast(minimumResultBytes)
          is RemoteImageResult.Svg -> value.bytes.size.coerceAtLeast(minimumResultBytes)
          RemoteImageResult.Failed -> minimumResultBytes
        }
    }

  suspend fun get(url: String): RemoteImageResult {
    cache.get(url)?.let { return it }
    val result = fetcher(url)
    cache.put(url, result)
    return result
  }
}

internal fun decodeRemoteImageBitmap(
  bytes: ByteArray,
  maxDimension: Int = REMOTE_IMAGE_MAX_DIMENSION,
  expectedContentType: String? = null,
): Bitmap? {
  if (bytes.isEmpty() || maxDimension <= 0) return null
  val encodedContentType = remoteImageContentType(bytes) ?: return null
  if (expectedContentType != null && encodedContentType != expectedContentType) return null
  return try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    BitmapFactory.decodeByteArray(
      bytes,
      0,
      bytes.size,
      BitmapFactory.Options().apply {
        inSampleSize = remoteImageSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
        inPreferredConfig = Bitmap.Config.ARGB_8888
      },
    )
  } catch (_: RuntimeException) {
    null
  } catch (_: OutOfMemoryError) {
    null
  }
}

private fun remoteImageContentType(bytes: ByteArray): String? =
  when {
    bytes.matchesPrefix(0x47, 0x49, 0x46, 0x38) -> "image/gif"
    bytes.matchesPrefix(0xff, 0xd8, 0xff) -> "image/jpeg"
    bytes.matchesPrefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> "image/png"
    bytes.matchesPrefix(0x52, 0x49, 0x46, 0x46) && bytes.matchesAt(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
    else -> null
  }

private fun remoteImageSampleSize(
  width: Int,
  height: Int,
  maxDimension: Int,
): Int {
  var sample = 1
  while (max(width / sample, height / sample) > maxDimension && sample <= Int.MAX_VALUE / 2) {
    sample *= 2
  }
  return sample
}

internal fun resolveRedirect(
  baseUrl: HttpUrl,
  location: String?,
  hostPolicy: (HttpUrl) -> Boolean = ::isPubliclyRoutableHost,
): HttpUrl? =
  location
    ?.let(baseUrl::resolve)
    ?.takeIf { isSafeWebUrl(it) && hostPolicy(it) }

private fun isSafeWebUrl(url: HttpUrl): Boolean = url.scheme == "http" || url.scheme == "https"

internal fun isPubliclyRoutableHost(url: HttpUrl): Boolean {
  val host = url.host.trimEnd('.').lowercase(Locale.US)
  if (host == "localhost" || host.endsWith(".local")) return false
  val address = parseLiteralAddress(host) ?: return true
  return isPubliclyRoutableAddress(address)
}

private fun parseLiteralAddress(host: String): InetAddress? {
  if (host.contains(':')) return runCatching { InetAddress.getByName(host) }.getOrNull()
  val octets = host.split('.')
  if (octets.size != 4) return null
  val bytes =
    octets.map { octet ->
      val value = octet.toIntOrNull()?.takeIf { it in 0..255 } ?: return null
      value.toByte()
    }
  return InetAddress.getByAddress(bytes.toByteArray())
}

private fun isPubliclyRoutableAddress(address: InetAddress): Boolean =
  !address.isAnyLocalAddress &&
    !address.isLoopbackAddress &&
    !address.isSiteLocalAddress &&
    !address.isLinkLocalAddress &&
    !address.isMulticastAddress &&
    !address.isUniqueLocalAddress() &&
    !address.isLimitedBroadcastAddress() &&
    !address.isSpecialPurposeAddress()

private fun InetAddress.isUniqueLocalAddress(): Boolean {
  val bytes = address
  return bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc
}

private fun InetAddress.isLimitedBroadcastAddress(): Boolean = this is Inet4Address && address.all { byte -> byte.toInt() and 0xff == 0xff }

private fun InetAddress.isSpecialPurposeAddress(): Boolean =
  when (this) {
    is Inet4Address -> {
      val octets = address.map { it.toInt() and 0xff }
      val first = octets[0]
      val second = octets[1]
      val third = octets[2]
      first == 0 ||
        first == 10 ||
        (first == 100 && second in 64..127) ||
        first == 127 ||
        (first == 169 && second == 254) ||
        (first == 172 && second in 16..31) ||
        (first == 192 && second == 0 && (third == 0 || third == 2)) ||
        (first == 192 && second == 88 && third == 99) ||
        (first == 192 && second == 168) ||
        (first == 198 && second in 18..19) ||
        (first == 198 && second == 51 && third == 100) ||
        (first == 203 && second == 0 && third == 113) ||
        first >= 224
    }
    is Inet6Address -> {
      val bytes = address
      val first = bytes[0].toInt() and 0xff
      val globalUnicast = first and 0xe0 == 0x20
      val special2001Prefix = bytes.matchesPrefix(0x20, 0x01, 0x00)
      val fourthHighNibble = bytes[3].toInt() and 0xf0
      val orchid = special2001Prefix && (fourthHighNibble == 0x10 || fourthHighNibble == 0x20)
      !globalUnicast ||
        bytes.matchesPrefix(0x20, 0x01, 0x00, 0x00) ||
        bytes.matchesPrefix(0x20, 0x01, 0x00, 0x02) ||
        orchid ||
        bytes.matchesPrefix(0x20, 0x01, 0x0d, 0xb8) ||
        bytes.matchesPrefix(0x20, 0x02) ||
        (bytes.matchesPrefix(0x3f, 0xff) && (bytes[2].toInt() and 0xf0) == 0)
    }
    else -> true
  }

private fun ByteArray.matchesPrefix(vararg prefix: Int): Boolean = matchesAt(0, *prefix)

private fun ByteArray.matchesAt(
  offset: Int,
  vararg expected: Int,
): Boolean = size >= offset + expected.size && expected.indices.all { index -> (this[offset + index].toInt() and 0xff) == expected[index] }

internal class PublicOnlyDns(
  private val delegate: Dns = Dns.SYSTEM,
) : Dns {
  override fun lookup(hostname: String): List<InetAddress> {
    val addresses = delegate.lookup(hostname)
    if (addresses.any { !isPubliclyRoutableAddress(it) }) {
      throw UnknownHostException("$hostname resolved to a non-public address")
    }
    return addresses
  }
}

internal val safePublicHttpClient: OkHttpClient =
  OkHttpClient
    .Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .cookieJar(CookieJar.NO_COOKIES)
    .authenticator(Authenticator.NONE)
    .proxyAuthenticator(Authenticator.NONE)
    .proxy(Proxy.NO_PROXY)
    // Pin the validated DNS answer to the connection and reject rebinding into private ranges.
    .dns(PublicOnlyDns())
    .build()

// Build the shared stores only after their public-only client; top-level initialization can
// otherwise re-enter the client field and expose a null default to preview/avatar callers.
private val safeRemoteImageFetcher = SafeRemoteImageFetcher()
internal val safeRemoteImageStore = SafeRemoteImageStore(fetcher = safeRemoteImageFetcher::fetch)

private suspend fun Call.executeCancellable(): Response? =
  suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    val response =
      try {
        execute()
      } catch (_: IOException) {
        null
      }
    if (response != null) {
      continuation.resume(response) { _, cancelledResponse, _ ->
        cancelledResponse.close()
      }
    } else if (continuation.isActive) {
      continuation.resume(null)
    }
  }

private suspend fun <T> Call.awaitBodyRead(block: () -> T?): T? =
  suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    try {
      val result = block()
      if (continuation.isActive) {
        continuation.resume(result)
      }
    } catch (_: IOException) {
      if (continuation.isActive) {
        continuation.resume(null)
      }
    }
  }

private fun readBody(
  body: ResponseBody,
  maxBytes: Int,
  rejectOversizedBody: Boolean,
): ByteArray? {
  if (rejectOversizedBody && body.contentLength() > maxBytes) return null
  val buffer = Buffer()
  val source = body.source()
  val readLimit = maxBytes.toLong() + if (rejectOversizedBody) 1L else 0L
  while (buffer.size < readLimit) {
    val remaining = readLimit - buffer.size
    if (source.read(buffer, remaining) == -1L) break
  }
  if (rejectOversizedBody && buffer.size > maxBytes) return null
  return buffer.readByteArray()
}
