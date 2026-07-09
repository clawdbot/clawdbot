package ai.openclaw.app.ui.chat

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
import org.commonmark.node.Code
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Proxy
import java.net.URI
import java.net.UnknownHostException
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.math.max

internal const val LINK_PREVIEW_TITLE_MAX_CHARS = 120
internal const val LINK_PREVIEW_DESCRIPTION_MAX_CHARS = 200
internal const val LINK_PREVIEW_BODY_MAX_BYTES = 512 * 1024
internal const val LINK_PREVIEW_IMAGE_BODY_MAX_BYTES = 1024 * 1024
internal const val LINK_PREVIEW_IMAGE_MAX_DIMENSION = 600
private const val LINK_PREVIEW_MAX_REDIRECTS = 3
private const val LINK_PREVIEW_TIMEOUT_MILLIS = 6_000L
private const val LINK_PREVIEW_CACHE_ENTRIES = 64
private const val LINK_PREVIEW_IMAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024
private const val LINK_PREVIEW_IMAGE_CACHE_ENTRIES = 32
private const val LINK_PREVIEW_ACCEPT = "text/html, application/xhtml+xml;q=0.9"
private const val LINK_PREVIEW_IMAGE_ACCEPT = "image/*"
private val LINK_PREVIEW_IMAGE_CONTENT_TYPES = setOf("image/jpeg", "image/png", "image/webp")

internal data class LinkPreviewMetadata(
  val url: String,
  val title: String?,
  val description: String?,
  val imageUrl: String?,
)

internal sealed interface LinkPreviewResult {
  data class Loaded(
    val metadata: LinkPreviewMetadata,
  ) : LinkPreviewResult

  data object Failed : LinkPreviewResult
}

internal sealed interface LinkPreviewImageResult {
  data class Loaded(
    val bitmap: Bitmap,
  ) : LinkPreviewImageResult

  data object Failed : LinkPreviewImageResult
}

/** Returns the first safe web link outside inline and block code. */
internal fun extractFirstBareUrl(markdown: String): String? = findFirstLink(parseChatMarkdown(markdown).firstChild)

private fun findFirstLink(start: Node?): String? {
  var node = start
  while (node != null) {
    when (node) {
      is Link -> {
        val destination = node.destination?.trim().orEmpty()
        if (isSafeMarkdownLinkDestination(destination)) return destination
      }
      is Code, is FencedCodeBlock, is IndentedCodeBlock -> Unit
      else -> findFirstLink(node.firstChild)?.let { return it }
    }
    node = node.next
  }
  return null
}

/** Parses the OpenGraph subset used by the compact chat preview card. */
internal fun parseOpenGraph(
  html: String,
  baseUrl: String,
): LinkPreviewResult {
  var ogTitle: String? = null
  var ogDescription: String? = null
  var ogImage: String? = null

  for (tag in findTags(html, "meta")) {
    val attributes = parseTagAttributes(tag)
    val property = (attributes["property"] ?: attributes["name"])?.lowercase(Locale.US)
    val content = attributes["content"] ?: continue
    when (property) {
      "og:title" -> if (ogTitle == null) ogTitle = content
      "og:description" -> if (ogDescription == null) ogDescription = content
      "og:image", "og:image:url" -> if (ogImage == null) ogImage = content
    }
  }

  val title = sanitizeMetadataText(ogTitle ?: findTitle(html), LINK_PREVIEW_TITLE_MAX_CHARS)
  val description = sanitizeMetadataText(ogDescription, LINK_PREVIEW_DESCRIPTION_MAX_CHARS)
  val imageUrl = resolveSafeWebUrl(baseUrl, decodeHtmlEntities(ogImage.orEmpty()))
  if (title == null && description == null && imageUrl == null) return LinkPreviewResult.Failed

  return LinkPreviewResult.Loaded(
    LinkPreviewMetadata(
      url = baseUrl,
      title = title,
      description = description,
      imageUrl = imageUrl,
    ),
  )
}

