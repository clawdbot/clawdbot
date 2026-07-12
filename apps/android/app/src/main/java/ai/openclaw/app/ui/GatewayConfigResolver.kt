package ai.openclaw.app.ui

import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
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

/** Effective transport shown by manual gateway forms before they connect. */
internal data class GatewayManualTransportPresentation(
  val requiresTls: Boolean,
  val effectiveTls: Boolean,
  val helperText: String?,
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

/** How a connection attempt may update credentials already owned by the runtime. */
internal enum class GatewaySavedAuthAction {
  PRESERVE,
  REPLACE_CREDENTIALS,
  REPLACE_ENDPOINT,
  REPLACE_SETUP,
}

/** Endpoint plus the credential ownership decision applied by MainViewModel. */
internal data class GatewayConnectPlan(
  val config: GatewayConnectConfig,
  val savedAuthAction: GatewaySavedAuthAction,
)

/** Validation reason used by setup, QR, and manual endpoint copy. */
internal enum class GatewayEndpointValidationError {
  INVALID_URL,
  INSECURE_REMOTE_URL,
  IPV6_ZONE_ID_UNSUPPORTED,
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

private fun remoteGatewaySecurityRuleText(): NativeText =
  nativeText(
    "Public gateways require wss:// or Tailscale Serve. ws:// is allowed for localhost, .local hosts, the Android emulator, and private LAN IPs.",
  )

private fun remoteGatewaySecurityFixText(): NativeText =
  nativeText(
    "Use a private LAN IP for local setup, or enable Tailscale Serve / expose a wss:// gateway URL for remote access.",
  )

/** Resolves setup-code or manual UI fields without reading stored credentials. */
internal fun resolveGatewayConnectConfig(
  useSetupCode: Boolean,
  setupCode: String,
  manualHostInput: String,
  manualPortInput: String,
  manualTlsInput: Boolean,
  bootstrapTokenInput: String,
  tokenInput: String,
  passwordInput: String,
): GatewayConnectConfig? {
  if (useSetupCode) {
    val setup = resolveSetupCodeCandidate(setupCode)?.let(::decodeGatewaySetupCode) ?: return null
    val parsed = parseGatewayEndpointResult(setup.url).config ?: return null
    val setupBootstrapToken =
      setup.bootstrapToken
        ?.trim()
        .orEmpty()
        .ifEmpty { bootstrapTokenInput.trim() }
    // Bootstrap setup codes intentionally suppress stale shared credentials;
    // the bootstrap token owns the first authenticated pairing exchange.
    val sharedToken =
      when {
        !setup.token.isNullOrBlank() -> setup.token.trim()
        setupBootstrapToken.isNotEmpty() -> ""
        else -> tokenInput.trim()
      }
    val sharedPassword =
      when {
        !setup.password.isNullOrBlank() -> setup.password.trim()
        setupBootstrapToken.isNotEmpty() || sharedToken.isNotEmpty() -> ""
        else -> passwordInput.trim()
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
  val token = tokenInput.trim()
  val bootstrapToken = bootstrapTokenInput.trim().takeIf { token.isEmpty() }.orEmpty()
  val password = passwordInput.trim().takeIf { token.isEmpty() && bootstrapToken.isEmpty() }.orEmpty()
  return GatewayConnectConfig(
    host = parsed.host,
    port = parsed.port,
    tls = parsed.tls,
    bootstrapToken = bootstrapToken,
    token = token,
    password = password,
  )
}

/**
 * Produces one closed endpoint/auth plan. Blank auth fields preserve secrets
 * only for the saved endpoint; neither Compose nor this resolver reads them.
 */
internal fun resolveGatewayConnectPlan(
  useSetupCode: Boolean,
  setupCode: String,
  savedManualHost: String,
  savedManualPort: String,
  savedManualTls: Boolean,
  manualHostInput: String,
  manualPortInput: String,
  manualTlsInput: Boolean,
  tokenInput: String,
  bootstrapTokenInput: String,
  passwordInput: String,
): GatewayConnectPlan? {
  val config =
    resolveGatewayConnectConfig(
      useSetupCode = useSetupCode,
      setupCode = setupCode,
      manualHostInput = manualHostInput,
      manualPortInput = manualPortInput,
      manualTlsInput = manualTlsInput,
      tokenInput = tokenInput,
      bootstrapTokenInput = bootstrapTokenInput,
      passwordInput = passwordInput,
    ) ?: return null
  if (useSetupCode) {
    return GatewayConnectPlan(config, GatewaySavedAuthAction.REPLACE_SETUP)
  }
  if (config.bootstrapToken.isNotEmpty()) {
    // Bootstrap auth requests a fresh pairing exchange. Retained role tokens
    // would otherwise win before the bootstrap credential is attempted.
    return GatewayConnectPlan(config, GatewaySavedAuthAction.REPLACE_SETUP)
  }

  val savedManualEndpoint =
    composeGatewayManualUrl(savedManualHost, savedManualPort, savedManualTls)
      ?.let { parseGatewayEndpointResult(it).config }
  val action =
    when {
      savedManualEndpoint?.sameEndpoint(config) != true -> GatewaySavedAuthAction.REPLACE_ENDPOINT
      config.token.isNotEmpty() || config.password.isNotEmpty() -> GatewaySavedAuthAction.REPLACE_CREDENTIALS
      else -> GatewaySavedAuthAction.PRESERVE
    }
  return GatewayConnectPlan(config, action)
}

private fun GatewayEndpointConfig.sameEndpoint(config: GatewayConnectConfig): Boolean = host.equals(config.host, ignoreCase = true) && port == config.port && tls == config.tls

/** Parses an endpoint string and returns only the valid connection config. */
internal fun parseGatewayEndpoint(rawInput: String): GatewayEndpointConfig? = parseGatewayEndpointResult(rawInput).config

/** Parses and validates gateway endpoint input with user-facing error reasons. */
internal fun parseGatewayEndpointResult(rawInput: String): GatewayEndpointParseResult {
  val raw = rawInput.trim()
  if (raw.isEmpty()) return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)

  val normalized = if (raw.contains("://")) raw else "https://$raw"
  val uri =
    runCatching { URI(normalized) }
      .getOrNull()
      ?: return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  val host =
    uri.host
      ?.trim()
      ?.trim('[', ']')
      .orEmpty()
  if (host.isEmpty()) return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  // OkHttp rejects scoped IPv6 hosts after URI decoding, so fail before saving an endpoint that can never dial.
  if (host.contains(':') && host.contains('%')) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED)
  }

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
  val port = gatewayPort(uri.port, defaultPort) ?: return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
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

internal fun manualTokenLooksLikeSetupCode(rawInput: String): Boolean = resolveSetupCodeCandidate(rawInput)?.let(::decodeGatewaySetupCode) != null

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
): String = gatewayEndpointValidationText(error, source).resolveNativeText()

internal fun gatewayEndpointValidationText(
  error: GatewayEndpointValidationError,
  source: GatewayEndpointInputSource,
): NativeText =
  when (error) {
    GatewayEndpointValidationError.INSECURE_REMOTE_URL ->
      when (source) {
        GatewayEndpointInputSource.SETUP_CODE ->
          nativeText(
            "Setup code points to an insecure remote gateway. \$remoteGatewaySecurityRule \$remoteGatewaySecurityFix",
            remoteGatewaySecurityRuleText(),
            remoteGatewaySecurityFixText(),
          )
        GatewayEndpointInputSource.QR_SCAN ->
          nativeText(
            "QR code points to an insecure remote gateway. \$remoteGatewaySecurityRule \$remoteGatewaySecurityFix",
            remoteGatewaySecurityRuleText(),
            remoteGatewaySecurityFixText(),
          )
        GatewayEndpointInputSource.MANUAL ->
          nativeText(
            "\$remoteGatewaySecurityRule \$remoteGatewaySecurityFix",
            remoteGatewaySecurityRuleText(),
            remoteGatewaySecurityFixText(),
          )
      }
    GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED ->
      when (source) {
        GatewayEndpointInputSource.SETUP_CODE ->
          nativeText("Setup code uses an IPv6 zone ID. Use an unscoped IPv6 address or a LAN hostname.")
        GatewayEndpointInputSource.QR_SCAN ->
          nativeText("QR code uses an IPv6 zone ID. Use an unscoped IPv6 address or a LAN hostname.")
        GatewayEndpointInputSource.MANUAL ->
          nativeText("IPv6 zone IDs are not supported. Use an unscoped IPv6 address or a LAN hostname.")
      }
    GatewayEndpointValidationError.INVALID_URL ->
      when (source) {
        GatewayEndpointInputSource.SETUP_CODE -> nativeText("Setup code has invalid gateway URL.")
        GatewayEndpointInputSource.QR_SCAN -> nativeText("QR code did not contain a valid setup code.")
        GatewayEndpointInputSource.MANUAL -> nativeText("Enter a valid manual endpoint to connect.")
      }
  }

private const val defaultManualGatewayPort = 18789
private const val tailnetTlsGatewayPort = 443

private fun gatewayPort(
  port: Int,
  defaultPort: Int,
): Int? =
  when {
    port == -1 -> defaultPort
    port in 1..65535 -> port
    else -> null
  }

/** Resolves the manual port default shared by onboarding, settings, and the Connect tab. */
internal fun resolveDefaultManualGatewayPort(
  hostInput: String,
  tls: Boolean,
): Int {
  val host =
    hostInput
      .trim()
      .trimEnd('/')
      .removeSuffix(".")
      .lowercase(Locale.US)
  return if (tls && host.endsWith(".ts.net")) tailnetTlsGatewayPort else defaultManualGatewayPort
}

/** Builds a URL from manual host/port/tls fields for shared endpoint parsing. */
internal fun composeGatewayManualUrl(
  hostInput: String,
  portInput: String,
  tls: Boolean,
): String? {
  val host = hostInput.trim()
  if (host.isEmpty()) return null
  // A pasted endpoint is already a complete authority; its scheme and port
  // must not be silently replaced by stale values from the separate controls.
  if (host.contains("://")) {
    val parsed = parseGatewayEndpointResult(host)
    return host.takeUnless { parsed.error == GatewayEndpointValidationError.INVALID_URL }
  }
  val bareHost = host.trimEnd('/')
  if (bareHost.isEmpty() || bareHost.contains('/')) return null
  val portTrimmed = portInput.trim()
  val port =
    if (portTrimmed.isEmpty()) {
      resolveDefaultManualGatewayPort(bareHost, tls)
    } else {
      portTrimmed.toIntOrNull() ?: return null
    }
  if (port !in 1..65535) return null
  val scheme = if (tls) "https" else "http"
  return "$scheme://${ai.openclaw.app.gateway.formatGatewayAuthority(bareHost, port)}"
}

/** Keeps manual transport controls aligned with the runtime's remote-host TLS policy. */
internal fun gatewayManualTransportPresentation(
  hostInput: String,
  requestedTls: Boolean,
): GatewayManualTransportPresentation {
  val host = hostInput.trim()
  if (host.isEmpty()) {
    return gatewayManualTransportPresentation(
      requiresTls = false,
      effectiveTls = requestedTls,
    )
  }

  if (host.contains("://")) {
    val config = parseGatewayEndpointResult(host).config
    if (config != null) {
      return gatewayManualTransportPresentation(
        requiresTls = !isLocalCleartextGatewayHost(config.host),
        effectiveTls = config.tls,
      )
    }
  }

  val normalizedHost = host.trimEnd('/')
  val requiresTls = !isLocalCleartextGatewayHost(normalizedHost)
  val effectiveTls = requestedTls || requiresTls
  return gatewayManualTransportPresentation(
    requiresTls = requiresTls,
    effectiveTls = effectiveTls,
  )
}

private fun gatewayManualTransportPresentation(
  requiresTls: Boolean,
  effectiveTls: Boolean,
): GatewayManualTransportPresentation =
  GatewayManualTransportPresentation(
    requiresTls = requiresTls,
    effectiveTls = effectiveTls,
    helperText =
      when {
        requiresTls -> nativeString("Secure connection is required for this host.")
        effectiveTls -> null
        else -> nativeString("Use only on a trusted private network.")
      },
  )

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
