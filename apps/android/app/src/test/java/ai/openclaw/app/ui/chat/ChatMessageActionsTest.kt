package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatMessageActionsTest {
  @Test
  fun plainTextJoinsTextPartsAndIgnoresAttachments() {
    val content =
      listOf(
        ChatMessageContent(type = "text", text = "First paragraph"),
        ChatMessageContent(type = "image", fileName = "photo.png", base64 = "AAAA"),
        ChatMessageContent(type = "text", text = "Second paragraph"),
      )

    assertEquals("First paragraph\n\nSecond paragraph", chatMessagePlainText(content))
  }

  @Test
  fun replyQuotesEveryLineAndLeavesComposerSpace() {
    assertEquals("> first\n>\n> second\n\n", quoteChatMessage("first\n\nsecond"))
  }

  @Test
  fun copyAndReplyPreserveWhitespaceSensitiveContent() {
    val text = "    indented code\nnext line  "
    val content = listOf(ChatMessageContent(type = "text", text = text))

    assertEquals(text, chatMessagePlainText(content))
    assertEquals(">     indented code\n> next line  \n\n", quoteChatMessage(text))
  }
}
