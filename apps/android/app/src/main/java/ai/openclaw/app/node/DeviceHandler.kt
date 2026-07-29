package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.SensitiveFeatureConfig
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.hasPhotoReadPermission
import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale

private const val DEFAULT_DEVICE_APPS_LIMIT = 100
private const val MAX_DEVICE_APPS_LIMIT = 200
private const val DEVICE_APPS_SYSTEM_FLAGS =
  ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP

internal fun isSystemDeviceApp(appInfo: ApplicationInfo): Boolean = (appInfo.flags and DEVICE_APPS_SYSTEM_FLAGS) != 0

internal data class DeviceAppEntry(
  val label: String,
  val packageName: String,
  val system: Boolean,
  val enabled: Boolean,
  val launchable: Boolean,
)

internal interface DeviceAppSource {
  fun listApps(includeNonLaunchable: Boolean): List<DeviceAppEntry>
}

private class AndroidDeviceAppSource(
  private val appContext: Context,
) : DeviceAppSource {
  override fun listApps(includeNonLaunchable: Boolean): List<DeviceAppEntry> {
    val packageManager = appContext.packageManager
    val launcherIntent = Intent(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) }
    val launchablePackages =
      packageManager
        .queryIntentActivities(launcherIntent, PackageManager.MATCH_ALL)
        .asSequence()
        .mapNotNull {
          it.activityInfo
            ?.packageName
            ?.trim()
            ?.takeIf(String::isNotEmpty)
        }.toSet()

    val appInfos =
      if (includeNonLaunchable) {
        visibleInstalledApplications(packageManager)
      } else {
        launchablePackages.mapNotNull { packageName ->
          runCatching { packageManager.getApplicationInfo(packageName, 0) }.getOrNull()
        }
      }

    return appInfos
      .asSequence()
      .mapNotNull { appInfo ->
        appInfo.packageName
          ?.trim()
          ?.takeIf(String::isNotEmpty)
          ?.let { packageName ->
            val label = packageManager.getApplicationLabel(appInfo).toString().trim()
            DeviceAppEntry(
              label = label.ifEmpty { packageName },
              packageName = packageName,
              system = isSystemDeviceApp(appInfo),
              enabled = appInfo.enabled,
              launchable = packageName in launchablePackages,
            )
          }
      }.distinctBy { it.packageName }
      .sortedWith(compareBy<DeviceAppEntry> { it.label.lowercase() }.thenBy { it.packageName })
      .toList()
  }

  @SuppressLint("QueryPermissionsNeeded")
  private fun visibleInstalledApplications(packageManager: PackageManager): List<ApplicationInfo> {
    // Android package visibility intentionally bounds this result to packages the app can see.
    // OpenClaw should not request QUERY_ALL_PACKAGES for this optional device-context surface.
    return packageManager.getInstalledApplications(PackageManager.MATCH_ALL)
  }
}

private data class DeviceAppsRequest(
  val includeSystem: Boolean,
  val includeDisabled: Boolean,
  val includeNonLaunchable: Boolean,
  val query: String?,
  val limit: Int,
)

/**
 * Gateway device command adapter for Android status, info, permission, and health snapshots.
 */
