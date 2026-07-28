package ai.openclaw.app.voice

import ai.openclaw.app.gateway.ChatSendAck
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
            ChatSendAck(runId = "run-1", status = "started")
          },
        )

      setTranscriptionSession(manager, "transcription-1")
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

    setTranscriptionSession(manager, "transcription-1")
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
            ChatSendAck(runId = "run-1", status = "started")
          },
        )

      setTranscriptionSession(manager, "transcription-1")
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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun submittedTranscribedMessageUsesGatewayTurnPath() =
    runTest {
      val sentMessages = mutableListOf<String>()
      val manager =
        createManager(
          scope = this,
          sendToGateway = { message, onRunIdKnown ->
            sentMessages += message
            onRunIdKnown("run-voice-e2e")
            ChatSendAck(runId = "run-voice-e2e", status = "started")
          },
        )

      manager.onGatewayConnectionChanged(true)
      manager.submitTranscribedMessage("voice e2e message")
      runCurrent()
      manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-voice-e2e", text = "voice e2e reply"))
      advanceUntilIdle()

      assertEquals(listOf("voice e2e message"), sentMessages)
      assertEquals(
        listOf(VoiceConversationRole.User, VoiceConversationRole.Assistant),
        manager.conversation.value.map { it.role },
      )
      assertEquals(
        "voice e2e reply",
        manager.conversation.value
          .last()
          .text,
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalGatewayTimeoutSendDoesNotAcceptDelayedOldRunEvents() =
    runTest {
      val manager =
        createManager(
          scope = this,
          sendToGateway = { _, onRunIdKnown ->
            onRunIdKnown("run-terminal")
            ChatSendAck(runId = "run-terminal", status = "timeout")
          },
        )

      manager.onGatewayConnectionChanged(true)
      manager.submitTranscribedMessage("terminal ack message")
      runCurrent()

      assertNull(privateField<String?>(manager, "pendingRunId"))
      assertEquals(false, manager.isSending.value)
      assertEquals("Send failed: Chat failed before the run started; try again.", manager.statusText.value)

      manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-terminal", text = "stale reply"))
      advanceUntilIdle()

      assertEquals(
        listOf(VoiceConversationRole.User),
        manager.conversation.value.map { it.role },
      )
      assertEquals(
        "terminal ack message",
        manager.conversation.value
          .single()
          .text,
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalGatewayErrorSurfacesFailureWithoutWaitingForRunEvents() =
    runTest {
      val manager =
        createManager(
          scope = this,
          sendToGateway = { _, onRunIdKnown ->
            onRunIdKnown("run-error")
            ChatSendAck(runId = "run-error", status = "error")
          },
        )

      manager.onGatewayConnectionChanged(true)
      manager.submitTranscribedMessage("terminal error message")
      runCurrent()

      assertNull(privateField<String?>(manager, "pendingRunId"))
      assertEquals(false, manager.isSending.value)
      assertEquals("Send failed: Chat failed before the run started; try again.", manager.statusText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun chatFailureRetainsLocalizedSourceForLaterLocaleChanges() =
    runTest {
      val manager =
        createManager(
          scope = this,
          sendToGateway = { _, onRunIdKnown ->
            onRunIdKnown("run-localized-error")
            ChatSendAck(runId = "run-localized-error", status = "started")
          },
        )

      manager.onGatewayConnectionChanged(true)
      manager.submitTranscribedMessage("trigger failure")
      runCurrent()
      manager.handleGatewayEvent(
        "chat",
        """{"runId":"run-localized-error","state":"error"}""",
      )
      advanceUntilIdle()

      val failure = manager.conversation.value.last()
      assertEquals(VoiceConversationRole.Assistant, failure.role)
      assertEquals("Voice request failed", failure.text)
      assertEquals("Voice request failed", failure.localizedSource)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalGatewayOkRefreshesHistoryWithoutWaitingForRunEvents() =
    runTest {
      var refreshCalls = 0
      val manager =
        createManager(
          scope = this,
          sendToGateway = { _, onRunIdKnown ->
            onRunIdKnown("run-ok")
            ChatSendAck(runId = "run-ok", status = "ok")
          },
          refreshAfterTerminalSuccess = { refreshCalls += 1 },
        )

      manager.onGatewayConnectionChanged(true)
      manager.submitTranscribedMessage("terminal ok message")
      runCurrent()

      assertNull(privateField<String?>(manager, "pendingRunId"))
      assertEquals(false, manager.isSending.value)
      assertEquals(1, refreshCalls)
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
      setTranscriptionSession(manager, "transcription-1")
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
      assertEquals("transcription-1", privateField<GatewayTranscriptionSession?>(manager, "transcriptionSession")?.id)
      privateField<Job?>(manager, "transcriptionDrainJob")?.cancel()
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun gatewayScopeChangeDropsQueuedVoiceBeforeReconnect() =
    runTest {
      val sentMessages = mutableListOf<String>()
      val manager =
        createManager(
          scope = this,
          sendToGateway = { message, onRunIdKnown ->
            sentMessages += message
            onRunIdKnown("run-b")
            ChatSendAck(runId = "run-b", status = "started")
          },
        )

      manager.submitTranscribedMessage("gateway A only")
      assertEquals(listOf("gateway A only"), manager.queuedMessages.value)

      manager.onGatewayScopeChanging()
      manager.onGatewayConnectionChanged(true)
      runCurrent()

      assertEquals(emptyList<String>(), manager.queuedMessages.value)
      assertEquals(emptyList<String>(), sentMessages)
      assertEquals(emptyList<VoiceConversationEntry>(), manager.conversation.value)
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
    sendToGateway: suspend (String, (String) -> Unit) -> ChatSendAck = { _, onRunIdKnown ->
      onRunIdKnown("run-1")
      ChatSendAck(runId = "run-1", status = "started")
    },
    refreshAfterTerminalSuccess: suspend () -> Unit = {},
  ): MicCaptureManager =
    MicCaptureManager(
      context =
        RuntimeEnvironment.getApplication().also { app ->
          shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
        },
      scope = scope,
      createTranscriptionSession = {
        GatewayTranscriptionSession(
          id = createTranscriptionSession(),
          gatewayId = "gateway-a",
        )
      },
      appendTranscriptionAudio = { _, _, _ -> },
      closeTranscriptionSession = { session -> closeTranscriptionSession(session.id) },
      sendToGateway = sendToGateway,
      refreshAfterTerminalSuccess = refreshAfterTerminalSuccess,
    )

  private fun setTranscriptionSession(
    manager: MicCaptureManager,
    id: String,
  ) {
    setPrivateField(
      manager,
      "transcriptionSession",
      GatewayTranscriptionSession(id = id, gatewayId = "gateway-a"),
    )
  }

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
