package ai.openclaw.app.ui.chat

import ai.openclaw.app.takeUtf16Safe
import ai.openclaw.app.ui.image.SafeWebFetcher
import ai.openclaw.app.ui.image.isPubliclyRoutableHost
import ai.openclaw.app.ui.image.safePublicHttpClient
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import org.commonmark.node.Code
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import java.net.URI
import java.util.Locale

internal const val LINK_PREVIEW_TITLE_MAX_CHARS = 120
internal const val LINK_PREVIEW_DESCRIPTION_MAX_CHARS = 200
internal const val LINK_PREVIEW_BODY_MAX_BYTES = 512 * 1024
private const val LINK_PREVIEW_TIMEOUT_MILLIS = 6_000L
private const val LINK_PREVIEW_CACHE_ENTRIES = 64
private const val LINK_PREVIEW_ACCEPT = "text/html, application/xhtml+xml;q=0.9"

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
  client: OkHttpClient = safePublicHttpClient,
  private val timeoutMillis: Long = LINK_PREVIEW_TIMEOUT_MILLIS,
  private val hostPolicy: (HttpUrl) -> Boolean = ::isPubliclyRoutableHost,
) {
  private val webFetcher = SafeWebFetcher(client, timeoutMillis, hostPolicy)

  suspend fun fetch(originalUrl: String): LinkPreviewResult {
    val response =
      webFetcher.fetch(
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

private val chatLinkPreviewFetcher = LinkPreviewFetcher()
internal val chatLinkPreviewStore = LinkPreviewStore(fetcher = chatLinkPreviewFetcher::fetch)

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
  return sanitized.takeUtf16Safe(maxChars).takeIf(String::isNotEmpty)
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
