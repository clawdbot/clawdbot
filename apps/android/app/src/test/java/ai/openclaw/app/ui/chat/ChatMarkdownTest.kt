package ai.openclaw.app.ui.chat

import androidx.compose.ui.text.LinkAnnotation
import org.junit.Assert.assertEquals
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
  fun plainTextDoesNotAddLinkAnnotations() {
    val annotated = buildChatInlineMarkdown("No link here")

    assertEquals("No link here", annotated.text)
    assertTrue(annotated.getLinkAnnotations(0, annotated.length).isEmpty())
  }
}
