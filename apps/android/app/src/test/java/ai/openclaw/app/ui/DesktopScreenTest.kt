package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DesktopScreenTest {
  @Test
  fun desktopUrlUsesDocumentModeWithoutSource() {
    val url = desktopUrl(baseUrl = "https://gateway.example.com:8443/openclaw/")

    assertEquals("https://gateway.example.com:8443/openclaw/?view=desktop", url)
    assertFalse(url.contains("token="))
    assertFalse(url.contains("password="))
  }

  @Test
  fun desktopUrlEncodesProvidedSource() {
    val url =
      desktopUrl(
        baseUrl = "https://gateway.example.com:8443",
        source = "environment:Mac Studio/QA & demo",
      )

    assertEquals(
      "https://gateway.example.com:8443/?view=desktop&source=environment%3AMac%20Studio%2FQA%20%26%20demo",
      url,
    )
    assertFalse(url.contains("token="))
    assertFalse(url.contains("password="))
  }
}
