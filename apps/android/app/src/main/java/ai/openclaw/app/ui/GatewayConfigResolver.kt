package ai.openclaw.app.ui

import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.net.URI
import java.util.Base64
import java.util.Locale

/** Parsed endpoint fields after URL validation and cleartext-safety checks. */
internal data class GatewayEndpointConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
)

/** Decoded setup-code payload; only one credential family is expected to be populated. */
internal data class GatewaySetupCode(
  val url: String,
  val bootstrapToken: String?,
  val token: String?,
  val password: String?,
)

/** Final gateway connection fields selected from setup-code or manual UI input. */
internal data class GatewayConnectConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val bootstrapToken: String,
  val token: String,
  val password: String,
)

/** Validation reason used by setup, QR, and manual endpoint copy. */
internal enum class GatewayEndpointValidationError {
  INVALID_URL,
  INSECURE_REMOTE_URL,
}

/** User input source used to choose endpoint-validation wording. */
internal enum class GatewayEndpointInputSource {
  SETUP_CODE,
  MANUAL,
  QR_SCAN,
}

/** Endpoint parse result that preserves the reason when no usable config exists. */
internal data class GatewayEndpointParseResult(
  val config: GatewayEndpointConfig? = null,
  val error: GatewayEndpointValidationError? = null,
)

/** QR scan result that separates a usable setup code from validation copy. */
internal data class GatewayScannedSetupCodeResult(
  val setupCode: String? = null,
  val error: GatewayEndpointValidationError? = null,
)

private val gatewaySetupJson = Json { ignoreUnknownKeys = true }
private const val remoteGatewaySecurityRule =
  "Public gateways require wss:// or Tailscale Serve. ws:// is allowed for localhost, the Android emulator, and private LAN IPs."
private const val remoteGatewaySecurityFix =
  "Use a private LAN IP for local setup, or enable Tailscale Serve / expose a wss:// gateway URL for remote access."

/** Resolves setup-code or manual UI fields into a connection config. */
internal fun resolveGatewayConnectConfig(
  useSetupCode: Boolean,
  setupCode: String,
  savedManualHost: String,
  savedManualPort: String,
  savedManualTls: Boolean,
  manualHostInput: String,
  manualPortInput: String,
  manualTlsInput: Boolean,
  fallbackBootstrapToken: String,
  fallbackToken: String,
  fallbackPassword: String,
): GatewayConnectConfig? {
  if (useSetupCode) {
    val setup = decodeGatewaySetupCode(setupCode) ?: return null
    val parsed = parseGatewayEndpointResult(setup.url).config ?: return null
    val setupBootstrapToken = setup.bootstrapToken?.trim().orEmpty()
    // Bootstrap setup codes intentionally suppress stale shared credentials;
    // the bootstrap token owns the first authenticated pairing exchange.
    val sharedToken =
      when {
        !setup.token.isNullOrBlank() -> setup.token.trim()
        setupBootstrapToken.isNotEmpty() -> ""
        else -> fallbackToken.trim()
      }
    val sharedPassword =
      when {
        !setup.password.isNullOrBlank() -> setup.password.trim()
        setupBootstrapToken.isNotEmpty() -> ""
        else -> fallbackPassword.trim()
      }
    return GatewayConnectConfig(
      host = parsed.host,
      port = parsed.port,
      tls = parsed.tls,
      bootstrapToken = setupBootstrapToken,
      token = sharedToken,
      password = sharedPassword,
    )
  }

  val manualUrl = composeGatewayManualUrl(manualHostInput, manualPortInput, manualTlsInput) ?: return null
  val parsed = parseGatewayEndpointResult(manualUrl).config ?: return null
  val savedManualEndpoint =
    composeGatewayManualUrl(savedManualHost, savedManualPort, savedManualTls)
      ?.let { parseGatewayEndpointResult(it).config }
  val preserveBootstrapToken =
    savedManualEndpoint != null &&
      savedManualEndpoint.host == parsed.host &&
      savedManualEndpoint.port == parsed.port &&
      savedManualEndpoint.tls == parsed.tls &&
      fallbackToken.isBlank() &&
      fallbackPassword.isBlank()
  return GatewayConnectConfig(
    host = parsed.host,
    port = parsed.port,
    tls = parsed.tls,
    bootstrapToken = if (preserveBootstrapToken) fallbackBootstrapToken.trim() else "",
    token = fallbackToken.trim(),
    password = fallbackPassword.trim(),
  )
}

/** Parses an endpoint string and returns only the valid connection config. */
internal fun parseGatewayEndpoint(rawInput: String): GatewayEndpointConfig? = parseGatewayEndpointResult(rawInput).config

