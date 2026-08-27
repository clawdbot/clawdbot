package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DesktopScreenTest {
  @Test
  fun desktopUrlBuildsCanonicalFocusPaths() {
    val cases =
      listOf(
        DesktopUrlCase(
          name = "root base",
          baseUrl = "https://gateway.example.com:8443",
          expected = "https://gateway.example.com:8443/focus/desktop",
        ),
        DesktopUrlCase(
          name = "configured base path",
          baseUrl = "https://gateway.example.com:8443/openclaw/",
          expected = "https://gateway.example.com:8443/openclaw/focus/desktop",
        ),
        DesktopUrlCase(
          name = "encoded source",
          baseUrl = "https://gateway.example.com:8443",
          source = "environment:Mac Studio/QA & demo",
          expected =
            "https://gateway.example.com:8443/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
        ),
        DesktopUrlCase(
          name = "encoded session under configured base path",
          baseUrl = "https://gateway.example.com:8443/openclaw/",
          session = "agent:main:mobile session",
          expected =
            "https://gateway.example.com:8443/openclaw/focus/desktop/session/agent%3Amain%3Amobile%20session",
        ),
        DesktopUrlCase(
          name = "source wins over session",
          baseUrl = "https://gateway.example.com:8443",
          source = "node:worker-1",
          session = "agent:main:mobile",
          expected = "https://gateway.example.com:8443/focus/desktop/source/node%3Aworker-1",
        ),
        DesktopUrlCase(
          name = "empty source falls through to session",
          baseUrl = "https://gateway.example.com:8443",
          source = "  ",
          session = "agent:main:mobile",
          expected = "https://gateway.example.com:8443/focus/desktop/session/agent%3Amain%3Amobile",
        ),
        DesktopUrlCase(
          name = "empty values are omitted",
          baseUrl = "https://gateway.example.com:8443/openclaw/",
          source = "  ",
          session = "\n",
          expected = "https://gateway.example.com:8443/openclaw/focus/desktop",
        ),
      )

    cases.forEach { case ->
      assertEquals(
        case.name,
        case.expected,
        desktopUrl(baseUrl = case.baseUrl, source = case.source, session = case.session),
      )
    }
  }

  private data class DesktopUrlCase(
    val name: String,
    val baseUrl: String,
    val source: String? = null,
    val session: String? = null,
    val expected: String,
  )
}
