package ai.openclaw.app.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class OpenClawProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", OpenClawCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", OpenClawCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", OpenClawCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", OpenClawCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", OpenClawCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", OpenClawCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", OpenClawCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", OpenClawCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", OpenClawCapability.Canvas.rawValue)
    assertEquals("camera", OpenClawCapability.Camera.rawValue)
    assertEquals("voiceWake", OpenClawCapability.VoiceWake.rawValue)
    assertEquals("location", OpenClawCapability.Location.rawValue)
    assertEquals("sms", OpenClawCapability.Sms.rawValue)
    assertEquals("device", OpenClawCapability.Device.rawValue)
    assertEquals("notifications", OpenClawCapability.Notifications.rawValue)
    assertEquals("system", OpenClawCapability.System.rawValue)
    assertEquals("photos", OpenClawCapability.Photos.rawValue)
    assertEquals("contacts", OpenClawCapability.Contacts.rawValue)
    assertEquals("calendar", OpenClawCapability.Calendar.rawValue)
    assertEquals("motion", OpenClawCapability.Motion.rawValue)
    assertEquals("callLog", OpenClawCapability.CallLog.rawValue)
  }

  @Test
  fun cameraCommandsUseStableStrings() {
    assertEquals("camera.list", OpenClawCameraCommand.List.rawValue)
    assertEquals("camera.snap", OpenClawCameraCommand.Snap.rawValue)
    assertEquals("camera.clip", OpenClawCameraCommand.Clip.rawValue)
  }

  @Test
  fun notificationsCommandsUseStableStrings() {
    assertEquals("notifications.list", OpenClawNotificationsCommand.List.rawValue)
    assertEquals("notifications.actions", OpenClawNotificationsCommand.Actions.rawValue)
  }

  @Test
  fun deviceCommandsUseStableStrings() {
    assertEquals("device.status", OpenClawDeviceCommand.Status.rawValue)
    assertEquals("device.info", OpenClawDeviceCommand.Info.rawValue)
    assertEquals("device.permissions", OpenClawDeviceCommand.Permissions.rawValue)
    assertEquals("device.health", OpenClawDeviceCommand.Health.rawValue)
  }

  @Test
  fun systemCommandsUseStableStrings() {
    assertEquals("system.notify", OpenClawSystemCommand.Notify.rawValue)
  }

  @Test
  fun photosCommandsUseStableStrings() {
    assertEquals("photos.latest", OpenClawPhotosCommand.Latest.rawValue)
  }

  @Test
  fun contactsCommandsUseStableStrings() {
    assertEquals("contacts.search", OpenClawContactsCommand.Search.rawValue)
    assertEquals("contacts.add", OpenClawContactsCommand.Add.rawValue)
  }

  @Test
  fun calendarCommandsUseStableStrings() {
    assertEquals("calendar.events", OpenClawCalendarCommand.Events.rawValue)
    assertEquals("calendar.add", OpenClawCalendarCommand.Add.rawValue)
  }

  @Test
  fun motionCommandsUseStableStrings() {
    assertEquals("motion.activity", OpenClawMotionCommand.Activity.rawValue)
    assertEquals("motion.pedometer", OpenClawMotionCommand.Pedometer.rawValue)
  }

  @Test
  fun smsCommandsUseStableStrings() {
    assertEquals("sms.send", OpenClawSmsCommand.Send.rawValue)
    assertEquals("sms.search", OpenClawSmsCommand.Search.rawValue)
  }

  @Test
  fun callLogCommandsUseStableStrings() {
    assertEquals("callLog.search", OpenClawCallLogCommand.Search.rawValue)
  }
}