class DeviceHandler private constructor(
  private val appContext: Context,
  private val smsEnabled: Boolean = SensitiveFeatureConfig.smsEnabled,
  private val callLogEnabled: Boolean = SensitiveFeatureConfig.callLogEnabled,
  private val photosEnabled: Boolean = SensitiveFeatureConfig.photosEnabled,
  private val appSource: DeviceAppSource = AndroidDeviceAppSource(appContext),
) {
  constructor(
    appContext: Context,
    smsEnabled: Boolean = SensitiveFeatureConfig.smsEnabled,
    callLogEnabled: Boolean = SensitiveFeatureConfig.callLogEnabled,
    photosEnabled: Boolean = SensitiveFeatureConfig.photosEnabled,
  ) : this(
    appContext = appContext,
    smsEnabled = smsEnabled,
    callLogEnabled = callLogEnabled,
    photosEnabled = photosEnabled,
    appSource = AndroidDeviceAppSource(appContext),
  )

  companion object {
    internal fun forTesting(
      appContext: Context,
      appSource: DeviceAppSource,
      smsEnabled: Boolean = SensitiveFeatureConfig.smsEnabled,
      callLogEnabled: Boolean = SensitiveFeatureConfig.callLogEnabled,
      photosEnabled: Boolean = SensitiveFeatureConfig.photosEnabled,
    ): DeviceHandler =
      DeviceHandler(
        appContext = appContext,
        smsEnabled = smsEnabled,
        callLogEnabled = callLogEnabled,
        photosEnabled = photosEnabled,
        appSource = appSource,
      )

    /**
     * SMS is available only when the feature flag, telephony hardware, and at least one SMS permission align.
     */
    internal fun hasAnySmsCapability(
      smsEnabled: Boolean,
      telephonyAvailable: Boolean,
      smsSendGranted: Boolean,
      smsReadGranted: Boolean,
    ): Boolean = smsEnabled && telephonyAvailable && (smsSendGranted || smsReadGranted)

    /**
     * Prompt only when Android can grant a missing SMS permission that this build can use.
     */
    internal fun isSmsPromptable(
      smsEnabled: Boolean,
      telephonyAvailable: Boolean,
      smsSendGranted: Boolean,
      smsReadGranted: Boolean,
    ): Boolean = smsEnabled && telephonyAvailable && (!smsSendGranted || !smsReadGranted)
  }

  private data class BatterySnapshot(
    val status: Int,
    val plugged: Int,
    val levelFraction: Double?,
    val temperatureC: Double?,
  )

  /** Returns battery, storage, network, and uptime state for device.status. */
  fun handleDeviceStatus(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(statusPayloadJson())

  /** Returns stable Android hardware, OS, app, and locale metadata for device.info. */
  fun handleDeviceInfo(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(infoPayloadJson())

  /** Returns permission and promptability state for Android capabilities exposed to the gateway. */
  fun handleDevicePermissions(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(permissionsPayloadJson())

  /** Returns coarse device health for memory, power, thermal, battery, and security patch state. */
  fun handleDeviceHealth(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(healthPayloadJson())

  fun handleDeviceApps(paramsJson: String?): GatewaySession.InvokeResult {
    val request = parseDeviceAppsRequest(paramsJson)
    val matchingApps =
      appSource
        .listApps(includeNonLaunchable = request.includeNonLaunchable)
        .asSequence()
        .filter { request.includeSystem || !it.system }
        .filter { request.includeDisabled || it.enabled }
        .filter { app ->
          val query = request.query ?: return@filter true
          app.label.contains(query, ignoreCase = true) || app.packageName.contains(query, ignoreCase = true)
        }.toList()
    val limitedApps = matchingApps.take(request.limit)

    return GatewaySession.InvokeResult.ok(
      buildJsonObject {
        put("count", JsonPrimitive(limitedApps.size))
        put("totalMatched", JsonPrimitive(matchingApps.size))
        put("truncated", JsonPrimitive(matchingApps.size > limitedApps.size))
        put("visibility", JsonPrimitive(if (request.includeNonLaunchable) "android-visible" else "launcher"))
        put("includeSystem", JsonPrimitive(request.includeSystem))
        put("includeDisabled", JsonPrimitive(request.includeDisabled))
        put(
          "apps",
          buildJsonArray {
            for (app in limitedApps) {
              add(
                buildJsonObject {
                  put("label", JsonPrimitive(app.label))
                  put("packageName", JsonPrimitive(app.packageName))
                  put("system", JsonPrimitive(app.system))
                  put("enabled", JsonPrimitive(app.enabled))
                  put("launchable", JsonPrimitive(app.launchable))
                },
              )
            }
          },
        )
      }.toString(),
    )
  }

  private fun statusPayloadJson(): String {
    val battery = readBatterySnapshot()
    val powerManager = appContext.getSystemService(PowerManager::class.java)
    val storage = StatFs(Environment.getDataDirectory().absolutePath)
    val totalBytes = storage.totalBytes
    val freeBytes = storage.availableBytes
    val usedBytes = (totalBytes - freeBytes).coerceAtLeast(0L)
    val connectivity = appContext.getSystemService(ConnectivityManager::class.java)
    val activeNetwork = connectivity?.activeNetwork
    val caps = activeNetwork?.let { connectivity.getNetworkCapabilities(it) }
    // elapsedRealtime is monotonic device uptime, not wall-clock time.
    val uptimeSeconds = SystemClock.elapsedRealtime() / 1_000.0

    return buildJsonObject {
      put(
        "battery",
        buildJsonObject {
          battery.levelFraction?.let { put("level", JsonPrimitive(it)) }
          put("state", JsonPrimitive(mapBatteryState(battery.status)))
          put("lowPowerModeEnabled", JsonPrimitive(powerManager?.isPowerSaveMode == true))
        },
      )
      put(
        "thermal",
        buildJsonObject {
          put("state", JsonPrimitive(mapThermalState(powerManager)))
        },
      )
      put(
        "storage",
        buildJsonObject {
          put("totalBytes", JsonPrimitive(totalBytes))
          put("freeBytes", JsonPrimitive(freeBytes))
          put("usedBytes", JsonPrimitive(usedBytes))
        },
      )
      put(
        "network",
        buildJsonObject {
          put("status", JsonPrimitive(mapNetworkStatus(caps)))
          put(
            "isExpensive",
            JsonPrimitive(
              caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)?.not() ?: false,
            ),
          )
          put(
            "isConstrained",
            JsonPrimitive(
              caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)?.not() ?: false,
            ),
          )
          put("interfaces", networkInterfacesJson(caps))
        },
      )
      put("uptimeSeconds", JsonPrimitive(uptimeSeconds))
    }.toString()
  }

  private fun infoPayloadJson(): String {
    val model = Build.MODEL?.trim().orEmpty()
    val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
    val modelIdentifier = Build.DEVICE?.trim().orEmpty()
    val systemVersion =
      Build.VERSION.RELEASE
        ?.trim()
        .orEmpty()
    val locale = Locale.getDefault().toLanguageTag().trim()
    val appVersion = BuildConfig.VERSION_NAME.trim()
    val appBuild = BuildConfig.VERSION_CODE.toString()

    return buildJsonObject {
      put("deviceName", JsonPrimitive(model.ifEmpty { "Android" }))
      put(
        "modelIdentifier",
        JsonPrimitive(modelIdentifier.ifEmpty { listOf(manufacturer, model).filter { it.isNotEmpty() }.joinToString(" ") }),
      )
      put("systemName", JsonPrimitive("Android"))
      put("systemVersion", JsonPrimitive(systemVersion.ifEmpty { Build.VERSION.SDK_INT.toString() }))
      put("appVersion", JsonPrimitive(appVersion.ifEmpty { "dev" }))
      put("appBuild", JsonPrimitive(appBuild.ifEmpty { "0" }))
      put("locale", JsonPrimitive(locale.ifEmpty { Locale.getDefault().toString() }))
    }.toString()
  }

  private fun permissionsPayloadJson(): String {
    val canSendSms = appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    val smsSendGranted = hasPermission(Manifest.permission.SEND_SMS)
    val smsReadGranted = hasPermission(Manifest.permission.READ_SMS)
    val notificationAccess = DeviceNotificationListenerService.isAccessEnabled(appContext)
    val photosGranted =
      if (!photosEnabled) {
        false
      } else {
        hasPhotoReadPermission(appContext)
      }
    val motionGranted = hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)
    val notificationsGranted =
      if (Build.VERSION.SDK_INT >= 33) {
        // POST_NOTIFICATIONS exists only on Android 13+.
        hasPermission(Manifest.permission.POST_NOTIFICATIONS)
      } else {
        true
      }
    return buildJsonObject {
      put(
        "permissions",
        buildJsonObject {
          put(
            "camera",
            permissionStateJson(
              granted = hasPermission(Manifest.permission.CAMERA),
              promptableWhenDenied = true,
            ),
          )
          put(
            "microphone",
            permissionStateJson(
              granted = hasPermission(Manifest.permission.RECORD_AUDIO),
              promptableWhenDenied = true,
            ),
          )
          put(
            "location",
            permissionStateJson(
              granted =
                hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
                  hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION),
              promptableWhenDenied = true,
            ),
          )
          put(
            "sms",
            buildJsonObject {
              put(
                "status",
                JsonPrimitive(
                  if (hasAnySmsCapability(
                      smsEnabled,
                      canSendSms,
                      smsSendGranted,
                      smsReadGranted,
                    )
                  ) {
                    "granted"
                  } else {
                    "denied"
                  },
                ),
              )
              put("promptable", JsonPrimitive(isSmsPromptable(smsEnabled, canSendSms, smsSendGranted, smsReadGranted)))
              put(
                "capabilities",
                buildJsonObject {
                  put(
                    "send",
                    permissionStateJson(
                      granted = smsEnabled && smsSendGranted && canSendSms,
                      promptableWhenDenied = smsEnabled && canSendSms,
                    ),
                  )
                  put(
                    "read",
                    permissionStateJson(
                      granted = smsEnabled && smsReadGranted && canSendSms,
                      promptableWhenDenied = smsEnabled && canSendSms,
                    ),
                  )
                },
              )
            },
          )
          put(
            "notificationListener",
            permissionStateJson(
              granted = notificationAccess,
              promptableWhenDenied = true,
            ),
          )
          put(
            "notifications",
            permissionStateJson(
              granted = notificationsGranted,
              promptableWhenDenied = true,
            ),
          )
          put(
            "photos",
            permissionStateJson(
              granted = photosGranted,
              promptableWhenDenied = photosEnabled,
            ),
          )
          put(
            "contacts",
            permissionStateJson(
              granted =
                hasPermission(Manifest.permission.READ_CONTACTS) &&
                  hasPermission(Manifest.permission.WRITE_CONTACTS),
              promptableWhenDenied = true,
            ),
          )
          put(
            "calendar",
            permissionStateJson(
              granted =
                hasPermission(Manifest.permission.READ_CALENDAR) &&
                  hasPermission(Manifest.permission.WRITE_CALENDAR),
              promptableWhenDenied = true,
            ),
          )
          put(
            "callLog",
            permissionStateJson(
              granted = callLogEnabled && hasPermission(Manifest.permission.READ_CALL_LOG),
              promptableWhenDenied = callLogEnabled,
            ),
          )
          put(
            "motion",
            permissionStateJson(
              granted = motionGranted,
              promptableWhenDenied = true,
            ),
          )
        },
      )
    }.toString()
  }

  private fun healthPayloadJson(): String {
    val battery = readBatterySnapshot()
    val batteryManager = appContext.getSystemService(BatteryManager::class.java)
    val currentNowUa = batteryManager?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
    val currentNowMa =
      if (currentNowUa == null || currentNowUa == Long.MIN_VALUE) {
        null
      } else {
        // BatteryManager reports microamps; expose milliamps in the gateway payload.
        currentNowUa.toDouble() / 1_000.0
      }

    val powerManager = appContext.getSystemService(PowerManager::class.java)
    val activityManager = appContext.getSystemService(ActivityManager::class.java)
    val memoryInfo = ActivityManager.MemoryInfo()
    activityManager?.getMemoryInfo(memoryInfo)
    val totalRamBytes = memoryInfo.totalMem.coerceAtLeast(0L)
    val availableRamBytes = memoryInfo.availMem.coerceAtLeast(0L)
    val usedRamBytes = (totalRamBytes - availableRamBytes).coerceAtLeast(0L)
    val lowMemory = memoryInfo.lowMemory
    val memoryPressure = mapMemoryPressure(totalRamBytes, availableRamBytes, lowMemory)

    return buildJsonObject {
      put(
        "memory",
        buildJsonObject {
          put("pressure", JsonPrimitive(memoryPressure))
          put("totalRamBytes", JsonPrimitive(totalRamBytes))
          put("availableRamBytes", JsonPrimitive(availableRamBytes))
          put("usedRamBytes", JsonPrimitive(usedRamBytes))
          put("thresholdBytes", JsonPrimitive(memoryInfo.threshold.coerceAtLeast(0L)))
          put("lowMemory", JsonPrimitive(lowMemory))
        },
      )
      put(
        "battery",
        buildJsonObject {
          put("state", JsonPrimitive(mapBatteryState(battery.status)))
          put("chargingType", JsonPrimitive(mapChargingType(battery.plugged)))
          battery.temperatureC?.let { put("temperatureC", JsonPrimitive(it)) }
          currentNowMa?.let { put("currentMa", JsonPrimitive(it)) }
        },
      )
      put(
        "power",
        buildJsonObject {
          put("dozeModeEnabled", JsonPrimitive(powerManager?.isDeviceIdleMode == true))
          put("lowPowerModeEnabled", JsonPrimitive(powerManager?.isPowerSaveMode == true))
        },
      )
      put(
        "system",
        buildJsonObject {
          Build.VERSION.SECURITY_PATCH
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { put("securityPatchLevel", JsonPrimitive(it)) }
        },
      )
    }.toString()
  }

  private fun parseDeviceAppsRequest(paramsJson: String?): DeviceAppsRequest {
    val params = parseJsonParamsObject(paramsJson)
    val includeSystem = parseJsonBooleanFlag(params, "includeSystem") ?: false
    val includeDisabled = parseJsonBooleanFlag(params, "includeDisabled") ?: false
    val includeNonLaunchable = parseJsonBooleanFlag(params, "includeNonLaunchable") ?: false
    val query = parseJsonString(params, "query")?.trim()?.takeIf { it.isNotEmpty() }
    val limit =
      (parseJsonInt(params, "limit") ?: DEFAULT_DEVICE_APPS_LIMIT)
        .coerceIn(1, MAX_DEVICE_APPS_LIMIT)
    return DeviceAppsRequest(
      includeSystem = includeSystem,
      includeDisabled = includeDisabled,
      includeNonLaunchable = includeNonLaunchable,
      query = query,
      limit = limit,
    )
  }

  private fun readBatterySnapshot(): BatterySnapshot {
    // ACTION_BATTERY_CHANGED is sticky; registerReceiver(null, ...) reads the last system snapshot.
    val intent = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val status =
      intent?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        ?: BatteryManager.BATTERY_STATUS_UNKNOWN
    val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
    val temperatureC =
      intent
        ?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        ?.takeIf { it != Int.MIN_VALUE }
        ?.toDouble()
        ?.div(10.0)
    return BatterySnapshot(
      status = status,
      plugged = plugged,
      levelFraction = batteryLevelFraction(intent),
      temperatureC = temperatureC,
    )
  }

  private fun batteryLevelFraction(intent: Intent?): Double? {
    val rawLevel = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val rawScale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    if (rawLevel < 0 || rawScale <= 0) return null
    return rawLevel.toDouble() / rawScale.toDouble()
  }

  private fun mapBatteryState(status: Int): String =
    when (status) {
      BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
      BatteryManager.BATTERY_STATUS_FULL -> "full"
      BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
      else -> "unknown"
    }

  private fun mapChargingType(plugged: Int): String =
    when (plugged) {
      BatteryManager.BATTERY_PLUGGED_AC -> "ac"
      BatteryManager.BATTERY_PLUGGED_USB -> "usb"
      BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
      BatteryManager.BATTERY_PLUGGED_DOCK -> "dock"
      else -> "none"
    }

  private fun mapThermalState(powerManager: PowerManager?): String {
    val thermal = powerManager?.currentThermalStatus ?: return "nominal"
    return when (thermal) {
      PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> "nominal"
      PowerManager.THERMAL_STATUS_MODERATE -> "fair"
      PowerManager.THERMAL_STATUS_SEVERE -> "serious"
      PowerManager.THERMAL_STATUS_CRITICAL,
      PowerManager.THERMAL_STATUS_EMERGENCY,
      PowerManager.THERMAL_STATUS_SHUTDOWN,
      -> "critical"
      else -> "nominal"
    }
  }

  private fun mapNetworkStatus(caps: NetworkCapabilities?): String {
    if (caps == null) return "unsatisfied"
    return when {
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> "satisfied"
      // Internet without validation mirrors iOS "requiresConnection" for captive or unproven networks.
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> "requiresConnection"
      else -> "unsatisfied"
    }
  }

  private fun permissionStateJson(
    granted: Boolean,
    promptableWhenDenied: Boolean,
  ) = buildJsonObject {
    put("status", JsonPrimitive(if (granted) "granted" else "denied"))
    put("promptable", JsonPrimitive(!granted && promptableWhenDenied))
  }

  private fun hasPermission(permission: String): Boolean =
    (
      ContextCompat.checkSelfPermission(appContext, permission) == PackageManager.PERMISSION_GRANTED
    )

  private fun mapMemoryPressure(
    totalBytes: Long,
    availableBytes: Long,
    lowMemory: Boolean,
  ): String {
    if (totalBytes <= 0L) return if (lowMemory) "critical" else "unknown"
    if (lowMemory) return "critical"
    val freeRatio = availableBytes.toDouble() / totalBytes.toDouble()
    // Thresholds intentionally mirror coarse OS health labels instead of exact memory pressure.
    return when {
      freeRatio <= 0.05 -> "critical"
      freeRatio <= 0.15 -> "high"
      freeRatio <= 0.30 -> "moderate"
      else -> "normal"
    }
  }

  private fun networkInterfacesJson(caps: NetworkCapabilities?) =
    buildJsonArray {
      if (caps == null) return@buildJsonArray
      var hasKnownTransport = false
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
        hasKnownTransport = true
        add(JsonPrimitive("wifi"))
      }
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
        hasKnownTransport = true
        add(JsonPrimitive("cellular"))
      }
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
        hasKnownTransport = true
        add(JsonPrimitive("wired"))
      }
      if (!hasKnownTransport) add(JsonPrimitive("other"))
    }
}
