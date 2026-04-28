package ai.openclaw.app

import java.time.Instant
import java.time.ZoneId

enum class NotificationPackageFilterMode(
  val rawValue: String,
) {
  Allowlist("allowlist"),
  Blocklist("blocklist"),
  ;

  companion object {
    fun fromRawValue(raw: String?): NotificationPackageFilterMode = entries.firstOrNull { it.rawValue == raw?.trim()?.lowercase() } ?: Blocklist
  }
}

internal data class NotificationForwardingPolicy(
  val enabled: Boolean,
  val mode: NotificationPackageFilterMode,
  val packages: Set<String>,
  val quietHoursEnabled: Boolean,
  val quietStart: String,
  val quietEnd: String,
  val maxEventsPerMinute: Int,
  val sessionKey: String?,
)

internal fun NotificationForwardingPolicy.allowsPackage(packageName: String): Boolean {
  val normalized = packageName.trim()
  if (normalized.isEmpty()) {
    return false
  }
  return when (mode) {
    NotificationPackageFilterMode.Allowlist -> packages.contains(normalized)
    NotificationPackageFilterMode.Blocklist -> !packages.contains(normalized)
  }
}

internal fun NotificationForwardingPolicy.isWithinQuietHours(
  nowEpochMs: Long,
  zoneId: ZoneId = ZoneId.systemDefault(),
): Boolean {
  if (!quietHoursEnabled) {
    return false
  }
  val startMinutes = parseLocalHourMinute(quietStart) ?: return false
  val endMinutes = parseLocalHourMinute(quietEnd) ?: return false
  if (startMinutes == endMinutes) {
    return true
  }
  val now =
    Instant
      .ofEpochMilli(nowEpochMs)
      .atZone(zoneId)
      .toLocalTime()
  val nowMinutes = now.hour * 60 + now.minute
  return if (startMinutes < endMinutes) {
    nowMinutes in startMinutes until endMinutes
  } else {
    nowMinutes >= startMinutes || nowMinutes < endMinutes
  }
}

private val localHourMinuteRegex = Regex("""^([01]\d|2[0-3]):([0-5]\d)$""")

internal fun normalizeLocalHourMinute(raw: String): String? {
  val trimmed = raw.trim()
  val match = localHourMinuteRegex.matchEntire(trimmed) ?: return null
  return "${match.groupValues[1]}:${match.groupValues[2]}"
}

internal fun parseLocalHourMinute(raw: String): Int? {
  val normalized = normalizeLocalHourMinute(raw) ?: return null
  val parts = normalized.split(':')
  val hour = parts[0].toInt()
  val minute = parts[1].toInt()
  return hour * 60 + minute
}

internal class NotificationBurstLimiter {
  private val lock = Any()
  private var windowStartMs: Long = -1L
  private var eventsInWindow: Int = 0

  fun allow(
    nowEpochMs: Long,
    maxEventsPerMinute: Int,
  ): Boolean {
    if (maxEventsPerMinute <= 0) {
      return false
    }
    val currentWindow = nowEpochMs - (nowEpochMs % 60_000L)
    synchronized(lock) {
      if (currentWindow != windowStartMs) {
        windowStartMs = currentWindow
        eventsInWindow = 0
      }
      if (eventsInWindow >= maxEventsPerMinute) {
        return false
      }
      eventsInWindow += 1
      return true
    }
  }
}
