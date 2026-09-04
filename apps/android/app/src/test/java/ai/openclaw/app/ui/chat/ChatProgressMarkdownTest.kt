package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatProgressMarkdownTest {
  @Test
  fun progressElementParsesAndKeepsSurroundingMarkdown() {
    val markdown =
      """
      Test is running

      <progress aria-label="Test progress" value="2" max="5" onclick="ignored()"></progress>

      40%
      """.trimIndent()
    val progress = findProgressElement(markdown)

    assertEquals(2.0, progress?.value)
    assertEquals(5.0, progress?.max)
    assertEquals(0.4f, progress?.fraction)
    assertEquals("Test progress", progress?.label)
  }

  @Test
  fun invalidProgressElementRemainsLiteralMarkdown() {
    val markdown = "<progress value=\"2\" max=\"0\"></progress>"

    assertNull(findProgressElement(markdown))
  }

  @Test
  fun progressExamplesInCodeBlocksRemainMarkdown() {
    val examples =
      listOf(
        "```html\n<progress value=\"2\" max=\"5\"></progress>\n```",
        "    <progress value=\"2\" max=\"5\"></progress>",
      )

    examples.forEach { markdown ->
      assertNull(findProgressElement(markdown))
    }
  }

  @Test
  fun malformedProgressAttributesRemainMarkdown() {
    val markdown = "<progress aria-label=\"unterminated value=\"2\" max=\"5\"></progress>"

    assertNull(findProgressElement(markdown))
  }

  @Test
  fun nonHtmlProgressNumbersRemainMarkdown() {
    listOf("0x1p0", "NaN", "Infinity", "+2", "2.", "2.e3").forEach { value ->
      val markdown = "<progress value=\"$value\" max=\"5\"></progress>"

      assertNull(findProgressElement(markdown))
    }
  }

  @Test
  fun warningAfterDisclosureIsNotReinterpretedAsProgress() {
    val markdown =
      """
      <progress value='2' max='5'></progress>

      <details>
      <summary>Logs</summary>
      body
      </details>Do not ship: tests are failing on Linux
      """.trimIndent()
    val tail = (parseChatMarkdownBlocks(markdown).last() as ChatMarkdownRenderBlock.CommonMark).node

    assertNull(parseChatProgressElement(tail))
  }

  private fun findProgressElement(markdown: String): ChatProgressElement? {
    var node = parseChatMarkdown(markdown).firstChild
    while (node != null) {
      parseChatProgressElement(node)?.let { return it }
      node = node.next
    }
    return null
  }
}
