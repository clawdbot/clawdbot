package ai.openclaw.app.voice

import ai.openclaw.app.gateway.DeviceAuthEntry
import ai.openclaw.app.gateway.DeviceAuthTokenStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import android.Manifest
import android.content.ComponentName
import android.content.IntentFilter
import android.os.SystemClock
import android.speech.RecognitionService
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TalkModeManagerTest {
  @Test
  fun stopTtsCancelsTrackedPlaybackJob() {
    val manager = createManager()
    val playbackJob = Job()

    setPrivateField(manager, "ttsJob", playbackJob)
    playbackGeneration(manager).set(7L)

    manager.stopTts()

    assertTrue(playbackJob.isCancelled)
    assertEquals(8L, playbackGeneration(manager).get())
  }

  @Test
  fun disablingPlaybackCancelsTrackedJobOnce() {
    val manager = createManager()
    val playbackJob = Job()

    setPrivateField(manager, "ttsJob", playbackJob)
    playbackGeneration(manager).set(11L)

    manager.setPlaybackEnabled(false)
    manager.setPlaybackEnabled(false)

    assertTrue(playbackJob.isCancelled)
    assertEquals(12L, playbackGeneration(manager).get())
  }

  @Test
  fun beginPushToTalkRejectsNewCaptureWhenNewCaptureIsDisallowed() =
    runTest {
      val manager = createManager()

      val error =
        runCatching { manager.beginPushToTalk(allowNewCapture = false) }
          .exceptionOrNull()

      assertEquals("NODE_BACKGROUND_UNAVAILABLE: command requires foreground", error?.message)
    }

  @Test
  fun beginPushToTalkReturnsActiveCaptureWhenNewCaptureIsDisallowed() =
    runTest {
      val manager = createManager()
      setPrivateField(manager, "activePttCaptureId", "capture-1")

      val payload = manager.beginPushToTalk(allowNewCapture = false)

      assertEquals("capture-1", payload.captureId)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun beginPushToTalkRejectsInvalidatedCaptureBeforeStarting() =
    runTest {
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val packageManager = shadowOf(app.packageManager)
      val speechService = ComponentName(app, "TestSpeechRecognitionService")
      packageManager.addServiceIfNotPresent(speechService)
      packageManager.addIntentFilterForService(speechService, IntentFilter(RecognitionService.SERVICE_INTERFACE))
      val manager = createManager()
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        val error =
          runCatching {
            manager.beginPushToTalk(
              allowNewCapture = true,
              canStartCapture = { false },
            )
          }.exceptionOrNull()

        assertEquals("NODE_BACKGROUND_UNAVAILABLE: command requires foreground", error?.message)
        assertNull(readPrivateField(manager, "activePttCaptureId"))
        assertFalse(manager.isListening.value)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun stopAllCaptureClearsPttWhenContinuousModeIsDisabled() {
    val manager = createManager()
    val finishingJob = Job()
    setPrivateField(manager, "activePttCaptureId", "capture-1")
    setPrivateField(manager, "finishingPttCaptureId", "capture-finishing")
    setPrivateField(manager, "finishingPttJob", finishingJob)
    setMutableStateFlow(manager, "_isListening", true)

    manager.stopAllCapture()

    assertNull(readPrivateField(manager, "activePttCaptureId"))
    assertEquals("capture-finishing", manager.finishingPushToTalkCaptureId)
    assertTrue(finishingJob.isCancelled)
    assertFalse(manager.isEnabled.value)
    assertFalse(manager.isListening.value)
    assertEquals("Off", manager.statusText.value)
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleCancellationDoesNotStopNewerPushToTalkCapture() =
    runTest {
      val manager = createManager()
      val completion = CompletableDeferred<TalkPttStopPayload>()
      setPrivateField(manager, "activePttCaptureId", "capture-new")
      setPrivateField(manager, "pttCompletion", completion)
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        val payload = manager.cancelPushToTalk("capture-old")

        assertEquals("idle", payload.status)
        assertEquals("capture-new", readPrivateField(manager, "activePttCaptureId"))
        assertFalse(completion.isCompleted)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun oneShotRetryDoesNotReplaceActivePushToTalkCapture() =
    runTest {
      val manager = createManager()
      val completion = CompletableDeferred<TalkPttStopPayload>()
      setPrivateField(manager, "activePttCaptureId", "capture-active")
      setPrivateField(manager, "pttCompletion", completion)

      val start = manager.beginPushToTalkOnce()
      val payload = manager.awaitPushToTalkOnce(start)

      assertEquals("busy", payload.status)
      assertEquals("capture-active", payload.captureId)
      assertEquals("capture-active", readPrivateField(manager, "activePttCaptureId"))
      assertFalse(completion.isCompleted)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cancelledOneShotWaitCleansItsCapture() =
    runTest {
      val manager = createManager()
      val completion = CompletableDeferred<TalkPttStopPayload>()
      setPrivateField(manager, "activePttCaptureId", "capture-1")
      setPrivateField(manager, "pttCompletion", completion)
      setMutableStateFlow(manager, "_isListening", true)
      val start = TalkPttOnceStart.Started(captureId = "capture-1", completion = completion)
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        val wait = launch { manager.awaitPushToTalkOnce(start) }
        advanceUntilIdle()
        wait.cancel()
        runCurrent()
        wait.join()

        assertNull(readPrivateField(manager, "activePttCaptureId"))
        assertNull(readPrivateField(manager, "pttCompletion"))
        assertFalse(manager.isListening.value)
        assertTrue(completion.isCompleted)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleStopDoesNotSubmitNewerPushToTalkCapture() =
    runTest {
      val manager = createManager()
      val completion = CompletableDeferred<TalkPttStopPayload>()
      setPrivateField(manager, "activePttCaptureId", "capture-new")
      setPrivateField(manager, "pttCompletion", completion)
      setPrivateField(manager, "lastTranscript", "new partial transcript")
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        val payload = manager.endPushToTalk("capture-old")

        assertEquals("idle", payload.status)
        assertEquals("capture-new", readPrivateField(manager, "activePttCaptureId"))
        assertEquals("new partial transcript", readPrivateField(manager, "lastTranscript"))
        assertFalse(completion.isCompleted)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun duplicateFinalForPendingTalkRunDoesNotStartAllResponseTts() {
    val manager = createManager()
    val final = CompletableDeferred<Boolean>()

    manager.ttsOnAllResponses = true
    setPrivateField(manager, "pendingRunId", "run-talk")
    setPrivateField(manager, "pendingFinal", final)

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-talk", text = "spoken once"))
    assertTrue(final.isCompleted)
    assertEquals(0L, playbackGeneration(manager).get())

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-talk", text = "spoken once"))

    assertEquals(0L, playbackGeneration(manager).get())
  }

  @Test
  fun nonPendingFinalStillUsesAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-other", text = "speak this"))

    assertEquals(1L, playbackGeneration(manager).get())
  }

  @Test
  fun nonPendingUserFinalDoesNotUseAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-user", text = "do not speak", role = "user"))

    assertEquals(0L, playbackGeneration(manager).get())
  }

  @Test
  fun realtimeToolFinalDoesNotUseAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    setPrivateField(manager, "realtimeSessionId", "relay-1")
    realtimeToolRuns(manager)["run-tool"] =
      RealtimeToolRun(callId = "call-1", relaySessionId = "relay-1")

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-tool", text = "tool result"))

    assertEquals(0L, playbackGeneration(manager).get())
    assertTrue(realtimeToolRuns(manager).isEmpty())
  }

  @Test
  fun realtimeToolFinalBeforeRunMetadataIsHeldForToolCompletion() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    setPrivateField(manager, "realtimeSessionId", "relay-1")
    pendingRealtimeToolCalls(manager).add("call-1")

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-tool", text = "tool result"))

    assertEquals(0L, playbackGeneration(manager).get())
    assertTrue(pendingRealtimeToolCompletions(manager).containsKey("run-tool"))
  }

  @Test
  fun realtimeCloseErrorDisablesTalkButKeepsFailureStatus() {
    var stoppedByRelay = false
    val manager = createManager(onStoppedByRelay = { stoppedByRelay = true })

    setPrivateField(manager, "realtimeSessionId", "relay-1")
    setMutableStateFlow(manager, "_isEnabled", true)

    manager.handleGatewayEvent(
      "talk.event",
      """{"relaySessionId":"relay-1","type":"close","reason":"error"}""",
    )

    assertFalse(manager.isEnabled.value)
    assertTrue(stoppedByRelay)
    assertEquals(
      "Talk failed: Realtime provider closed unexpectedly.",
      manager.statusText.value,
    )
  }

  @Test
  fun realtimeClosePreservesTypedFailureWithoutEnglishPrefix() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")
    setMutableStateFlow(manager, "_isEnabled", true)
    setTalkFailure(manager, verbatimText("Échec de Talk : session refusée."))

    manager.handleGatewayEvent(
      "talk.event",
      """{"relaySessionId":"relay-1","type":"close","reason":"error"}""",
    )

    assertEquals("Échec de Talk : session refusée.", manager.statusText.value)
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun localizedOffStatusDoesNotBecomeRealtimeStartFailure() =
    runTest {
      val manager = createManager(scope = this)
      val turn =
        async(start = CoroutineStart.UNDISPATCHED) {
          runCatching {
            manager.runE2eRealtimeTurn(
              userText = "ignored",
              assistantText = "ignored",
              timeoutMs = 250L,
            )
          }.exceptionOrNull()
        }

      manager.stopAllCapture()
      setMutableStateFlow(manager, "_statusText", verbatimText("Désactivé"))
      assertEquals("Désactivé", manager.statusText.value)
      advanceUntilIdle()

      assertTrue(turn.await() is TimeoutCancellationException)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun realtimePlaybackMarkAcknowledgesAfterQueuedAudioBarrier() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val dispatcher = StandardTestDispatcher(testScheduler)
      val manager =
        createManager(
          scope = this,
          realtimePlaybackDispatcher = dispatcher,
          realtimeMarkAcknowledger = { sessionId, markName ->
            acknowledgements += sessionId to markName
          },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")

      manager.handleGatewayEvent(
        "talk.event",
        """{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""",
      )
      runCurrent()

      assertEquals(listOf("relay-1" to "audio-1"), acknowledgements)
    }

  @Test
  fun realtimeTranscriptsPopulateVoiceConversation() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "hello"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "hello world", final = true))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "hi"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "hi there", final = true))

    assertEquals(
      listOf(
        VoiceConversationEntry(
          id = manager.conversation.value[0].id,
          role = VoiceConversationRole.User,
          text = "hello world",
        ),
        VoiceConversationEntry(
          id = manager.conversation.value[1].id,
          role = VoiceConversationRole.Assistant,
          text = "hi there",
        ),
      ),
      manager.conversation.value,
    )
  }

  @Test
  fun realtimeUserTranscriptsDriveSpeechActive() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    assertFalse(manager.speechActive.value)
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "hello"))
    assertTrue(manager.speechActive.value)
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "hello world", final = true))
    assertFalse(manager.speechActive.value)
  }

  @Test
  fun finalUserTranscriptMarksAwaitingAgentUntilStatusMovesOn() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    assertFalse(manager.awaitingAgent.value)
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "hello", final = true))
    assertTrue(manager.awaitingAgent.value)
    // Any later status transition clears the typed flag; forgetting it at a
    // new setStatus site fails safe instead of showing a stale Thinking wave.
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "hi there", final = true))
    manager.stopAllCapture()
    assertFalse(manager.awaitingAgent.value)
  }

  @Test
  fun realtimeTranscriptDeltasAccumulateVoiceConversation() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "The"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = " answer"))

    val entry = manager.conversation.value.single()
    assertEquals("The answer", entry.text)
    assertTrue(entry.isStreaming)
  }

  @Test
  fun realtimeTranscriptFragmentsInsertWordSpacing() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Turn off"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "the lights"))

    val entry = manager.conversation.value.single()
    assertEquals("Turn off the lights", entry.text)
    assertTrue(entry.isStreaming)
  }

  @Test
  fun realtimeTranscriptFragmentsInsertSpacingAfterPunctuation() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "Ready."))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "What next?"))

    val entry = manager.conversation.value.single()
    assertEquals("Ready. What next?", entry.text)
    assertTrue(entry.isStreaming)
  }

  @Test
  fun realtimeFinalTranscriptCanCompleteDeltaText() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "The"))
    manager.handleGatewayEvent(
      "talk.event",
      realtimeTranscriptPayload(role = "assistant", text = " answer", final = true),
    )

    val entry = manager.conversation.value.single()
    assertEquals("The answer", entry.text)
    assertFalse(entry.isStreaming)
  }

  @Test
  fun realtimeAssistantOutputSeparatesNextUserBubble() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "First request"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "Checking"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Second request"))

    val entries = manager.conversation.value
    assertEquals(3, entries.size)
    assertEquals(VoiceConversationRole.User, entries[0].role)
    assertEquals("First request", entries[0].text)
    assertFalse(entries[0].isStreaming)
    assertEquals(VoiceConversationRole.Assistant, entries[1].role)
    assertEquals("Checking", entries[1].text)
    assertFalse(entries[1].isStreaming)
    assertEquals(VoiceConversationRole.User, entries[2].role)
    assertEquals("Second request", entries[2].text)
    assertTrue(entries[2].isStreaming)
  }

  @Test
  fun realtimeUserTranscriptRewriteStaysInSameBubble() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Can you tack"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Can you check?", final = true))

    val entry = manager.conversation.value.single()
    assertEquals(VoiceConversationRole.User, entry.role)
    assertEquals("Can you check?", entry.text)
    assertFalse(entry.isStreaming)
  }

  @Test
  fun realtimeLateFinalUserTranscriptRewritesBubbleAfterAssistantStarts() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Can you tack"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "Checking"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Can you check?", final = true))

    val entries = manager.conversation.value
    assertEquals(2, entries.size)
    assertEquals(VoiceConversationRole.User, entries[0].role)
    assertEquals("Can you check?", entries[0].text)
    assertFalse(entries[0].isStreaming)
    assertEquals(VoiceConversationRole.Assistant, entries[1].role)
    assertEquals("Checking", entries[1].text)
  }

  @Test
  fun realtimeFinalNextUserAfterAssistantStartsCreatesNewBubble() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "First request"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "assistant", text = "Checking"))
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Second request", final = true))

    val entries = manager.conversation.value
    assertEquals(3, entries.size)
    assertEquals(VoiceConversationRole.User, entries[0].role)
    assertEquals("First request", entries[0].text)
    assertEquals(VoiceConversationRole.Assistant, entries[1].role)
    assertEquals("Checking", entries[1].text)
    assertEquals(VoiceConversationRole.User, entries[2].role)
    assertEquals("Second request", entries[2].text)
    assertFalse(entries[2].isStreaming)
  }

  @Test
  fun realtimeAlternatingTurnsStayInSeparateBubbles() {
    val manager = createManager()

    setPrivateField(manager, "realtimeSessionId", "relay-1")

    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Hey, what time is it?", final = true))
    manager.handleGatewayEvent(
      "talk.event",
      realtimeTranscriptPayload(
        role = "assistant",
        text = "Let me look into that for you. It's currently 7:55 PM UTC.",
        final = true,
      ),
    )
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "How's it going?", final = true))
    manager.handleGatewayEvent(
      "talk.event",
      realtimeTranscriptPayload(
        role = "assistant",
        text = "Great! Ready for the next task. What can I do for you?",
        final = true,
      ),
    )
    manager.handleGatewayEvent("talk.event", realtimeTranscriptPayload(role = "user", text = "Turn on the basement lights", final = true))
    manager.handleGatewayEvent(
      "talk.event",
      realtimeTranscriptPayload(
        role = "assistant",
        text = "Got it, let me check on that.",
        final = true,
      ),
    )

    val entries = manager.conversation.value
    assertEquals(6, entries.size)
    assertEquals(VoiceConversationRole.User, entries[0].role)
    assertEquals("Hey, what time is it?", entries[0].text)
    assertEquals(VoiceConversationRole.Assistant, entries[1].role)
    assertEquals("Let me look into that for you. It's currently 7:55 PM UTC.", entries[1].text)
    assertEquals(VoiceConversationRole.User, entries[2].role)
    assertEquals("How's it going?", entries[2].text)
    assertEquals(VoiceConversationRole.Assistant, entries[3].role)
    assertEquals("Great! Ready for the next task. What can I do for you?", entries[3].text)
    assertEquals(VoiceConversationRole.User, entries[4].role)
    assertEquals("Turn on the basement lights", entries[4].text)
    assertEquals(VoiceConversationRole.Assistant, entries[5].role)
    assertEquals("Got it, let me check on that.", entries[5].text)
    assertTrue(entries.none { it.isStreaming })
  }

  @Test
  fun e2eRealtimeTurnUsesRelayTranscriptPath() =
    runTest {
      val manager = createManager(scope = this)

      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.runE2eRealtimeTurn(
        userText = "voice e2e user",
        assistantText = "voice e2e assistant",
        timeoutMs = 1_000L,
      )

      val entries = manager.conversation.value
      assertEquals(2, entries.size)
      assertEquals(VoiceConversationRole.User, entries[0].role)
      assertEquals("voice e2e user", entries[0].text)
      assertEquals(VoiceConversationRole.Assistant, entries[1].role)
      assertEquals("voice e2e assistant", entries[1].text)
      assertTrue(entries.none { it.isStreaming })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun realtimeStartWithoutGatewayTurnsTalkOff() =
    runTest {
      val stoppedByRelay = AtomicBoolean(false)
      val manager =
        createManager(
          scope = this,
          isConnected = { false },
          onStoppedByRelay = { stoppedByRelay.set(true) },
        )

      setPrivateField(manager, "configLoaded", true)
      manager.setEnabled(true)
      advanceUntilIdle()

      assertFalse(manager.isEnabled.value)
      assertFalse(manager.isListening.value)
      assertEquals("Gateway not connected", manager.statusText.value)
      assertTrue(stoppedByRelay.get())
    }

  @Test
  fun staleRealtimeToolFinalDoesNotUseAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    setPrivateField(manager, "realtimeSessionId", "relay-2")
    realtimeToolRuns(manager)["run-tool"] =
      RealtimeToolRun(callId = "call-1", relaySessionId = "relay-1")

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-tool", text = "stale result"))

    assertEquals(0L, playbackGeneration(manager).get())
    assertTrue(realtimeToolRuns(manager).isEmpty())
  }

  @Test
  fun textReadyDoesNotEnterSpeakingUntilAudioPlaybackStarts() =
    runTest {
      val talkSpeakClient = FakeTalkSpeechSynthesizer()
      val talkAudioPlayer = FakeTalkAudioPlayer()
      val manager = createManager(talkSpeakClient = talkSpeakClient, talkAudioPlayer = talkAudioPlayer)

      val job = launch { manager.speakAssistantReply("hello") }
      talkSpeakClient.requested.await()

      assertEquals("Generating voice…", manager.statusText.value)
      assertFalse(manager.isSpeaking.value)

      talkSpeakClient.result.complete(
        TalkSpeakResult.Success(
          TalkSpeakAudio(
            bytes = byteArrayOf(1, 2, 3),
            provider = "test",
            outputFormat = "mp3_44100_128",
            voiceCompatible = true,
            mimeType = "audio/mpeg",
            fileExtension = ".mp3",
          ),
        ),
      )
      talkAudioPlayer.started.await()

      assertEquals("Speaking…", manager.statusText.value)
      assertTrue(manager.isSpeaking.value)

      talkAudioPlayer.finished.complete(Unit)
      job.join()
    }

  @Test
  fun realtimeAudioFramesStreamUntilPlaybackStarts() {
    val manager = createManager()

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 0))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 16))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 4_800))

    setPrivateField(manager, "realtimePlaybackEndsAtMs", SystemClock.elapsedRealtime() + 1_000)

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 4_800))

    setPrivateField(manager, "realtimePlaybackEndsAtMs", SystemClock.elapsedRealtime() - 1)

    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 4_800))
  }

  @Test
  fun pushToTalkPauseWaitsForRealtimeCaptureJobs() =
    runTest {
      val manager = createManager()
      val captureJob = Job()
      val appendJob = Job()
      setPrivateField(manager, "realtimeCaptureJob", captureJob)
      setPrivateField(manager, "realtimeAppendJob", appendJob)
      setMutableStateFlow(manager, "_isEnabled", true)

      manager.pauseRealtimeCaptureForPushToTalk("capture-1")

      assertTrue(captureJob.isCancelled)
      assertTrue(appendJob.isCancelled)
      assertNull(readPrivateField(manager, "realtimeCaptureJob"))
      assertNull(readPrivateField(manager, "realtimeAppendJob"))
      assertTrue(readPrivateField(manager, "realtimeCapturePause") != null)
    }

  @Test
  fun unconfirmedOutputCancellationClosesRealtimeRelay() =
    runTest {
      var stoppedByRelay = false
      val manager =
        createManager(
          scope = this,
          onStoppedByRelay = { stoppedByRelay = true },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setMutableStateFlow(manager, "_isEnabled", true)

      manager.pauseRealtimeCaptureForPushToTalk("capture-1")

      assertNull(readPrivateField(manager, "realtimeSessionId"))
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      assertEquals("capture-1", readPrivateField(pause, "pttCaptureId"))
      assertTrue(readPrivateField(pause, "restartRelay") as Boolean)
      assertTrue(manager.isEnabled.value)
      assertFalse(stoppedByRelay)
    }

  @Test
  fun stalePushToTalkCompletionCannotResumeNewerPause() =
    runTest {
      val manager = createManager()
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-new")
      setPrivateField(manager, "activePttCaptureId", "capture-new")

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-old")

      assertTrue(readPrivateField(manager, "realtimeCapturePause") != null)
      assertEquals("capture-new", readPrivateField(manager, "activePttCaptureId"))
    }

  @Test
  fun pushToTalkPauseOutlivesRecognitionWhileRelayConnects() =
    runTest {
      val manager = createManager()

      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      setPrivateField(manager, "activePttCaptureId", null)

      val pause = readPrivateField(manager, "realtimeCapturePause")
      assertTrue(pause != null)
      assertNull(readPrivateField(pause!!, "sessionId"))
      assertEquals("capture-1", readPrivateField(pause, "pttCaptureId"))

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertNull(readPrivateField(manager, "realtimeCapturePause"))
    }

  @Test
  fun resumingRealtimeCaptureRestoresListeningState() =
    runTest {
      val manager =
        createManager(
          scope = this,
          realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setMutableStateFlow(manager, "_isListening", false)
      setMutableStateFlow(manager, "_statusText", nativeText("Thinking…"))

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertTrue(manager.isListening.value)
      assertEquals("Listening", manager.statusText.value)
      assertTrue(readPrivateField(manager, "realtimeOutputSuppressed") as Boolean)

      manager.handleGatewayEvent(
        "talk.event",
        """{"relaySessionId":"relay-1","type":"transcript","role":"user","text":"stale","final":true}""",
      )

      assertTrue(readPrivateField(manager, "realtimeOutputSuppressed") as Boolean)

      manager.handleGatewayEvent(
        "talk.event",
        """{"relaySessionId":"relay-1","type":"inputAudio","byteLength":4800}""",
      )

      assertFalse(readPrivateField(manager, "realtimeOutputSuppressed") as Boolean)
      manager.stopAllCapture()
    }

  @Test
  fun replacementRelayPublishedDuringPushToTalkResumesCapture() =
    runTest {
      val manager =
        createManager(
          scope = this,
          realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-replacement")
      setPrivateField(pause, "restartRelay", true)
      setPrivateField(manager, "realtimeSessionId", "relay-replacement")

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertNull(readPrivateField(manager, "realtimeCapturePause"))
      assertTrue(manager.isListening.value)
      assertTrue((readPrivateField(manager, "realtimeCaptureJob") as Job).isActive)
      assertTrue((readPrivateField(manager, "realtimeAppendJob") as Job).isActive)
      manager.stopAllCapture()
    }

  @Test
  fun stoppedTalkModeDoesNotRestartRelayAfterPushToTalk() =
    runTest {
      val manager = createManager(scope = this)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "restartRelay", true)
      setPrivateField(manager, "stopRequested", true)
      setMutableStateFlow(manager, "_statusText", nativeText("Off"))

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertNull(readPrivateField(manager, "realtimeCapturePause"))
      assertNull(readPrivateField(manager, "realtimeSessionId"))
      assertFalse(manager.isEnabled.value)
      assertEquals("Off", manager.statusText.value)
    }

  @Test
  fun pausedPushToTalkTurnSuppressesSpeechInterruptListener() =
    runTest {
      val manager = createManager(scope = this)
      assertTrue(manager.shouldAllowSpeechInterrupt())

      manager.pauseRealtimeCaptureForPushToTalk("capture-1")

      assertFalse(manager.shouldAllowSpeechInterrupt())
      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")
      assertTrue(manager.shouldAllowSpeechInterrupt())
    }

  @Test
  fun finishingPushToTalkTurnRejectsReplacementCapture() =
    runTest {
      val manager = createManager(scope = this)
      setPrivateField(manager, "finishingPttCaptureId", "capture-1")

      val error =
        runCatching { manager.beginPushToTalk(allowNewCapture = true) }
          .exceptionOrNull()
      val oneShot = manager.beginPushToTalkOnce()

      assertEquals("PTT_BUSY: previous push-to-talk turn is still finishing", error?.message)
      assertTrue(oneShot is TalkPttOnceStart.Busy)
      assertEquals("capture-1", (oneShot as TalkPttOnceStart.Busy).payload.captureId)
    }

  @Test
  fun relayClosePreservesFinishingPushToTalkOwnership() =
    runTest {
      val manager = createManager(scope = this)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "finishingPttCaptureId", "capture-1")

      manager.handleGatewayEvent(
        "talk.event",
        """{"relaySessionId":"relay-1","type":"close","reason":"completed"}""",
      )

      assertNull(readPrivateField(manager, "realtimeCapturePause"))
      assertEquals("capture-1", manager.finishingPushToTalkCaptureId)
    }

  @Test
  fun disconnectedRelayDoesNotResumeAfterPushToTalk() =
    runTest {
      var stoppedByRelay = false
      val manager =
        createManager(
          scope = this,
          isConnected = { false },
          onStoppedByRelay = { stoppedByRelay = true },
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setMutableStateFlow(manager, "_isListening", false)
      setMutableStateFlow(manager, "_statusText", nativeText("Gateway not connected"))

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertFalse(manager.isListening.value)
      assertFalse(manager.isEnabled.value)
      assertTrue(stoppedByRelay)
      assertEquals("Gateway not connected", manager.statusText.value)
      assertNull(readPrivateField(manager, "realtimeSessionId"))
      assertNull(readPrivateField(manager, "realtimeCaptureJob"))
      assertNull(readPrivateField(manager, "realtimeAppendJob"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun chatFinalWaitUsesGatewayEventTimeout() =
    runTest {
      val manager = createManager(scope = this)

      setPrivateField(manager, "pendingRunId", "run-missing-final")
      setPrivateField(manager, "pendingFinal", CompletableDeferred<Boolean>())

      assertFalse(manager.waitForChatFinal("run-missing-final"))
      assertEquals(45_000, currentTime)
    }

  private fun createManager(
    talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(),
    talkAudioPlayer: TalkAudioPlaying? = null,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    isConnected: () -> Boolean = { true },
    onStoppedByRelay: () -> Unit = {},
    realtimeCaptureDispatcher: CoroutineDispatcher = Dispatchers.IO,
    realtimePlaybackDispatcher: CoroutineDispatcher = Dispatchers.IO,
    realtimeMarkAcknowledger: (suspend (String, String) -> Unit)? = null,
  ): TalkModeManager {
    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = DeviceIdentityStore(app),
        deviceAuthStore = InMemoryDeviceAuthStore(),
        onConnected = {},
        onDisconnected = {},
        onEvent = { _, _ -> },
      )
    return TalkModeManager(
      context = app,
      scope = scope,
      session = session,
      isConnected = isConnected,
      onStoppedByRelay = onStoppedByRelay,
      talkSpeakClient = talkSpeakClient,
      talkAudioPlayer = talkAudioPlayer ?: TalkAudioPlayer(app),
      realtimeCaptureDispatcher = realtimeCaptureDispatcher,
      realtimePlaybackDispatcher = realtimePlaybackDispatcher,
      realtimeMarkAcknowledger = realtimeMarkAcknowledger,
    )
  }

  @Suppress("UNCHECKED_CAST")
  private fun playbackGeneration(manager: TalkModeManager) = readPrivateField(manager, "playbackGeneration") as AtomicLong

  @Suppress("UNCHECKED_CAST")
  private fun realtimeToolRuns(manager: TalkModeManager) = readPrivateField(manager, "realtimeToolRuns") as MutableMap<String, RealtimeToolRun>

  @Suppress("UNCHECKED_CAST")
  private fun pendingRealtimeToolCalls(manager: TalkModeManager) = readPrivateField(manager, "pendingRealtimeToolCalls") as MutableSet<String>

  @Suppress("UNCHECKED_CAST")
  private fun pendingRealtimeToolCompletions(manager: TalkModeManager) = readPrivateField(manager, "pendingRealtimeToolCompletions") as MutableMap<String, Any>

  private fun setPrivateField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    field.set(target, value)
  }

  private fun readPrivateField(
    target: Any,
    name: String,
  ): Any? {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    return field.get(target)
  }

  private fun setTalkFailure(
    manager: TalkModeManager,
    text: NativeText,
  ) {
    val method = manager.javaClass.getDeclaredMethod("setTalkFailure", NativeText::class.java)
    method.isAccessible = true
    method.invoke(manager, text)
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> setMutableStateFlow(
    target: Any,
    name: String,
    value: T,
  ) {
    (readPrivateField(target, name) as MutableStateFlow<T>).value = value
  }

  private fun shouldAppendRealtimeCapturedFrame(
    manager: TalkModeManager,
    length: Int,
  ): Boolean {
    val method =
      manager.javaClass.getDeclaredMethod(
        "shouldAppendRealtimeCapturedFrame",
        Int::class.javaPrimitiveType,
      )
    method.isAccessible = true
    return method.invoke(manager, length) as Boolean
  }

  private fun chatFinalPayload(
    runId: String,
    text: String,
    role: String = "assistant",
  ): String =
    """
    {
      "runId": "$runId",
      "sessionKey": "main",
      "state": "final",
      "message": {
        "role": "$role",
        "content": [
          { "type": "text", "text": "$text" }
        ]
      }
    }
    """.trimIndent()

  private fun realtimeTranscriptPayload(
    role: String,
    text: String,
    final: Boolean = false,
  ): String =
    """
    {
      "relaySessionId": "relay-1",
      "type": "transcript",
      "role": "$role",
      "text": "$text",
      "final": $final
    }
    """.trimIndent()
}

private class FakeTalkSpeechSynthesizer : TalkSpeechSynthesizing {
  val requested = CompletableDeferred<Unit>()
  val result = CompletableDeferred<TalkSpeakResult>()

  override suspend fun synthesize(
    text: String,
    directive: TalkDirective?,
  ): TalkSpeakResult {
    requested.complete(Unit)
    return result.await()
  }
}

private class FakeTalkAudioPlayer : TalkAudioPlaying {
  val started = CompletableDeferred<Unit>()
  val finished = CompletableDeferred<Unit>()
  var stopped = false

  override suspend fun play(audio: TalkSpeakAudio) {
    started.complete(Unit)
    finished.await()
  }

  override fun stop() {
    stopped = true
  }
}

private class InMemoryDeviceAuthStore : DeviceAuthTokenStore {
  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) = Unit

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ) = Unit
}
