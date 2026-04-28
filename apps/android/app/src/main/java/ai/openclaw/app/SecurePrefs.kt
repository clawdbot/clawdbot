@file:Suppress("DEPRECATION")

package ai.openclaw.app

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

class SecurePrefs(
  context: Context,
  private val securePrefsOverride: SharedPreferences? = null,
) {
  companion object {
    val defaultWakeWords: List<String> = listOf("openclaw", "claude")
    private const val displayNameKey = "node.displayName"
    private const val locationModeKey = "location.enabledMode"
    private const val voiceWakeModeKey = "voiceWake.mode"
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
    private const val notificationsForwardingSessionKeyKey = "notifications.forwarding.sessionKey"
    private const val voiceMicEnabledKey = "voice.micEnabled"
  }

  private val appContext = context.applicationContext
  private val json = Json { ignoreUnknownKeys = true }
  private val plainPrefs: SharedPreferences =
    appContext.getSharedPreferences(plainPrefsName, Context.MODE_PRIVATE)

  private val masterKey by lazy {
    MasterKey
      .Builder(appContext)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
  }
  private val securePrefs: SharedPreferences by lazy { securePrefsOverride ?: createSecurePrefs(appContext, securePrefsName) }

  private val _instanceId = MutableStateFlow(loadOrCreateInstanceId())
  val instanceId: StateFlow<String> = _instanceId

  private val _displayName =
    MutableStateFlow(loadOrMigrateDisplayName(context = context))
  val displayName: StateFlow<String> = _displayName

  private val _cameraEnabled = MutableStateFlow(plainPrefs.getBoolean("camera.enabled", true))
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

  private val _gatewayToken = MutableStateFlow("")
  val gatewayToken: StateFlow<String> = _gatewayToken

  private val _gatewayBootstrapToken = MutableStateFlow("")
  val gatewayBootstrapToken: StateFlow<String> = _gatewayBootstrapToken

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

  private val _notificationForwardingSessionKey =
    MutableStateFlow(
      plainPrefs
        .getString(notificationsForwardingSessionKeyKey, "")
        ?.trim()
        ?.takeIf { it.isNotEmpty() },
    )
  val notificationForwardingSessionKey: StateFlow<String?> = _notificationForwardingSessionKey

  private val _wakeWords = MutableStateFlow(loadWakeWords())
  val wakeWords: StateFlow<List<String>> = _wakeWords

  private val _voiceWakeMode = MutableStateFlow(loadVoiceWakeMode())
  val voiceWakeMode: StateFlow<VoiceWakeMode> = _voiceWakeMode

  private val _voiceMicEnabled = MutableStateFlow(plainPrefs.getBoolean(voiceMicEnabledKey, false))
  val voiceMicEnabled: StateFlow<Boolean> = _voiceMicEnabled

  private val _speakerEnabled = MutableStateFlow(plainPrefs.getBoolean("voice.speakerEnabled", true))
  val speakerEnabled: StateFlow<Boolean> = _speakerEnabled

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
    plainPrefs.edit { putBoolean("camera.enabled", value) }
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

  fun setGatewayToken(value: String) {
    val trimmed = value.trim()
    securePrefs.edit { putString("gateway.manual.token", trimmed) }
    _gatewayToken.value = trimmed
  }

  fun setGatewayPassword(value: String) {
    saveGatewayPassword(value)
  }

  fun setGatewayBootstrapToken(value: String) {
    saveGatewayBootstrapToken(value)
  }

  fun setOnboardingCompleted(value: Boolean) {
    plainPrefs.edit { putBoolean("onboarding.completed", value) }
    _onboardingCompleted.value = value
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean("canvas.debugStatusEnabled", value) }
    _canvasDebugStatusEnabled.value = value
  }

  internal fun getNotificationForwardingPolicy(appPackageName: String): NotificationForwardingPolicy {
    val modeRaw = plainPrefs.getString(notificationsForwardingModeKey, null)
    val mode = NotificationPackageFilterMode.fromRawValue(modeRaw)

    val configuredPackages = loadNotificationForwardingPackages()
    val normalizedAppPackage = appPackageName.trim()
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
    val sessionKey =
      plainPrefs
        .getString(notificationsForwardingSessionKeyKey, "")
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

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
    val normalized = value?.trim()?.takeIf { it.isNotEmpty() }
    plainPrefs.edit {
      putString(notificationsForwardingSessionKeyKey, normalized.orEmpty())
    }
    _notificationForwardingSessionKey.value = normalized
  }

  fun loadGatewayToken(): String? {
    val manual =
      _gatewayToken.value.trim().ifEmpty {
        val stored = securePrefs.getString("gateway.manual.token", null)?.trim().orEmpty()
        if (stored.isNotEmpty()) _gatewayToken.value = stored
        stored
      }
    if (manual.isNotEmpty()) return manual
    val key = "gateway.token.${_instanceId.value}"
    val stored = securePrefs.getString(key, null)?.trim()
    return stored?.takeIf { it.isNotEmpty() }
  }

  fun saveGatewayToken(token: String) {
    val key = "gateway.token.${_instanceId.value}"
    securePrefs.edit { putString(key, token.trim()) }
  }

  fun loadGatewayBootstrapToken(): String? {
    val key = "gateway.bootstrapToken.${_instanceId.value}"
    val stored =
      _gatewayBootstrapToken.value.trim().ifEmpty {
        val persisted = securePrefs.getString(key, null)?.trim().orEmpty()
        if (persisted.isNotEmpty()) {
          _gatewayBootstrapToken.value = persisted
        }
        persisted
      }
    return stored.takeIf { it.isNotEmpty() }
  }

  fun saveGatewayBootstrapToken(token: String) {
    val key = "gateway.bootstrapToken.${_instanceId.value}"
    val trimmed = token.trim()
    securePrefs.edit { putString(key, trimmed) }
    _gatewayBootstrapToken.value = trimmed
  }

  fun loadGatewayPassword(): String? {
    val key = "gateway.password.${_instanceId.value}"
    val stored = securePrefs.getString(key, null)?.trim()
    return stored?.takeIf { it.isNotEmpty() }
  }

  fun saveGatewayPassword(password: String) {
    val key = "gateway.password.${_instanceId.value}"
    securePrefs.edit { putString(key, password.trim()) }
  }

  fun clearGatewaySetupAuth() {
    val instanceId = _instanceId.value
    securePrefs.edit {
      remove("gateway.manual.token")
      remove("gateway.token.$instanceId")
      remove("gateway.bootstrapToken.$instanceId")
      remove("gateway.password.$instanceId")
    }
    _gatewayToken.value = ""
    _gatewayBootstrapToken.value = ""
  }

  fun loadGatewayTlsFingerprint(stableId: String): String? {
    val key = "gateway.tls.$stableId"
    return plainPrefs.getString(key, null)?.trim()?.takeIf { it.isNotEmpty() }
  }

  fun saveGatewayTlsFingerprint(
    stableId: String,
    fingerprint: String,
  ) {
    val key = "gateway.tls.$stableId"
    plainPrefs.edit { putString(key, fingerprint.trim()) }
  }

  fun getString(key: String): String? = securePrefs.getString(key, null)

  fun putString(
    key: String,
    value: String,
  ) {
    securePrefs.edit { putString(key, value) }
  }

  fun remove(key: String) {
    securePrefs.edit { remove(key) }
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
    val fresh = UUID.randomUUID().toString()
    plainPrefs.edit { putString("node.instanceId", fresh) }
    return fresh
  }

  private fun loadOrMigrateDisplayName(context: Context): String {
    val existing = plainPrefs.getString(displayNameKey, null)?.trim().orEmpty()
    if (existing.isNotEmpty() && existing != "Android Node") return existing

    val candidate = DeviceNames.bestDefaultNodeName(context).trim()
    val resolved = candidate.ifEmpty { "Android Node" }

    plainPrefs.edit { putString(displayNameKey, resolved) }
    return resolved
  }

  fun setWakeWords(words: List<String>) {
    val sanitized = WakeWords.sanitize(words, defaultWakeWords)
    val encoded =
      JsonArray(sanitized.map { JsonPrimitive(it) }).toString()
    plainPrefs.edit { putString("voiceWake.triggerWords", encoded) }
    _wakeWords.value = sanitized
  }

  fun setVoiceWakeMode(mode: VoiceWakeMode) {
    plainPrefs.edit { putString(voiceWakeModeKey, mode.rawValue) }
    _voiceWakeMode.value = mode
  }

  fun setVoiceMicEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean(voiceMicEnabledKey, value) }
    _voiceMicEnabled.value = value
  }

  fun setSpeakerEnabled(value: Boolean) {
    plainPrefs.edit { putBoolean("voice.speakerEnabled", value) }
    _speakerEnabled.value = value
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

  private fun loadVoiceWakeMode(): VoiceWakeMode {
    val raw = plainPrefs.getString(voiceWakeModeKey, null)
    val resolved = VoiceWakeMode.fromRawValue(raw)

    // Default ON (foreground) when unset.
    if (raw.isNullOrBlank()) {
      plainPrefs.edit { putString(voiceWakeModeKey, resolved.rawValue) }
    }

    return resolved
  }

  private fun loadLocationMode(): LocationMode {
    val raw = plainPrefs.getString(locationModeKey, "off")
    val resolved = LocationMode.fromRawValue(raw)
    if (raw?.trim()?.lowercase() == "always") {
      plainPrefs.edit { putString(locationModeKey, resolved.rawValue) }
    }
    return resolved
  }

  private fun loadWakeWords(): List<String> {
    val raw = plainPrefs.getString("voiceWake.triggerWords", null)?.trim()
    if (raw.isNullOrEmpty()) return defaultWakeWords
    return try {
      val element = json.parseToJsonElement(raw)
      val array = element as? JsonArray ?: return defaultWakeWords
      val decoded =
        array.mapNotNull { item ->
          when (item) {
            is JsonNull -> null
            is JsonPrimitive -> item.content.trim().takeIf { it.isNotEmpty() }
            else -> null
          }
        }
      WakeWords.sanitize(decoded, defaultWakeWords)
    } catch (_: Throwable) {
      defaultWakeWords
    }
  }
}
