package ai.openclaw.app.chat

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatMessageContentParsingTest {
  @Test
  fun dropsInternalToolBlocksFromDisplayHistory() {
    val content =
      Json.parseToJsonElement(
        """{"type":"toolResult","content":"large internal output"}""",
      )

    assertNull(parseChatMessageContent(content))
  }

  @Test
  fun parsesCodexTextBlocksAsVisibleText() {
    val content =
      Json.parseToJsonElement(
        """{"type":"output_text","text":"Done."}""",
      )

    assertEquals(ChatMessageContent(type = "text", text = "Done."), parseChatMessageContent(content))
  }

  @Test
  fun parsesImageBlocksOnlyWhenInlineContentExists() {
    val image =
      Json.parseToJsonElement(
        """{"type":"image","mimeType":"image/png","fileName":"chart.png","content":"abc123"}""",
      )
    val managedImage =
      Json.parseToJsonElement(
        """{"type":"image","mimeType":"image/png","fileName":"chart.png","url":"/api/chat/media/outgoing/main/id"}""",
      )

    assertEquals(
      ChatMessageContent(type = "image", mimeType = "image/png", fileName = "chart.png", base64 = "abc123"),
      parseChatMessageContent(image),
    )
    assertEquals(
      ChatMessageContent(type = "image", mimeType = "image/png", fileName = "chart.png", base64 = null),
      parseChatMessageContent(managedImage),
    )
  }
}
