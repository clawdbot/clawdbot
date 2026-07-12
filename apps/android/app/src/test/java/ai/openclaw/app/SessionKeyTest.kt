package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionKeyTest {
  @Test
  fun buildNodeMainSessionKeyUsesStableDeviceScopedSuffix() {
    val key = buildNodeMainSessionKey(deviceId = "1234567890abcdef", agentId = "ops")

    assertEquals("agent:ops:node-1234567890ab", key)
  }

  @Test
  fun buildAndroidAppSessionLabelIncludesDeviceDisplayName() {
    assertEquals("OpenClaw App · 1234567890ab", buildAndroidAppSessionLabel(null, "1234567890abcdef"))
    assertEquals(
      "OpenClaw App · Pixel · 1234567890ab",
      buildAndroidAppSessionLabel(" Pixel ", "1234567890abcdef"),
    )
  }

  @Test
  fun resolveAgentIdFromMainSessionKeyParsesCanonicalAgentKey() {
    assertEquals("ops", resolveAgentIdFromMainSessionKey("agent:ops:main"))
    assertNull(resolveAgentIdFromMainSessionKey("global"))
  }
}
