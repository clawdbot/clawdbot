package ai.openclaw.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
class ControlUiWebViewTest {
  @Test
  fun pinnedSslError_proceedsOnlyForExactCertificateAtGatewayOrigin() {
    val certificate = "accepted gateway certificate".toByteArray()
    val fingerprint = sha256Hex(certificate)

    assertTrue(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = fingerprint,
        errorUrl = "https://gateway.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
    assertFalse(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = "00".repeat(32),
        errorUrl = "https://gateway.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
    assertFalse(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = fingerprint,
        errorUrl = "https://attacker.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
    assertFalse(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = null,
        errorUrl = "https://gateway.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
  }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(bytes)
      .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
