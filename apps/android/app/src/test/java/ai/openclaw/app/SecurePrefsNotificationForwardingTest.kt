package ai.openclaw.app

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SecurePrefsNotificationForwardingTest {
  @Test
  fun setNotificationForwardingQuietHours_rejectsInvalidDraftsWithoutMutatingStoredValues() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = SecurePrefs(context)

    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = false,
        start = "22:00",
        end = "07:00",
      ),
    )

    val originalStart = prefs.notificationForwardingQuietStart.value
    val originalEnd = prefs.notificationForwardingQuietEnd.value
    val originalEnabled = prefs.notificationForwardingQuietHoursEnabled.value

    assertFalse(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "7:00",
        end = "07:00",
      ),
    )

    assertEquals(originalStart, prefs.notificationForwardingQuietStart.value)
    assertEquals(originalEnd, prefs.notificationForwardingQuietEnd.value)
    assertEquals(originalEnabled, prefs.notificationForwardingQuietHoursEnabled.value)
  }

  @Test
  fun setNotificationForwardingQuietHours_persistsValidDraftsAndEnabledState() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = SecurePrefs(context)

    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "22:30",
        end = "06:45",
      ),
    )

    assertTrue(prefs.notificationForwardingQuietHoursEnabled.value)
    assertEquals("22:30", prefs.notificationForwardingQuietStart.value)
    assertEquals("06:45", prefs.notificationForwardingQuietEnd.value)
  }

  @Test
  fun setNotificationForwardingQuietHours_disablesWithoutRevalidatingDrafts() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = SecurePrefs(context)
    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "22:30",
        end = "06:45",
      ),
    )

    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = false,
        start = "7:00",
        end = "06:45",
      ),
    )

    assertFalse(prefs.notificationForwardingQuietHoursEnabled.value)
    assertEquals("22:30", prefs.notificationForwardingQuietStart.value)
    assertEquals("06:45", prefs.notificationForwardingQuietEnd.value)
  }

  @Test
  fun getNotificationForwardingPolicy_readsLatestQuietHoursImmediately() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = SecurePrefs(context)
    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "21:15",
        end = "06:10",
      ),
    )

    val policy = prefs.getNotificationForwardingPolicy(appPackageName = "ai.openclaw.app")

    assertTrue(policy.quietHoursEnabled)
    assertEquals("21:15", policy.quietStart)
    assertEquals("06:10", policy.quietEnd)
  }

  @Test
  fun notificationForwarding_defaultsDisabledForSaferPosture() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()

    val prefs = SecurePrefs(context)
    val policy = prefs.getNotificationForwardingPolicy(appPackageName = "ai.openclaw.app")

    assertFalse(prefs.notificationForwardingEnabled.value)
    assertFalse(policy.enabled)
    assertEquals(NotificationPackageFilterMode.Blocklist, policy.mode)
  }
}
