package ai.openclaw.app

import android.app.Notification
import android.content.Intent
import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeForegroundServiceTest {
  @Test
  fun buildNotificationSetsLaunchIntent() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()
    val notification = buildNotification(service)

    val pendingIntent = notification.contentIntent
    assertNotNull(pendingIntent)

    val savedIntent = Shadows.shadowOf(pendingIntent).savedIntent
    assertNotNull(savedIntent)
    assertEquals(MainActivity::class.java.name, savedIntent.component?.className)

    val expectedFlags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    assertEquals(expectedFlags, savedIntent.flags and expectedFlags)
  }

  @Test
  fun foregroundServiceTypesForVoiceMode_addsMicrophoneOnlyForTalkMode() {
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      foregroundServiceTypesForVoiceMode(VoiceCaptureMode.Off),
    )
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      foregroundServiceTypesForVoiceMode(VoiceCaptureMode.ManualMic),
    )
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      foregroundServiceTypesForVoiceMode(VoiceCaptureMode.TalkMode),
    )
  }

  @Test
  fun voiceNotificationSuffixReflectsActiveCaptureMode() {
    assertEquals("", voiceNotificationSuffix(VoiceCaptureMode.Off, false, false, false, false))
    assertEquals(
      " · Mic: Listening",
      voiceNotificationSuffix(VoiceCaptureMode.ManualMic, true, true, false, false),
    )
    assertEquals(
      " · Talk: Speaking",
      voiceNotificationSuffix(VoiceCaptureMode.TalkMode, false, false, true, true),
    )
  }

  private fun buildNotification(service: NodeForegroundService): Notification {
    val method =
      NodeForegroundService::class.java.getDeclaredMethod(
        "buildNotification",
        String::class.java,
        String::class.java,
      )
    method.isAccessible = true
    return method.invoke(service, "Title", "Text") as Notification
  }
}