internal class LinkPreviewFetcher(
  private val client: OkHttpClient = defaultLinkPreviewClient,
  private val timeoutMillis: Long = LINK_PREVIEW_TIMEOUT_MILLIS,
  private val hostPolicy: (HttpUrl) -> Boolean = ::isPubliclyRoutableHost,
) {
  suspend fun fetch(url: String): LinkPreviewResult =
    withContext(Dispatchers.IO) {
      fetchBlocking(url)
    }

  suspend fun fetchImage(url: String): LinkPreviewImageResult =
    withContext(Dispatchers.IO) {
      fetchImageBlocking(url)
    }

  private suspend fun fetchBlocking(originalUrl: String): LinkPreviewResult {
    val response =
      fetchBody(
        originalUrl = originalUrl,
        accept = LINK_PREVIEW_ACCEPT,
        allowedContentTypes = setOf("text/html"),
        maxBytes = LINK_PREVIEW_BODY_MAX_BYTES,
        rejectOversizedBody = false,
      ) ?: return LinkPreviewResult.Failed
    val html = response.bytes.toString(response.charset)
    return when (val parsed = parseOpenGraph(html, response.url.toString())) {
      is LinkPreviewResult.Loaded -> parsed.copy(metadata = parsed.metadata.copy(url = originalUrl))
      LinkPreviewResult.Failed -> LinkPreviewResult.Failed
    }
  }

  private suspend fun fetchImageBlocking(url: String): LinkPreviewImageResult {
    val response =
      fetchBody(
        originalUrl = url,
        accept = LINK_PREVIEW_IMAGE_ACCEPT,
        allowedContentTypes = LINK_PREVIEW_IMAGE_CONTENT_TYPES,
        maxBytes = LINK_PREVIEW_IMAGE_BODY_MAX_BYTES,
        rejectOversizedBody = true,
      ) ?: return LinkPreviewImageResult.Failed
    val bitmap =
      decodeLinkPreviewBitmap(
        bytes = response.bytes,
        expectedContentType = response.contentType,
      ) ?: return LinkPreviewImageResult.Failed
    return LinkPreviewImageResult.Loaded(bitmap)
  }

  private suspend fun fetchBody(
    originalUrl: String,
    accept: String,
    allowedContentTypes: Set<String>,
    maxBytes: Int,
    rejectOversizedBody: Boolean,
  ): LinkPreviewFetchedBody? {
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
          if (redirects >= LINK_PREVIEW_MAX_REDIRECTS) return null
          currentUrl = resolveRedirect(currentUrl, it.header("Location"), hostPolicy) ?: return null
          redirects += 1
          continue
        }
        if (!it.isSuccessful) return null
        val contentType = it.body.contentType() ?: return null
        val contentTypeName = "${contentType.type}/${contentType.subtype}".lowercase(Locale.US)
        if (contentTypeName !in allowedContentTypes) return null

        val bytes = call.awaitBodyRead { readBody(it.body, maxBytes, rejectOversizedBody) } ?: return null
        return LinkPreviewFetchedBody(
          url = currentUrl,
          bytes = bytes,
          charset = contentType.charset(Charsets.UTF_8) ?: Charsets.UTF_8,
          contentType = contentTypeName,
        )
      }
    }
  }
}

private suspend fun Call.executeCancellable(): Response? =
  suspendCancellableCoroutine { continuation ->
    // execute() blocks this IO worker, so cancellation must cancel the Call from the cancelling thread.
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

private data class LinkPreviewFetchedBody(
  val url: HttpUrl,
  val bytes: ByteArray,
  val charset: java.nio.charset.Charset,
  val contentType: String,
)

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

internal fun decodeLinkPreviewBitmap(
  bytes: ByteArray,
  maxDimension: Int = LINK_PREVIEW_IMAGE_MAX_DIMENSION,
  expectedContentType: String? = null,
): Bitmap? {
  if (bytes.isEmpty() || maxDimension <= 0) return null
  val encodedContentType = linkPreviewImageContentType(bytes) ?: return null
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
        inSampleSize = linkPreviewImageSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
        inPreferredConfig = Bitmap.Config.ARGB_8888
      },
    )
  } catch (_: RuntimeException) {
    null
  } catch (_: OutOfMemoryError) {
    null
  }
}

