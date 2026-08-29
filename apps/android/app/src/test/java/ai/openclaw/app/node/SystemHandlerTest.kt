package ai.openclaw.app.node

import ai.openclaw.app.MainActivity
import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemHandlerTest {
  @Test
  fun handleSystemNotify_rejectsUnauthorized() {
    val context: Application = RuntimeEnvironment.getApplication()
    val manager = context.getSystemService(NotificationManager::class.java)
    val handler = SystemHandler(context)

    for (permissionGranted in listOf(false, true)) {
      if (permissionGranted) {
        Shadows.shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
      } else {
        Shadows.shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
      }
      Shadows.shadowOf(manager).setNotificationsEnabled(!permissionGranted)

      val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"hi"}""")

      assertFalse(result.ok)
      assertEquals("NOT_AUTHORIZED", result.error?.code)
      assertTrue(manager.notificationChannels.isEmpty())
      assertTrue(manager.activeNotifications.isEmpty())
    }
  }

  @Test
  fun handleSystemNotify_rejectsEmptyNotification() {
    val handler = SystemHandler.forTesting(poster = FakePoster())

    val result = handler.handleSystemNotify("""{"title":"   ","body":"  "}""")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleSystemNotify_rejectsInvalidRequestObject() {
    val handler = SystemHandler.forTesting(poster = FakePoster())

    val result = handler.handleSystemNotify("""{"title":"OpenClaw"}""")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleSystemNotify_postsNotification() {
    val poster = FakePoster()
    val handler = SystemHandler.forTesting(poster = poster)

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done","priority":"active"}""")

    assertTrue(result.ok)
    assertEquals(1, poster.posts)
  }

  @Test
  fun handleSystemNotify_rejectsBlockedSelectedChannels() {
    val context: Application = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    val manager = context.getSystemService(NotificationManager::class.java)
    val handler = SystemHandler(context)
    assertTrue(manager.areNotificationsEnabled())

    val priorities = listOf(null to "active", "active" to "active", "passive" to "passive", "timeSensitive" to "timesensitive")
    for ((priority, suffix) in priorities) {
      val channelId = "openclaw.system.notify.$suffix"
      manager.createNotificationChannel(NotificationChannel(channelId, "Blocked", NotificationManager.IMPORTANCE_NONE))
      val priorityField = priority?.let { ",\"priority\":\"$it\"" }.orEmpty()

      val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"blocked"$priorityField}""")

      assertFalse("priority=$priority must not report a blocked post as successful", result.ok)
      assertEquals("NOT_AUTHORIZED", result.error?.code)
      assertEquals(NotificationManager.IMPORTANCE_NONE, manager.getNotificationChannel(channelId).importance)
    }
  }

  @Test
  fun handleSystemNotify_postsAllowedChannelWhenAnotherPriorityIsBlocked() {
    val context: Application = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel("openclaw.system.notify.active", "Blocked", NotificationManager.IMPORTANCE_NONE),
    )
    val handler = SystemHandler(context)

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"allowed","priority":"passive"}""")

    assertTrue(result.ok)
    assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel("openclaw.system.notify.passive").importance)
    val notification = manager.activeNotifications.single().notification
    assertEquals("openclaw.system.notify.passive", notification.channelId)
    assertEquals("allowed", notification.extras.getCharSequence("android.text"))
  }

  @Test
  fun handleSystemNotify_trimsAndPassesOptionalFields() {
    val poster = FakePoster()
    val handler = SystemHandler.forTesting(poster = poster)

    val result =
      handler.handleSystemNotify(
        """{"title":" OpenClaw ","body":" done ","priority":" passive ","sound":" silent "}""",
      )

    assertTrue(result.ok)
    assertEquals("OpenClaw", poster.lastRequest?.title)
    assertEquals("done", poster.lastRequest?.body)
    assertEquals("passive", poster.lastRequest?.priority)
    assertEquals("silent", poster.lastRequest?.sound)
  }

  @Test
  fun buildSystemNotificationSetsImmutableAppLaunchIntent() {
    val context: Context = RuntimeEnvironment.getApplication()
    val notification =
      buildSystemNotification(
        appContext = context,
        channelId = "test",
        request = SystemNotifyRequest("OpenClaw", "done", sound = null, priority = null),
      )

    val pendingIntent = notification.contentIntent
    assertNotNull(pendingIntent)
    assertTrue(pendingIntent.isImmutable)

    val savedIntent = Shadows.shadowOf(pendingIntent).savedIntent
    assertEquals(MainActivity::class.java.name, savedIntent.component?.className)
    val expectedFlags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    assertEquals(expectedFlags, savedIntent.flags and expectedFlags)
  }

  @Test
  fun handleSystemNotify_returnsUnauthorizedWhenPostFailsPermission() {
    val handler = SystemHandler.forTesting(poster = ThrowingPoster(error = SecurityException("denied")))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done"}""")

    assertFalse(result.ok)
    assertEquals("NOT_AUTHORIZED", result.error?.code)
  }

  @Test
  fun handleSystemNotify_returnsUnavailableWhenPostFailsUnexpectedly() {
    val handler = SystemHandler.forTesting(poster = ThrowingPoster(error = IllegalStateException("boom")))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done"}""")

    assertFalse(result.ok)
    assertEquals("UNAVAILABLE", result.error?.code)
    assertEquals("NOTIFICATION_FAILED: boom", result.error?.message)
  }
}

private class FakePoster : SystemNotificationPoster {
  var posts: Int = 0
    private set
  var lastRequest: SystemNotifyRequest? = null
    private set

  override fun post(request: SystemNotifyRequest) {
    posts += 1
    lastRequest = request
  }
}

private class ThrowingPoster(
  private val error: Throwable,
) : SystemNotificationPoster {
  override fun post(request: SystemNotifyRequest): Unit = throw error
}
