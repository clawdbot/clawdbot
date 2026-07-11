package ai.openclaw.app

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeForegroundServiceTest {
  @Test
  fun restoreStickyRuntimeCreatesAndActivatesMissingProcessRuntime() =
    runBlocking {
      val restoredRuntime = Any()
      var created = false
      var activated: Any? = null

      restoreStickyRuntime(
        createRuntime = {
          created = true
          restoredRuntime
        },
        disconnectRequested = { false },
        disconnectRuntime = {},
        activateRuntime = {
          activated = it
          true
        },
      )

      assertTrue(created)
      assertSame(restoredRuntime, activated)
    }

  @Test
  fun restoreStickyRuntimeDoesNotCreateAfterDisconnectAlreadyWon() =
    runBlocking {
      var created = false

      restoreStickyRuntime(
        createRuntime = {
          created = true
          Any()
        },
        disconnectRequested = { true },
        disconnectRuntime = {},
        activateRuntime = { true },
      )

      assertFalse(created)
    }

  @Test
  fun restoreStickyRuntimeHonorsDisconnectRequestedDuringCreation() =
    runBlocking {
      val restoredRuntime = Any()
      var disconnectRequested = false
      var disconnected: Any? = null
      var activated = false

      restoreStickyRuntime(
        createRuntime = {
          disconnectRequested = true
          restoredRuntime
        },
        disconnectRequested = { disconnectRequested },
        disconnectRuntime = { disconnected = it },
        activateRuntime = {
          activated = true
          true
        },
      )

      assertSame(restoredRuntime, disconnected)
      assertFalse(activated)
    }

  @Test
  fun restoreStickyRuntimeDisconnectsWhenActivationDeclinesOwnership() =
    runBlocking {
      val restoredRuntime = Any()
      var disconnected: Any? = null

      restoreStickyRuntime(
        createRuntime = { restoredRuntime },
        disconnectRequested = { false },
        disconnectRuntime = { disconnected = it },
        activateRuntime = { false },
      )

      assertSame(restoredRuntime, disconnected)
    }

  @Test
  fun coldStopDoesNotCreateRuntime() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    assertNull(app.peekRuntime())
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()

    try {
      val result =
        controller
          .get()
          .onStartCommand(
            Intent(app, NodeForegroundService::class.java)
              .setAction("ai.openclaw.app.action.STOP"),
            0,
            1,
          )

      assertEquals(Service.START_NOT_STICKY, result)
      assertNull(app.peekRuntime())

      val secondResult = controller.get().onStartCommand(Intent(app, NodeForegroundService::class.java), 0, 2)
      assertEquals(Service.START_NOT_STICKY, secondResult)
      assertEquals(2, Shadows.shadowOf(controller.get()).stopSelfResultId)
      assertNull(app.peekRuntime())
    } finally {
      controller.destroy()
    }
  }

  @Test
  fun backgroundRuntimeStartsWithoutForegroundCapabilitiesOrMicRestore() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences("node-service-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setVoiceMicEnabled(true)
    val runtime = NodeRuntime(app, prefs, initialForeground = false)

    try {
      assertFalse(runtime.isForeground.value)
      assertFalse(prefs.voiceMicEnabled.value)
    } finally {
      runtime.disconnect()
    }
  }

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
  fun foregroundServiceTypes_addsOnlyActiveSensitiveTypes() {
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      foregroundServiceTypes(VoiceCaptureMode.Off, backgroundLocationActive = false),
    )
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      foregroundServiceTypes(VoiceCaptureMode.ManualMic, backgroundLocationActive = false),
    )
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      foregroundServiceTypes(VoiceCaptureMode.TalkMode, backgroundLocationActive = true),
    )
  }

  @Test
  fun backgroundLocationNotificationSuffix_disclosesActiveAlwaysMode() {
    assertEquals("", backgroundLocationNotificationSuffix(active = false))
    assertEquals(" · Location: Always", backgroundLocationNotificationSuffix(active = true))
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
