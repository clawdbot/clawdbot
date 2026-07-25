package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CanvasNavigationPolicyTest {
  @Test
  fun blocksDeviceLocalWebUrls() {
    listOf(
      "http://127.0.0.1:18789",
      "https://localhost",
      "https://canvas.localhost/path",
      "http://0.0.0.0:18789",
      "http://0/canvas",
      "http://[::]/canvas",
      "http://[::1]/canvas",
      "http://[::1%25lo]/canvas",
      "http://[::ffff:127.0.0.1]/canvas",
      "http://2130706433/canvas",
      "http://0x7f000001/canvas",
      "http://017700000001/canvas",
      "http://127.1/canvas",
      "http://0x7f.1/canvas",
      "http://127.0.0.1/a raw space",
      "http://127.0.0.1/#raw space",
      "http://127.0.0.1\\@example.com/",
      "http://%31%32%37.0.0.1:18789/",
      "http://%6c%6f%63%61%6c%68%6f%73%74/",
      "http://ｌｏｃａｌｈｏｓｔ:18789/",
      "http://１２７.０.０.１:18789/",
      "http:\\127.0.0.1:18789/",
      "http:127.0.0.1:18789/",
    ).forEach { url ->
      assertEquals(url, true, CanvasNavigationPolicy.shouldBlock(url))
      assertEquals(url, "", CanvasNavigationPolicy.normalize(url))
    }
  }

  @Test
  fun blocksMalformedWebHosts() {
    listOf(
      "http:///missing-host",
      "https://double%252dencoded.example/",
      "http://example.com%00.evil/",
    ).forEach { url -> assertEquals(url, true, CanvasNavigationPolicy.shouldBlock(url)) }
  }

  @Test
  fun keepsRemoteEmulatorBridgeAndBundledUrls() {
    val accepted =
      listOf(
        "https://example.com/canvas",
        "https://xn--mnich-kva.example/canvas",
        "http://gateway.local:18789/__openclaw__/canvas/",
        "http://10.0.2.2:18789/__openclaw__/canvas/",
        CanvasActionTrust.scaffoldAssetUrl,
      )
    accepted.forEach { url ->
      assertEquals(url, false, CanvasNavigationPolicy.shouldBlock(url))
      assertEquals(url, url, CanvasNavigationPolicy.normalize(" $url "))
    }
  }

  @Test
  fun blankAndRootSelectBundledCanvasWithoutBeingSecurityBlocks() {
    listOf("", " / ").forEach { url ->
      assertEquals(url, false, CanvasNavigationPolicy.shouldBlock(url))
      assertEquals(url, "", CanvasNavigationPolicy.normalize(url))
    }
  }

  @Test
  fun controllerUsesSharedPolicyForDirectLoads() {
    val controller = CanvasController()

    controller.navigate("http://127.0.0.1:18789")
    assertNull(controller.currentUrl())

    controller.navigate("http://10.0.2.2:18789/__openclaw__/canvas/")
    assertEquals("http://10.0.2.2:18789/__openclaw__/canvas/", controller.currentUrl())
  }

  @Test
  fun nonGetMainFrameRequestsFailClosedBeforeRedirects() {
    assertEquals(
      true,
      CanvasNavigationPolicy.shouldBlockNonGetMainFrame("POST", isForMainFrame = true),
    )
    assertEquals(
      false,
      CanvasNavigationPolicy.shouldBlockNonGetMainFrame("GET", isForMainFrame = true),
    )
    assertEquals(
      false,
      CanvasNavigationPolicy.shouldBlockNonGetMainFrame("POST", isForMainFrame = false),
    )
  }
}
