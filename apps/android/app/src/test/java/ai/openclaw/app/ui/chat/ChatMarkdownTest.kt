package ai.openclaw.app.ui.chat

import androidx.compose.ui.text.LinkAnnotation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatMarkdownTest {
  @Test
  fun bareUrlsCarryClickableUrlAnnotations() {
    val url = "https://www.amazon.it/GAZEBO-CANOPY-ACCIAIO-BIANCO-IMPERMEABILE/dp/B01G5R9FCK"

    val annotated = buildChatInlineMarkdown("Open $url")

    assertEquals("Open $url", annotated.text)
    val links = annotated.getLinkAnnotations(0, annotated.length)
    assertEquals(1, links.size)
    assertEquals(5, links.single().start)
    assertEquals(5 + url.length, links.single().end)
    assertEquals(url, (links.single().item as LinkAnnotation.Url).url)
  }

  @Test
  fun markdownLinksUseLabelTextAndDestinationUrl() {
    val annotated = buildChatInlineMarkdown("Open [docs](https://docs.openclaw.ai/help/testing) now")

    assertEquals("Open docs now", annotated.text)
    val links = annotated.getLinkAnnotations(0, annotated.length)
    assertEquals(1, links.size)
    assertEquals(5, links.single().start)
    assertEquals(9, links.single().end)
    assertEquals("https://docs.openclaw.ai/help/testing", (links.single().item as LinkAnnotation.Url).url)
  }

  @Test
  fun markdownLinksDropUnsafeDestinations() {
    listOf(
      "intent://example/#Intent;scheme=openclaw;end",
      "file:///sdcard/Download/x",
      "content://downloads/public_downloads/1",
      "tel:+15551234567",
      "javascript:alert(1)",
    ).forEach { destination ->
      val annotated = buildChatInlineMarkdown("Open [settings]($destination)")

      assertEquals("Open settings", annotated.text)
      assertTrue(annotated.getLinkAnnotations(0, annotated.length).isEmpty())
    }
  }

  @Test
  fun plainTextDoesNotAddLinkAnnotations() {
    val annotated = buildChatInlineMarkdown("No link here")

    assertEquals("No link here", annotated.text)
    assertTrue(annotated.getLinkAnnotations(0, annotated.length).isEmpty())
  }

  @Test
  fun parseDataImageDestinationAcceptsBoundedPayloads() {
    val parsed = parseDataImageDestination("data:image/png;base64,QUJD")

    assertEquals(ParsedDataImage(mimeType = "image/png", base64 = "QUJD"), parsed)
  }

  @Test
  fun parseDataImageDestinationRejectsOversizedPayloads() {
    val oversized = "A".repeat(CHAT_IMAGE_MAX_BASE64_CHARS + 1)

    val parsed = parseDataImageDestination("data:image/png;base64,$oversized")

    assertNull(parsed)
  }
}
