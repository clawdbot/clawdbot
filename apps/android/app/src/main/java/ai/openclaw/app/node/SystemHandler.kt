package ai.openclaw.app.node

import ai.openclaw.app.NodeApp
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.mainActivityPendingIntent
import ai.openclaw.app.ui.popup.PopupOverlayActivity
import ai.openclaw.app.ui.popup.popupSpokenText
import android.Manifest
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val NOTIFICATION_CHANNEL_BASE_ID = "openclaw.system.notify"
private const val NOTIFICATION_CONTENT_REQUEST_CODE = 3
private const val NOTIFICATION_FULL_SCREEN_REQUEST_CODE = 4

/** Parsed payload for system.notify invocations. */
internal data class SystemNotifyRequest(
  val title: String,
  val body: String,
  val sound: String?,
  val priority: String?,
  val delivery: String? = null,
  val subtitle: String? = null,
  val timestampMillis: Long? = null,
)

/** Notification posting seam used by production Android and unit tests. */
internal interface SystemNotificationPoster {
  fun isAuthorized(): Boolean

  fun post(request: SystemNotifyRequest)
}

private class AndroidSystemNotificationPoster(
  private val appContext: Context,
) : SystemNotificationPoster {
  /** Checks both Android 13 runtime permission and app-level notification enablement. */
  override fun isAuthorized(): Boolean {
    if (Build.VERSION.SDK_INT >= 33) {
      val granted =
        ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED
      if (!granted) return false
    }
    return NotificationManagerCompat.from(appContext).areNotificationsEnabled()
  }

  /** Posts through a priority-specific channel so Android's immutable channel importance is respected. */
  override fun post(request: SystemNotifyRequest) {
    val isOverlay = request.delivery == "overlay"
    val deliveryMode = if (isOverlay) resolvePopupDeliveryMode(appContext) else null
    // A full-screen intent only actually fires from a HIGH-importance channel, regardless of
    // the caller's requested priority, so an overlay delivery always gets the loudest channel.
    val channelPriority = if (isOverlay) "timesensitive" else request.priority
    val channelId = ensureChannel(channelPriority)
    val wantsFullScreenIntent =
      deliveryMode == PopupDeliveryMode.FullScreenLocked && fullScreenIntentPermitted(appContext)
    val notification = buildSystemNotification(appContext, channelId, request, wantsFullScreenIntent)
    if (
      Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      throw SecurityException("notifications permission missing")
    }
    NotificationManagerCompat.from(appContext).notify((System.currentTimeMillis() and 0x7FFFFFFF).toInt(), notification)

    when (deliveryMode) {
      PopupDeliveryMode.OverlayWindow ->
        (appContext as NodeApp).popupOverlayWindow.show(
          title = request.title,
          subtitle = request.subtitle,
          body = request.body,
          timestampMillis = request.timestampMillis ?: System.currentTimeMillis(),
        )
      PopupDeliveryMode.HeadsUpFallback ->
        // No visual card renders in this mode (the notification alone can't force full-screen
        // while unlocked+backgrounded), so speak explicitly here — TTS has no visual-permission
        // dependency and is the core purpose of overlay delivery, not a nice-to-have.
        (appContext as NodeApp).speakPopupMessage(popupSpokenText(request.subtitle, request.body))
      PopupDeliveryMode.FullScreenLocked, null -> Unit
    }
  }

  private fun ensureChannel(priority: String?): String {
    val normalizedPriority = priority.orEmpty().trim().lowercase()
    // Android channel importance is immutable after creation, so priority maps
    // to stable channel ids instead of mutating one shared channel.
    val (suffix, importance, name) =
      when (normalizedPriority) {
        "passive" ->
          Triple("passive", NotificationManager.IMPORTANCE_LOW, nativeString("OpenClaw Passive"))
        "timesensitive" ->
          Triple(
            "timesensitive",
            NotificationManager.IMPORTANCE_HIGH,
            nativeString("OpenClaw Time Sensitive"),
          )
        else ->
          Triple("active", NotificationManager.IMPORTANCE_DEFAULT, nativeString("OpenClaw Active"))
      }
    val channelId = "$NOTIFICATION_CHANNEL_BASE_ID.$suffix"
    val manager = appContext.getSystemService(NotificationManager::class.java)
    // Only the full-screen-intent channel needs to cut through Do Not Disturb; this only takes
    // effect once the user separately grants notification policy access (see SettingsScreens).
    val bypassDnd = normalizedPriority == "timesensitive"
    val existing = manager.getNotificationChannel(channelId)
    val channel = existing ?: NotificationChannel(channelId, name, importance)
    if (existing == null || channel.canBypassDnd() != bypassDnd) {
      channel.setBypassDnd(bypassDnd)
      // Re-creating with the same id+importance updates mutable fields on an existing channel.
      manager.createNotificationChannel(channel)
    }
    return channelId
  }
}

