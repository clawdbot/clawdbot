package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeErrorParserTest {
  @Test
  fun parseInvokeErrorMessage_parsesUppercaseCodePrefix() {
    val parsed = parseInvokeErrorMessage("CAMERA_PERMISSION_REQUIRED: grant Camera permission")
    assertEquals("CAMERA_PERMISSION_REQUIRED", parsed.code)
    assertEquals("grant Camera permission", parsed.message)
    assertTrue(parsed.hadExplicitCode)
    assertEquals("CAMERA_PERMISSION_REQUIRED: grant Camera permission", parsed.prefixedMessage)
  }

  @Test
  fun parseInvokeErrorMessage_parsesNumericCodePrefix() {
    val parsed = parseInvokeErrorMessage("A2UI_HOST_UNAVAILABLE: bundled A2UI host not reachable")
    assertEquals("A2UI_HOST_UNAVAILABLE", parsed.code)
    assertEquals("bundled A2UI host not reachable", parsed.message)
    assertTrue(parsed.hadExplicitCode)
  }

  @Test
  fun parseInvokeErrorMessage_rejectsNonCanonicalCodePrefix() {
    listOf(
      "IllegalStateException: boom",
      "2FAST: boom",
      "_PRIVATE: boom",
      "CAMERA-PERMISSION: boom",
    ).forEach { raw ->
      val parsed = parseInvokeErrorMessage(raw)
      assertEquals("UNAVAILABLE", parsed.code)
      assertEquals(raw, parsed.message)
      assertFalse(parsed.hadExplicitCode)
    }
  }

  @Test
  fun parseInvokeErrorFromThrowable_usesFallbackWhenMessageMissing() {
    val parsed = parseInvokeErrorFromThrowable(IllegalStateException(), fallbackMessage = "fallback")
    assertEquals("UNAVAILABLE", parsed.code)
    assertEquals("fallback", parsed.message)
    assertFalse(parsed.hadExplicitCode)
  }
}
