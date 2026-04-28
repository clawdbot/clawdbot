package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val NOTIFICATION_CHANNEL_BASE_ID = "openclaw.system.notify"

internal data class SystemNotifyRequest(
  val title: String,
  val body: String,
  val sound: String?,
  val priority: String?,
)

internal interface SystemNotificationPoster {
  fun isAuthorized(): Boolean

  fun post(request: SystemNotifyRequest)
}

private class AndroidSystemNotificationPoster(
  private val appContext: Context,
) : SystemNotificationPoster {
  override fun isAuthorized(): Boolean {
    if (Build.VERSION.SDK_INT >= 33) {
      val granted =
        ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED
      if (!granted) return false
    }
    return NotificationManagerCompat.from(appContext).areNotificationsEnabled()
  }

  override fun post(request: SystemNotifyRequest) {
    val channelId = ensureChannel(request.priority)
    val silent = isSilentSound(request.sound)
    val notification =
      NotificationCompat
        .Builder(appContext, channelId)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle(request.title)
        .setContentText(request.body)
        .setPriority(compatPriority(request.priority))
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .setSilent(silent)
        .build()
    if (
      Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      throw SecurityException("notifications permission missing")
    }
    NotificationManagerCompat.from(appContext).notify((System.currentTimeMillis() and 0x7FFFFFFF).toInt(), notification)
  }

  private fun ensureChannel(priority: String?): String {
    val normalizedPriority = priority.orEmpty().trim().lowercase()
    val (suffix, importance, name) =
      when (normalizedPriority) {
        "passive" -> Triple("passive", NotificationManager.IMPORTANCE_LOW, "OpenClaw Passive")
        "timesensitive" -> Triple("timesensitive", NotificationManager.IMPORTANCE_HIGH, "OpenClaw Time Sensitive")
        else -> Triple("active", NotificationManager.IMPORTANCE_DEFAULT, "OpenClaw Active")
      }
    val channelId = "$NOTIFICATION_CHANNEL_BASE_ID.$suffix"
    val manager = appContext.getSystemService(NotificationManager::class.java)
    val existing = manager.getNotificationChannel(channelId)
    if (existing == null) {
      manager.createNotificationChannel(NotificationChannel(channelId, name, importance))
    }
    return channelId
  }

  private fun compatPriority(priority: String?): Int =
    when (priority.orEmpty().trim().lowercase()) {
      "passive" -> NotificationCompat.PRIORITY_LOW
      "timesensitive" -> NotificationCompat.PRIORITY_HIGH
      else -> NotificationCompat.PRIORITY_DEFAULT
    }

  private fun isSilentSound(sound: String?): Boolean {
    val normalized = sound?.trim()?.lowercase() ?: return false
    return normalized in setOf("none", "silent", "off", "false", "0")
  }
}

class SystemHandler private constructor(
  private val poster: SystemNotificationPoster,
) {
  constructor(appContext: Context) : this(poster = AndroidSystemNotificationPoster(appContext))

  fun handleSystemNotify(paramsJson: String?): GatewaySession.InvokeResult {
    val params =
      parseNotifyRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object with title/body",
        )
    if (params.title.isEmpty() && params.body.isEmpty()) {
      return GatewaySession.InvokeResult.error(
        code = "INVALID_REQUEST",
        message = "INVALID_REQUEST: empty notification",
      )
    }
    if (!poster.isAuthorized()) {
      return GatewaySession.InvokeResult.error(
        code = "NOT_AUTHORIZED",
        message = "NOT_AUTHORIZED: notifications",
      )
    }
    return try {
      poster.post(params)
      GatewaySession.InvokeResult.ok(null)
    } catch (_: SecurityException) {
      GatewaySession.InvokeResult.error(
        code = "NOT_AUTHORIZED",
        message = "NOT_AUTHORIZED: notifications",
      )
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "UNAVAILABLE",
        message = "NOTIFICATION_FAILED: ${err.message ?: "notification post failed"}",
      )
    }
  }

  private fun parseNotifyRequest(paramsJson: String?): SystemNotifyRequest? {
    val params = parseParamsObject(paramsJson) ?: return null
    val rawTitle =
      (params["title"] as? JsonPrimitive)
        ?.contentOrNull
        ?: return null
    val rawBody =
      (params["body"] as? JsonPrimitive)
        ?.contentOrNull
        ?: return null
    val sound = (params["sound"] as? JsonPrimitive)?.contentOrNull
    val priority = (params["priority"] as? JsonPrimitive)?.contentOrNull
    return SystemNotifyRequest(
      title = rawTitle.trim(),
      body = rawBody.trim(),
      sound = sound?.trim()?.ifEmpty { null },
      priority = priority?.trim()?.ifEmpty { null },
    )
  }

  private fun parseParamsObject(paramsJson: String?): JsonObject? {
    if (paramsJson.isNullOrBlank()) return null
    return try {
      Json.parseToJsonElement(paramsJson).asObjectOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  companion object {
    internal fun forTesting(poster: SystemNotificationPoster): SystemHandler = SystemHandler(poster)
  }
}
