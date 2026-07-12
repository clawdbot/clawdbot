package ai.openclaw.app.node

import ai.openclaw.app.protocol.OpenClawCalendarCommand
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCapability
import ai.openclaw.app.protocol.OpenClawContactsCommand
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawNotificationsCommand
import ai.openclaw.app.protocol.OpenClawPhotosCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import ai.openclaw.app.protocol.OpenClawSystemCommand
import ai.openclaw.app.protocol.OpenClawTalkCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  private val coreCapabilities =
    setOf(
      OpenClawCapability.Canvas.rawValue,
      OpenClawCapability.Device.rawValue,
      OpenClawCapability.Notifications.rawValue,
      OpenClawCapability.System.rawValue,
      OpenClawCapability.Talk.rawValue,
      OpenClawCapability.Contacts.rawValue,
      OpenClawCapability.Calendar.rawValue,
    )

  private val optionalCapabilities =
    setOf(
      OpenClawCapability.Camera.rawValue,
      OpenClawCapability.Location.rawValue,
      OpenClawCapability.Sms.rawValue,
      OpenClawCapability.CallLog.rawValue,
      OpenClawCapability.Motion.rawValue,
      OpenClawCapability.Photos.rawValue,
    )

  private val coreCommands =
    setOf(
      OpenClawDeviceCommand.Status.rawValue,
      OpenClawDeviceCommand.Info.rawValue,
      OpenClawDeviceCommand.Permissions.rawValue,
      OpenClawDeviceCommand.Health.rawValue,
      OpenClawNotificationsCommand.List.rawValue,
      OpenClawNotificationsCommand.Actions.rawValue,
      OpenClawSystemCommand.Notify.rawValue,
      OpenClawTalkCommand.PttStart.rawValue,
      OpenClawTalkCommand.PttStop.rawValue,
      OpenClawTalkCommand.PttCancel.rawValue,
      OpenClawTalkCommand.PttOnce.rawValue,
      OpenClawContactsCommand.Search.rawValue,
      OpenClawContactsCommand.Add.rawValue,
      OpenClawCalendarCommand.Events.rawValue,
      OpenClawCalendarCommand.Add.rawValue,
    )

  private val optionalCommands =
    setOf(
      OpenClawCameraCommand.Snap.rawValue,
      OpenClawCameraCommand.Clip.rawValue,
      OpenClawCameraCommand.List.rawValue,
      OpenClawLocationCommand.Get.rawValue,
      OpenClawMotionCommand.Activity.rawValue,
      OpenClawMotionCommand.Pedometer.rawValue,
      OpenClawSmsCommand.Send.rawValue,
      OpenClawSmsCommand.Search.rawValue,
      OpenClawCallLogCommand.Search.rawValue,
      OpenClawPhotosCommand.Latest.rawValue,
    )

  private val debugCommands = setOf("debug.logs", "debug.ed25519")

  @Test
  fun advertisedCapabilities_respectsFeatureAvailability() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags())

    assertContainsAll(capabilities, coreCapabilities)
    assertMissingAll(capabilities, optionalCapabilities)
  }

  @Test
  fun advertisedCapabilities_includesFeatureCapabilitiesWhenEnabled() {
    val capabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          sendSmsAvailable = true,
          readSmsAvailable = true,
          smsSearchPossible = true,
          callLogAvailable = true,
          photosAvailable = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
        ),
      )

    assertContainsAll(capabilities, coreCapabilities + optionalCapabilities)
  }

  @Test
  fun advertisedCommands_respectsFeatureAvailability() {
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags())

    assertContainsAll(commands, coreCommands)
    assertMissingAll(commands, optionalCommands + debugCommands)
  }

  @Test
  fun advertisedCommands_includesDeviceAppsOnlyWhenUserOptedIn() {
    val disabled = InvokeCommandRegistry.advertisedCommands(defaultFlags(installedAppsSharingEnabled = false))
    val enabled = InvokeCommandRegistry.advertisedCommands(defaultFlags(installedAppsSharingEnabled = true))

    assertFalse(disabled.contains(OpenClawDeviceCommand.Apps.rawValue))
    assertTrue(enabled.contains(OpenClawDeviceCommand.Apps.rawValue))
  }

  @Test
  fun advertisedCommands_includesFeatureCommandsWhenEnabled() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          sendSmsAvailable = true,
          readSmsAvailable = true,
          smsSearchPossible = true,
          callLogAvailable = true,
          photosAvailable = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
          debugBuild = true,
        ),
      )

    assertContainsAll(commands, coreCommands + optionalCommands + debugCommands)
  }

  @Test
  fun advertisedCommands_onlyIncludesSupportedMotionCommands() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        NodeRuntimeFlags(
          cameraEnabled = false,
          locationEnabled = false,
          sendSmsAvailable = false,
          readSmsAvailable = false,
          smsSearchPossible = false,
          callLogAvailable = false,
          photosAvailable = false,
          motionActivityAvailable = true,
          motionPedometerAvailable = false,
          installedAppsSharingEnabled = false,
          debugBuild = false,
        ),
      )

    assertTrue(commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(OpenClawMotionCommand.Pedometer.rawValue))
  }

  @Test
  fun advertisedCommands_splitsSmsSendAndSearchAvailability() {
    val readOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(readSmsAvailable = true, smsSearchPossible = true),
      )
    val sendOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(sendSmsAvailable = true),
      )
    val requestableSearchCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(smsSearchPossible = true),
      )

    assertTrue(readOnlyCommands.contains(OpenClawSmsCommand.Search.rawValue))
    assertFalse(readOnlyCommands.contains(OpenClawSmsCommand.Send.rawValue))
    assertTrue(sendOnlyCommands.contains(OpenClawSmsCommand.Send.rawValue))
    assertFalse(sendOnlyCommands.contains(OpenClawSmsCommand.Search.rawValue))
    assertTrue(requestableSearchCommands.contains(OpenClawSmsCommand.Search.rawValue))
  }

  @Test
  fun advertisedCapabilities_includeSmsWhenEitherSmsPathIsAvailable() {
    val readOnlyCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(readSmsAvailable = true),
      )
    val sendOnlyCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(sendSmsAvailable = true),
      )
    val requestableSearchCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(smsSearchPossible = true),
      )

    assertTrue(readOnlyCapabilities.contains(OpenClawCapability.Sms.rawValue))
    assertTrue(sendOnlyCapabilities.contains(OpenClawCapability.Sms.rawValue))
    assertFalse(requestableSearchCapabilities.contains(OpenClawCapability.Sms.rawValue))
  }

  @Test
  fun advertisedCommands_excludesCallLogWhenUnavailable() {
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags(callLogAvailable = false))

    assertFalse(commands.contains(OpenClawCallLogCommand.Search.rawValue))
  }

  @Test
  fun advertisedCapabilities_excludesCallLogWhenUnavailable() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags(callLogAvailable = false))

    assertFalse(capabilities.contains(OpenClawCapability.CallLog.rawValue))
  }

  @Test
  fun advertisedPhotosSurface_respectsFeatureAvailability() {
    val disabledFlags = defaultFlags(photosAvailable = false)
    val enabledFlags = defaultFlags(photosAvailable = true)

    assertFalse(InvokeCommandRegistry.advertisedCapabilities(disabledFlags).contains(OpenClawCapability.Photos.rawValue))
    assertFalse(InvokeCommandRegistry.advertisedCommands(disabledFlags).contains(OpenClawPhotosCommand.Latest.rawValue))
    assertTrue(InvokeCommandRegistry.advertisedCapabilities(enabledFlags).contains(OpenClawCapability.Photos.rawValue))
    assertTrue(InvokeCommandRegistry.advertisedCommands(enabledFlags).contains(OpenClawPhotosCommand.Latest.rawValue))
  }

  @Test
  fun find_returnsForegroundMetadataForCameraCommands() {
    val list = InvokeCommandRegistry.find(OpenClawCameraCommand.List.rawValue)
    val location = InvokeCommandRegistry.find(OpenClawLocationCommand.Get.rawValue)
    val pttStart = InvokeCommandRegistry.find(OpenClawTalkCommand.PttStart.rawValue)
    val pttStop = InvokeCommandRegistry.find(OpenClawTalkCommand.PttStop.rawValue)
    val pttCancel = InvokeCommandRegistry.find(OpenClawTalkCommand.PttCancel.rawValue)
    val pttOnce = InvokeCommandRegistry.find(OpenClawTalkCommand.PttOnce.rawValue)

    assertNotNull(list)
    assertEquals(true, list?.requiresForeground)
    assertNotNull(location)
    assertEquals(false, location?.requiresForeground)
    assertNotNull(pttStart)
    assertEquals(false, pttStart?.requiresForeground)
    assertNotNull(pttStop)
    assertEquals(false, pttStop?.requiresForeground)
    assertNotNull(pttCancel)
    assertEquals(false, pttCancel?.requiresForeground)
    assertNotNull(pttOnce)
    assertEquals(true, pttOnce?.requiresForeground)
  }

  @Test
  fun find_returnsNullForUnknownCommand() {
    assertNull(InvokeCommandRegistry.find("not.real"))
  }

  private fun defaultFlags(
    cameraEnabled: Boolean = false,
    locationEnabled: Boolean = false,
    sendSmsAvailable: Boolean = false,
    readSmsAvailable: Boolean = false,
    smsSearchPossible: Boolean = false,
    callLogAvailable: Boolean = false,
    photosAvailable: Boolean = false,
    motionActivityAvailable: Boolean = false,
    motionPedometerAvailable: Boolean = false,
    installedAppsSharingEnabled: Boolean = false,
    debugBuild: Boolean = false,
  ): NodeRuntimeFlags =
    NodeRuntimeFlags(
      cameraEnabled = cameraEnabled,
      locationEnabled = locationEnabled,
      sendSmsAvailable = sendSmsAvailable,
      readSmsAvailable = readSmsAvailable,
      smsSearchPossible = smsSearchPossible,
      callLogAvailable = callLogAvailable,
      photosAvailable = photosAvailable,
      motionActivityAvailable = motionActivityAvailable,
      motionPedometerAvailable = motionPedometerAvailable,
      installedAppsSharingEnabled = installedAppsSharingEnabled,
      debugBuild = debugBuild,
    )

  private fun assertContainsAll(
    actual: List<String>,
    expected: Set<String>,
  ) {
    expected.forEach { value -> assertTrue(actual.contains(value)) }
  }

  private fun assertMissingAll(
    actual: List<String>,
    forbidden: Set<String>,
  ) {
    forbidden.forEach { value -> assertFalse(actual.contains(value)) }
  }
}
