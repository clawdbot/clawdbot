package ai.openclaw.app.voice

import ai.openclaw.app.gateway.ChatSendAck
import android.Manifest
import android.media.AudioRecord
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAudioRecord
import java.lang.management.ManagementFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

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

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun ttsPauseWaitsForTheActualCaptureFinallyBeforePlayingSpeech() =
    runTest {
      val manager = createManager(scope = this)
      val release = CompletableDeferred<Unit>()
      var closed = false
      val capture =
        launch {
          try {
            awaitCancellation()
          } finally {
            withContext(NonCancellable) { release.await() }
            closed = true
          }
        }
      setPrivateMutableStateFlowValue(manager, "_micEnabled", true)
      setTranscriptionSession(manager, "capture-before-tts")
      setPrivateField(manager, "transcriptionCaptureJob", capture)
      runCurrent()
      val paused = async { manager.pauseForTts() }
      try {
        runCurrent()
        assertTrue(capture.isCancelled)
        assertFalse(closed)
        assertFalse("TTS must wait until the microphone is physically released", paused.isCompleted)
        release.complete(Unit)
        paused.await()
        assertTrue(closed)
      } finally {
        release.complete(Unit)
        capture.join()
        paused.cancel()
      }
    }

  @Test
  fun reenableDuringInputCloseResumesTheSameSessionAfterTheOldRecorderIsReleased() =
    runBlocking {
      val scopeJob = SupervisorJob()
      val scope = CoroutineScope(scopeJob + Dispatchers.IO)
      val firstRead = CompletableDeferred<AudioRecord>()
      val resumedRead = CompletableDeferred<AudioRecord>()
      val firstRecorder = AtomicReference<AudioRecord?>()
      val finishFirstRead = CountDownLatch(1)
      val finishResumedRead = CountDownLatch(1)
      val resumeFromClose = AtomicBoolean(false)
      var creates = 0
      lateinit var manager: MicCaptureManager
      ShadowAudioRecord.setSourceProvider { recorder ->
        firstRecorder.compareAndSet(null, recorder)
        object : ShadowAudioRecord.AudioRecordSource {
          override fun readInByteArray(
            buffer: ByteArray,
            offset: Int,
            size: Int,
            blocking: Boolean,
          ): Int {
            if (recorder === firstRecorder.get()) {
              firstRead.complete(recorder)
              check(finishFirstRead.await(15, TimeUnit.SECONDS))
            } else {
              resumedRead.complete(recorder)
              check(finishResumedRead.await(15, TimeUnit.SECONDS))
            }
            return 0
          }
        }
      }
      try {
        manager =
          createManager(
            scope = scope,
            createTranscriptionSession = {
              creates++
              "reused-session"
            },
            onAppliedAudioInputChanged = { key ->
              if (key == null && resumeFromClose.compareAndSet(true, false)) manager.setMicEnabled(true)
            },
          )
        manager.onGatewayConnectionChanged(true)
        manager.setMicEnabled(true)
        val retired = withTimeout(5_000) { firstRead.await() }
        val input = privateField<AndroidAudioInputSession>(manager, "transcriptionAudioInput")
        setPrivateField(input, "appliedPreferredInputKey", "synthetic-applied-device")
        resumeFromClose.set(true)
        manager.setMicEnabled(false)
        finishFirstRead.countDown()

        assertNotNull("Re-enable during finally must restart physical input", withTimeoutOrNull(5_000) { resumedRead.await() })
        assertEquals(AudioRecord.STATE_UNINITIALIZED, retired.state)
        assertEquals(1, creates)
        assertTrue(manager.micEnabled.value)
        assertFalse(manager.micCooldown.value)
      } finally {
        resumeFromClose.set(false)
        manager.cancelMicCapture()
        finishFirstRead.countDown()
        finishResumedRead.countDown()
        scopeJob.cancelAndJoin()
        ShadowAudioRecord.clearSource()
      }
    }

  @Test
  fun oldAppendFailureCannotStopSameSessionCaptureReplacement() =
    runBlocking {
      val scopeJob = SupervisorJob()
      val scope = CoroutineScope(scopeJob + Dispatchers.IO)
      val callback = CompletableDeferred<(String) -> Unit>()
      val readAgain = CountDownLatch(1)
      val sentFrame = AtomicBoolean(false)
      ShadowAudioRecord.setSourceProvider {
        object : ShadowAudioRecord.AudioRecordSource {
          override fun readInByteArray(
            buffer: ByteArray,
            offset: Int,
            size: Int,
            blocking: Boolean,
          ): Int {
            if (sentFrame.compareAndSet(false, true)) {
              buffer.fill(1, offset, offset + size)
              return size
            }
            check(readAgain.await(15, TimeUnit.SECONDS))
            return 0
          }
        }
      }
      val manager = createManager(scope = scope, appendTranscriptionAudio = { _, _, onError -> callback.complete(onError) })
      var failure: Thread? = null
      try {
        manager.onGatewayConnectionChanged(true)
        manager.setMicEnabled(true)
        val oldError = withTimeout(5_000) { callback.await() }
        val session = privateField<GatewayTranscriptionSession>(manager, "transcriptionSession")
        val restart = manager.javaClass.getDeclaredMethod("startTranscriptionCapture", GatewayTranscriptionSession::class.java).also { it.isAccessible = true }
        val replacement =
          synchronized(privateField<Any>(manager, "ttsPauseLock")) {
            failure = Thread { oldError("retired append failed") }.also { it.start() }
            awaitOwnershipLock(failure, privateField(manager, "ttsPauseLock"))
            // Re-enable deliberately reuses the provider session while replacing its input owner.
            manager.setMicEnabled(true)
            restart.invoke(manager, session)
            privateField<Job>(manager, "transcriptionCaptureJob")
          }
        failure!!.join(5_000)
        assertFalse("Failure callback must finish after owner admission", failure.isAlive)
        assertTrue("An old append failure must not disable replacement capture", manager.micEnabled.value)
        assertEquals(session, privateField<GatewayTranscriptionSession?>(manager, "transcriptionSession"))
        assertTrue(replacement.isActive)
      } finally {
        readAgain.countDown()
        failure?.join(5_000)
        manager.cancelMicCapture()
        scopeJob.cancelAndJoin()
        ShadowAudioRecord.clearSource()
      }
    }

  @Test
  fun retiredProviderCloseCannotStopReplacementCapture() = assertRetiredTerminalCannotStopReplacement("close")

  @Test
  fun retiredCreateFailureCannotStopReplacementCapture() = assertRetiredTerminalCannotStopReplacement("create failure")

  private fun assertRetiredTerminalCannotStopReplacement(terminal: String) =
    runBlocking {
      val scopeJob = SupervisorJob()
      val scope = CoroutineScope(scopeJob + Dispatchers.Unconfined)
      val created = CompletableDeferred<String>()
      val manager = createManager(scope = scope, createTranscriptionSession = { created.await() })
      val replacement = Job(scopeJob)
      var oldTerminal: Thread? = null
      try {
        if (terminal == "create failure") {
          manager.onGatewayConnectionChanged(true)
          manager.setMicEnabled(true)
        } else {
          setTranscriptionSession(manager, "old-provider")
          setPrivateMutableStateFlowValue(manager, "_micEnabled", true)
        }
        val lock = privateField<Any>(manager, "ttsPauseLock")
        synchronized(lock) {
          oldTerminal =
            Thread {
              if (terminal == "create failure") {
                created.completeExceptionally(IllegalStateException("retired create failed"))
              } else {
                manager.handleGatewayEvent("talk.event", """{"transcriptionSessionId":"old-provider","type":"close"}""")
              }
            }.also { it.start() }
          awaitOwnershipLock(oldTerminal, lock)
          // Model a replacement admitted at the existing provider/input ownership boundary.
          privateField<AtomicLong>(manager, "audioInputGeneration").incrementAndGet()
          setTranscriptionSession(manager, "replacement-provider")
          setPrivateField(manager, "transcriptionCaptureJob", replacement)
          setPrivateMutableStateFlowValue(manager, "_micEnabled", true)
        }
        oldTerminal!!.join(5_000)
        assertFalse("$terminal must finish after owner admission", oldTerminal.isAlive)
        assertTrue("$terminal must not disable the replacement", manager.micEnabled.value)
        assertEquals(terminal, "replacement-provider", privateField<GatewayTranscriptionSession?>(manager, "transcriptionSession")?.id)
        assertTrue("$terminal must not cancel replacement input", replacement.isActive)
      } finally {
        oldTerminal?.join(5_000)
        manager.cancelMicCapture()
        scopeJob.cancelAndJoin()
      }
    }

  @Suppress("DEPRECATION")
  private fun awaitOwnershipLock(
    thread: Thread,
    lock: Any,
  ) {
    val bean = ManagementFactory.getThreadMXBean()
    val deadline = System.nanoTime() + 5_000_000_000L
    while (true) {
      val info = bean.getThreadInfo(thread.id)
      if (info?.lockOwnerId == Thread.currentThread().id && info.lockInfo?.identityHashCode == System.identityHashCode(lock)) return
      check(System.nanoTime() < deadline) { "Terminal callback did not reach the capture ownership lock" }
      Thread.yield()
    }
  }

  private fun createManager(
    scope: CoroutineScope = CoroutineScope(Dispatchers.Unconfined),
    onAppliedAudioInputChanged: (String?) -> Unit = {},
    createTranscriptionSession: suspend () -> String = { "transcription-1" },
    closeTranscriptionSession: suspend (String) -> Unit = { _ -> },
    appendTranscriptionAudio: suspend (GatewayTranscriptionSession, ByteArray, (String) -> Unit) -> Unit = { _, _, _ -> },
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
      onAppliedAudioInputChanged = onAppliedAudioInputChanged,
      createTranscriptionSession = {
        GatewayTranscriptionSession(
          id = createTranscriptionSession(),
          gatewayId = "gateway-a",
        )
      },
      appendTranscriptionAudio = appendTranscriptionAudio,
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
