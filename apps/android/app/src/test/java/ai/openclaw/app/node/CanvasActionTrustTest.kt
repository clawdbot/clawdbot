package ai.openclaw.app.node

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CanvasActionTrustTest {
  @Test
  fun acceptsBundledScaffoldAsset() {
    assertTrue(CanvasActionTrust.isTrustedCanvasActionUrl(CanvasActionTrust.scaffoldAssetUrl))
  }

  @Test
  fun acceptsBundledA2uiAsset() {
    assertTrue(CanvasActionTrust.isTrustedCanvasActionUrl(CanvasActionTrust.localA2uiAssetUrl))
  }

  @Test
  fun rejectsRemoteHttpA2uiPageEvenWhenGatewayAdvertised() {
    assertFalse(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "http://canvas.example.com:9443/__openclaw__/cap/token/__openclaw__/a2ui/?platform=android",
      ),
    )
  }

  @Test
  fun rejectsRemoteHttpsA2uiPageEvenWhenGatewayAdvertised() {
    assertFalse(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "https://canvas.example.com:9443/__openclaw__/cap/token/__openclaw__/a2ui/?platform=android",
      ),
    )
  }

  @Test
  fun rejectsRemoteCanvasPage() {
    assertFalse(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "https://canvas.example.com:9443/__openclaw__/canvas/",
      ),
    )
  }

  @Test
  fun rejectsDescendantPathUnderBundledA2uiRoot() {
    assertFalse(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "file:///android_asset/CanvasA2UI/child/index.html",
      ),
    )
  }

  @Test
  fun rejectsQueryOrFragmentChangesToBundledA2uiAsset() {
    assertFalse(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "${CanvasActionTrust.localA2uiAssetUrl}?platform=android",
      ),
    )
    assertFalse(CanvasActionTrust.isTrustedCanvasActionUrl("${CanvasActionTrust.localA2uiAssetUrl}#step2"))
  }
}
