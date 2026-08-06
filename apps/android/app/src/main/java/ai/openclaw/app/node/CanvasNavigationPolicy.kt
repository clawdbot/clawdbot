package ai.openclaw.app.node

import java.net.InetAddress
import java.net.URI

/** Shared policy for gateway-driven loads and WebView main-frame navigations. */
internal object CanvasNavigationPolicy {
  fun normalize(rawUrl: String): String {
    val trimmed = rawUrl.trim()
    if (trimmed.isBlank() || trimmed == "/") return ""
    return trimmed.takeUnless(::shouldBlock).orEmpty()
  }

  fun shouldBlock(rawUrl: String): Boolean {
    val trimmed = rawUrl.trim()
    if (trimmed.isBlank() || trimmed == "/") return false
    val target = parseTarget(trimmed)
    val isWebUrl = target.scheme == "http" || target.scheme == "https"
    if (isWebUrl && (target.host.isEmpty() || isMalformedWebHost(target.host))) return true
    return target.host.isNotEmpty() && isDeviceLocalHost(target.host)
  }

  /** WebView does not expose POST redirects to shouldOverrideUrlLoading; fail closed before dispatch. */
  fun shouldBlockNonGetMainFrame(
    method: String,
    isForMainFrame: Boolean,
  ): Boolean = isForMainFrame && !method.equals("GET", ignoreCase = true)

  private data class Target(
    val scheme: String,
    val host: String,
  )

  private fun parseTarget(rawUrl: String): Target {
    val parsed = runCatching { URI(rawUrl) }.getOrNull()
    val scheme =
      parsed
        ?.scheme
        ?.trim()
        ?.lowercase()
        .orEmpty()
        .ifBlank { rawScheme(rawUrl) }
    val host =
      parsed
        ?.host
        ?.trim()
        .orEmpty()
        .ifBlank { authorityHost(parsed?.rawAuthority ?: rawAuthority(rawUrl)) }
    return Target(scheme = scheme, host = percentDecodeAscii(host))
  }

  private fun rawScheme(rawUrl: String): String {
    val schemeSeparator = rawUrl.indexOf("://")
    val colonSeparator = rawUrl.indexOf(':')
    val end =
      when {
        schemeSeparator > 0 -> schemeSeparator
        colonSeparator > 0 -> colonSeparator
        else -> return ""
      }
    val candidate = rawUrl.substring(0, end).trim().lowercase()
    return candidate
      .takeIf {
        it.all { char ->
          char in 'a'..'z' || char in '0'..'9' || char == '+' || char == '-' || char == '.'
        }
      }.orEmpty()
  }

  private fun rawAuthority(rawUrl: String): String? {
    val schemeSeparator = rawUrl.indexOf("://")
    if (schemeSeparator < 0) return null
    val authorityStart = schemeSeparator + 3
    val authorityEnd =
      rawUrl
        .indexOfAny(charArrayOf('/', '\\', '?', '#'), startIndex = authorityStart)
        .takeIf { it >= 0 }
        ?: rawUrl.length
    return rawUrl.substring(authorityStart, authorityEnd)
  }

  private fun authorityHost(rawAuthority: String?): String {
    val authority = rawAuthority?.trim().orEmpty()
    if (authority.isEmpty()) return ""
    val hostPort = authority.substringAfterLast('@')
    if (hostPort.startsWith("[")) {
      return hostPort.substringAfter('[').substringBefore(']')
    }
    return if (hostPort.count { it == ':' } == 1) hostPort.substringBefore(':') else hostPort
  }

  private fun percentDecodeAscii(value: String): String {
    if (!value.contains('%')) return value
    val out = StringBuilder(value.length)
    var index = 0
    while (index < value.length) {
      if (value[index] == '%' && index + 2 < value.length) {
        val byte = value.substring(index + 1, index + 3).toIntOrNull(16)
        if (byte != null) {
          out.append(byte.toChar())
          index += 3
          continue
        }
      }
      out.append(value[index])
      index += 1
    }
    return out.toString()
  }

  private fun isMalformedWebHost(rawHost: String): Boolean =
    // Chromium applies UTS #46 before resolving special-scheme hosts. Reject raw Unicode here so
    // compatibility characters cannot become localhost or a loopback IP after this check.
    rawHost.any { char ->
      char <= ' ' ||
        char.code > 0x7f ||
        char == '/' ||
        char == '\\' ||
        char == '?' ||
        char == '#' ||
        char == '@'
    } ||
      rawHost.contains('%')

  private fun isDeviceLocalHost(rawHost: String): Boolean {
    var host =
      rawHost
        .trim()
        .lowercase()
        .trim('[', ']')
        .trimEnd('.')
    host = host.substringBefore('%')
    if (host == "localhost" || host.endsWith(".localhost")) return true

    parseWebViewIpv4Address(host)?.let { address ->
      return address == 0L || ((address ushr 24) and 0xffL) == 127L
    }

    if (!host.contains(':') || !host.all(::isIpv6LiteralChar)) return false
    val address = runCatching { InetAddress.getByName(host).address }.getOrNull() ?: return false
    if (address.size == 4) {
      return address.all { it == 0.toByte() } || address[0] == 127.toByte()
    }
    if (address.size != 16) return false
    if (address.all { it == 0.toByte() }) return true
    if (address.copyOfRange(0, 15).all { it == 0.toByte() } && address[15] == 1.toByte()) return true

    val mappedPrefix =
      address.copyOfRange(0, 10).all { it == 0.toByte() } &&
        address[10] == 0xff.toByte() &&
        address[11] == 0xff.toByte()
    val compatiblePrefix = address.copyOfRange(0, 12).all { it == 0.toByte() }
    return (mappedPrefix || compatiblePrefix) &&
      (address[12] == 127.toByte() || address.copyOfRange(12, 16).all { it == 0.toByte() })
  }

  private fun isIpv6LiteralChar(char: Char): Boolean = char == ':' || char == '.' || char in '0'..'9' || char.lowercaseChar() in 'a'..'f'

  /** Matches Chromium/WebView's accepted decimal, octal, hex, and shorthand IPv4 forms. */
  private fun parseWebViewIpv4Address(rawHost: String): Long? {
    val host = rawHost.trim().lowercase().trimEnd('.')
    if (host.isEmpty() || host.contains(':') || host.contains('%')) return null
    val parts = host.split('.')
    if (parts.size !in 1..4 || parts.any { it.isEmpty() }) return null
    val numbers = parts.map { parseWebViewIpv4Number(it) ?: return null }
    if (numbers.dropLast(1).any { it > 255L }) return null
    val lastMax =
      when (numbers.size) {
        1 -> 0xffffffffL
        2 -> 0x00ffffffL
        3 -> 0x0000ffffL
        else -> 0xffL
      }
    val last = numbers.last()
    if (last > lastMax) return null
    return when (numbers.size) {
      1 -> last
      2 -> (numbers[0] shl 24) or last
      3 -> (numbers[0] shl 24) or (numbers[1] shl 16) or last
      else -> (numbers[0] shl 24) or (numbers[1] shl 16) or (numbers[2] shl 8) or last
    }
  }

  private fun parseWebViewIpv4Number(raw: String): Long? {
    val normalized = raw.trim().lowercase()
    if (normalized.isEmpty()) return null
    val (digits, radix) =
      when {
        normalized.startsWith("0x") -> normalized.drop(2) to 16
        normalized.length > 1 && normalized.startsWith("0") -> normalized.drop(1) to 8
        else -> normalized to 10
      }
    if (digits.isEmpty()) return 0L
    return digits.toLongOrNull(radix)
  }
}
