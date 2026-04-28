package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

internal interface NotificationsStateProvider {
  fun readSnapshot(context: Context): DeviceNotificationSnapshot

  fun requestServiceRebind(context: Context)

  fun executeAction(
    context: Context,
    request: NotificationActionRequest,
  ): NotificationActionResult
}

private object SystemNotificationsStateProvider : NotificationsStateProvider {
  override fun readSnapshot(context: Context): DeviceNotificationSnapshot {
    val enabled = DeviceNotificationListenerService.isAccessEnabled(context)
    if (!enabled) {
      return DeviceNotificationSnapshot(
        enabled = false,
        connected = false,
        notifications = emptyList(),
      )
    }
    return DeviceNotificationListenerService.snapshot(context, enabled = true)
  }

  override fun requestServiceRebind(context: Context) {
    DeviceNotificationListenerService.requestServiceRebind(context)
  }

  override fun executeAction(
    context: Context,
    request: NotificationActionRequest,
  ): NotificationActionResult = DeviceNotificationListenerService.executeAction(context, request)
}

class NotificationsHandler private constructor(
  private val appContext: Context,
  private val stateProvider: NotificationsStateProvider,
) {
  constructor(appContext: Context) : this(appContext = appContext, stateProvider = SystemNotificationsStateProvider)

  suspend fun handleNotificationsList(_paramsJson: String?): GatewaySession.InvokeResult {
    val snapshot = readSnapshotWithRebind()
    return GatewaySession.InvokeResult.ok(snapshotPayloadJson(snapshot))
  }

  suspend fun handleNotificationsActions(paramsJson: String?): GatewaySession.InvokeResult {
    readSnapshotWithRebind()

    val params =
      parseParamsObject(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    val key =
      readString(params, "key")
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: key required",
        )
    val actionRaw =
      readString(params, "action")?.lowercase()
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: action required (open|dismiss|reply)",
        )
    val action =
      when (actionRaw) {
        "open" -> NotificationActionKind.Open
        "dismiss" -> NotificationActionKind.Dismiss
        "reply" -> NotificationActionKind.Reply
        else ->
          return GatewaySession.InvokeResult.error(
            code = "INVALID_REQUEST",
            message = "INVALID_REQUEST: action must be open|dismiss|reply",
          )
      }
    val replyText = readString(params, "replyText")
    if (action == NotificationActionKind.Reply && replyText.isNullOrBlank()) {
      return GatewaySession.InvokeResult.error(
        code = "INVALID_REQUEST",
        message = "INVALID_REQUEST: replyText required for reply action",
      )
    }

    val result =
      stateProvider.executeAction(
        appContext,
        NotificationActionRequest(
          key = key,
          kind = action,
          replyText = replyText,
        ),
      )
    if (!result.ok) {
      return GatewaySession.InvokeResult.error(
        code = result.code ?: "UNAVAILABLE",
        message = result.message ?: "notification action failed",
      )
    }

    val payload =
      buildJsonObject {
        put("ok", JsonPrimitive(true))
        put("key", JsonPrimitive(key))
        put("action", JsonPrimitive(actionRaw))
      }.toString()
    return GatewaySession.InvokeResult.ok(payload)
  }

  private fun readSnapshotWithRebind(): DeviceNotificationSnapshot {
    val snapshot = stateProvider.readSnapshot(appContext)
    if (snapshot.enabled && !snapshot.connected) {
      stateProvider.requestServiceRebind(appContext)
    }
    return snapshot
  }

  private fun snapshotPayloadJson(snapshot: DeviceNotificationSnapshot): String =
    buildJsonObject {
      put("enabled", JsonPrimitive(snapshot.enabled))
      put("connected", JsonPrimitive(snapshot.connected))
      put("count", JsonPrimitive(snapshot.notifications.size))
      put(
        "notifications",
        JsonArray(
          snapshot.notifications.map { entry -> entry.toJsonObject() },
        ),
      )
    }.toString()

  private fun parseParamsObject(paramsJson: String?): JsonObject? {
    if (paramsJson.isNullOrBlank()) return null
    return try {
      Json.parseToJsonElement(paramsJson).asObjectOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  private fun readString(
    params: JsonObject,
    key: String,
  ): String? =
    (params[key] as? JsonPrimitive)
      ?.contentOrNull
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

  companion object {
    internal fun forTesting(
      appContext: Context,
      stateProvider: NotificationsStateProvider,
    ): NotificationsHandler = NotificationsHandler(appContext = appContext, stateProvider = stateProvider)
  }
}
