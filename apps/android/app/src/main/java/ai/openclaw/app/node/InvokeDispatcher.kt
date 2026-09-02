package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.protocol.OpenClawCalendarCommand
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCapability
import ai.openclaw.app.protocol.OpenClawContactsCommand
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMobileUiCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawNotificationsCommand
import ai.openclaw.app.protocol.OpenClawPhotosCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import ai.openclaw.app.protocol.OpenClawSystemCommand
import ai.openclaw.app.protocol.OpenClawTalkCommand

/** Owns Android command bindings and their live advertised/invoke availability. */
class InvokeDispatcher(
  cameraHandler: CameraHandler,
  locationHandler: LocationHandler,
  deviceHandler: DeviceHandler,
  notificationsHandler: NotificationsHandler,
  systemHandler: SystemHandler,
  talkHandler: TalkHandler,
  photosHandler: PhotosHandler,
  contactsHandler: ContactsHandler,
  calendarHandler: CalendarHandler,
  motionHandler: MotionHandler,
  smsHandler: SmsHandler,
  debugHandler: DebugHandler,
  callLogHandler: CallLogHandler,
  mobileUiHandler: MobileUiHandler,
  private val isForeground: () -> Boolean,
  cameraEnabled: () -> Boolean,
  locationEnabled: () -> Boolean,
  sendSmsAvailable: () -> Boolean,
  private val readSmsAvailable: () -> Boolean,
  smsSearchPossible: () -> Boolean,
  callLogAvailable: () -> Boolean,
  photosAvailable: () -> Boolean,
  installedAppsSharingEnabled: () -> Boolean,
  debugBuild: () -> Boolean,
  motionActivityAvailable: () -> Boolean,
  motionPedometerAvailable: () -> Boolean,
  mobileUiAvailable: () -> Boolean,
  private val voiceWakeAvailable: () -> Boolean,
) {
  private class CommandGate(
    val isAvailable: () -> Boolean,
    val unavailable: GatewaySession.InvokeResult,
    val isAdvertised: () -> Boolean = isAvailable,
  )

  private class Command(
    val name: String,
    val invoke: suspend (String?) -> GatewaySession.InvokeResult,
    val gate: CommandGate? = null,
    val requiresForeground: Boolean = false,
  )

  private val cameraGate =
    CommandGate(cameraEnabled, unavailable("CAMERA_DISABLED", "enable Camera in Settings"))
  private val locationGate =
    CommandGate(locationEnabled, unavailable("LOCATION_DISABLED", "enable Location in Settings"))
  private val motionActivityGate =
    CommandGate(motionActivityAvailable, unavailable("MOTION_UNAVAILABLE", "accelerometer not available"))
  private val motionPedometerGate =
    CommandGate(motionPedometerAvailable, unavailable("PEDOMETER_UNAVAILABLE", "step counter not available"))
  private val smsUnavailable = unavailable("SMS_UNAVAILABLE", "SMS not available on this device")
  private val smsSendGate = CommandGate(sendSmsAvailable, smsUnavailable)
  private val smsSearchGate =
    CommandGate(
      isAvailable = { readSmsAvailable() || smsSearchPossible() },
      unavailable = smsUnavailable,
      // Search is advertised before READ_SMS is granted so its handler can request permission.
      isAdvertised = smsSearchPossible,
    )
  private val callLogGate =
    CommandGate(callLogAvailable, unavailable("CALL_LOG_UNAVAILABLE", "call log not available on this build"))
  private val photosGate =
    CommandGate(photosAvailable, unavailable("PHOTOS_UNAVAILABLE", "photos not available on this build"))
  private val installedAppsGate =
    CommandGate(installedAppsSharingEnabled, unavailable("INSTALLED_APPS_SHARING_DISABLED", "enable Installed Apps in Settings"))
  private val debugGate =
    CommandGate(debugBuild, unavailable("INVALID_REQUEST", "unknown command"))
  private val mobileUiGate =
    CommandGate(mobileUiAvailable, unavailable("MOBILE_UI_UNAVAILABLE", "accessibility service is not connected"))

  // Keep protocol ordering stable. The same entries advertise and dispatch each bound handler.
  private val commands =
    listOf(
      Command(OpenClawSystemCommand.Notify.rawValue, systemHandler::handleSystemNotify),
      Command(OpenClawTalkCommand.PttStart.rawValue, talkHandler::handlePttStart),
      Command(OpenClawTalkCommand.PttStop.rawValue, talkHandler::handlePttStop),
      Command(OpenClawTalkCommand.PttCancel.rawValue, talkHandler::handlePttCancel),
      Command(OpenClawTalkCommand.PttOnce.rawValue, talkHandler::handlePttOnce, requiresForeground = true),
      Command(OpenClawCameraCommand.List.rawValue, cameraHandler::handleList, cameraGate, requiresForeground = true),
      Command(OpenClawCameraCommand.Snap.rawValue, cameraHandler::handleSnap, cameraGate, requiresForeground = true),
      Command(OpenClawCameraCommand.Clip.rawValue, cameraHandler::handleClip, cameraGate, requiresForeground = true),
      Command(OpenClawLocationCommand.Get.rawValue, locationHandler::handleLocationGet, locationGate),
      Command(OpenClawDeviceCommand.Status.rawValue, deviceHandler::handleDeviceStatus),
      Command(OpenClawDeviceCommand.Info.rawValue, deviceHandler::handleDeviceInfo),
      Command(OpenClawDeviceCommand.Permissions.rawValue, deviceHandler::handleDevicePermissions),
      Command(OpenClawDeviceCommand.Health.rawValue, deviceHandler::handleDeviceHealth),
      Command(OpenClawDeviceCommand.Apps.rawValue, deviceHandler::handleDeviceApps, installedAppsGate),
      Command(OpenClawNotificationsCommand.List.rawValue, notificationsHandler::handleNotificationsList),
      Command(OpenClawNotificationsCommand.Actions.rawValue, notificationsHandler::handleNotificationsActions),
      Command(OpenClawPhotosCommand.Latest.rawValue, photosHandler::handlePhotosLatest, photosGate),
      Command(OpenClawContactsCommand.Search.rawValue, contactsHandler::handleContactsSearch),
      Command(OpenClawContactsCommand.Add.rawValue, contactsHandler::handleContactsAdd),
      Command(OpenClawCalendarCommand.Events.rawValue, calendarHandler::handleCalendarEvents),
      Command(OpenClawCalendarCommand.Add.rawValue, calendarHandler::handleCalendarAdd),
      Command(OpenClawMotionCommand.Activity.rawValue, motionHandler::handleMotionActivity, motionActivityGate),
      Command(OpenClawMotionCommand.Pedometer.rawValue, motionHandler::handleMotionPedometer, motionPedometerGate),
      Command(OpenClawSmsCommand.Send.rawValue, smsHandler::handleSmsSend, smsSendGate),
      Command(OpenClawSmsCommand.Search.rawValue, smsHandler::handleSmsSearch, smsSearchGate),
      Command(OpenClawCallLogCommand.Search.rawValue, callLogHandler::handleCallLogSearch, callLogGate),
      Command(OpenClawMobileUiCommand.Observe.rawValue, mobileUiHandler::handleObserve, mobileUiGate),
      Command(OpenClawMobileUiCommand.Act.rawValue, mobileUiHandler::handleAct, mobileUiGate),
      Command("debug.logs", { debugHandler.handleLogs() }, debugGate),
      Command("debug.ed25519", { debugHandler.handleEd25519() }, debugGate),
    )
  private val commandsByName = commands.associateBy(Command::name)

  suspend fun handleInvoke(
    command: String,
    paramsJson: String?,
  ): GatewaySession.InvokeResult {
    val binding = commandsByName[command] ?: return unavailable("INVALID_REQUEST", "unknown command")
    if (binding.requiresForeground && !isForeground()) {
      return unavailable("NODE_BACKGROUND_UNAVAILABLE", "command requires foreground")
    }
    val gate = binding.gate
    if (gate != null && !gate.isAvailable()) return gate.unavailable
    return binding.invoke(paramsJson)
  }

  fun buildInvokeCommands(): List<String> {
    // A settings change must not split a command family within one connect payload.
    val availability = mutableMapOf<CommandGate, Boolean>()
    return commands
      .filter { command ->
        val gate = command.gate
        gate == null || availability.getOrPut(gate, gate.isAdvertised)
      }.map(Command::name)
  }

  fun buildCapabilities(): List<String> =
    buildList {
      add(OpenClawCapability.Device.rawValue)
      add(OpenClawCapability.Notifications.rawValue)
      add(OpenClawCapability.System.rawValue)
      if (cameraGate.isAvailable()) add(OpenClawCapability.Camera.rawValue)
      // A promptable search alone does not advertise the SMS capability.
      if (smsSendGate.isAvailable() || readSmsAvailable()) add(OpenClawCapability.Sms.rawValue)
      add(OpenClawCapability.Talk.rawValue)
      if (locationGate.isAvailable()) add(OpenClawCapability.Location.rawValue)
      if (photosGate.isAvailable()) add(OpenClawCapability.Photos.rawValue)
      add(OpenClawCapability.Contacts.rawValue)
      add(OpenClawCapability.Calendar.rawValue)
      if (motionActivityGate.isAvailable() || motionPedometerGate.isAvailable()) add(OpenClawCapability.Motion.rawValue)
      if (callLogGate.isAvailable()) add(OpenClawCapability.CallLog.rawValue)
      if (voiceWakeAvailable()) add(OpenClawCapability.VoiceWake.rawValue)
      if (mobileUiGate.isAvailable()) add(OpenClawCapability.MobileUI.rawValue)
    }

  private fun unavailable(
    code: String,
    message: String,
  ): GatewaySession.InvokeResult = GatewaySession.InvokeResult.error(code, "$code: $message")
}

/** Talk-mode command adapter implemented by the voice subsystem. */
interface TalkHandler {
  /** Starts a push-to-talk capture session and keeps it open until stop or cancel. */
  suspend fun handlePttStart(paramsJson: String?): GatewaySession.InvokeResult

  /** Finishes the active push-to-talk capture and submits recognized speech. */
  suspend fun handlePttStop(paramsJson: String?): GatewaySession.InvokeResult

  /** Aborts the active push-to-talk capture without submitting speech. */
  suspend fun handlePttCancel(paramsJson: String?): GatewaySession.InvokeResult

  /** Runs a bounded one-shot push-to-talk capture. */
  suspend fun handlePttOnce(paramsJson: String?): GatewaySession.InvokeResult
}
