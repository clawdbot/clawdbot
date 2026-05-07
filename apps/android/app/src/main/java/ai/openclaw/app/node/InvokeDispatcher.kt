package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.protocol.OpenClawCalendarCommand
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCanvasA2UICommand
import ai.openclaw.app.protocol.OpenClawCanvasCommand
import ai.openclaw.app.protocol.OpenClawContactsCommand
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawNotificationsCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import ai.openclaw.app.protocol.OpenClawSystemCommand
import ai.openclaw.app.protocol.OpenClawTalkCommand

internal enum class SmsSearchAvailabilityReason {
  Available,
  PermissionRequired,
  Unavailable,
}

internal fun classifySmsSearchAvailability(
  readSmsAvailable: Boolean,
  smsFeatureEnabled: Boolean,
  smsTelephonyAvailable: Boolean,
): SmsSearchAvailabilityReason {
  if (readSmsAvailable) return SmsSearchAvailabilityReason.Available
  if (!smsFeatureEnabled || !smsTelephonyAvailable) return SmsSearchAvailabilityReason.Unavailable
  return SmsSearchAvailabilityReason.PermissionRequired
}

internal fun smsSearchAvailabilityError(
  readSmsAvailable: Boolean,
  smsFeatureEnabled: Boolean,
  smsTelephonyAvailable: Boolean,
): GatewaySession.InvokeResult? =
  when (
    classifySmsSearchAvailability(
      readSmsAvailable = readSmsAvailable,
      smsFeatureEnabled = smsFeatureEnabled,
      smsTelephonyAvailable = smsTelephonyAvailable,
    )
  ) {
    SmsSearchAvailabilityReason.Available,
    SmsSearchAvailabilityReason.PermissionRequired,
    -> null
    SmsSearchAvailabilityReason.Unavailable ->
      GatewaySession.InvokeResult.error(
        code = "SMS_UNAVAILABLE",
        message = "SMS_UNAVAILABLE: SMS not available on this device",
      )
  }

