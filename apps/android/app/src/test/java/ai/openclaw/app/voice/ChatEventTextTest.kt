package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatEventTextTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun extractsAssistantTextParts() {
    val payload =
      payload(
        """
        {
          "message": {
            "role": "assistant",
            "content": [
              { "type": "text", "text": "hello" },
              { "type": "text", "text": "world" }
            ]
          }
        }
        """,
      )

    assertEquals("hello\nworld", ChatEventText.assistantTextFromPayload(payload))
  }

  @Test
  fun extractsPlainStringContent() {
    val payload =
      payload(
        """
        {
          "message": {
            "role": "assistant",
            "content": "plain reply"
          }
        }
        """,
      )

    assertEquals("plain reply", ChatEventText.assistantTextFromPayload(payload))
  }

  @Test
  fun ignoresUserMessages() {
    val payload =
      payload(
        """
        {
          "message": {
            "role": "user",
            "content": [
              { "type": "text", "text": "do not speak" }
            ]
          }
        }
        """,
      )

    assertNull(ChatEventText.assistantTextFromPayload(payload))
  }

  private fun payload(source: String): JsonObject = json.parseToJsonElement(source.trimIndent()) as JsonObject
}
