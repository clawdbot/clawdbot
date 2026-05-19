package ai.openclaw.app.voice

import android.Manifest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MicCaptureManagerTest {
  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun transcriptionFinalQueuesGatewayMessage() =
    runTest {
      val sentMessages = mutableListOf<String>()
      val manager =
        createManager(
          scope = this,
          sendToGateway = { message, onRunIdKnown ->
            sentMessages += message
            onRunIdKnown("run-1")
            null
          },
        )

      setPrivateField(manager, "transcriptionSessionId", "transcription-1")
      manager.onGatewayConnectionChanged(true)
      manager.handleGatewayEvent(
        "talk.event",
        """{"transcriptionSessionId":"transcription-1","type":"partial","text":"hello"}""",
      )
      manager.handleGatewayEvent(
        "talk.event",
        """{"transcriptionSessionId":"transcription-1","type":"transcript","text":"hello world","final":true}""",
      )
      runCurrent()
      manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-1", text = "reply"))
      advanceUntilIdle()

      assertNull(manager.liveTranscript.value)
      assertEquals(listOf("hello world"), sentMessages)
      val conversation = manager.conversation.value.first()
      assertEquals(VoiceConversationRole.User, conversation.role)
      assertEquals("hello world", conversation.text)
    }

  @Test
  fun transcriptionErrorDisablesMic() {
    val manager = createManager()

    setPrivateField(manager, "transcriptionSessionId", "transcription-1")
    manager.handleGatewayEvent(
      "talk.event",
      """{"transcriptionSessionId":"transcription-1","type":"error","message":"provider unavailable"}""",
    )

    assertEquals(false, manager.micEnabled.value)
    assertEquals("Transcription failed: provider unavailable", manager.statusText.value)
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun punctuationOnlyTranscriptDoesNotSendTurn() =
    runTest {
      val sentMessages = mutableListOf<String>()
      val manager =
        createManager(
          scope = this,
          sendToGateway = { message, onRunIdKnown ->
            sentMessages += message
            onRunIdKnown("run-1")
            "run-1"
          },
        )

      setPrivateField(manager, "transcriptionSessionId", "transcription-1")
      manager.onGatewayConnectionChanged(true)
      manager.handleGatewayEvent(
        "talk.event",
        """{"transcriptionSessionId":"transcription-1","type":"transcript","text":".","final":true}""",
      )
      advanceUntilIdle()

      assertEquals(emptyList<String>(), sentMessages)
      assertEquals(emptyList<VoiceConversationEntry>(), manager.conversation.value)
    }

  @Test
  fun pcm16FramesAreEncodedAsPcmuFrames() {
    val manager = createManager()
    val method = manager.javaClass.getDeclaredMethod("pcm16ToPcmu", ByteArray::class.java)
    method.isAccessible = true

    val encoded = method.invoke(manager, byteArrayOf(0, 0, 0, 0)) as ByteArray

    assertEquals(2, encoded.size)
    assertEquals(0xff.toByte(), encoded[0])
    assertEquals(0xff.toByte(), encoded[1])
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun disablingMicDuringSessionCreateClosesReturnedSession() =
    runTest {
      val createdSession = CompletableDeferred<String>()
      val closedSessions = mutableListOf<String>()
      val manager =
        createManager(
          scope = this,
          createTranscriptionSession = { createdSession.await() },
          closeTranscriptionSession = { sessionId -> closedSessions += sessionId },
        )

      manager.onGatewayConnectionChanged(true)
      manager.setMicEnabled(true)
      manager.setMicEnabled(false)
      createdSession.complete("transcription-1")
      advanceUntilIdle()

      assertEquals(listOf("transcription-1"), closedSessions)
      assertEquals(false, manager.isListening.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun disablingMicKeepsSessionOpenForFinalTranscript() =
    runTest {
      val manager = createManager(scope = this)

      setPrivateMutableStateFlowValue(manager, "_micEnabled", true)
      setPrivateField(manager, "transcriptionSessionId", "transcription-1")
      manager.setMicEnabled(false)
      manager.handleGatewayEvent(
        "talk.event",
        """{"transcriptionSessionId":"transcription-1","type":"transcript","text":"testing testing 1 2 3","final":true}""",
      )
      runCurrent()

      assertEquals(
        "testing testing 1 2 3",
        manager.conversation.value
          .single()
          .text,
      )
      assertEquals("transcription-1", privateField<String?>(manager, "transcriptionSessionId"))
      privateField<Job?>(manager, "transcriptionDrainJob")?.cancel()
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectRestartsAfterPendingCreateCancellation() =
    runTest {
      val firstCreate = CompletableDeferred<String>()
      val secondCreate = CompletableDeferred<String>()
      var createCalls = 0
      val manager =
        createManager(
          scope = this,
          createTranscriptionSession = {
            createCalls += 1
            if (createCalls == 1) firstCreate.await() else secondCreate.await()
          },
        )

      manager.onGatewayConnectionChanged(true)
      manager.setMicEnabled(true)
      runCurrent()
      manager.onGatewayConnectionChanged(false)
      manager.onGatewayConnectionChanged(true)
      firstCreate.completeExceptionally(CancellationException("connection closed"))
      runCurrent()

      assertEquals(2, createCalls)
      assertEquals(true, manager.micEnabled.value)
      manager.setMicEnabled(false)
      secondCreate.completeExceptionally(CancellationException("test complete"))
      runCurrent()
    }

  private fun createManager(
    scope: CoroutineScope = CoroutineScope(Dispatchers.Unconfined),
    createTranscriptionSession: suspend () -> String = { "transcription-1" },
    closeTranscriptionSession: suspend (String) -> Unit = { _ -> },
    sendToGateway: suspend (String, (String) -> Unit) -> String? = { _, onRunIdKnown ->
      onRunIdKnown("run-1")
      "run-1"
    },
  ): MicCaptureManager =
    MicCaptureManager(
      context =
        RuntimeEnvironment.getApplication().also { app ->
          shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
        },
      scope = scope,
      createTranscriptionSession = createTranscriptionSession,
      appendTranscriptionAudio = { _, _, _ -> },
      closeTranscriptionSession = closeTranscriptionSession,
      sendToGateway = sendToGateway,
    )

  private fun setPrivateField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    field.set(target, value)
  }

  @Suppress("UNCHECKED_CAST")
  private fun setPrivateMutableStateFlowValue(
    target: Any,
    name: String,
    value: Boolean,
  ) {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    (field.get(target) as MutableStateFlow<Boolean>).value = value
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> privateField(
    target: Any,
    name: String,
  ): T {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    return field.get(target) as T
  }

  private fun chatFinalPayload(
    runId: String,
    text: String,
  ): String =
    """
    {
      "runId": "$runId",
      "state": "final",
      "message": {
        "role": "assistant",
        "content": [
          { "type": "text", "text": "$text" }
        ]
      }
    }
    """.trimIndent()
}
