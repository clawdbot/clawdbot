package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class NotificationForwardingPolicyTest {
  @Test
  fun parseLocalHourMinute_parsesValidValues() {
    assertEquals(0, parseLocalHourMinute("00:00"))
    assertEquals(23 * 60 + 59, parseLocalHourMinute("23:59"))
    assertEquals(7 * 60 + 5, parseLocalHourMinute("07:05"))
  }

  @Test
  fun normalizeLocalHourMinute_acceptsStrict24HourDrafts() {
    assertEquals("00:00", normalizeLocalHourMinute("00:00"))
    assertEquals("23:59", normalizeLocalHourMinute("23:59"))
    assertEquals("07:05", normalizeLocalHourMinute("07:05"))
  }

  @Test
  fun parseLocalHourMinute_rejectsInvalidValues() {
    assertEquals(null, parseLocalHourMinute(""))
    assertEquals(null, parseLocalHourMinute("24:00"))
    assertEquals(null, parseLocalHourMinute("12:60"))
    assertEquals(null, parseLocalHourMinute("abc"))
    assertEquals(null, parseLocalHourMinute("7:05"))
    assertEquals(null, parseLocalHourMinute("07:5"))
  }

  @Test
  fun normalizeLocalHourMinute_rejectsNonCanonicalDrafts() {
    assertEquals(null, normalizeLocalHourMinute(""))
    assertEquals(null, normalizeLocalHourMinute("7:05"))
    assertEquals(null, normalizeLocalHourMinute("07:5"))
    assertEquals(null, normalizeLocalHourMinute("24:00"))
    assertEquals(null, normalizeLocalHourMinute("12:60"))
  }

  @Test
  fun allowsPackage_blocklistBlocksConfiguredPackages() {
    val policy =
      NotificationForwardingPolicy(
        enabled = true,
        mode = NotificationPackageFilterMode.Blocklist,
        packages = setOf("com.blocked.app"),
        quietHoursEnabled = false,
        quietStart = "22:00",
        quietEnd = "07:00",
        maxEventsPerMinute = 20,
        sessionKey = null,
      )

    assertFalse(policy.allowsPackage("com.blocked.app"))
    assertTrue(policy.allowsPackage("com.allowed.app"))
  }

  @Test
  fun allowsPackage_allowlistOnlyAllowsConfiguredPackages() {
    val policy =
      NotificationForwardingPolicy(
        enabled = true,
        mode = NotificationPackageFilterMode.Allowlist,
        packages = setOf("com.allowed.app"),
        quietHoursEnabled = false,
        quietStart = "22:00",
        quietEnd = "07:00",
        maxEventsPerMinute = 20,
        sessionKey = null,
      )

    assertTrue(policy.allowsPackage("com.allowed.app"))
    assertFalse(policy.allowsPackage("com.other.app"))
  }

  @Test
  fun isWithinQuietHours_handlesWindowCrossingMidnight() {
    val policy =
      NotificationForwardingPolicy(
        enabled = true,
        mode = NotificationPackageFilterMode.Blocklist,
        packages = emptySet(),
        quietHoursEnabled = true,
        quietStart = "22:00",
        quietEnd = "07:00",
        maxEventsPerMinute = 20,
        sessionKey = null,
      )

    val zone = ZoneId.of("UTC")
    val at2330 =
      LocalDateTime
        .of(2024, 1, 6, 23, 30)
        .atZone(zone)
        .toInstant()
        .toEpochMilli()
    val at1200 =
      LocalDateTime
        .of(2024, 1, 6, 12, 0)
        .atZone(zone)
        .toInstant()
        .toEpochMilli()

    assertTrue(policy.isWithinQuietHours(nowEpochMs = at2330, zoneId = zone))
    assertFalse(policy.isWithinQuietHours(nowEpochMs = at1200, zoneId = zone))
  }

  @Test
  fun isWithinQuietHours_sameStartEndMeansAlwaysQuiet() {
    val policy =
      NotificationForwardingPolicy(
        enabled = true,
        mode = NotificationPackageFilterMode.Blocklist,
        packages = emptySet(),
        quietHoursEnabled = true,
        quietStart = "00:00",
        quietEnd = "00:00",
        maxEventsPerMinute = 20,
        sessionKey = null,
      )

    assertTrue(policy.isWithinQuietHours(nowEpochMs = 1_704_098_400_000L, zoneId = ZoneId.of("UTC")))
  }

  @Test
  fun blocksEventsWhenDisabledOrQuietHoursOrRateLimited() {
    val disabled =
      NotificationForwardingPolicy(
        enabled = false,
        mode = NotificationPackageFilterMode.Blocklist,
        packages = emptySet(),
        quietHoursEnabled = false,
        quietStart = "22:00",
        quietEnd = "07:00",
        maxEventsPerMinute = 20,
        sessionKey = null,
      )
    assertFalse(disabled.enabled && disabled.allowsPackage("com.allowed.app"))

    val quiet =
      NotificationForwardingPolicy(
        enabled = true,
        mode = NotificationPackageFilterMode.Blocklist,
        packages = emptySet(),
        quietHoursEnabled = true,
        quietStart = "22:00",
        quietEnd = "07:00",
        maxEventsPerMinute = 20,
        sessionKey = null,
      )
    val zone = ZoneId.of("UTC")
    val at2330 =
      LocalDateTime
        .of(2024, 1, 6, 23, 30)
        .atZone(zone)
        .toInstant()
        .toEpochMilli()
    assertTrue(quiet.isWithinQuietHours(nowEpochMs = at2330, zoneId = zone))

    val limiter = NotificationBurstLimiter()
    val minute = 1_704_098_400_000L
    assertTrue(limiter.allow(nowEpochMs = minute, maxEventsPerMinute = 1))
    assertFalse(limiter.allow(nowEpochMs = minute + 500L, maxEventsPerMinute = 1))
  }

  @Test
  fun burstLimiter_blocksEventsAboveLimitInSameMinute() {
    val limiter = NotificationBurstLimiter()
    val minute = 1_704_098_400_000L

    assertTrue(limiter.allow(nowEpochMs = minute, maxEventsPerMinute = 2))
    assertTrue(limiter.allow(nowEpochMs = minute + 1_000L, maxEventsPerMinute = 2))
    assertFalse(limiter.allow(nowEpochMs = minute + 2_000L, maxEventsPerMinute = 2))
  }

  @Test
  fun burstLimiter_resetsOnNextMinuteWindow() {
    val limiter = NotificationBurstLimiter()
    val minute = 1_704_098_400_000L

    assertTrue(limiter.allow(nowEpochMs = minute, maxEventsPerMinute = 1))
    assertFalse(limiter.allow(nowEpochMs = minute + 1_000L, maxEventsPerMinute = 1))
    assertTrue(limiter.allow(nowEpochMs = minute + 60_000L, maxEventsPerMinute = 1))
  }
}
