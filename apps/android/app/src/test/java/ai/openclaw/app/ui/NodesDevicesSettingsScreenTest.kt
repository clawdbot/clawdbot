package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class NodesDevicesSettingsScreenTest {
  @Test
  fun deviceListSummariesPreserveValuesAndLocalizeControlledCounts() {
    assertEquals(null, formatDeviceList(emptyList(), DeviceListKind.Role))
    assertEquals("operator", formatDeviceList(listOf("operator"), DeviceListKind.Role))
    assertEquals("2 roles", formatDeviceList(listOf("operator", "admin"), DeviceListKind.Role))
    assertEquals("read:messages", formatDeviceList(listOf("read:messages"), DeviceListKind.Scope))
    assertEquals(
      "2 scopes",
      formatDeviceList(listOf("read:messages", "write:messages"), DeviceListKind.Scope),
    )
  }

  @Test
  fun relativeDeviceTimeUsesLocalizedAgeTemplates() {
    val nowMs = 10L * 24L * 60L * 60L * 1_000L

    assertEquals("now", relativeDeviceTime(timeMs = nowMs - 30_000L, nowMs = nowMs))
    assertEquals("2m ago", relativeDeviceTime(timeMs = nowMs - 2L * 60L * 1_000L, nowMs = nowMs))
    assertEquals("3h ago", relativeDeviceTime(timeMs = nowMs - 3L * 60L * 60L * 1_000L, nowMs = nowMs))
    assertEquals("4d ago", relativeDeviceTime(timeMs = nowMs - 4L * 24L * 60L * 60L * 1_000L, nowMs = nowMs))
  }
}
