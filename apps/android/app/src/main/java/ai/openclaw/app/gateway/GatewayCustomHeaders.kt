package ai.openclaw.app.gateway

/**
 * Operator-defined HTTP headers attached to gateway connections so gateways fronted by
 * authenticating reverse proxies (Cloudflare Access-style service tokens) stay reachable.
 * Header values are credentials: persist them only in SecurePrefs and never log them.
 */
object GatewayCustomHeaders {
  // Connection-management headers the WebSocket upgrade owns. Operator overrides here would
  // corrupt the handshake or duplicate fields OkHttp sets itself.
  private val reservedNames =
    setOf("connection", "content-length", "host", "proxy-connection", "upgrade")
  private const val RESERVED_PREFIX = "sec-websocket-"
  private const val TOKEN_PUNCTUATION = "!#$%&'*+-.^_`|~"

  fun isReservedName(name: String): Boolean {
    val normalized = name.trim().lowercase()
    return normalized in reservedNames || normalized.startsWith(RESERVED_PREFIX)
  }

  /**
   * Drops entries that cannot travel as a single well-formed header: empty, reserved, or
   * non-token names, and values outside printable ASCII. Dropping invalid entries keeps one bad
   * stored value from wedging every reconnect or being interpreted differently by a proxy.
   */
  fun sanitized(headers: Map<String, String>): Map<String, String> {
    val result = LinkedHashMap<String, String>()
    for ((rawName, value) in headers) {
      val name = rawName.trim()
      if (name.isEmpty() || isReservedName(name)) continue
      if (!name.all(::isTokenCharacter)) continue
      if (!value.all { it in ' '..'~' }) continue
      result[name] = value
    }
    return result
  }

  private fun isTokenCharacter(character: Char): Boolean =
    character in '0'..'9' ||
      character in 'A'..'Z' ||
      character in 'a'..'z' ||
      character in TOKEN_PUNCTUATION
}
