package ai.openclaw.app.ui

import ai.openclaw.app.gateway.isLoopbackGatewayHost
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.net.URI
import java.util.Base64
import java.util.Locale

internal data class GatewayEndpointConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
)

internal data class GatewaySetupCode(
  val url: String,
  val bootstrapToken: String?,
  val token: String?,
  val password: String?,
)

internal data class GatewayConnectConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val bootstrapToken: String,
  val token: String,
  val password: String,
)

internal enum class GatewayEndpointValidationError {
  INVALID_URL,
  INSECURE_REMOTE_URL,
}

internal enum class GatewayEndpointInputSource {
  SETUP_CODE,
  MANUAL,
  QR_SCAN,
}

internal data class GatewayEndpointParseResult(
  val config: GatewayEndpointConfig? = null,
  val error: GatewayEndpointValidationError? = null,
)

internal data class GatewayScannedSetupCodeResult(
  val setupCode: String? = null,
  val error: GatewayEndpointValidationError? = null,
)

private val gatewaySetupJson = Json { ignoreUnknownKeys = true }
private const val remoteGatewaySecurityRule =
  "Tailscale and public mobile nodes require wss:// or Tailscale Serve. ws:// is allowed only for localhost and the Android emulator."
private const val remoteGatewaySecurityFix =
  "Use localhost/the Android emulator, or enable Tailscale Serve / expose a wss:// gateway URL."

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

internal fun parseGatewayEndpoint(rawInput: String): GatewayEndpointConfig? = parseGatewayEndpointResult(rawInput).config

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
  val tls =
    when (scheme) {
      "ws", "http" -> false
      "wss", "https" -> true
      else -> true
    }
  if (!tls && !isLoopbackGatewayHost(host)) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INSECURE_REMOTE_URL)
  }
  val defaultPort =
    when (scheme) {
      "wss", "https" -> 443
      "ws", "http" -> 18789
      else -> 443
    }
  val displayPort =
    when (scheme) {
      "wss", "https" -> 443
      "ws", "http" -> 80
      else -> 443
    }
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

internal fun resolveScannedSetupCode(rawInput: String): String? = resolveScannedSetupCodeResult(rawInput).setupCode

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