class InvokeDispatcher(
  private val canvas: CanvasController,
  private val cameraHandler: CameraHandler,
  private val locationHandler: LocationHandler,
  private val deviceHandler: DeviceHandler,
  private val notificationsHandler: NotificationsHandler,
  private val systemHandler: SystemHandler,
  private val talkHandler: TalkHandler,
  private val photosHandler: PhotosHandler,
  private val contactsHandler: ContactsHandler,
  private val calendarHandler: CalendarHandler,
  private val motionHandler: MotionHandler,
  private val smsHandler: SmsHandler,
  private val a2uiHandler: A2UIHandler,
  private val debugHandler: DebugHandler,
  private val callLogHandler: CallLogHandler,
  private val isForeground: () -> Boolean,
  private val cameraEnabled: () -> Boolean,
  private val locationEnabled: () -> Boolean,
  private val sendSmsAvailable: () -> Boolean,
  private val readSmsAvailable: () -> Boolean,
  private val smsFeatureEnabled: () -> Boolean,
  private val smsTelephonyAvailable: () -> Boolean,
  private val callLogAvailable: () -> Boolean,
  private val debugBuild: () -> Boolean,
  private val onCanvasA2uiPush: () -> Unit,
  private val onCanvasA2uiReset: () -> Unit,
  private val refreshCanvasHostUrl: suspend () -> String?,
  private val motionActivityAvailable: () -> Boolean,
  private val motionPedometerAvailable: () -> Boolean,
) {
  suspend fun handleInvoke(
    command: String,
    paramsJson: String?,
  ): GatewaySession.InvokeResult {
    val spec =
      InvokeCommandRegistry.find(command)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: unknown command",
        )
    if (spec.requiresForeground && !isForeground()) {
      return GatewaySession.InvokeResult.error(
        code = "NODE_BACKGROUND_UNAVAILABLE",
        message = "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
      )
    }
    availabilityError(spec.availability)?.let { return it }

    return when (command) {
      // Canvas commands
      OpenClawCanvasCommand.Present.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      OpenClawCanvasCommand.Hide.rawValue -> GatewaySession.InvokeResult.ok(null)
      OpenClawCanvasCommand.Navigate.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      OpenClawCanvasCommand.Eval.rawValue -> {
        val js =
          CanvasController.parseEvalJs(paramsJson)
            ?: return GatewaySession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = "INVALID_REQUEST: javaScript required",
            )
        withCanvasAvailable {
          val result = canvas.eval(js)
          GatewaySession.InvokeResult.ok("""{"result":${result.toJsonString()}}""")
        }
      }
      OpenClawCanvasCommand.Snapshot.rawValue -> {
        val snapshotParams = CanvasController.parseSnapshotParams(paramsJson)
        withCanvasAvailable {
          val base64 =
            canvas.snapshotBase64(
              format = snapshotParams.format,
              quality = snapshotParams.quality,
              maxWidth = snapshotParams.maxWidth,
            )
          GatewaySession.InvokeResult.ok("""{"format":"${snapshotParams.format.rawValue}","base64":"$base64"}""")
        }
      }

      // A2UI commands
      OpenClawCanvasA2UICommand.Reset.rawValue ->
        withReadyA2ui {
          withCanvasAvailable {
            val res = canvas.eval(A2UIHandler.a2uiResetJS)
            onCanvasA2uiReset()
            GatewaySession.InvokeResult.ok(res)
          }
        }
      OpenClawCanvasA2UICommand.Push.rawValue, OpenClawCanvasA2UICommand.PushJSONL.rawValue -> {
        val messages =
          try {
            a2uiHandler.decodeA2uiMessages(command, paramsJson)
          } catch (err: Throwable) {
            return GatewaySession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = err.message ?: "invalid A2UI payload",
            )
          }
        withReadyA2ui {
          withCanvasAvailable {
            val js = A2UIHandler.a2uiApplyMessagesJS(messages)
            val res = canvas.eval(js)
            onCanvasA2uiPush()
            GatewaySession.InvokeResult.ok(res)
          }
        }
      }

      // Camera commands
      OpenClawCameraCommand.List.rawValue -> cameraHandler.handleList(paramsJson)
      OpenClawCameraCommand.Snap.rawValue -> cameraHandler.handleSnap(paramsJson)
      OpenClawCameraCommand.Clip.rawValue -> cameraHandler.handleClip(paramsJson)

      // Location command
      OpenClawLocationCommand.Get.rawValue -> locationHandler.handleLocationGet(paramsJson)

      // Device commands
      OpenClawDeviceCommand.Status.rawValue -> deviceHandler.handleDeviceStatus(paramsJson)
      OpenClawDeviceCommand.Info.rawValue -> deviceHandler.handleDeviceInfo(paramsJson)
      OpenClawDeviceCommand.Permissions.rawValue -> deviceHandler.handleDevicePermissions(paramsJson)
      OpenClawDeviceCommand.Health.rawValue -> deviceHandler.handleDeviceHealth(paramsJson)

      // Notifications command
      OpenClawNotificationsCommand.List.rawValue -> notificationsHandler.handleNotificationsList(paramsJson)
      OpenClawNotificationsCommand.Actions.rawValue -> notificationsHandler.handleNotificationsActions(paramsJson)

      // System command
      OpenClawSystemCommand.Notify.rawValue -> systemHandler.handleSystemNotify(paramsJson)

      // Talk commands
      OpenClawTalkCommand.PttStart.rawValue -> talkHandler.handlePttStart(paramsJson)
      OpenClawTalkCommand.PttStop.rawValue -> talkHandler.handlePttStop(paramsJson)
      OpenClawTalkCommand.PttCancel.rawValue -> talkHandler.handlePttCancel(paramsJson)
      OpenClawTalkCommand.PttOnce.rawValue -> talkHandler.handlePttOnce(paramsJson)

      // Photos command
      ai.openclaw.app.protocol.OpenClawPhotosCommand.Latest.rawValue ->
        photosHandler.handlePhotosLatest(
          paramsJson,
        )

      // Contacts command
      OpenClawContactsCommand.Search.rawValue -> contactsHandler.handleContactsSearch(paramsJson)
      OpenClawContactsCommand.Add.rawValue -> contactsHandler.handleContactsAdd(paramsJson)

      // Calendar command
      OpenClawCalendarCommand.Events.rawValue -> calendarHandler.handleCalendarEvents(paramsJson)
      OpenClawCalendarCommand.Add.rawValue -> calendarHandler.handleCalendarAdd(paramsJson)

      // Motion command
      OpenClawMotionCommand.Activity.rawValue -> motionHandler.handleMotionActivity(paramsJson)
      OpenClawMotionCommand.Pedometer.rawValue -> motionHandler.handleMotionPedometer(paramsJson)

      // SMS command
      OpenClawSmsCommand.Send.rawValue -> smsHandler.handleSmsSend(paramsJson)
      OpenClawSmsCommand.Search.rawValue -> smsHandler.handleSmsSearch(paramsJson)

      // CallLog command
      OpenClawCallLogCommand.Search.rawValue -> callLogHandler.handleCallLogSearch(paramsJson)

      // Debug commands
      "debug.ed25519" -> debugHandler.handleEd25519()
      "debug.logs" -> debugHandler.handleLogs()
      else -> GatewaySession.InvokeResult.error(code = "INVALID_REQUEST", message = "INVALID_REQUEST: unknown command")
    }
  }

  private suspend fun withReadyA2ui(block: suspend () -> GatewaySession.InvokeResult): GatewaySession.InvokeResult {
    var a2uiUrl =
      a2uiHandler.resolveA2uiHostUrl()
        ?: refreshCanvasHostUrl().let { a2uiHandler.resolveA2uiHostUrl() }
        ?: return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_NOT_CONFIGURED",
          message = "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
        )
    val readyOnFirstCheck = a2uiHandler.ensureA2uiReady(a2uiUrl)
    if (!readyOnFirstCheck) {
      refreshCanvasHostUrl()
      a2uiUrl = a2uiHandler.resolveA2uiHostUrl() ?: a2uiUrl
      if (!a2uiHandler.ensureA2uiReady(a2uiUrl)) {
        return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_UNAVAILABLE",
          message = "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        )
      }
    }
    return block()
  }

  private suspend fun withCanvasAvailable(block: suspend () -> GatewaySession.InvokeResult): GatewaySession.InvokeResult =
    try {
      block()
    } catch (_: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "NODE_BACKGROUND_UNAVAILABLE",
        message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
      )
    }

  private fun availabilityError(availability: InvokeCommandAvailability): GatewaySession.InvokeResult? =
    when (availability) {
      InvokeCommandAvailability.Always -> null
      InvokeCommandAvailability.CameraEnabled ->
        if (cameraEnabled()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "CAMERA_DISABLED",
            message = "CAMERA_DISABLED: enable Camera in Settings",
          )
        }
      InvokeCommandAvailability.LocationEnabled ->
        if (locationEnabled()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "LOCATION_DISABLED",
            message = "LOCATION_DISABLED: enable Location in Settings",
          )
        }
      InvokeCommandAvailability.MotionActivityAvailable ->
        if (motionActivityAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "MOTION_UNAVAILABLE",
            message = "MOTION_UNAVAILABLE: accelerometer not available",
          )
        }
      InvokeCommandAvailability.MotionPedometerAvailable ->
        if (motionPedometerAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "PEDOMETER_UNAVAILABLE",
            message = "PEDOMETER_UNAVAILABLE: step counter not available",
          )
        }
      InvokeCommandAvailability.SendSmsAvailable ->
        if (sendSmsAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "SMS_UNAVAILABLE",
            message = "SMS_UNAVAILABLE: SMS not available on this device",
          )
        }
      InvokeCommandAvailability.ReadSmsAvailable,
      InvokeCommandAvailability.RequestableSmsSearchAvailable,
      ->
        smsSearchAvailabilityError(
          readSmsAvailable = readSmsAvailable(),
          smsFeatureEnabled = smsFeatureEnabled(),
          smsTelephonyAvailable = smsTelephonyAvailable(),
        )
      InvokeCommandAvailability.CallLogAvailable ->
        if (callLogAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "CALL_LOG_UNAVAILABLE",
            message = "CALL_LOG_UNAVAILABLE: call log not available on this build",
          )
        }
      InvokeCommandAvailability.DebugBuild ->
        if (debugBuild()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "INVALID_REQUEST",
            message = "INVALID_REQUEST: unknown command",
          )
        }
    }
}

interface TalkHandler {
  suspend fun handlePttStart(paramsJson: String?): GatewaySession.InvokeResult

  suspend fun handlePttStop(paramsJson: String?): GatewaySession.InvokeResult

  suspend fun handlePttCancel(paramsJson: String?): GatewaySession.InvokeResult

  suspend fun handlePttOnce(paramsJson: String?): GatewaySession.InvokeResult
}
