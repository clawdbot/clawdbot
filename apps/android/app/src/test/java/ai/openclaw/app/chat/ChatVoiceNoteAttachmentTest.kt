package ai.openclaw.app.chat

import ai.openclaw.app.ui.chat.stageVoiceNoteAttachment
import ai.openclaw.app.ui.chat.toOutgoingAttachment
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

@OptIn(ExperimentalCoroutinesApi::class)
class ChatVoiceNoteAttachmentTest {
  @Test
  fun stagedVoiceNoteUsesAudioPayloadAndDurationInLocalEcho() =
    runTest {
      val file = Files.createTempFile("voice-note-", ".m4a").toFile()
      file.writeBytes("voice-bytes".encodeToByteArray())
      val pending = stageVoiceNoteAttachment(VoiceNoteRecording(file = file, durationMs = 12_345L))
      val outgoing = pending.toOutgoingAttachment()
      var sentParams: JsonObject? = null
      val json = Json { ignoreUnknownKeys = true }
      val chat =
        ChatController(
          scope = backgroundScope,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "chat.send" -> {
                sentParams = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                """{"runId":"voice-run","status":"started"}"""
              }
              else -> "{}"
            }
          },
        )
      chat.handleGatewayEvent("health", null)
      runCurrent()

      val accepted =
        chat.sendMessageAwaitAcceptance(
          message = "listen",
          thinkingLevel = "off",
          attachments = listOf(outgoing),
        )

      assertTrue(accepted)
      assertFalse(file.exists())
      assertEquals("audio", outgoing.type)
      assertEquals(VOICE_NOTE_MIME_TYPE, outgoing.mimeType)
      assertTrue(outgoing.fileName.endsWith(".m4a"))
      assertEquals("dm9pY2UtYnl0ZXM=", outgoing.base64)

      val sentAttachment = ((sentParams?.get("attachments") as JsonArray).single() as JsonObject)
      assertEquals("audio", (sentAttachment["type"] as JsonPrimitive).content)
      assertEquals(VOICE_NOTE_MIME_TYPE, (sentAttachment["mimeType"] as JsonPrimitive).content)
      assertTrue((sentAttachment["fileName"] as JsonPrimitive).content.endsWith(".m4a"))
      assertEquals("dm9pY2UtYnl0ZXM=", (sentAttachment["content"] as JsonPrimitive).content)

      val echoedAudio =
        chat.messages.value
          .single()
          .content
          .single { it.type == "audio" }
      assertEquals(VOICE_NOTE_MIME_TYPE, echoedAudio.mimeType)
      assertEquals(12_345L, echoedAudio.durationMs)
    }
}
