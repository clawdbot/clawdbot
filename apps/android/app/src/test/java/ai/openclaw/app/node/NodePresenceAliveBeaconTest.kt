package ai.openclaw.app.node

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NodePresenceAliveBeaconTest {
  @Test
  fun shouldSkipRecentSuccess_requiresFreshSuccess() {
    assertTrue(
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        nowMs = 2_000,
        lastSuccessAtMs = 1_500,
        minIntervalMs = 1_000,
      ),
    )
    assertFalse(
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        nowMs = 2_000,
        lastSuccessAtMs = null,
        minIntervalMs = 1_000,
      ),
    )
    assertFalse(
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        nowMs = 3_000,
        lastSuccessAtMs = 1_500,
        minIntervalMs = 1_000,
      ),
    )
  }

  @Test
  fun makePayloadJson_includesAndroidPresenceMetadata() {
    val payload =
      Json
        .parseToJsonElement(
          NodePresenceAliveBeacon.makePayloadJson(
            trigger = NodePresenceAliveBeacon.Trigger.Connect,
            sentAtMs = 123,
            displayName = "Pixel Node",
            version = "2026.4.28",
            platform = "Android 15 (SDK 35)",
            deviceFamily = "Android",
            modelIdentifier = "Google Pixel 9",
          ),
        ).jsonObject

    assertEquals("connect", payload["trigger"]?.jsonPrimitive?.content)
    assertEquals("123", payload["sentAtMs"]?.jsonPrimitive?.content)
    assertEquals("Pixel Node", payload["displayName"]?.jsonPrimitive?.content)
    assertEquals("2026.4.28", payload["version"]?.jsonPrimitive?.content)
    assertEquals("Android 15 (SDK 35)", payload["platform"]?.jsonPrimitive?.content)
    assertEquals("Android", payload["deviceFamily"]?.jsonPrimitive?.content)
    assertEquals("Google Pixel 9", payload["modelIdentifier"]?.jsonPrimitive?.content)
    assertNull(payload["pushTransport"])
  }

  @Test
  fun decodeResponse_leavesOldGatewayAckUnhandled() {
    val response = NodePresenceAliveBeacon.decodeResponse("""{"ok":true}""")

    assertEquals(true, response?.ok)
    assertNull(response?.handled)
  }

  @Test
  fun decodeResponse_readsHandledPresenceResult() {
    val response =
      NodePresenceAliveBeacon.decodeResponse(
        """{"ok":true,"event":"node.presence.alive","handled":true,"reason":"persisted"}""",
      )

    assertEquals(true, response?.ok)
    assertEquals("node.presence.alive", response?.event)
    assertEquals(true, response?.handled)
    assertEquals("persisted", response?.reason)
  }

  @Test
  fun decodeResponse_rejectsOversizedPayloadBeforeParsing() {
    assertNull(
      NodePresenceAliveBeacon.decodeResponse("""{"ok":true,"reason":"${"x".repeat(16 * 1024)}"}"""),
    )
  }

  @Test
  fun sanitizeReasonForLog_removesControlCharactersAndBoundsLength() {
    val raw = "bad\nreason\t${"x".repeat(240)}"
    val sanitized = NodePresenceAliveBeacon.sanitizeReasonForLog(raw)

    assertFalse(sanitized.contains("\n"))
    assertFalse(sanitized.contains("\t"))
    assertEquals(200, sanitized.length)
  }
}
