package ai.openclaw.app.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
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

  @Test
  fun dropsOversizedInlineImageContentBeforeRendering() {
    val oversized = "A".repeat(CHAT_IMAGE_MAX_BASE64_CHARS + 1)
    val image =
      Json.parseToJsonElement(
        """{"type":"image","mimeType":"image/png","fileName":"large.png","content":"$oversized"}""",
      )

    assertEquals(
      ChatMessageContent(type = "image", mimeType = "image/png", fileName = "large.png", base64 = null),
      parseChatMessageContent(image),
    )
  }

  @Test
  fun parsesDirectAndAttachmentAudioBlocks() {
    val direct =
      Json.parseToJsonElement(
        """{"type":"audio","mimeType":"audio/mp4","fileName":"voice.m4a"}""",
      )
    val attachment =
      Json.parseToJsonElement(
        """{"type":"attachment","attachment":{"kind":"audio","mimeType":"audio/mpeg","label":"reply.mp3"}}""",
      )

    assertEquals(
      ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "voice.m4a"),
      parseChatMessageContent(direct),
    )
    assertEquals(
      ChatMessageContent(type = "audio", mimeType = "audio/mpeg", fileName = "reply.mp3"),
      parseChatMessageContent(attachment),
    )
  }

  @Test
  fun parsesTranscriptAudioMediaFieldsAlongsideCaption() {
    val message =
      Json
        .parseToJsonElement(
          """{"content":[{"type":"text","text":"See attached."}],"MediaPaths":["media/inbound/voice.m4a"],"MediaTypes":["audio/x-m4a"]}""",
        ).jsonObject

    assertEquals(
      listOf(
        ChatMessageContent(type = "text", text = "See attached."),
        ChatMessageContent(type = "audio", mimeType = "audio/x-m4a", fileName = "voice.m4a"),
      ),
      parseChatMessageContents(message),
    )
  }
}
