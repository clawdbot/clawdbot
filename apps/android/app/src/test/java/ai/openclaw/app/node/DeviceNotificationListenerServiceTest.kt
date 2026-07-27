package ai.openclaw.app.node

import ai.openclaw.app.NotificationBurstLimiter
import ai.openclaw.app.NotificationForwardingPolicy
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.isWithinQuietHours
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class DeviceNotificationListenerServiceTest {
  @Test
  fun recentPackages_migratesLegacyPreferenceKey() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = context.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
    prefs
      .edit()
      .clear()
      .putString("notifications.recentPackages", "com.example.one, com.example.two")
      .commit()

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(listOf("com.example.one", "com.example.two"), packages)
    assertEquals(
      "com.example.one, com.example.two",
      prefs.getString("notifications.forwarding.recentPackages", null),
    )
    assertFalse(prefs.contains("notifications.recentPackages"))
  }

  @Test
  fun recentPackages_cleansUpLegacyKeyWhenNewKeyAlreadyExists() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = context.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
    prefs
      .edit()
      .clear()
      .putString("notifications.forwarding.recentPackages", "com.example.new")
      .putString("notifications.recentPackages", "com.example.legacy")
      .commit()

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(listOf("com.example.new"), packages)
    assertNull(prefs.getString("notifications.recentPackages", null))
  }

  @Test
  fun recentPackages_trimsDedupesAndPreservesRecencyOrder() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = context.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
    prefs
      .edit()
      .clear()
      .putString(
        "notifications.forwarding.recentPackages",
        " com.example.recent , ,com.example.other,com.example.recent, com.example.third ",
      ).commit()

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(
      listOf("com.example.recent", "com.example.other", "com.example.third"),
      packages,
    )
  }

  @Test
  fun quietHoursAndRateLimitingUseWallClockTimeNotNotificationPostTime() {
    val zone = java.time.ZoneId.systemDefault()
    val now = java.time.ZonedDateTime.now(zone)
    val quietStart =
      now
        .minusMinutes(5)
        .toLocalTime()
        .withSecond(0)
        .withNano(0)
    val quietEnd =
      now
        .plusMinutes(5)
        .toLocalTime()
        .withSecond(0)
        .withNano(0)
    val stalePostTime =
      now
        .minusHours(2)
        .withMinute(0)
        .withSecond(0)
        .withNano(0)
        .toInstant()
        .toEpochMilli()

    val policy =
      NotificationForwardingPolicy(
        enabled = true,
        mode = NotificationPackageFilterMode.Blocklist,
        packages = emptySet(),
        quietHoursEnabled = true,
        quietStart = "%02d:%02d".format(quietStart.hour, quietStart.minute),
        quietEnd = "%02d:%02d".format(quietEnd.hour, quietEnd.minute),
        maxEventsPerMinute = 1,
        sessionKey = null,
      )

    assertFalse(policy.isWithinQuietHours(nowEpochMs = stalePostTime, zoneId = zone))
    assertTrue(policy.isWithinQuietHours(nowEpochMs = System.currentTimeMillis(), zoneId = zone))

    val limiter = NotificationBurstLimiter()
    assertTrue(limiter.allow(nowEpochMs = stalePostTime, maxEventsPerMinute = 1))
    assertTrue(limiter.allow(nowEpochMs = System.currentTimeMillis(), maxEventsPerMinute = 1))
    assertFalse(limiter.allow(nowEpochMs = System.currentTimeMillis(), maxEventsPerMinute = 1))
  }

  @Test
  fun burstLimiter_capsAnyForwardedNotificationEvent() {
    val limiter = NotificationBurstLimiter()
    val nowEpochMs = System.currentTimeMillis()

    assertTrue(limiter.allow(nowEpochMs = nowEpochMs, maxEventsPerMinute = 2))
    assertTrue(limiter.allow(nowEpochMs = nowEpochMs, maxEventsPerMinute = 2))
    assertFalse(limiter.allow(nowEpochMs = nowEpochMs, maxEventsPerMinute = 2))
  }
}