/** Which surface an overlay-delivery notify shows through; see AndroidSystemNotificationPoster.post. */
internal enum class PopupDeliveryMode { FullScreenLocked, OverlayWindow, HeadsUpFallback }

/**
 * Full-screen-intent notifications only auto-launch their Activity while the device is locked;
 * unlocked+backgrounded just shows a heads-up banner (an intentional Android anti-abuse policy).
 * So overlay delivery needs a second mechanism (PopupOverlayWindow) for the unlocked case.
 */
internal fun resolvePopupDeliveryMode(appContext: Context): PopupDeliveryMode {
  val locked = appContext.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true
  return when {
    locked -> PopupDeliveryMode.FullScreenLocked
    Settings.canDrawOverlays(appContext) -> PopupDeliveryMode.OverlayWindow
    else -> PopupDeliveryMode.HeadsUpFallback
  }
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

internal fun buildSystemNotification(
  appContext: Context,
  channelId: String,
  request: SystemNotifyRequest,
  wantsFullScreenIntent: Boolean = false,
): Notification {
  val builder =
    NotificationCompat
      .Builder(appContext, channelId)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(request.title)
      .setContentText(request.body)
      .setContentIntent(mainActivityPendingIntent(appContext, NOTIFICATION_CONTENT_REQUEST_CODE))
      .setPriority(compatPriority(request.priority))
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setSilent(isSilentSound(request.sound))

  request.subtitle?.let { builder.setSubText(it) }
  request.timestampMillis?.let {
    builder.setWhen(it)
    builder.setShowWhen(true)
  }

  if (wantsFullScreenIntent) {
    builder.setFullScreenIntent(popupOverlayPendingIntent(appContext, request), true)
  }

  return builder.build()
}

/** Android 14+ requires an explicit OS grant; earlier versions allow full-screen intents by default. */
private fun fullScreenIntentPermitted(appContext: Context): Boolean {
  if (Build.VERSION.SDK_INT < 34) return true
  val manager = appContext.getSystemService(NotificationManager::class.java)
  return manager?.canUseFullScreenIntent() ?: false
}

private fun popupOverlayPendingIntent(
  appContext: Context,
  request: SystemNotifyRequest,
): PendingIntent =
  PendingIntent.getActivity(
    appContext,
    NOTIFICATION_FULL_SCREEN_REQUEST_CODE,
    PopupOverlayActivity.launchIntent(
      context = appContext,
      title = request.title,
      subtitle = request.subtitle,
      body = request.body,
      timestampMillis = request.timestampMillis,
    ),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

/** Handles system-level node.invoke commands implemented by Android services. */
class SystemHandler private constructor(
  private val poster: SystemNotificationPoster,
) {
  constructor(appContext: Context) : this(poster = AndroidSystemNotificationPoster(appContext))

  /** Posts an Android notification from the gateway system.notify command. */
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
    // title/body are required by the gateway contract; optional fields only
    // influence Android channel/silence behavior.
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
    val delivery = (params["delivery"] as? JsonPrimitive)?.contentOrNull
    val subtitle = (params["subtitle"] as? JsonPrimitive)?.contentOrNull
    val timestamp = (params["timestamp"] as? JsonPrimitive)?.contentOrNull
    return SystemNotifyRequest(
      title = rawTitle.trim(),
      body = rawBody.trim(),
      sound = sound?.trim()?.ifEmpty { null },
      priority = priority?.trim()?.ifEmpty { null },
      delivery = delivery?.trim()?.ifEmpty { null },
      subtitle = subtitle?.trim()?.ifEmpty { null },
      timestampMillis = timestamp?.trim()?.ifEmpty { null }?.let(::parseIsoTimestampMillis),
    )
  }

  private fun parseIsoTimestampMillis(raw: String): Long? =
    try {
      Instant.parse(raw).toEpochMilli()
    } catch (_: Throwable) {
      null
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
    /** Creates a handler with a fake poster for parser and authorization tests. */
    internal fun forTesting(poster: SystemNotificationPoster): SystemHandler = SystemHandler(poster)
  }
}
