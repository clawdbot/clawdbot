package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayDiscovery
import ai.openclaw.app.gateway.createGatewaySystemDns
import ai.openclaw.app.node.DeviceHandler
import ai.openclaw.app.node.readAndroidPermissionSnapshot
import ai.openclaw.app.ui.chat.AndroidChatDictationRecognizer
import ai.openclaw.app.ui.chat.ChatDictationFailure
import ai.openclaw.app.ui.chat.canSaveChatWidgetToDownloads
import ai.openclaw.app.ui.chat.dictationFailureForError
import ai.openclaw.app.voice.AndroidOnDeviceVoiceWakeRecognizer
import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.speech.SpeechRecognizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
class AndroidApiCompatibilityTest {
  @Test
  @Config(sdk = [28])
  fun api28UsesLegacyPermissionSemanticsWithoutNewerServices() {
    val app = appContext()
    shadowOf(app).grantPermissions(
      Manifest.permission.ACCESS_COARSE_LOCATION,
      Manifest.permission.READ_CALL_LOG,
    )

    val snapshot =
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = true,
        callLogEnabled = true,
        photosEnabled = false,
        backgroundLocationEnabled = true,
      )

    assertTrue(snapshot.locationBackground)
    assertTrue(snapshot.motion)
    assertFalse(snapshot.callLog)
    shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, true)
    assertTrue(
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = true,
        callLogEnabled = true,
        photosEnabled = false,
        backgroundLocationEnabled = true,
      ).callLog,
    )
    assertTrue(AndroidPermissionPolicy.hasBackgroundLocation(app))
    assertTrue(AndroidPermissionPolicy.hasActivityRecognition(app))
    assertNull(createGatewaySystemDns(app, directExecutor))
    assertFalse(AndroidChatDictationRecognizer(app).isAvailable)
    assertFalse(AndroidOnDeviceVoiceWakeRecognizer(app).isAvailable)
    assertFalse(canSaveChatWidgetToDownloads())
  }

  @Test
  @Config(sdk = [28])
  fun api28ConstructsDiscoveryAndReportsUnknownThermalState() {
    val app = appContext()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    try {
      GatewayDiscovery(app, scope)
    } finally {
      scope.cancel()
    }

    val result = DeviceHandler(app).handleDeviceStatus(null)
    val payload = Json.parseToJsonElement(result.payloadJson.orEmpty()).jsonObject
    assertEquals(
      "unknown",
      payload
        .getValue("thermal")
        .jsonObject
        .getValue("state")
        .jsonPrimitive.content,
    )
  }

  @Test
  @Config(sdk = [28])
  fun api28ForegroundServiceTypesAreIgnored() {
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    try {
      assertEquals(0, foregroundServiceTypes(VoiceCaptureMode.TalkMode, backgroundLocationActive = true))
    } finally {
      controller.destroy()
    }
  }

  @Test
  @Config(sdk = [29])
  fun api29RequiresNewRuntimePermissionsAndOmitsMicrophoneServiceType() {
    val app = appContext()
    assertFalse(AndroidPermissionPolicy.hasBackgroundLocation(app))
    assertFalse(AndroidPermissionPolicy.hasActivityRecognition(app))
    assertTrue(canSaveChatWidgetToDownloads())
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      foregroundServiceTypes(VoiceCaptureMode.TalkMode, backgroundLocationActive = true),
    )
  }

  @Test
  @Config(sdk = [30])
  fun api30AddsMicrophoneForegroundServiceType() {
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      foregroundServiceTypes(VoiceCaptureMode.ManualMic, backgroundLocationActive = false),
    )
  }

  @Test
  @Config(sdk = [31])
  fun api31ActivatesModernSpeechAndCommunicationContracts() {
    val app = appContext()

    assertNotNull(createGatewaySystemDns(app, directExecutor))
    assertEquals(
      ChatDictationFailure.Unavailable,
      dictationFailureForError(SpeechRecognizer.ERROR_SERVER_DISCONNECTED),
    )
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      foregroundServiceTypes(VoiceCaptureMode.TalkMode, backgroundLocationActive = false),
    )
    // These calls cross the API 31 speech boundary even when Robolectric has no
    // installed on-device recognition service.
    AndroidChatDictationRecognizer(app).isAvailable
    AndroidOnDeviceVoiceWakeRecognizer(app).isAvailable
  }

  @Test
  @Config(sdk = [36])
  fun currentApiRetainsModernPermissionAndServiceContracts() {
    val app = appContext()

    assertFalse(AndroidPermissionPolicy.hasBackgroundLocation(app))
    assertFalse(AndroidPermissionPolicy.hasActivityRecognition(app))
    assertTrue(canSaveChatWidgetToDownloads())
    assertNotNull(createGatewaySystemDns(app, directExecutor))
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      foregroundServiceTypes(VoiceCaptureMode.ManualMic, backgroundLocationActive = true),
    )
  }

  private fun appContext(): Application = RuntimeEnvironment.getApplication()

  private val directExecutor = Executor(Runnable::run)
}
