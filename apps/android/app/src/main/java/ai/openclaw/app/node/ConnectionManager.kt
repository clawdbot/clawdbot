package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.LocationMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewayClientInfo
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.gateway.isLoopbackGatewayHost
import android.os.Build

/**
 * Builds gateway connect metadata from current Android permissions, settings, and device identity.
 */
class ConnectionManager(
  private val prefs: SecurePrefs,
  private val cameraEnabled: () -> Boolean,
  private val locationMode: () -> LocationMode,
  private val motionActivityAvailable: () -> Boolean,
  private val motionPedometerAvailable: () -> Boolean,
  private val sendSmsAvailable: () -> Boolean,
  private val readSmsAvailable: () -> Boolean,
  private val smsSearchPossible: () -> Boolean,
  private val callLogAvailable: () -> Boolean,
  private val photosAvailable: () -> Boolean,
  private val installedAppsSharingEnabled: () -> Boolean,
  private val voiceWakeAvailable: () -> Boolean,
  private val mobileUiAvailable: () -> Boolean,
  private val inlineWidgetsAvailable: () -> Boolean,
  private val manualTls: (GatewayEndpoint) -> Boolean,
) {
  companion object {
    internal val legacyOperatorScopes: List<String> =
      listOf(
        "operator.approvals",
        "operator.read",
        "operator.write",
      )

    internal val nativeClientOperatorScopes: List<String> =
      listOf(
        // admin matches iOS fresh token/password connects and is required for
        // sessions.patch (model switching); stored tokens keep their granted scopes.
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      )

    internal const val AGENT_KIND_CLIENT_CAPABILITY = "agent-kind"
    internal const val INLINE_WIDGETS_CLIENT_CAPABILITY = "inline-widgets"

    internal fun operatorScopesForStoredDeviceToken(storedScopes: List<String>): List<String> {
      val normalized =
        storedScopes
          .map { it.trim() }
          .filter { it.isNotEmpty() }
          .distinct()
      return normalized.ifEmpty { legacyOperatorScopes }
    }

    /**
     * Decide whether a discovered/manual endpoint must use pinned TLS or can stay local cleartext.
     */
    internal fun resolveTlsParamsForEndpoint(
      endpoint: GatewayEndpoint,
      storedFingerprint: String?,
      manualTlsEnabled: Boolean,
    ): GatewayTlsParams? {
      val stableId = endpoint.stableId
      val stored = storedFingerprint?.trim().takeIf { !it.isNullOrEmpty() }
      val isManual = stableId.startsWith("manual|")
      val cleartextAllowedHost =
        if (isManual) {
          isLocalCleartextGatewayHost(endpoint.host)
        } else {
          isLoopbackGatewayHost(endpoint.host)
        }

      if (isManual) {
        // Manual remote hosts default to TLS; only local manual hosts may honor the cleartext toggle.
        if (!manualTlsEnabled && cleartextAllowedHost) return null
        if (!stored.isNullOrBlank()) {
          return GatewayTlsParams(
            required = true,
            expectedFingerprint = stored,
            allowTOFU = false,
            stableId = stableId,
          )
        }
        return GatewayTlsParams(
          required = true,
          expectedFingerprint = null,
          allowTOFU = false,
          stableId = stableId,
        )
      }

      // Prefer stored pins. Never let discovery-provided TXT override a stored fingerprint.
      if (!stored.isNullOrBlank()) {
        return GatewayTlsParams(
          required = true,
          expectedFingerprint = stored,
          allowTOFU = false,
          stableId = stableId,
        )
      }

      val hinted = endpoint.tlsEnabled || !endpoint.tlsFingerprintSha256.isNullOrBlank()
      if (hinted) {
        // TXT is unauthenticated. Do not treat the advertised fingerprint as authoritative.
        return GatewayTlsParams(
          required = true,
          expectedFingerprint = null,
          allowTOFU = false,
          stableId = stableId,
        )
      }

      if (!cleartextAllowedHost) {
        // Non-loopback discovered hosts require TLS even without TXT hints.
        return GatewayTlsParams(
          required = true,
          expectedFingerprint = null,
          allowTOFU = false,
          stableId = stableId,
        )
      }

      return null
    }
  }

  private fun runtimeFlags(): NodeRuntimeFlags =
    NodeRuntimeFlags(
      cameraEnabled = cameraEnabled(),
      locationEnabled = locationMode() != LocationMode.Off,
      sendSmsAvailable = sendSmsAvailable(),
      readSmsAvailable = readSmsAvailable(),
      smsSearchPossible = smsSearchPossible(),
      callLogAvailable = callLogAvailable(),
      photosAvailable = photosAvailable(),
      motionActivityAvailable = motionActivityAvailable(),
      motionPedometerAvailable = motionPedometerAvailable(),
      installedAppsSharingEnabled = installedAppsSharingEnabled(),
      debugBuild = BuildConfig.DEBUG,
      voiceWakeEnabled = prefs.voiceWakeEnabled.value && voiceWakeAvailable(),
      mobileUiAvailable = mobileUiAvailable(),
    )

  /** Builds the gateway-advertised node.invoke command list from current permission and feature state. */
  fun buildInvokeCommands(): List<String> = InvokeCommandRegistry.advertisedCommands(runtimeFlags())

  /** Builds the gateway-advertised capability list from current permission and feature state. */
  fun buildCapabilities(): List<String> = InvokeCommandRegistry.advertisedCapabilities(runtimeFlags())

  /**
   * Debug Android builds advertise a dev version so gateway logs do not look like release clients.
   */
  fun resolvedVersionName(): String {
    val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
    return if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
      "$versionName-dev"
    } else {
      versionName
    }
  }

  /** Human-readable Android device model used in gateway client metadata. */
  fun resolveModelIdentifier(): String? =
    listOfNotNull(Build.MANUFACTURER, Build.MODEL)
      .joinToString(" ")
      .trim()
      .ifEmpty { null }

  /**
   * User-Agent used for gateway telemetry and troubleshooting.
   */
  fun buildUserAgent(): String {
    val version = resolvedVersionName()
    val release =
      Build.VERSION.RELEASE
        ?.trim()
        .orEmpty()
    val releaseLabel = if (release.isEmpty()) "unknown" else release
    return "OpenClawAndroid/$version (Android $releaseLabel; SDK ${Build.VERSION.SDK_INT})"
  }

  /** Client identity block shared by node and operator gateway sessions. */
  fun buildClientInfo(
    clientId: String,
    clientMode: String,
  ): GatewayClientInfo =
    GatewayClientInfo(
      id = clientId,
      displayName = prefs.displayName.value,
      version = resolvedVersionName(),
      platform = "android",
      mode = clientMode,
      instanceId = prefs.instanceId.value,
      deviceFamily = "Android",
      modelIdentifier = resolveModelIdentifier(),
    )

  /** Connect options for the Android node session that exposes phone capabilities. */
  fun buildNodeConnectOptions(): GatewayConnectOptions =
    GatewayConnectOptions(
      role = "node",
      scopes = emptyList(),
      caps = buildCapabilities(),
      commands = buildInvokeCommands(),
      permissions = emptyMap(),
      client = buildClientInfo(clientId = "openclaw-android", clientMode = "node"),
      userAgent = buildUserAgent(),
    )

  /** Connect options for the Android operator session that drives approvals and UI actions. */
  fun buildOperatorConnectOptions(
    scopes: List<String> = nativeClientOperatorScopes,
  ): GatewayConnectOptions =
    GatewayConnectOptions(
      role = "operator",
      scopes = scopes,
      caps =
        buildList {
          add(AGENT_KIND_CLIENT_CAPABILITY)
          if (inlineWidgetsAvailable()) add(INLINE_WIDGETS_CLIENT_CAPABILITY)
        },
      commands = emptyList(),
      permissions = emptyMap(),
      client = buildClientInfo(clientId = "openclaw-android", clientMode = "ui"),
      userAgent = buildUserAgent(),
    )

  /** Resolves persisted TLS pin policy for a concrete gateway endpoint. */
  fun resolveTlsParams(endpoint: GatewayEndpoint): GatewayTlsParams? {
    val stored = prefs.loadGatewayTlsFingerprint(endpoint.stableId)
    return resolveTlsParamsForEndpoint(endpoint, storedFingerprint = stored, manualTlsEnabled = manualTls(endpoint))
  }
}