private fun linkPreviewImageContentType(bytes: ByteArray): String? =
  when {
    bytes.matchesPrefix(0xff, 0xd8, 0xff) -> "image/jpeg"
    bytes.matchesPrefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> "image/png"
    bytes.matchesPrefix(0x52, 0x49, 0x46, 0x46) && bytes.matchesAt(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
    else -> null
  }

private fun ByteArray.matchesAt(
  offset: Int,
  vararg expected: Int,
): Boolean = size >= offset + expected.size && expected.indices.all { index -> (this[offset + index].toInt() and 0xff) == expected[index] }

private fun linkPreviewImageSampleSize(
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

internal class LinkPreviewStore(
  private val fetcher: suspend (String) -> LinkPreviewResult,
  private val maxEntries: Int = LINK_PREVIEW_CACHE_ENTRIES,
) {
  private val cache =
    object : LinkedHashMap<String, LinkPreviewResult>(maxEntries, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, LinkPreviewResult>?): Boolean = size > maxEntries
    }

  suspend fun get(url: String): LinkPreviewResult {
    synchronized(cache) { cache[url] }?.let { return it }
    val result = fetcher(url)
    synchronized(cache) { cache[url] = result }
    return result
  }
}

internal class LinkPreviewImageStore(
  private val fetcher: suspend (String) -> LinkPreviewImageResult,
  maxBytes: Int = LINK_PREVIEW_IMAGE_CACHE_MAX_BYTES,
) {
  // Every result pays at least one entry share, preserving the entry cap while loaded bitmaps
  // also pay their full backing allocation.
  private val minimumResultBytes = max(1, maxBytes / LINK_PREVIEW_IMAGE_CACHE_ENTRIES)
  private val cache =
    object : LruCache<String, LinkPreviewImageResult>(maxBytes) {
      override fun sizeOf(
        key: String,
        value: LinkPreviewImageResult,
      ): Int =
        when (value) {
          is LinkPreviewImageResult.Loaded -> value.bitmap.allocationByteCount.coerceAtLeast(minimumResultBytes)
          LinkPreviewImageResult.Failed -> minimumResultBytes
        }
    }

  suspend fun get(url: String): LinkPreviewImageResult {
    cache.get(url)?.let { return it }
    val result = fetcher(url)
    cache.put(url, result)
    return result
  }
}

private val defaultLinkPreviewClient: OkHttpClient =
  OkHttpClient
    .Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .cookieJar(CookieJar.NO_COOKIES)
    .authenticator(Authenticator.NONE)
    .proxyAuthenticator(Authenticator.NONE)
    .proxy(Proxy.NO_PROXY)
    // Validate inside Dns so the approved address is the one OkHttp connects to, preventing rebinding/TOCTOU.
    .dns(PublicOnlyDns())
    .build()

private val chatLinkPreviewFetcher = LinkPreviewFetcher()
internal val chatLinkPreviewStore = LinkPreviewStore(fetcher = chatLinkPreviewFetcher::fetch)
internal val chatLinkPreviewImageStore = LinkPreviewImageStore(fetcher = chatLinkPreviewFetcher::fetchImage)

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

private fun resolveSafeWebUrl(
  baseUrl: String,
  destination: String,
): String? {
  if (destination.isBlank()) return null
  val resolved =
    runCatching { URI(baseUrl).resolve(destination.trim()).toString() }
      .getOrNull()
      ?: return null
  return resolved.takeIf(::isSafeMarkdownLinkDestination)
}

private fun sanitizeMetadataText(
  value: String?,
  maxChars: Int,
): String? {
  if (value == null) return null
  val sanitized =
    decodeHtmlEntities(value)
      .filterNot(Character::isISOControl)
      .replace(Regex("\\s+"), " ")
      .trim()
  return sanitized.take(maxChars).takeIf(String::isNotEmpty)
}

private fun findTitle(html: String): String? =
  Regex("(?is)<title(?:\\s[^>]*)?>(.*?)</title\\s*>")
    .find(html)
    ?.groupValues
    ?.getOrNull(1)

private fun findTags(
  html: String,
  tagName: String,
): Sequence<String> =
  sequence {
    var searchFrom = 0
    while (searchFrom < html.length) {
      val start = html.indexOf("<$tagName", searchFrom, ignoreCase = true)
      if (start < 0) break
      val boundary = html.getOrNull(start + tagName.length + 1)
      if (boundary != null && !boundary.isWhitespace() && boundary != '/' && boundary != '>') {
        searchFrom = start + tagName.length + 1
        continue
      }
      val end = findTagEnd(html, start + tagName.length + 1)
      if (end < 0) break
      yield(html.substring(start, end + 1))
      searchFrom = end + 1
    }
  }

private fun findTagEnd(
  html: String,
  start: Int,
): Int {
  var quote: Char? = null
  for (index in start until html.length) {
    val char = html[index]
    if (quote == null && (char == '\'' || char == '"')) {
      quote = char
    } else if (char == quote) {
      quote = null
    } else if (char == '>' && quote == null) {
      return index
    }
  }
  return -1
}

private fun parseTagAttributes(tag: String): Map<String, String> {
  val attributes = mutableMapOf<String, String>()
  var index = tag.indexOfFirst(Char::isWhitespace).takeIf { it >= 0 } ?: return attributes
  while (index < tag.length) {
    while (index < tag.length && tag[index].isWhitespace()) index += 1
    if (index >= tag.length || tag[index] == '>' || tag[index] == '/') break
    val nameStart = index
    while (index < tag.length && !tag[index].isWhitespace() && tag[index] != '=' && tag[index] != '>') index += 1
    val name = tag.substring(nameStart, index).lowercase(Locale.US)
    while (index < tag.length && tag[index].isWhitespace()) index += 1
    if (index >= tag.length || tag[index] != '=') continue
    index += 1
    while (index < tag.length && tag[index].isWhitespace()) index += 1
    if (index >= tag.length) break
    val quote = tag[index].takeIf { it == '\'' || it == '"' }
    if (quote != null) index += 1
    val valueStart = index
    if (quote != null) {
      while (index < tag.length && tag[index] != quote) index += 1
    } else {
      while (index < tag.length && !tag[index].isWhitespace() && tag[index] != '>') index += 1
    }
    attributes.putIfAbsent(name, tag.substring(valueStart, index))
    if (quote != null && index < tag.length) index += 1
  }
  return attributes
}

private fun decodeHtmlEntities(value: String): String =
  value.replace(Regex("&#(x[0-9a-fA-F]+|[0-9]+);?|&(amp|lt|gt|quot|apos|nbsp);", RegexOption.IGNORE_CASE)) { match ->
    val numeric = match.groupValues[1]
    if (numeric.isNotEmpty()) {
      val radix = if (numeric.startsWith('x', ignoreCase = true)) 16 else 10
      val digits = if (radix == 16) numeric.drop(1) else numeric
      digits
        .toIntOrNull(radix)
        ?.takeIf(Character::isValidCodePoint)
        ?.let(Character::toChars)
        ?.concatToString()
        ?: match.value
    } else {
      when (match.groupValues[2].lowercase(Locale.US)) {
        "amp" -> "&"
        "lt" -> "<"
        "gt" -> ">"
        "quot" -> "\""
        "apos" -> "'"
        "nbsp" -> " "
        else -> match.value
      }
    }
  }
