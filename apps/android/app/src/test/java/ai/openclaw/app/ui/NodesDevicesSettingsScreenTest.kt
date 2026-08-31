package ai.openclaw.app.ui

import ai.openclaw.app.GatewayPendingDeviceSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

  @Test
  fun approvalIdentityIncludesGatewayPairingFields() {
    val lines =
      pendingDeviceIdentityLines(
        GatewayPendingDeviceSummary(
          requestId = "request-1",
          deviceId = "device-1",
          publicKey = "public-key-1",
          displayName = "Pixel",
          platform = "android",
          deviceFamily = "phone",
          clientId = "openclaw-android",
          clientMode = "ui",
          browserOrigin = "https://gateway.example",
          remoteIp = "192.0.2.10",
          roles = listOf("operator"),
          scopes = listOf("operator.read", "operator.pairing"),
          requestedAtMs = 123L,
          repair = false,
        ),
      ).toMap()

    assertEquals("Pixel", lines["Name"])
    assertEquals("device-1", lines["Device ID"])
    assertEquals("public-key-1", lines["Public key"])
    assertEquals("android · phone", lines["Platform"])
    assertEquals("openclaw-android · ui", lines["Client"])
    assertEquals("https://gateway.example", lines["Origin"])
    assertEquals("192.0.2.10", lines["Remote IP"])
    assertEquals("operator", lines["Roles"])
    assertEquals("operator.read, operator.pairing", lines["Scopes"])
  }

  @Test
  fun approvalIdentityStripsLineAndBidiSpoofingAndBoundsLength() {
    assertEquals(
      "Pixel Device ID: fake",
      pairingIdentityForDisplay("Pixel\n\u202EDevice ID: fake"),
    )
    assertEquals("abc…", pairingIdentityForDisplay("abcdef", maxCodePoints = 4))
    assertEquals("…", pairingIdentityForDisplay("\u202E\n"))
  }

  @Test
  fun approvalIdentityShowsRequestedScopeAfterLongPrecedingScopes() {
    val requestedScope = "operator.admin"
    val longPrecedingScope = "operator." + "x".repeat(180)
    val lines =
      pendingDeviceIdentityLines(
        GatewayPendingDeviceSummary(
          requestId = "request-1",
          deviceId = "device-1",
          displayName = "Pixel",
          remoteIp = null,
          roles = listOf("operator"),
          scopes = listOf(longPrecedingScope, requestedScope),
          requestedAtMs = 123L,
          repair = false,
        ),
      ).toMap()

    assertTrue(lines.getValue("Scopes").contains(requestedScope))
  }
}
