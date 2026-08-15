package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CanvasA2UIActionBridgeTest {
  @Test
  fun forwardsTrimmedPayloadFromTrustedPage() {
    val forwarded = mutableListOf<String>()
    val bridge =
      CanvasA2UIActionBridge(
        isTrustedPage = { true },
        onMessage = { forwarded += it },
      )

    bridge.postMessage("  {\"ok\":true}  ")

    assertEquals(listOf("{\"ok\":true}"), forwarded)
  }

  @Test
  fun rejectsPayloadFromUntrustedPage() {
    val forwarded = mutableListOf<String>()
    val bridge =
      CanvasA2UIActionBridge(
        isTrustedPage = { false },
        onMessage = { forwarded += it },
      )

    bridge.postMessage("{\"ok\":true}")

    assertTrue(forwarded.isEmpty())
  }

  @Test
  fun rejectsBlankPayloadBeforeForwarding() {
    val forwarded = mutableListOf<String>()
    val bridge =
      CanvasA2UIActionBridge(
        isTrustedPage = { true },
        onMessage = { forwarded += it },
      )

    bridge.postMessage("   ")
    bridge.postMessage(null)

    assertTrue(forwarded.isEmpty())
  }
}
