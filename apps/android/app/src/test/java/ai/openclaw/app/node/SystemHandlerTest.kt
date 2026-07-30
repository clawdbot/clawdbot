package ai.openclaw.app.node

import ai.openclaw.app.MainActivity
import android.Manifest
import android.app.Application
import android.app.KeyguardManager
import android.app.Notification
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
import org.robolectric.shadows.ShadowSettings

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemHandlerTest {
  @Test
  fun handleSystemNotify_rejectsUnauthorized() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = false))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"hi"}""")

    assertFalse(result.ok)
    assertEquals("NOT_AUTHORIZED", result.error?.code)
  }

  @Test
  fun handleSystemNotify_rejectsEmptyNotification() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = true))

    val result = handler.handleSystemNotify("""{"title":"   ","body":"  "}""")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleSystemNotify_rejectsInvalidRequestObject() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = true))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw"}""")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleSystemNotify_postsNotification() {
    val poster = FakePoster(authorized = true)
    val handler = SystemHandler.forTesting(poster = poster)

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done","priority":"active"}""")

    assertTrue(result.ok)
    assertEquals(1, poster.posts)
  }

  @Test
  fun handleSystemNotify_trimsAndPassesOptionalFields() {
    val poster = FakePoster(authorized = true)
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
  fun handleSystemNotify_parsesSubtitleTimestampAndDelivery() {
    val poster = FakePoster(authorized = true)
    val handler = SystemHandler.forTesting(poster = poster)

    val result =
      handler.handleSystemNotify(
        """{"title":"WhatsApp","body":"Dinner at 7?","subtitle":"Anna","timestamp":"2026-07-29T14:32:00Z","delivery":"overlay"}""",
      )

    assertTrue(result.ok)
    assertEquals("Anna", poster.lastRequest?.subtitle)
    assertEquals("overlay", poster.lastRequest?.delivery)
    assertEquals(1785335520000L, poster.lastRequest?.timestampMillis)
  }

  @Test
  fun handleSystemNotify_ignoresUnparsableTimestamp() {
    val poster = FakePoster(authorized = true)
    val handler = SystemHandler.forTesting(poster = poster)

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done","timestamp":"not-a-date"}""")

    assertTrue(result.ok)
    assertEquals(null, poster.lastRequest?.timestampMillis)
  }

  @Test
  @Config(sdk = [33])
  fun buildSystemNotificationAttachesFullScreenIntentForOverlayDelivery() {
    val context: Context = RuntimeEnvironment.getApplication()
    val notification =
      buildSystemNotification(
        appContext = context,
        channelId = "test",
        request =
          SystemNotifyRequest(
            "WhatsApp",
            "Dinner at 7?",
            sound = null,
            priority = null,
            delivery = "overlay",
            subtitle = "Anna",
            timestampMillis = 1_785_335_520_000L,
          ),
        wantsFullScreenIntent = true,
      )

    assertNotNull(notification.fullScreenIntent)
    val savedIntent = Shadows.shadowOf(notification.fullScreenIntent).savedIntent
    assertEquals("ai.openclaw.app.ui.popup.PopupOverlayActivity", savedIntent.component?.className)
    assertEquals("Anna", notification.extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString())
    assertEquals(1_785_335_520_000L, notification.`when`)
  }

  @Test
  fun buildSystemNotificationOmitsFullScreenIntentForSystemDelivery() {
    val context: Context = RuntimeEnvironment.getApplication()
    val notification =
      buildSystemNotification(
        appContext = context,
        channelId = "test",
        request = SystemNotifyRequest("OpenClaw", "done", sound = null, priority = null, delivery = "system"),
      )

    assertEquals(null, notification.fullScreenIntent)
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
    val handler = SystemHandler.forTesting(poster = ThrowingPoster(authorized = true, error = SecurityException("denied")))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done"}""")

    assertFalse(result.ok)
    assertEquals("NOT_AUTHORIZED", result.error?.code)
  }

  @Test
  fun handleSystemNotify_returnsUnavailableWhenPostFailsUnexpectedly() {
    val handler = SystemHandler.forTesting(poster = ThrowingPoster(authorized = true, error = IllegalStateException("boom")))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done"}""")

    assertFalse(result.ok)
    assertEquals("UNAVAILABLE", result.error?.code)
    assertEquals("NOTIFICATION_FAILED: boom", result.error?.message)
  }

  @Test
  fun handleSystemNotify_overlayDeliveryChannelBypassesDnd() {
    val context: Context = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    // Isolate this from delivery-mode branching (own coverage below): locked keeps the
    // full-screen-intent path, which is all this test cares about.
    Shadows.shadowOf(context.getSystemService(KeyguardManager::class.java)).setKeyguardLocked(true)
    val handler = SystemHandler(context)

    val result = handler.handleSystemNotify("""{"title":"WhatsApp","body":"hi","delivery":"overlay"}""")

    assertTrue(result.ok)
    val manager = context.getSystemService(NotificationManager::class.java)
    val channel = manager.getNotificationChannel("openclaw.system.notify.timesensitive")
    assertNotNull(channel)
    assertTrue(channel!!.canBypassDnd())
  }

  @Test
  fun handleSystemNotify_defaultDeliveryChannelDoesNotBypassDnd() {
    val context: Context = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    val handler = SystemHandler(context)

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"hi"}""")

    assertTrue(result.ok)
    val manager = context.getSystemService(NotificationManager::class.java)
    val channel = manager.getNotificationChannel("openclaw.system.notify.active")
    assertNotNull(channel)
    assertFalse(channel!!.canBypassDnd())
  }

  @Test
  fun resolvePopupDeliveryMode_locked_returnsFullScreenLocked() {
    val context: Context = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context.getSystemService(KeyguardManager::class.java)).setKeyguardLocked(true)

    assertEquals(PopupDeliveryMode.FullScreenLocked, resolvePopupDeliveryMode(context))
  }

  @Test
  fun resolvePopupDeliveryMode_unlockedWithOverlayPermission_returnsOverlayWindow() {
    val context: Context = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context.getSystemService(KeyguardManager::class.java)).setKeyguardLocked(false)
    ShadowSettings.setCanDrawOverlays(true)

    assertEquals(PopupDeliveryMode.OverlayWindow, resolvePopupDeliveryMode(context))
  }

  @Test
  fun resolvePopupDeliveryMode_unlockedWithoutOverlayPermission_returnsHeadsUpFallback() {
    val context: Context = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context.getSystemService(KeyguardManager::class.java)).setKeyguardLocked(false)
    ShadowSettings.setCanDrawOverlays(false)

    assertEquals(PopupDeliveryMode.HeadsUpFallback, resolvePopupDeliveryMode(context))
  }
}

private class FakePoster(
  private val authorized: Boolean,
) : SystemNotificationPoster {
  var posts: Int = 0
    private set
  var lastRequest: SystemNotifyRequest? = null
    private set

  override fun isAuthorized(): Boolean = authorized

  override fun post(request: SystemNotifyRequest) {
    posts += 1
    lastRequest = request
  }
}

private class ThrowingPoster(
  private val authorized: Boolean,
  private val error: Throwable,
) : SystemNotificationPoster {
  override fun isAuthorized(): Boolean = authorized

  override fun post(request: SystemNotifyRequest): Unit = throw error
}