/** Parses and validates gateway endpoint input with user-facing error reasons. */
internal fun parseGatewayEndpointResult(rawInput: String): GatewayEndpointParseResult {
  val raw = rawInput.trim()
  if (raw.isEmpty()) return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)

  val normalized = if (raw.contains("://")) raw else "https://$raw"
  val uri =
    runCatching { URI(normalized) }.getOrNull()
      ?: return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  val host =
    uri.host
      ?.trim()
      ?.trim('[', ']')
      .orEmpty()
  if (host.isEmpty()) return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)

  val scheme =
    uri.scheme
      ?.trim()
      ?.lowercase(Locale.US)
      .orEmpty()
  if (scheme !in setOf("ws", "wss", "http", "https")) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  }
  val tls = scheme == "wss" || scheme == "https"
  if (!tls && !isLocalCleartextGatewayHost(host)) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INSECURE_REMOTE_URL)
  }
  val defaultPort = if (tls) 443 else 18789
  val displayPort = if (tls) 443 else 80
  val port = uri.port.takeIf { it in 1..65535 } ?: defaultPort
  val displayHost = if (host.contains(":")) "[$host]" else host
  val displayUrl =
    if (port == displayPort && defaultPort == displayPort) {
      "${if (tls) "https" else "http"}://$displayHost"
    } else {
      "${if (tls) "https" else "http"}://$displayHost:$port"
    }

  return GatewayEndpointParseResult(
    config = GatewayEndpointConfig(host = host, port = port, tls = tls, displayUrl = displayUrl),
  )
}

/** Decodes base64url setup-code payloads produced by gateway onboarding. */
internal fun decodeGatewaySetupCode(rawInput: String): GatewaySetupCode? {
  val trimmed = rawInput.trim()
  if (trimmed.isEmpty()) return null

  val padded =
    trimmed
      .replace('-', '+')
      .replace('_', '/')
      .let { normalized ->
        val remainder = normalized.length % 4
        if (remainder == 0) normalized else normalized + "=".repeat(4 - remainder)
      }

  return try {
    val decoded = String(Base64.getDecoder().decode(padded), Charsets.UTF_8)
    val obj = parseJsonObject(decoded) ?: return null
    val url = jsonField(obj, "url").orEmpty()
    if (url.isEmpty()) return null
    val bootstrapToken = jsonField(obj, "bootstrapToken")
    val token = jsonField(obj, "token")
    val password = jsonField(obj, "password")
    GatewaySetupCode(url = url, bootstrapToken = bootstrapToken, token = token, password = password)
  } catch (_: IllegalArgumentException) {
    null
  }
}

/** Extracts a setup code from QR scanner text when the embedded endpoint is valid. */
internal fun resolveScannedSetupCode(rawInput: String): String? = resolveScannedSetupCodeResult(rawInput).setupCode

/** Resolves QR scanner text to setup-code or validation error for UI copy. */
internal fun resolveScannedSetupCodeResult(rawInput: String): GatewayScannedSetupCodeResult {
  val setupCode =
    resolveSetupCodeCandidate(rawInput)
      ?: return GatewayScannedSetupCodeResult(error = GatewayEndpointValidationError.INVALID_URL)
  val decoded =
    decodeGatewaySetupCode(setupCode)
      ?: return GatewayScannedSetupCodeResult(error = GatewayEndpointValidationError.INVALID_URL)
  val parsed = parseGatewayEndpointResult(decoded.url)
  if (parsed.config == null) {
    return GatewayScannedSetupCodeResult(error = parsed.error)
  }
  return GatewayScannedSetupCodeResult(setupCode = setupCode)
}

/** Converts endpoint validation errors into setup-source-specific UI copy. */
internal fun gatewayEndpointValidationMessage(
  error: GatewayEndpointValidationError,
  source: GatewayEndpointInputSource,
): String =
  when (error) {
    GatewayEndpointValidationError.INSECURE_REMOTE_URL ->
      when (source) {
        GatewayEndpointInputSource.SETUP_CODE ->
          "Setup code points to an insecure remote gateway. $remoteGatewaySecurityRule $remoteGatewaySecurityFix"
        GatewayEndpointInputSource.QR_SCAN ->
          "QR code points to an insecure remote gateway. $remoteGatewaySecurityRule $remoteGatewaySecurityFix"
        GatewayEndpointInputSource.MANUAL ->
          "$remoteGatewaySecurityRule $remoteGatewaySecurityFix"
      }
    GatewayEndpointValidationError.INVALID_URL ->
      when (source) {
        GatewayEndpointInputSource.SETUP_CODE -> "Setup code has invalid gateway URL."
        GatewayEndpointInputSource.QR_SCAN -> "QR code did not contain a valid setup code."
        GatewayEndpointInputSource.MANUAL -> "Enter a valid manual endpoint to connect."
      }
  }

/** Builds a URL from manual host/port/tls fields for shared endpoint parsing. */
internal fun composeGatewayManualUrl(
  hostInput: String,
  portInput: String,
  tls: Boolean,
): String? {
  val host = hostInput.trim()
  if (host.isEmpty()) return null
  val portTrimmed = portInput.trim()
  val port =
    if (portTrimmed.isEmpty()) {
      if (tls) 443 else return null
    } else {
      portTrimmed.toIntOrNull() ?: return null
    }
  if (port !in 1..65535) return null
  val scheme = if (tls) "https" else "http"
  return "$scheme://$host:$port"
}

private fun parseJsonObject(input: String): JsonObject? = runCatching { gatewaySetupJson.parseToJsonElement(input).jsonObject }.getOrNull()

private fun resolveSetupCodeCandidate(rawInput: String): String? {
  val trimmed = rawInput.trim()
  if (trimmed.isEmpty()) return null
  val qrSetupCode = parseJsonObject(trimmed)?.let { jsonField(it, "setupCode") }
  return qrSetupCode ?: trimmed
}

private fun jsonField(
  obj: JsonObject,
  key: String,
): String? {
  val value = (obj[key] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
  return value.ifEmpty { null }
}
