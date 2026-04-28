package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.SensitiveFeatureConfig
import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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

class DeviceHandler(
  private val appContext: Context,
  private val smsEnabled: Boolean = SensitiveFeatureConfig.smsEnabled,
  private val callLogEnabled: Boolean = SensitiveFeatureConfig.callLogEnabled,
) {
  companion object {
    internal fun hasAnySmsCapability(
      smsEnabled: Boolean,
      telephonyAvailable: Boolean,
      smsSendGranted: Boolean,
      smsReadGranted: Boolean,
    ): Boolean = smsEnabled && telephonyAvailable && (smsSendGranted || smsReadGranted)

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

  fun handleDeviceStatus(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(statusPayloadJson())

  fun handleDeviceInfo(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(infoPayloadJson())

  fun handleDevicePermissions(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(permissionsPayloadJson())

  fun handleDeviceHealth(_paramsJson: String?): GatewaySession.InvokeResult = GatewaySession.InvokeResult.ok(healthPayloadJson())

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
      if (Build.VERSION.SDK_INT >= 33) {
        hasPermission(Manifest.permission.READ_MEDIA_IMAGES)
      } else {
        hasPermission(Manifest.permission.READ_EXTERNAL_STORAGE)
      }
    val motionGranted = hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)
    val notificationsGranted =
      if (Build.VERSION.SDK_INT >= 33) {
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
              promptableWhenDenied = true,
            ),
          )
          put(
            "contacts",
            permissionStateJson(
              granted = hasPermission(Manifest.permission.READ_CONTACTS),
              promptableWhenDenied = true,
            ),
          )
          put(
            "calendar",
            permissionStateJson(
              granted = hasPermission(Manifest.permission.READ_CALENDAR),
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

  private fun readBatterySnapshot(): BatterySnapshot {
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
