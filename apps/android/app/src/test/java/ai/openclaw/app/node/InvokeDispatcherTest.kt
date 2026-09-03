package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.testDeviceIdentityStore
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMobileUiCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawPhotosCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import ai.openclaw.app.protocol.OpenClawTalkCommand
import android.content.Context
import android.content.pm.PackageManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class InvokeDispatcherTest {
  @Test
  fun handleInvoke_allowsRequestableSmsSearchToReachHandler() =
    runTest {
      val result =
        newInvokeDispatcher(
          readSmsAvailable = false,
          smsFeatureEnabled = true,
          smsTelephonyAvailable = true,
        ).handleInvoke(OpenClawSmsCommand.Search.rawValue, "not-json")

      assertEquals("SMS_PERMISSION_REQUIRED", result.error?.code)
      assertEquals("grant READ_SMS permission", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksSmsSearchWhenFeatureIsUnavailable() =
    runTest {
      val result =
        newInvokeDispatcher(
          readSmsAvailable = false,
          smsFeatureEnabled = false,
          smsTelephonyAvailable = true,
        ).handleInvoke(OpenClawSmsCommand.Search.rawValue, "not-json")

      assertEquals("SMS_UNAVAILABLE", result.error?.code)
      assertEquals("SMS_UNAVAILABLE: SMS not available on this device", result.error?.message)
    }

  @Test
  fun handleInvoke_allowsAvailableSmsSendToReachHandler() =
    runTest {
      val result =
        newInvokeDispatcher(
          sendSmsAvailable = true,
          smsFeatureEnabled = true,
          smsTelephonyAvailable = true,
        ).handleInvoke(OpenClawSmsCommand.Send.rawValue, """{"to":"+15551234567","message":"hi"}""")

      assertEquals("SMS_PERMISSION_REQUIRED", result.error?.code)
      assertEquals("grant SMS permission", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksSmsSendWhenUnavailable() =
    runTest {
      val result =
        newInvokeDispatcher(
          sendSmsAvailable = false,
          smsFeatureEnabled = true,
          smsTelephonyAvailable = true,
        ).handleInvoke(OpenClawSmsCommand.Send.rawValue, """{"to":"+15551234567","message":"hi"}""")

      assertEquals("SMS_UNAVAILABLE", result.error?.code)
      assertEquals("SMS_UNAVAILABLE: SMS not available on this device", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksCameraCommandsWhenCameraDisabled() =
    runTest {
      val result = newInvokeDispatcher(cameraEnabled = { false }).handleInvoke(OpenClawCameraCommand.List.rawValue, null)

      assertEquals("CAMERA_DISABLED", result.error?.code)
      assertEquals("CAMERA_DISABLED: enable Camera in Settings", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksLocationCommandWhenLocationDisabled() =
    runTest {
      val result = newInvokeDispatcher(locationEnabled = false).handleInvoke(OpenClawLocationCommand.Get.rawValue, null)

      assertEquals("LOCATION_DISABLED", result.error?.code)
      assertEquals("LOCATION_DISABLED: enable Location in Settings", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksDeviceAppsWhenSharingDisabled() =
    runTest {
      val result =
        newInvokeDispatcher(installedAppsSharingEnabled = false)
          .handleInvoke(OpenClawDeviceCommand.Apps.rawValue, """{"limit":1}""")

      assertEquals("INSTALLED_APPS_SHARING_DISABLED", result.error?.code)
      assertEquals(
        "INSTALLED_APPS_SHARING_DISABLED: enable Installed Apps in Settings",
        result.error?.message,
      )
    }

  @Test
  fun handleInvoke_blocksMotionActivityWhenUnavailable() =
    runTest {
      val result =
        newInvokeDispatcher(motionActivityAvailable = false)
          .handleInvoke(OpenClawMotionCommand.Activity.rawValue, null)

      assertEquals("MOTION_UNAVAILABLE", result.error?.code)
      assertEquals("MOTION_UNAVAILABLE: accelerometer not available", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksMotionPedometerWhenUnavailable() =
    runTest {
      val result =
        newInvokeDispatcher(motionPedometerAvailable = false)
          .handleInvoke(OpenClawMotionCommand.Pedometer.rawValue, null)

      assertEquals("PEDOMETER_UNAVAILABLE", result.error?.code)
      assertEquals("PEDOMETER_UNAVAILABLE: step counter not available", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksCallLogWhenUnavailable() =
    runTest {
      val result =
        newInvokeDispatcher(callLogAvailable = false).handleInvoke(OpenClawCallLogCommand.Search.rawValue, null)

      assertEquals("CALL_LOG_UNAVAILABLE", result.error?.code)
      assertEquals("CALL_LOG_UNAVAILABLE: call log not available on this build", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksPhotosWhenUnavailable() =
    runTest {
      val result = newInvokeDispatcher(photosAvailable = false).handleInvoke(OpenClawPhotosCommand.Latest.rawValue, null)

      assertEquals("PHOTOS_UNAVAILABLE", result.error?.code)
      assertEquals("PHOTOS_UNAVAILABLE: photos not available on this build", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksMobileUiWhenServiceIsUnavailable() =
    runTest {
      val result =
        newInvokeDispatcher(mobileUiAvailable = false)
          .handleInvoke(OpenClawMobileUiCommand.Observe.rawValue, null)

      assertEquals("MOBILE_UI_UNAVAILABLE", result.error?.code)
      assertEquals(
        "MOBILE_UI_UNAVAILABLE: accessibility service is not connected",
        result.error?.message,
      )
    }

  @Test
  fun handleInvoke_treatsDebugCommandsAsUnknownOutsideDebugBuilds() =
    runTest {
      val result = newInvokeDispatcher(debugBuild = false).handleInvoke("debug.logs", null)

      assertEquals("INVALID_REQUEST", result.error?.code)
      assertEquals("INVALID_REQUEST: unknown command", result.error?.message)
    }

  @Test
  fun handleInvoke_routesTalkPttCommands() =
    runTest {
      val talk = InvokeDispatcherFakeTalkHandler()
      val dispatcher = newInvokeDispatcher(talkHandler = talk)

      val start = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)
      val stop = dispatcher.handleInvoke(OpenClawTalkCommand.PttStop.rawValue, null)
      val cancel = dispatcher.handleInvoke(OpenClawTalkCommand.PttCancel.rawValue, null)
      val once = dispatcher.handleInvoke(OpenClawTalkCommand.PttOnce.rawValue, null)

      assertEquals("""{"captureId":"start"}""", start.payloadJson)
      assertEquals("""{"status":"stop"}""", stop.payloadJson)
      assertEquals("""{"status":"cancel"}""", cancel.payloadJson)
      assertEquals("""{"status":"once"}""", once.payloadJson)
      assertEquals(
        listOf("start", "stop", "cancel", "once"),
        talk.calls,
      )
    }

  @Test
  fun handleInvoke_blocksTalkOnceButLeavesPttStartToRuntimeStateGateWhenBackgrounded() =
    runTest {
      val talk = InvokeDispatcherFakeTalkHandler()
      val dispatcher = newInvokeDispatcher(isForeground = { false }, talkHandler = talk)

      val start = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)
      val once = dispatcher.handleInvoke(OpenClawTalkCommand.PttOnce.rawValue, null)
      val stop = dispatcher.handleInvoke(OpenClawTalkCommand.PttStop.rawValue, null)
      val cancel = dispatcher.handleInvoke(OpenClawTalkCommand.PttCancel.rawValue, null)

      assertEquals("""{"captureId":"start"}""", start.payloadJson)
      assertEquals("NODE_BACKGROUND_UNAVAILABLE", once.error?.code)
      assertEquals("NODE_BACKGROUND_UNAVAILABLE: command requires foreground", once.error?.message)
      assertEquals("""{"status":"stop"}""", stop.payloadJson)
      assertEquals("""{"status":"cancel"}""", cancel.payloadJson)
      assertEquals(listOf("start", "stop", "cancel"), talk.calls)
    }

  @Test
  fun foregroundAndAvailabilityGatesReadCurrentStateBeforeInvokingHandlers() =
    runTest {
      var foreground = false
      var cameraEnabled = false
      var cameraReads = 0
      val dispatcher =
        newInvokeDispatcher(
          isForeground = { foreground },
          cameraEnabled = {
            cameraReads += 1
            cameraEnabled
          },
        )

      assertEquals("INVALID_REQUEST", dispatcher.handleInvoke("not.real", null).error?.code)
      assertEquals(
        "NODE_BACKGROUND_UNAVAILABLE",
        dispatcher.handleInvoke(OpenClawCameraCommand.List.rawValue, null).error?.code,
      )
      assertEquals(0, cameraReads)

      foreground = true
      assertEquals("CAMERA_DISABLED", dispatcher.handleInvoke(OpenClawCameraCommand.List.rawValue, null).error?.code)
      assertEquals(1, cameraReads)

      cameraEnabled = true
      assertTrue(dispatcher.buildInvokeCommands().contains(OpenClawCameraCommand.List.rawValue))
      assertTrue(dispatcher.buildCapabilities().contains("camera"))
      cameraEnabled = false
      assertFalse(dispatcher.buildInvokeCommands().contains(OpenClawCameraCommand.List.rawValue))
      assertEquals("CAMERA_DISABLED", dispatcher.handleInvoke(OpenClawCameraCommand.List.rawValue, null).error?.code)
    }

  @Test
  fun advertisementSamplesEachCommandFamilyOnceAndRefreshesOnNextBuild() {
    var cameraReads = 0
    val dispatcher =
      newInvokeDispatcher(
        cameraEnabled = {
          cameraReads += 1
          cameraReads % 2 == 1
        },
      )

    val cameras = listOf(OpenClawCameraCommand.List, OpenClawCameraCommand.Snap, OpenClawCameraCommand.Clip).map { it.rawValue }
    val enabled = dispatcher.buildInvokeCommands()
    assertEquals(1, cameraReads)
    assertEquals(cameras, enabled.filter { it in cameras })

    val disabled = dispatcher.buildInvokeCommands()
    assertEquals(2, cameraReads)
    assertTrue(disabled.none { it in cameras })
  }

  @Test
  fun boundHandlerReceivesOpaqueParamsAndPropagatesFailureAndCancellation() =
    runTest {
      val talk = InvokeDispatcherFakeTalkHandler()
      val dispatcher = newInvokeDispatcher(talkHandler = talk)
      val params = "opaque handler-owned params"
      dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, params)
      assertEquals(listOf(params), talk.params)

      for (failure in listOf(IllegalStateException("synthetic failure"), CancellationException("synthetic cancellation"))) {
        talk.failure = failure
        val result = runCatching { dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, params) }
        assertSame(failure, result.exceptionOrNull())
      }
    }

  @Test
  fun advertisedCommandsReachBoundHandlersInsteadOfUnknownCommandFallbacks() =
    runTest {
      val dispatcher =
        newInvokeDispatcher(
          isForeground = { false },
          cameraEnabled = { true },
          locationEnabled = true,
          sendSmsAvailable = true,
          readSmsAvailable = true,
          callLogAvailable = true,
          photosAvailable = true,
          installedAppsSharingEnabled = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
          mobileUiAvailable = true,
        )

      for (command in dispatcher.buildInvokeCommands()) {
        val result = dispatcher.handleInvoke(command, "{}")
        assertNotEquals(command, "INVALID_REQUEST: unknown command", result.error?.message)
      }
    }
}

internal fun newInvokeDispatcher(
  isForeground: () -> Boolean = { true },
  cameraEnabled: () -> Boolean = { false },
  locationEnabled: Boolean = false,
  sendSmsAvailable: Boolean = false,
  readSmsAvailable: Boolean = false,
  smsFeatureEnabled: Boolean = true,
  smsTelephonyAvailable: Boolean = true,
  callLogAvailable: Boolean = false,
  photosAvailable: Boolean = true,
  installedAppsSharingEnabled: Boolean = true,
  debugBuild: Boolean = false,
  motionActivityAvailable: Boolean = false,
  motionPedometerAvailable: Boolean = false,
  mobileUiAvailable: Boolean = false,
  talkHandler: TalkHandler = InvokeDispatcherFakeTalkHandler(),
  smsSearchPossible: () -> Boolean = { smsFeatureEnabled && smsTelephonyAvailable },
  voiceWakeAvailable: () -> Boolean = { false },
): InvokeDispatcher {
  val appContext = RuntimeEnvironment.getApplication()
  shadowOf(appContext.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, smsTelephonyAvailable)
  return InvokeDispatcher(
    cameraHandler = newCameraHandler(appContext),
    locationHandler =
      LocationHandler.forTesting(
        appContext = appContext,
        dataSource = InvokeDispatcherFakeLocationDataSource(),
      ),
    deviceHandler = DeviceHandler(appContext),
    notificationsHandler =
      NotificationsHandler(
        appContext = appContext,
        stateProvider = InvokeDispatcherFakeNotificationsStateProvider(),
      ),
    systemHandler = SystemHandler(InvokeDispatcherFakeSystemNotificationPoster()),
    talkHandler = talkHandler,
    photosHandler = PhotosHandler(appContext, InvokeDispatcherFakePhotosDataSource()),
    contactsHandler = ContactsHandler(appContext, InvokeDispatcherFakeContactsDataSource()),
    calendarHandler = CalendarHandler(appContext, InvokeDispatcherFakeCalendarDataSource()),
    motionHandler = MotionHandler(appContext, InvokeDispatcherFakeMotionDataSource()),
    smsHandler = SmsHandler(SmsManager(appContext)),
    debugHandler = DebugHandler(appContext, testDeviceIdentityStore(appContext)),
    callLogHandler = CallLogHandler.forTesting(appContext, InvokeDispatcherFakeCallLogDataSource()),
    mobileUiHandler = MobileUiHandler(),
    isForeground = isForeground,
    cameraEnabled = cameraEnabled,
    locationEnabled = { locationEnabled },
    sendSmsAvailable = { sendSmsAvailable },
    readSmsAvailable = { readSmsAvailable },
    smsSearchPossible = smsSearchPossible,
    callLogAvailable = { callLogAvailable },
    photosAvailable = { photosAvailable },
    installedAppsSharingEnabled = { installedAppsSharingEnabled },
    debugBuild = { debugBuild },
    motionActivityAvailable = { motionActivityAvailable },
    motionPedometerAvailable = { motionPedometerAvailable },
    mobileUiAvailable = { mobileUiAvailable },
    voiceWakeAvailable = voiceWakeAvailable,
  )
}

private fun newCameraHandler(appContext: Context): CameraHandler =
  CameraHandler(
    appContext = appContext,
    camera = CameraCaptureManager(appContext),
    setCameraAudioCaptureActive = { true },
    invokeErrorFromThrowable = { err -> "UNAVAILABLE" to (err.message ?: "camera failed") },
  )

private class InvokeDispatcherFakeLocationDataSource : LocationDataSource {
  override fun hasFinePermission(context: Context): Boolean = false

  override fun hasCoarsePermission(context: Context): Boolean = false

  override fun hasBackgroundPermission(context: Context): Boolean = false

  override suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
    isPrecise: Boolean,
  ): LocationCaptureManager.Payload {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeNotificationsStateProvider : NotificationsStateProvider {
  override fun readSnapshot(context: Context): DeviceNotificationSnapshot = DeviceNotificationSnapshot(enabled = false, connected = false, notifications = emptyList())

  override fun requestServiceRebind(context: Context) = Unit

  override fun executeAction(
    context: Context,
    request: NotificationActionRequest,
  ): NotificationActionResult = NotificationActionResult(ok = true, code = null, message = null)
}

private class InvokeDispatcherFakeSystemNotificationPoster : SystemNotificationPoster {
  override fun post(request: SystemNotifyRequest) = Unit
}

private class InvokeDispatcherFakeTalkHandler : TalkHandler {
  val calls = mutableListOf<String>()
  val params = mutableListOf<String?>()
  var failure: Throwable? = null

  override suspend fun handlePttStart(paramsJson: String?): GatewaySession.InvokeResult {
    calls.add("start")
    params.add(paramsJson)
    failure?.let { throw it }
    return GatewaySession.InvokeResult.ok("""{"captureId":"start"}""")
  }

  override suspend fun handlePttStop(paramsJson: String?): GatewaySession.InvokeResult {
    calls.add("stop")
    return GatewaySession.InvokeResult.ok("""{"status":"stop"}""")
  }

  override suspend fun handlePttCancel(paramsJson: String?): GatewaySession.InvokeResult {
    calls.add("cancel")
    return GatewaySession.InvokeResult.ok("""{"status":"cancel"}""")
  }

  override suspend fun handlePttOnce(paramsJson: String?): GatewaySession.InvokeResult {
    calls.add("once")
    return GatewaySession.InvokeResult.ok("""{"status":"once"}""")
  }
}

private class InvokeDispatcherFakePhotosDataSource : PhotosDataSource {
  override fun hasPermission(context: Context): Boolean = true

  override fun latest(
    context: Context,
    request: PhotosLatestRequest,
  ): List<EncodedPhotoPayload> = emptyList()
}

private class InvokeDispatcherFakeContactsDataSource : ContactsDataSource {
  override fun hasReadPermission(context: Context): Boolean = true

  override fun hasWritePermission(context: Context): Boolean = true

  override fun search(
    context: Context,
    request: ContactsSearchRequest,
  ): List<ContactRecord> = emptyList()

  override fun add(
    context: Context,
    request: ContactsAddRequest,
  ): ContactRecord {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeCalendarDataSource : CalendarDataSource {
  override fun hasReadPermission(context: Context): Boolean = true

  override fun hasWritePermission(context: Context): Boolean = true

  override fun events(
    context: Context,
    request: CalendarEventsRequest,
  ): List<CalendarEventRecord> = emptyList()

  override fun add(
    context: Context,
    request: CalendarAddRequest,
  ): CalendarEventRecord {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeMotionDataSource : MotionDataSource {
  override fun isActivityAvailable(context: Context): Boolean = false

  override fun isPedometerAvailable(context: Context): Boolean = false

  override fun hasPermission(context: Context): Boolean = true

  override suspend fun activity(
    context: Context,
    request: MotionActivityRequest,
  ): MotionActivityRecord {
    error("unused in InvokeDispatcherTest")
  }

  override suspend fun pedometer(
    context: Context,
    request: MotionPedometerRequest,
  ): PedometerRecord {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeCallLogDataSource : CallLogDataSource {
  override fun hasReadPermission(context: Context): Boolean = true

  override fun search(
    context: Context,
    request: CallLogSearchRequest,
  ): List<CallLogRecord> = emptyList()
}
