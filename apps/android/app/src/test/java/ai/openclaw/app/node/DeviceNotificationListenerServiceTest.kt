package ai.openclaw.app.node

import ai.openclaw.app.NotificationBurstLimiter
import ai.openclaw.app.NotificationForwardingPolicy
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.isWithinQuietHours
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowApplication
import org.robolectric.shadows.ShadowNotificationListenerService
import org.robolectric.shadows.ShadowNotificationManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceNotificationListenerServiceTest {
  private lateinit var context: Context
  private lateinit var service: DeviceNotificationListenerService
  private lateinit var shadowService: ShadowNotificationListenerService
  private lateinit var shadowApplication: ShadowApplication

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    service = Robolectric.buildService(DeviceNotificationListenerService::class.java).create().get()
    shadowService = Shadow.extract(service)
    shadowApplication = Shadow.extract(RuntimeEnvironment.getApplication())
    shadowApplication.clearBroadcastIntents()
  }

  @After
  fun tearDown() {
    runCatching { service.onListenerDisconnected() }
    DeviceNotificationListenerService.setNodeEventSink(null)
    ShadowNotificationListenerService.reset()
    shadowApplication.clearBroadcastIntents()
  }

  @Test
  fun recentPackages_migratesLegacyPreferenceKey() {
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

  @Test
  fun postedCallbackStoresOnlyGatewayVisibleThirdPartyNotifications() {
    val thirdPartyKey =
      shadowService.addActiveNotification(
        thirdPartyPackage,
        102,
        buildNotification("Third-party proof"),
      )
    service.onListenerConnected()
    val ownKey =
      shadowService.addActiveNotification(
        context.packageName,
        101,
        buildNotification("Private assistant reply"),
      )

    service.onNotificationPosted(service.activeNotifications.single { it.key == ownKey })

    val snapshot = DeviceNotificationListenerService.snapshot(context, enabled = true)
    assertEquals(listOf(thirdPartyKey), snapshot.notifications.map { it.key })
    assertEquals(listOf(thirdPartyPackage), snapshot.notifications.map { it.packageName })
    assertEquals("Third-party proof", snapshot.notifications.single().text)
  }

  @Test
  fun listenerReconnectRefreshStoresOnlyGatewayVisibleThirdPartyNotifications() {
    shadowService.addActiveNotification(
      context.packageName,
      201,
      buildNotification("Private assistant reply"),
    )
    val thirdPartyKey =
      shadowService.addActiveNotification(
        thirdPartyPackage,
        202,
        buildNotification("Third-party proof"),
      )

    service.onListenerConnected()

    val snapshot = DeviceNotificationListenerService.snapshot(context, enabled = true)
    assertEquals(listOf(thirdPartyKey), snapshot.notifications.map { it.key })
    assertEquals(listOf(thirdPartyPackage), snapshot.notifications.map { it.packageName })
  }

  @Test
  fun actionsRejectOwnNotificationsAndPreserveThirdPartyOpen() {
    val manager = context.getSystemService(NotificationManager::class.java)
    val shadowManager = Shadow.extract<ShadowNotificationManager>(manager)
    shadowManager.setNotificationListenerAccessGranted(
      ComponentName(context, DeviceNotificationListenerService::class.java),
      true,
    )
    val ownKey =
      shadowService.addActiveNotification(
        context.packageName,
        301,
        buildNotification(
          text = "Private assistant reply",
          contentIntent = trackingPendingIntent(ownOpenAction, requestCode = 301),
        ),
      )
    val thirdPartyKey =
      shadowService.addActiveNotification(
        thirdPartyPackage,
        302,
        buildNotification(
          text = "Third-party proof",
          contentIntent = trackingPendingIntent(thirdPartyOpenAction, requestCode = 302),
        ),
      )
    service.onListenerConnected()

    val ownResult =
      DeviceNotificationListenerService.executeAction(
        context,
        NotificationActionRequest(ownKey, NotificationActionKind.Open),
      )
    assertFalse(ownResult.ok)
    assertEquals("NOTIFICATION_NOT_FOUND", ownResult.code)
    assertFalse(
      shadowApplication
        .broadcastIntents
        .any { it.action == ownOpenAction },
    )

    val thirdPartyResult =
      DeviceNotificationListenerService.executeAction(
        context,
        NotificationActionRequest(thirdPartyKey, NotificationActionKind.Open),
      )
    assertTrue(thirdPartyResult.ok)
    assertTrue(
      shadowApplication
        .broadcastIntents
        .any { it.action == thirdPartyOpenAction },
    )
  }

  private fun buildNotification(
    text: String,
    contentIntent: PendingIntent? = null,
  ): Notification =
    Notification
      .Builder(context, "test-channel")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle("Notification")
      .setContentText(text)
      .setContentIntent(contentIntent)
      .build()

  private fun trackingPendingIntent(
    action: String,
    requestCode: Int,
  ): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      requestCode,
      Intent(action).setPackage(context.packageName),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private companion object {
    const val thirdPartyPackage = "com.example.thirdparty"
    const val ownOpenAction = "ai.openclaw.app.test.OWN_OPEN"
    const val thirdPartyOpenAction = "ai.openclaw.app.test.THIRD_PARTY_OPEN"
  }
}
