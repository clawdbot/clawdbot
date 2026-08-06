@file:Suppress("DEPRECATION")

package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayCustomHeaders
import ai.openclaw.app.gateway.GatewayRegistryStore
import ai.openclaw.app.gateway.GatewayStoreMigration
import ai.openclaw.app.voice.VoiceWakePreferences
import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

@Serializable
data class GatewayCredentials(
  val token: String? = null,
  val bootstrapToken: String? = null,
  val password: String? = null,
) {
  internal fun normalized(): GatewayCredentials =
    copy(
      token = token?.trim()?.takeIf { it.isNotEmpty() },
      bootstrapToken = bootstrapToken?.trim()?.takeIf { it.isNotEmpty() },
      password = password?.trim()?.takeIf { it.isNotEmpty() },
    )
}

/**
 * Reactive settings facade for Android node preferences and encrypted gateway credentials.
 */
class SecurePrefs(
  context: Context,
  private val securePrefsOverride: SharedPreferences? = null,
) {
  companion object {
    private const val displayNameKey = "node.displayName"
    private const val locationModeKey = "location.enabledMode"
    private const val plainPrefsName = "openclaw.node"
    private const val securePrefsName = "openclaw.node.secure"
    private const val notificationsForwardingEnabledKey = "notifications.forwarding.enabled"
    private const val defaultNotificationForwardingEnabled = false
    private const val notificationsForwardingModeKey = "notifications.forwarding.mode"
    private const val notificationsForwardingPackagesKey = "notifications.forwarding.packages"
    private const val notificationsForwardingQuietHoursEnabledKey =
      "notifications.forwarding.quietHoursEnabled"
    private const val notificationsForwardingQuietStartKey = "notifications.forwarding.quietStart"
    private const val notificationsForwardingQuietEndKey = "notifications.forwarding.quietEnd"
    private const val notificationsForwardingMaxEventsPerMinuteKey =
      "notifications.forwarding.maxEventsPerMinute"
    private const val notificationsForwardingSessionKeyPrefix = "notifications.forwarding.sessionKey"
    private const val installedAppsSharingEnabledKey = "device.apps.sharing.enabled"
    private const val installedAppsDisclosureConsentVersionKey =
      "device.apps.prominentDisclosure.consentVersion"
    private const val currentInstalledAppsDisclosureConsentVersion = 1
    private const val accessibilityControlEnabledKey = "mobileUi.accessibilityControl.enabled"
    private const val cameraEnabledKey = "camera.enabled"
    private const val preferredCameraFacingKey = "camera.preferredFacing"
    private const val voiceMicEnabledKey = "voice.micEnabled"
    private const val preferredAudioInputDeviceKey = "voice.preferredAudioInputDevice"
    private const val voiceWakeEnabledKey = "voiceWake.enabled"
    private const val voiceWakeWordsKey = "voiceWake.triggerWords"
    private const val appearanceThemeModeKey = "appearance.themeMode"
    private const val chatModelFavoritesKey = "chat.modelFavorites"
    private const val chatModelRecentsKey = "chat.modelRecents"
    private const val sessionCustomGroupsKey = "sessions.customGroups"
    private const val maxChatModelRecents = 5
    private const val gatewayCustomHeadersKeyPrefix = "gateway.customHeaders."
  }

  private val appContext = context.applicationContext
  private val json = Json { ignoreUnknownKeys = true }

  // Non-secret UI/runtime preferences stay readable for migration and backup behavior.
  private val plainPrefs: SharedPreferences =
    appContext.getSharedPreferences(plainPrefsName, Context.MODE_PRIVATE)
  private val hadPlainPrefsBeforeInit = plainPrefs.all.isNotEmpty()

  // Gateway credentials and arbitrary secret strings are isolated behind EncryptedSharedPreferences.
  private val masterKey by lazy {
    MasterKey
      .Builder(appContext)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
  }
  private val securePrefs: SharedPreferences by lazy { securePrefsOverride ?: createSecurePrefs(appContext, securePrefsName) }

  private val _instanceId = MutableStateFlow(loadOrCreateInstanceId())
  val instanceId: StateFlow<String> = _instanceId

  // Lazy so plain-preference reads never touch the encrypted store (Robolectric
  // has no AndroidKeyStore); the one-time legacy migration runs before the first
  // gateway-state read, which is the earliest the registry can be observed.
  val gatewayRegistry: GatewayRegistryStore by lazy {
    GatewayStoreMigration(this).run()
    GatewayRegistryStore(this, ::handleActiveGatewayChanged)
  }

  private val _displayName =
    MutableStateFlow(loadOrMigrateDisplayName(context = context))
  val displayName: StateFlow<String> = _displayName

  private val _cameraEnabled = MutableStateFlow(loadCameraEnabled())
  val cameraEnabled: StateFlow<Boolean> = _cameraEnabled

  private val _locationMode = MutableStateFlow(loadLocationMode())
  val locationMode: StateFlow<LocationMode> = _locationMode

  private val _locationPreciseEnabled =
    MutableStateFlow(plainPrefs.getBoolean("location.preciseEnabled", true))
  val locationPreciseEnabled: StateFlow<Boolean> = _locationPreciseEnabled

  private val _preventSleep = MutableStateFlow(plainPrefs.getBoolean("screen.preventSleep", true))
  val preventSleep: StateFlow<Boolean> = _preventSleep

  private val _manualEnabled =
    MutableStateFlow(plainPrefs.getBoolean("gateway.manual.enabled", false))
  val manualEnabled: StateFlow<Boolean> = _manualEnabled

  private val _manualHost =
    MutableStateFlow(plainPrefs.getString("gateway.manual.host", "") ?: "")
  val manualHost: StateFlow<String> = _manualHost

  private val _manualPort =
    MutableStateFlow(plainPrefs.getInt("gateway.manual.port", 18789))
  val manualPort: StateFlow<Int> = _manualPort

  private val _manualTls =
    MutableStateFlow(plainPrefs.getBoolean("gateway.manual.tls", true))
  val manualTls: StateFlow<Boolean> = _manualTls

  private val _onboardingCompleted =
    MutableStateFlow(plainPrefs.getBoolean("onboarding.completed", false))
  val onboardingCompleted: StateFlow<Boolean> = _onboardingCompleted

  private val _lastDiscoveredStableId =
    MutableStateFlow(
      plainPrefs.getString("gateway.lastDiscoveredStableID", "") ?: "",
    )
  val lastDiscoveredStableId: StateFlow<String> = _lastDiscoveredStableId

  private val _canvasDebugStatusEnabled =
    MutableStateFlow(plainPrefs.getBoolean("canvas.debugStatusEnabled", false))
  val canvasDebugStatusEnabled: StateFlow<Boolean> = _canvasDebugStatusEnabled

  private val _installedAppsSharingEnabled =
    MutableStateFlow(loadInstalledAppsSharingEnabled())
  val installedAppsSharingEnabled: StateFlow<Boolean> = _installedAppsSharingEnabled

  private val _accessibilityControlEnabled =
    MutableStateFlow(plainPrefs.getBoolean(accessibilityControlEnabledKey, false))
  val accessibilityControlEnabled: StateFlow<Boolean> = _accessibilityControlEnabled

  private val _notificationForwardingEnabled =
    MutableStateFlow(plainPrefs.getBoolean(notificationsForwardingEnabledKey, defaultNotificationForwardingEnabled))
  val notificationForwardingEnabled: StateFlow<Boolean> = _notificationForwardingEnabled

  private val _notificationForwardingMode =
    MutableStateFlow(
      NotificationPackageFilterMode.fromRawValue(
        plainPrefs.getString(notificationsForwardingModeKey, null),
      ),
    )
  val notificationForwardingMode: StateFlow<NotificationPackageFilterMode> = _notificationForwardingMode

  private val _notificationForwardingPackages = MutableStateFlow(loadNotificationForwardingPackages())
  val notificationForwardingPackages: StateFlow<Set<String>> = _notificationForwardingPackages

  private val storedQuietStart =
    normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietStartKey, "22:00").orEmpty())
      ?: "22:00"
  private val storedQuietEnd =
    normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietEndKey, "07:00").orEmpty())
      ?: "07:00"
  private val storedQuietHoursEnabled =
    plainPrefs.getBoolean(notificationsForwardingQuietHoursEnabledKey, false) &&
      normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietStartKey, "22:00").orEmpty()) != null &&
      normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietEndKey, "07:00").orEmpty()) != null

  private val _notificationForwardingQuietHoursEnabled =
    MutableStateFlow(storedQuietHoursEnabled)
  val notificationForwardingQuietHoursEnabled: StateFlow<Boolean> = _notificationForwardingQuietHoursEnabled

  private val _notificationForwardingQuietStart = MutableStateFlow(storedQuietStart)
  val notificationForwardingQuietStart: StateFlow<String> = _notificationForwardingQuietStart

  private val _notificationForwardingQuietEnd = MutableStateFlow(storedQuietEnd)
  val notificationForwardingQuietEnd: StateFlow<String> = _notificationForwardingQuietEnd

  private val _notificationForwardingMaxEventsPerMinute =
    MutableStateFlow(plainPrefs.getInt(notificationsForwardingMaxEventsPerMinuteKey, 20).coerceAtLeast(1))
  val notificationForwardingMaxEventsPerMinute: StateFlow<Int> = _notificationForwardingMaxEventsPerMinute

  private val _notificationForwardingSessionKey by lazy {
    MutableStateFlow(loadNotificationForwardingSessionKey(gatewayRegistry.activeStableId.value))
  }
  val notificationForwardingSessionKey: StateFlow<String?> get() = _notificationForwardingSessionKey

  private val _voiceMicEnabled = MutableStateFlow(plainPrefs.getBoolean(voiceMicEnabledKey, false))
  val voiceMicEnabled: StateFlow<Boolean> = _voiceMicEnabled

  private val _voiceWakeEnabled = MutableStateFlow(plainPrefs.getBoolean(voiceWakeEnabledKey, false))
  val voiceWakeEnabled: StateFlow<Boolean> = _voiceWakeEnabled

  private val _voiceWakeWords = MutableStateFlow(loadVoiceWakeWords())
  val voiceWakeWords: StateFlow<List<String>> = _voiceWakeWords

  private val _speakerEnabled = MutableStateFlow(plainPrefs.getBoolean("voice.speakerEnabled", true))
  val speakerEnabled: StateFlow<Boolean> = _speakerEnabled

  private val _preferredCameraFacing =
    MutableStateFlow(plainPrefs.getString(preferredCameraFacingKey, null).takeIf { it == "back" } ?: "front")
  val preferredCameraFacing: StateFlow<String> = _preferredCameraFacing

  private val _preferredAudioInputDevice =
    MutableStateFlow(plainPrefs.getString(preferredAudioInputDeviceKey, null)?.takeIf(String::isNotBlank))
  val preferredAudioInputDevice: StateFlow<String?> = _preferredAudioInputDevice

  private val _appearanceThemeMode =
    MutableStateFlow(AppearanceThemeMode.fromRawValue(plainPrefs.getString(appearanceThemeModeKey, null)))
  val appearanceThemeMode: StateFlow<AppearanceThemeMode> = _appearanceThemeMode

  private val _modelFavorites = MutableStateFlow(loadChatModelRefs(chatModelFavoritesKey))
  val modelFavorites: StateFlow<List<String>> = _modelFavorites

  private val _modelRecents = MutableStateFlow(loadChatModelRefs(chatModelRecentsKey))
  val modelRecents: StateFlow<List<String>> = _modelRecents

  // Custom session group names the user created locally; assigned groups also
  // persist server-side via the session category field (mirrors web localStorage).
  private val _sessionCustomGroups = MutableStateFlow(loadChatModelRefs(sessionCustomGroupsKey))
  val sessionCustomGroups: StateFlow<List<String>> = _sessionCustomGroups

  fun setLastDiscoveredStableId(value: String) {
    val trimmed = value.trim()
    plainPrefs.edit { putString("gateway.lastDiscoveredStableID", trimmed) }
    _lastDiscoveredStableId.value = trimmed
  }

  fun setDisplayName(value: String) {
    val trimmed = value.trim()
    plainPrefs.edit { putString(displayNameKey, trimmed) }
    _displayName.value = trimmed
  }

  fun setCameraEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean(cameraEnabledKey, value) }
    _cameraEnabled.value = value
  }

  fun setLocationMode(mode: LocationMode) {
    plainPrefs.edit { putString(locationModeKey, mode.rawValue) }
    _locationMode.value = mode
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean("location.preciseEnabled", value) }
    _locationPreciseEnabled.value = value
  }

  fun setPreventSleep(value: Boolean) {
    plainPrefs.edit { putBoolean("screen.preventSleep", value) }
    _preventSleep.value = value
  }

  fun setManualEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean("gateway.manual.enabled", value) }
    _manualEnabled.value = value
  }

  fun setManualHost(value: String) {
    val trimmed = value.trim()
    plainPrefs.edit { putString("gateway.manual.host", trimmed) }
    _manualHost.value = trimmed
  }

  fun setManualPort(value: Int) {
    plainPrefs.edit { putInt("gateway.manual.port", value) }
    _manualPort.value = value
  }

  fun setManualTls(value: Boolean) {
    plainPrefs.edit { putBoolean("gateway.manual.tls", value) }
    _manualTls.value = value
  }

  fun setOnboardingCompleted(value: Boolean) {
    plainPrefs.edit { putBoolean("onboarding.completed", value) }
    _onboardingCompleted.value = value
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean("canvas.debugStatusEnabled", value) }
    _canvasDebugStatusEnabled.value = value
  }

  fun grantInstalledAppsDisclosureConsent() {
    plainPrefs.edit {
      putBoolean(installedAppsSharingEnabledKey, true)
      putInt(installedAppsDisclosureConsentVersionKey, currentInstalledAppsDisclosureConsentVersion)
    }
    _installedAppsSharingEnabled.value = true
  }

  fun revokeInstalledAppsDisclosureConsent() {
    plainPrefs.edit {
      putBoolean(installedAppsSharingEnabledKey, false)
      remove(installedAppsDisclosureConsentVersionKey)
    }
    _installedAppsSharingEnabled.value = false
  }

  fun setAccessibilityControlEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean(accessibilityControlEnabledKey, value) }
    _accessibilityControlEnabled.value = value
  }

  private fun loadInstalledAppsSharingEnabled(): Boolean {
    val enabled = plainPrefs.getBoolean(installedAppsSharingEnabledKey, false)
    val consentVersion = plainPrefs.getInt(installedAppsDisclosureConsentVersionKey, 0)
    if (enabled && consentVersion == currentInstalledAppsDisclosureConsentVersion) return true

    // A shipped opt-in without this disclosure version cannot authorize package-inventory access.
    // Canonicalize both keys so every later enable starts with fresh affirmative consent.
    if (enabled || consentVersion != 0) {
      plainPrefs.edit {
        putBoolean(installedAppsSharingEnabledKey, false)
        remove(installedAppsDisclosureConsentVersionKey)
      }
    }
    return false
  }

  internal fun getNotificationForwardingPolicy(appPackageName: String): NotificationForwardingPolicy {
    val modeRaw = plainPrefs.getString(notificationsForwardingModeKey, null)
    val mode = NotificationPackageFilterMode.fromRawValue(modeRaw)

    val configuredPackages = loadNotificationForwardingPackages()
    val normalizedAppPackage = appPackageName.trim()
    // Always block OpenClaw's own notifications in blocklist mode to prevent forwarding loops.
    val defaultBlockedPackages =
      if (normalizedAppPackage.isNotEmpty()) setOf(normalizedAppPackage) else emptySet()

    val packages =
      when (mode) {
        NotificationPackageFilterMode.Allowlist -> configuredPackages
        NotificationPackageFilterMode.Blocklist -> configuredPackages + defaultBlockedPackages
      }

    val maxEvents = plainPrefs.getInt(notificationsForwardingMaxEventsPerMinuteKey, 20)
    val quietStart =
      normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietStartKey, "22:00").orEmpty())
        ?: "22:00"
    val quietEnd =
      normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietEndKey, "07:00").orEmpty())
        ?: "07:00"
    // NotificationListenerService owns a separate SecurePrefs facade, so resolve the persisted
    // pointer per event rather than trusting that facade's process-local registry flow.
    val sessionKey = loadNotificationForwardingSessionKey(gatewayRegistry.storedActiveStableId())

    val quietHoursEnabled =
      plainPrefs.getBoolean(notificationsForwardingQuietHoursEnabledKey, false) &&
        normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietStartKey, "22:00").orEmpty()) != null &&
        normalizeLocalHourMinute(plainPrefs.getString(notificationsForwardingQuietEndKey, "07:00").orEmpty()) != null

    return NotificationForwardingPolicy(
      enabled = plainPrefs.getBoolean(notificationsForwardingEnabledKey, defaultNotificationForwardingEnabled),
      mode = mode,
      packages = packages,
      quietHoursEnabled = quietHoursEnabled,
      quietStart = quietStart,
      quietEnd = quietEnd,
      maxEventsPerMinute = maxEvents.coerceAtLeast(1),
      sessionKey = sessionKey,
      selfPackageName = normalizedAppPackage,
    )
  }

  internal fun setNotificationForwardingEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean(notificationsForwardingEnabledKey, value) }
    _notificationForwardingEnabled.value = value
  }

  internal fun setNotificationForwardingMode(mode: NotificationPackageFilterMode) {
    plainPrefs.edit { putString(notificationsForwardingModeKey, mode.rawValue) }
    _notificationForwardingMode.value = mode
  }

  internal fun setNotificationForwardingPackages(packages: List<String>) {
    val sanitized =
      packages
        .asSequence()
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .toSet()
        .toList()
        .sorted()
    // Persist deterministic JSON so settings diffs and state restoration are stable.
    val encoded = JsonArray(sanitized.map { JsonPrimitive(it) }).toString()
    plainPrefs.edit { putString(notificationsForwardingPackagesKey, encoded) }
    _notificationForwardingPackages.value = sanitized.toSet()
  }

  internal fun setNotificationForwardingQuietHours(
    enabled: Boolean,
    start: String,
    end: String,
  ): Boolean {
    if (!enabled) {
      plainPrefs.edit { putBoolean(notificationsForwardingQuietHoursEnabledKey, false) }
      _notificationForwardingQuietHoursEnabled.value = false
      return true
    }
    val normalizedStart = normalizeLocalHourMinute(start) ?: return false
    val normalizedEnd = normalizeLocalHourMinute(end) ?: return false
    plainPrefs.edit {
      putBoolean(notificationsForwardingQuietHoursEnabledKey, enabled)
      putString(notificationsForwardingQuietStartKey, normalizedStart)
      putString(notificationsForwardingQuietEndKey, normalizedEnd)
    }
    _notificationForwardingQuietHoursEnabled.value = enabled
    _notificationForwardingQuietStart.value = normalizedStart
    _notificationForwardingQuietEnd.value = normalizedEnd
    return true
  }

  internal fun setNotificationForwardingMaxEventsPerMinute(value: Int) {
    val normalized = value.coerceAtLeast(1)
    plainPrefs.edit {
      putInt(notificationsForwardingMaxEventsPerMinuteKey, normalized)
    }
    _notificationForwardingMaxEventsPerMinute.value = normalized
  }

  internal fun setNotificationForwardingSessionKey(value: String?) {
    val stableId = gatewayRegistry.activeStableId.value ?: return
    val normalized = value?.trim()?.takeIf { it.isNotEmpty() }
    plainPrefs.edit {
      putString(notificationForwardingSessionKeyKey(stableId), normalized.orEmpty())
    }
    _notificationForwardingSessionKey.value = normalized
  }

  fun loadGatewayCredentials(stableId: String): GatewayCredentials {
    // Credential reads are gateway state; force the lazy registry so the one-time
    // legacy migration has run before the first per-gateway bundle is resolved.
    gatewayRegistry
    val raw = securePrefs.getString(gatewayCredentialsKey(stableId), null) ?: return GatewayCredentials()
    return runCatching { json.decodeFromString<GatewayCredentials>(raw).normalized() }.getOrDefault(GatewayCredentials())
  }

  fun saveGatewayCredentials(
    stableId: String,
    credentials: GatewayCredentials,
  ) {
    securePrefs.edit {
      putString(gatewayCredentialsKey(stableId), json.encodeToString(credentials.normalized()))
    }
  }

  fun saveGatewayCredentials(
    stableId: String,
    token: String? = null,
    bootstrapToken: String? = null,
    password: String? = null,
  ) {
    saveGatewayCredentials(stableId, GatewayCredentials(token, bootstrapToken, password))
  }

  fun clearGatewayCredentials(stableId: String) {
    securePrefs.edit { remove(gatewayCredentialsKey(stableId)) }
  }

  /**
   * Custom proxy headers are per-gateway credentials (Cloudflare Access-style service tokens).
   * They live in the encrypted store like the other gateway secrets and are read at connect
   * time; never log their values.
   */
  fun loadGatewayCustomHeaders(stableId: String): Map<String, String> {
    val raw = securePrefs.getString(gatewayCustomHeadersKey(stableId), null) ?: return emptyMap()
    val stored =
      runCatching { json.decodeFromString<Map<String, String>>(raw) }.getOrElse { return emptyMap() }
    return GatewayCustomHeaders.sanitized(stored)
  }

  fun saveGatewayCustomHeaders(
    stableId: String,
    headers: Map<String, String>,
  ) {
    val key = gatewayCustomHeadersKey(stableId)
    val sanitized = GatewayCustomHeaders.sanitized(headers)
    if (sanitized.isEmpty()) {
      securePrefs.edit { remove(key) }
      return
    }
    securePrefs.edit { putString(key, json.encodeToString(sanitized)) }
  }

  /** Forgets one gateway's proxy credentials; forgetting a gateway is the removal boundary. */
  fun clearGatewayCustomHeaders(stableId: String) {
    securePrefs.edit { remove(gatewayCustomHeadersKey(stableId)) }
  }

  private fun gatewayCustomHeadersKey(stableId: String) = "$gatewayCustomHeadersKeyPrefix${stableId.trim()}"

  /** Loads the pinned gateway TLS fingerprint for a discovered/manual stable endpoint id. */
  fun loadGatewayTlsFingerprint(stableId: String): String? {
    val key = "gateway.tls.$stableId"
    return plainPrefs.getString(key, null)?.trim()?.takeIf { it.isNotEmpty() }
  }

  /** Persists the gateway TLS fingerprint captured through TOFU or explicit trust. */
  fun saveGatewayTlsFingerprint(
    stableId: String,
    fingerprint: String,
  ) {
    val key = "gateway.tls.$stableId"
    plainPrefs.edit { putString(key, fingerprint.trim()) }
  }

  fun clearGatewayTlsFingerprint(stableId: String) {
    plainPrefs.edit { remove("gateway.tls.$stableId") }
  }

  fun clearNotificationForwardingSessionKey(stableId: String) {
    plainPrefs.edit { remove(notificationForwardingSessionKeyKey(stableId)) }
    if (gatewayRegistry.activeStableId.value == stableId) {
      _notificationForwardingSessionKey.value = null
    }
  }

  fun getString(key: String): String? = securePrefs.getString(key, null)

  fun putString(
    key: String,
    value: String,
  ) {
    securePrefs.edit { putString(key, value) }
  }

  // KTX edit(commit = true) discards commit's Boolean; the identity migration fails closed on it.
  @Suppress("UseKtx")
  internal fun putStringSynchronously(
    key: String,
    value: String,
  ): Boolean = securePrefs.edit().putString(key, value).commit()

  fun remove(key: String) {
    securePrefs.edit { remove(key) }
  }

  internal fun containsSecureKey(key: String): Boolean = securePrefs.contains(key)

  internal fun secureKeys(): Set<String> = securePrefs.all.keys

  internal fun removeSecureKeys(keys: List<String>) {
    securePrefs.edit { keys.forEach { remove(it) } }
  }

  internal fun moveSecureString(
    sourceKey: String,
    destinationKey: String?,
  ) {
    val value = securePrefs.getString(sourceKey, null)
    securePrefs.edit {
      if (destinationKey != null && value != null) putString(destinationKey, value)
      remove(sourceKey)
    }
  }

  internal fun getPlainString(key: String): String? = plainPrefs.getString(key, null)

  internal fun getPlainBoolean(
    key: String,
    defaultValue: Boolean,
  ): Boolean = plainPrefs.getBoolean(key, defaultValue)

  internal fun getPlainInt(
    key: String,
    defaultValue: Int,
  ): Int = plainPrefs.getInt(key, defaultValue)

  internal fun movePlainString(
    sourceKey: String,
    destinationKey: String?,
  ) {
    val value = plainPrefs.getString(sourceKey, null)?.trim()?.takeIf { it.isNotEmpty() }
    plainPrefs.edit(commit = true) {
      if (destinationKey != null && value != null) putString(destinationKey, value)
      remove(sourceKey)
    }
  }

  private fun gatewayCredentialsKey(stableId: String): String {
    val normalized = stableId.trim()
    require(normalized.isNotEmpty()) { "Gateway stable id cannot be empty" }
    return "gateway.credentials.$normalized"
  }

  private fun notificationForwardingSessionKeyKey(stableId: String): String = "$notificationsForwardingSessionKeyPrefix.$stableId"

  private fun loadNotificationForwardingSessionKey(stableId: String?): String? =
    stableId
      ?.let(::notificationForwardingSessionKeyKey)
      ?.let { plainPrefs.getString(it, null) }
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

  private fun handleActiveGatewayChanged(stableId: String?) {
    _notificationForwardingSessionKey.value = loadNotificationForwardingSessionKey(stableId)
  }

  private fun createSecurePrefs(
    context: Context,
    name: String,
  ): SharedPreferences =
    EncryptedSharedPreferences.create(
      context,
      name,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

  private fun loadOrCreateInstanceId(): String {
    val existing = plainPrefs.getString("node.instanceId", null)?.trim()
    if (!existing.isNullOrBlank()) return existing
    // Instance id is not secret; it scopes local credentials and survives display-name changes.
    val fresh = UUID.randomUUID().toString()
    plainPrefs.edit { putString("node.instanceId", fresh) }
    return fresh
  }

  private fun loadOrMigrateDisplayName(context: Context): String {
    val existing = plainPrefs.getString(displayNameKey, null)?.trim().orEmpty()
    if (existing.isNotEmpty() && existing != "Android Node") return existing

    // Replace the historical generic name with a device-specific default once.
    val candidate = DeviceNames.bestDefaultNodeName(context).trim()
    val resolved = candidate.ifEmpty { "Android Node" }

    plainPrefs.edit { putString(displayNameKey, resolved) }
    return resolved
  }

  fun setVoiceMicEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean(voiceMicEnabledKey, value) }
    _voiceMicEnabled.value = value
  }

  fun setVoiceWakeEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean(voiceWakeEnabledKey, value) }
    _voiceWakeEnabled.value = value
  }

  fun setVoiceWakeWords(words: List<String>) {
    val sanitized = VoiceWakePreferences.sanitizeTriggerWords(words)
    plainPrefs.edit { putString(voiceWakeWordsKey, JsonArray(sanitized.map(::JsonPrimitive)).toString()) }
    _voiceWakeWords.value = sanitized
  }

  fun setSpeakerEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean("voice.speakerEnabled", value) }
    _speakerEnabled.value = value
  }

  fun setPreferredCameraFacing(value: String) {
    val facing = value.takeIf { it == "back" } ?: "front"
    plainPrefs.edit { putString(preferredCameraFacingKey, facing) }
    _preferredCameraFacing.value = facing
  }

  fun setPreferredAudioInputDevice(value: String?) {
    val key = value?.takeIf(String::isNotBlank)
    plainPrefs.edit {
      if (key == null) remove(preferredAudioInputDeviceKey) else putString(preferredAudioInputDeviceKey, key)
    }
    _preferredAudioInputDevice.value = key
  }

  private fun loadVoiceWakeWords(): List<String> {
    val stored = plainPrefs.getString(voiceWakeWordsKey, null) ?: return VoiceWakePreferences.defaultTriggerWords
    val decoded =
      runCatching {
        (json.parseToJsonElement(stored) as? JsonArray)
          ?.mapNotNull { (it as? JsonPrimitive)?.content }
      }.getOrNull()
    return VoiceWakePreferences.sanitizeTriggerWords(decoded.orEmpty())
  }

  fun setAppearanceThemeMode(mode: AppearanceThemeMode) {
    plainPrefs.edit { putString(appearanceThemeModeKey, mode.rawValue) }
    _appearanceThemeMode.value = mode
  }

  fun toggleModelFavorite(ref: String) {
    val trimmed = ref.trim()
    if (trimmed.isEmpty()) return
    val next =
      if (trimmed in _modelFavorites.value) {
        _modelFavorites.value - trimmed
      } else {
        _modelFavorites.value + trimmed
      }
    persistChatModelRefs(chatModelFavoritesKey, next)
    _modelFavorites.value = next
  }

  fun recordModelRecent(ref: String) {
    val trimmed = ref.trim()
    if (trimmed.isEmpty()) return
    val next = (listOf(trimmed) + _modelRecents.value.filterNot { it == trimmed }).take(maxChatModelRecents)
    persistChatModelRefs(chatModelRecentsKey, next)
    _modelRecents.value = next
  }

  fun setSessionCustomGroups(groups: List<String>) {
    val sanitized = groups.map(String::trim).filter { it.isNotEmpty() }.distinct()
    persistChatModelRefs(sessionCustomGroupsKey, sanitized)
    _sessionCustomGroups.value = sanitized
  }

  private fun persistChatModelRefs(
    key: String,
    refs: List<String>,
  ) {
    val encoded = JsonArray(refs.map(::JsonPrimitive)).toString()
    plainPrefs.edit { putString(key, encoded) }
  }

  private fun loadNotificationForwardingPackages(): Set<String> {
    val raw = plainPrefs.getString(notificationsForwardingPackagesKey, null)?.trim()
    if (raw.isNullOrEmpty()) {
      return emptySet()
    }
    return try {
      val element = json.parseToJsonElement(raw)
      val array = element as? JsonArray ?: return emptySet()
      array
        .mapNotNull { item ->
          when (item) {
            is JsonNull -> null
            is JsonPrimitive -> item.content.trim().takeIf { it.isNotEmpty() }
            else -> null
          }
        }.toSet()
    } catch (_: Throwable) {
      emptySet()
    }
  }

  private fun loadLocationMode(): LocationMode {
    val raw = plainPrefs.getString(locationModeKey, "off")
    val stored = LocationMode.fromRawValue(raw)
    val resolved =
      if (stored == LocationMode.Always && !SensitiveFeatureConfig.backgroundLocationEnabled) {
        LocationMode.WhileUsing
      } else {
        stored
      }
    if (resolved != stored) {
      plainPrefs.edit { putString(locationModeKey, resolved.rawValue) }
    }
    return resolved
  }

  private fun loadCameraEnabled(): Boolean {
    if (plainPrefs.contains(cameraEnabledKey)) {
      return plainPrefs.getBoolean(cameraEnabledKey, false)
    }
    val migratedValue = hadPlainPrefsBeforeInit
    plainPrefs.edit { putBoolean(cameraEnabledKey, migratedValue) }
    return migratedValue
  }

  private fun loadChatModelRefs(key: String): List<String> {
    val raw = plainPrefs.getString(key, null)?.trim()
    if (raw.isNullOrEmpty()) return emptyList()
    return try {
      val array = json.parseToJsonElement(raw) as? JsonArray ?: return emptyList()
      array
        .mapNotNull { item ->
          when (item) {
            is JsonNull -> null
            is JsonPrimitive -> item.content.trim().takeIf { it.isNotEmpty() }
            else -> null
          }
        }.distinct()
    } catch (_: Throwable) {
      emptyList()
    }
  }
}
