package ai.openclaw.app.voice

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.testDeviceIdentityStore
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import android.Manifest
import android.content.ComponentName
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioTrack
import android.os.Bundle
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
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
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TalkModeManagerTest {
  // realtimeAudioWriterJob (playout owner) and its idle-poll ticker are
  // intentionally infinite for TalkModeManager's real lifetime, unlike every
  // other coroutine this class launches (which complete naturally and so
  // stay properly tracked by runTest/advanceUntilIdle on scope = this, realtimePlaybackOwnerScope = backgroundScope).
  // Every createManager() call registers here so this teardown can cancel
  // just those two jobs after each test, without changing scope for
  // anything else — using TestScope.backgroundScope for the whole manager
  // instead was tried and rejected: it also silently exempts gatewayWorkScope
  // (built from the same scope's CoroutineContext) from advanceUntilIdle()
  // draining, which broke unrelated pre-existing tests.
  private val createdManagers = mutableListOf<TalkModeManager>()

  @After
  fun cancelRealtimePlaybackOwners() {
    for (manager in createdManagers) {
      runCatching { cancelRealtimeAudioWriterJob(manager) }
    }
    createdManagers.clear()
  }

  @Test
  fun phoneRealtimeRetriesWithoutLanguageWhenOlderGatewayRejectsCreateParams() =
    runTest {
      val requestedLanguages = mutableListOf<String?>()

      val payload =
        requestPhoneRealtimeSessionWithLanguageFallback("de") { language ->
          requestedLanguages += language
          if (requestedLanguages.size == 1) {
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "invalid talk.session.create params at root",
              ),
            )
          }
          """{"relaySessionId":"relay-1"}"""
        }

      assertEquals("""{"relaySessionId":"relay-1"}""", payload)
      assertEquals(listOf("de", null), requestedLanguages)
    }

  @Test
  fun phoneRealtimeDoesNotRetryUnrelatedGatewayErrors() =
    runTest {
      var attempts = 0

      val error =
        runCatching {
          requestPhoneRealtimeSessionWithLanguageFallback("de") {
            attempts += 1
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "invalid talk.session.appendAudio params",
              ),
            )
          }
        }.exceptionOrNull()

      assertTrue(error is GatewayRequestRejected)
      assertEquals(1, attempts)
    }

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
  fun beginPushToTalkRejectsInvalidatedCaptureBeforeStarting() =
    runTest {
      installSpeechRecognitionService()
      val manager = createManager()
      withMain {
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
  fun staleCancellationDoesNotStopNewerPushToTalkCapture() =
    runTest {
      val manager = createManager()
      val completion = CompletableDeferred<TalkPttStopPayload>()
      setPrivateField(manager, "activePttCaptureId", "capture-new")
      setPrivateField(manager, "pttCompletion", completion)
      withMain {
        val payload = manager.cancelPushToTalk("capture-old")

        assertEquals("idle", payload.status)
        assertEquals("capture-new", readPrivateField(manager, "activePttCaptureId"))
        assertFalse(completion.isCompleted)
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
  fun cancelledOneShotWaitCleansItsCapture() =
    runTest {
      val manager = createManager()
      val completion = CompletableDeferred<TalkPttStopPayload>()
      setPrivateField(manager, "activePttCaptureId", "capture-1")
      setPrivateField(manager, "pttCompletion", completion)
      setMutableStateFlow(manager, "_isListening", true)
      val start = TalkPttOnceStart.Started(captureId = "capture-1", completion = completion)
      withMain {
        val wait = launch { manager.awaitPushToTalkOnce(start) }
        advanceUntilIdle()
        wait.cancel()
        runCurrent()
        wait.join()

        assertNull(readPrivateField(manager, "activePttCaptureId"))
        assertNull(readPrivateField(manager, "pttCompletion"))
        assertFalse(manager.isListening.value)
        assertTrue(completion.isCompleted)
      }
    }

  @Test
  fun staleStopDoesNotSubmitNewerPushToTalkCapture() =
    runTest {
      val manager = createManager()
      val completion = CompletableDeferred<TalkPttStopPayload>()
      setPrivateField(manager, "activePttCaptureId", "capture-new")
      setPrivateField(manager, "pttCompletion", completion)
      setPrivateField(manager, "lastTranscript", "new partial transcript")
      withMain {
        val payload = manager.endPushToTalk("capture-old")

        assertEquals("idle", payload.status)
        assertEquals("capture-new", readPrivateField(manager, "activePttCaptureId"))
        assertEquals("new partial transcript", readPrivateField(manager, "lastTranscript"))
        assertFalse(completion.isCompleted)
      }
    }

  @Test
  fun segmentDuringPushToTalkReleaseWaitsForEndOfSegmentedSession() {
    val manager = createManager()
    val releaseCompletion = CompletableDeferred<Unit>()
    setPrivateField(manager, "activePttCaptureId", "capture-1")
    setPrivateField(manager, "pttReleaseCompletion", releaseCompletion)
    val listener = recognitionListener(manager, "capture-1")
    val segment =
      Bundle().apply {
        putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf("first segment"))
      }

    listener.onSegmentResults(segment)

    assertFalse(releaseCompletion.isCompleted)
    assertEquals(listOf("first segment"), readPrivateField(manager, "pttFinalSegments"))

    listener.onEndOfSegmentedSession()

    assertTrue(releaseCompletion.isCompleted)
  }

  @Test
  fun releaseKeepsWaitingPastOldGraceForLateTerminalSegment() =
    runTest {
      val manager = createManager(isConnected = { false })
      val releaseCompletion = CompletableDeferred<Unit>()
      setPrivateField(manager, "activePttCaptureId", "capture-1")
      setPrivateField(manager, "pttReleaseCompletion", releaseCompletion)
      setPrivateField(manager, "pttRecognitionRung", silenceSegmentedRung())
      @Suppress("UNCHECKED_CAST")
      (readPrivateField(manager, "pttFinalSegments") as MutableList<String>) += "early segment"
      val listener = recognitionListener(manager, "capture-1")
      withMain {
        val ending = async { manager.endPushToTalk("capture-1") }
        runCurrent()

        advanceTimeBy(1_200)
        listener.onSegmentResults(
          Bundle().apply {
            putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf("late segment"))
          },
        )
        assertFalse(ending.isCompleted)

        listener.onEndOfSegmentedSession()
        advanceUntilIdle()

        assertEquals("early segment. late segment", ending.await().transcript)
      }
    }

  @Test
  fun cancelledEndPushToTalkClearsPendingReleaseBeforeNextBegin() =
    runTest {
      installSpeechRecognitionService()
      val manager = createManager()
      setPrivateField(manager, "activePttCaptureId", "capture-a")
      setPrivateField(manager, "pttReleaseCompletion", CompletableDeferred<Unit>())
      setPrivateField(manager, "pttRecognitionRung", silenceSegmentedRung())
      @Suppress("UNCHECKED_CAST")
      (readPrivateField(manager, "pttFinalSegments") as MutableList<String>) += "capture a"
      withMain(cleanup = manager::stopAllCapture) {
        val ending = async { manager.endPushToTalk("capture-a") }
        runCurrent()
        ending.cancel()
        runCurrent()
        ending.join()

        assertTrue(ending.isCancelled)
        assertNull(readPrivateField(manager, "activePttCaptureId"))
        assertNull(readPrivateField(manager, "pttReleaseCompletion"))
        assertEquals(emptyList<String>(), readPrivateField(manager, "pttFinalSegments"))

        val started = manager.beginPushToTalk(allowNewCapture = true)

        assertEquals(started.captureId, readPrivateField(manager, "activePttCaptureId"))
        assertEquals(emptyList<String>(), readPrivateField(manager, "pttFinalSegments"))
      }
    }

  @Test
  fun replacementBeginDrainsPendingReleaseBeforeStartingNewCapture() =
    runTest {
      installSpeechRecognitionService()
      var connectionChecks = 0
      val manager =
        createManager(
          isConnected = {
            connectionChecks += 1
            connectionChecks != 2
          },
        )
      val releaseCompletion = CompletableDeferred<Unit>()
      setPrivateField(manager, "activePttCaptureId", "capture-a")
      setPrivateField(manager, "pttReleaseCompletion", releaseCompletion)
      setPrivateField(manager, "pttRecognitionRung", silenceSegmentedRung())
      @Suppress("UNCHECKED_CAST")
      (readPrivateField(manager, "pttFinalSegments") as MutableList<String>) += "first segment"
      withMain(cleanup = manager::stopAllCapture) {
        val ending = async { manager.endPushToTalk("capture-a") }
        runCurrent()
        val starting = async { manager.beginPushToTalk(allowNewCapture = true) }
        runCurrent()

        releaseCompletion.complete(Unit)
        advanceUntilIdle()

        val ended = ending.await()
        val started = starting.await()
        assertEquals("offline", ended.status)
        assertEquals("first segment", ended.transcript)
        assertEquals(started.captureId, readPrivateField(manager, "activePttCaptureId"))
        assertEquals(emptyList<String>(), readPrivateField(manager, "pttFinalSegments"))
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
  fun realtimeCloseErrorDisablesTalkButKeepsFailureStatus() {
    var stoppedByRelay = false
    val manager = createManager(onStoppedByRelay = { stoppedByRelay = true })

    setPrivateField(manager, "realtimeSessionId", "relay-1")
    setMutableStateFlow(manager, "_isEnabled", true)

    manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"close","reason":"error"}""")

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

    manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"close","reason":"error"}""")

    assertEquals("Échec de Talk : session refusée.", manager.statusText.value)
  }

  @Test
  fun localizedOffStatusDoesNotBecomeRealtimeStartFailure() =
    runTest {
      val manager = createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope)
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
  fun realtimePlaybackMarkAcknowledgesAfterQueuedAudioBarrier() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimePlaybackDispatcher = StandardTestDispatcher(testScheduler),
          realtimeMarkAcknowledger = { sessionId, markName ->
            acknowledgements += sessionId to markName
          },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()

      assertEquals(listOf("relay-1" to "audio-1"), acknowledgements)
    }

  @Test
  fun realtimeTranscriptsPopulateVoiceConversation() {
    val manager = createRealtimeManager()

    manager.transcript("user", "hello")
    manager.transcript("user", "hello world", final = true)
    manager.transcript("assistant", "hi")
    manager.transcript("assistant", "hi there", final = true)

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
    val manager = createRealtimeManager()

    assertFalse(manager.speechActive.value)
    manager.transcript("user", "hello")
    assertTrue(manager.speechActive.value)
    manager.transcript("user", "hello world", final = true)
    assertFalse(manager.speechActive.value)
  }

  @Test
  fun finalUserTranscriptMarksAwaitingAgentUntilStatusMovesOn() {
    val manager = createRealtimeManager()

    assertFalse(manager.awaitingAgent.value)
    manager.transcript("user", "hello", final = true)
    assertTrue(manager.awaitingAgent.value)
    // Any later status transition clears the typed flag; forgetting it at a
    // new setStatus site fails safe instead of showing a stale Thinking wave.
    manager.transcript("assistant", "hi there", final = true)
    manager.stopAllCapture()
    assertFalse(manager.awaitingAgent.value)
  }

  @Test
  fun realtimeTranscriptDeltasAccumulateVoiceConversation() {
    val manager = createRealtimeManager()

    manager.transcript("assistant", "The")
    manager.transcript("assistant", " answer")

    val entry = manager.conversation.value.single()
    assertEquals("The answer", entry.text)
    assertTrue(entry.isStreaming)
  }

  @Test
  fun realtimeTranscriptFragmentsInsertWordSpacing() {
    val manager = createRealtimeManager()

    manager.transcript("user", "Turn off")
    manager.transcript("user", "the lights")

    val entry = manager.conversation.value.single()
    assertEquals("Turn off the lights", entry.text)
    assertTrue(entry.isStreaming)
  }

  @Test
  fun realtimeTranscriptFragmentsInsertSpacingAfterPunctuation() {
    val manager = createRealtimeManager()

    manager.transcript("assistant", "Ready.")
    manager.transcript("assistant", "What next?")

    val entry = manager.conversation.value.single()
    assertEquals("Ready. What next?", entry.text)
    assertTrue(entry.isStreaming)
  }

  @Test
  fun realtimeFinalTranscriptCanCompleteDeltaText() {
    val manager = createRealtimeManager()

    manager.transcript("assistant", "The")
    manager.transcript("assistant", " answer", final = true)

    val entry = manager.conversation.value.single()
    assertEquals("The answer", entry.text)
    assertFalse(entry.isStreaming)
  }

  @Test
  fun realtimeAssistantOutputSeparatesNextUserBubble() {
    val manager = createRealtimeManager()

    manager.transcript("user", "First request")
    manager.transcript("assistant", "Checking")
    manager.transcript("user", "Second request")

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
    val manager = createRealtimeManager()

    manager.transcript("user", "Can you tack")
    manager.transcript("user", "Can you check?", final = true)

    val entry = manager.conversation.value.single()
    assertEquals(VoiceConversationRole.User, entry.role)
    assertEquals("Can you check?", entry.text)
    assertFalse(entry.isStreaming)
  }

  @Test
  fun realtimeLateFinalUserTranscriptRewritesBubbleAfterAssistantStarts() {
    val manager = createRealtimeManager()

    manager.transcript("user", "Can you tack")
    manager.transcript("assistant", "Checking")
    manager.transcript("user", "Can you check?", final = true)

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
    val manager = createRealtimeManager()

    manager.transcript("user", "First request")
    manager.transcript("assistant", "Checking")
    manager.transcript("user", "Second request", final = true)

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
    val manager = createRealtimeManager()

    manager.transcript("user", "Hey, what time is it?", final = true)
    manager.transcript("assistant", "Let me look into that for you. It's currently 7:55 PM UTC.", final = true)
    manager.transcript("user", "How's it going?", final = true)
    manager.transcript("assistant", "Great! Ready for the next task. What can I do for you?", final = true)
    manager.transcript("user", "Turn on the basement lights", final = true)
    manager.transcript("assistant", "Got it, let me check on that.", final = true)

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
      val manager = createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope)

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
  fun realtimeStartWithoutGatewayTurnsTalkOff() =
    runTest {
      val stoppedByRelay = AtomicBoolean(false)
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
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
  fun browserOnlyRealtimeConfigStartsNativeTalkInsteadOfRelay() =
    runTest {
      installSpeechRecognitionService()
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
        )
      withMain(cleanup = { manager.setEnabled(false) }) {
        setPrivateField(manager, "configLoaded", true)
        setPrivateField(manager, "realtimeRelayModelSupported", false)
        manager.setEnabled(true)
        advanceUntilIdle()

        assertTrue(manager.isEnabled.value)
        assertTrue(manager.isListening.value)
        assertNull(readPrivateField(manager, "realtimeSessionId"))
        assertEquals("Listening", manager.statusText.value)
      }
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
  fun aecEnabledCommunicationCaptureForwardsThroughPlayback() {
    val manager = createManager()
    setPrivateField(manager, "realtimePlaybackEndsAtMs", SystemClock.elapsedRealtime() + 1_000)

    setPrivateField(manager, "realtimeAecEnabled", true)
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 4_800))

    // AEC unavailable/disabled is the safe fallback: playback-time suppression returns.
    setPrivateField(manager, "realtimeAecEnabled", false)
    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 4_800))
  }

  @Test
  fun realtimePlaybackUsesVoiceCommunicationAudioAttributes() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, byteArrayOf(1, 2, 3, 4))
      runCurrent()
      val track = readPrivateField(manager, "realtimeAudioTrack") as AudioTrack

      assertEquals(AudioAttributes.USAGE_VOICE_COMMUNICATION, track.audioAttributes.usage)
      assertEquals(AudioAttributes.CONTENT_TYPE_SPEECH, track.audioAttributes.contentType)
      cancelRealtimeAudioWriterJob(manager)
    }

  // --- Root-cause regression suite for the Gateway receive head-of-line
  // blocking fix. The prior design (c8d45) held realtimePlaybackLock across
  // one bounded-but-still-blocking AudioTrack.write() chunk; physical retest
  // showed contention still ran 767-850ms because AudioTrack hardware
  // backpressure itself, not chunk size, is what stalled the lock holder.
  // This design removes the shared lock and blocking write entirely: the
  // Gateway message pump only ever enqueues commands (trySend, never
  // suspends, never touches AudioTrack), and a single playout owner
  // coroutine processes them with WRITE_NON_BLOCKING, retrying zero-accept
  // writes via delay() instead of blocking.
  //
  // These tests drive that owner coroutine deterministically via
  // StandardTestDispatcher, using runCurrent()/bounded advanceTimeBy() rather
  // than advanceUntilIdle(). The owner's idle-poll ticker compares
  // SystemClock.elapsedRealtime() (a real/Robolectric-shadow clock) against a
  // deadline computed the same way; that clock does not advance in lockstep
  // with the coroutine test scheduler's virtual time, so it never naturally
  // crosses the deadline under advanceUntilIdle() alone, which would keep
  // rearming the ticker forever. Staying below one full
  // realtimePlaybackIdlePollMs tick avoids ever exercising that mismatch.
  // Because every retry path suspends on delay() (never a tight spin), each
  // step below is still fully deterministic. scope = this, realtimePlaybackOwnerScope = backgroundScope (not
  // backgroundScope) is required so runCurrent()/advanceTimeBy() actually
  // dispatch the owner; each test cancels it at the end since it is
  // intentionally infinite for TalkModeManager's real lifetime. ---

  @Test
  fun gatewayIngressNeverSuspendsRegardlessOfPlayoutOwnerState() =
    runTest {
      // No runCurrent/advanceTimeBy call anywhere in this test: the playout
      // owner never actually runs. Every ingress call below is a trySend and
      // must still return immediately without consuming any virtual time —
      // proof that the Gateway message pump cannot be made to wait on the
      // playout owner or any playback-owned monitor.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }
      val startTime = testScheduler.currentTime

      repeat(50) { playRealtimeAudio(manager, ByteArray(960)) }
      queueRealtimePlaybackMark(manager, "relay-1", "mark-1")
      requestRealtimePlaybackClear(manager)
      stopRealtimePlayback(manager)

      assertEquals(startTime, testScheduler.currentTime)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun partialWritesAccumulateCorrectTotalsAndMarkTarget() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      // First two write() calls only accept 320 of what's offered; the third
      // (fallback) accepts the rest — exercises the partial-write accounting
      // path without assuming a whole frame is written in one call. Neither
      // partial result is 0, so no delay() retry is involved.
      val writer = ScriptedRealtimeAudioTrackWriter(scripted = listOf(320, 320))
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }
      val bytes = ByteArray(960) { (it % 128).toByte() }

      playRealtimeAudio(manager, bytes)
      queueRealtimePlaybackMark(manager, "relay-1", "mark-1")
      runCurrent()

      assertEquals(listOf(0, 320, 640), writer.calls.map { it[0] })
      assertEquals((bytes.size / 2).toLong(), readPrivateField(manager, "realtimeWrittenFrames") as Long)
      assertTrue(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun zeroWriteRetriesWithBoundedDelayInsteadOfBusySpinning() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      // Buffer momentarily full for 3 attempts, then accepts the rest.
      val writer = ScriptedRealtimeAudioTrackWriter(scripted = listOf(0, 0, 0))
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      // Runs only what's schedulable at the CURRENT virtual time, without
      // advancing it. A busy-spinning retry loop has no suspension point, so
      // it would run every retry synchronously right here; the real
      // (delay()-based) implementation instead suspends after exactly one
      // write attempt, leaving the rest for later virtual-time ticks.
      runCurrent()
      assertEquals(1, writer.calls.size)

      // Exactly enough virtual time for the 3 scripted retries
      // (realtimePlaybackWriteRetryDelayMs each), and comfortably under one
      // realtimePlaybackIdlePollMs tick so the idle-poll ticker (armed only
      // after the 4th, successful write) never actually fires here.
      advanceTimeBy(3 * REALTIME_PLAYBACK_WRITE_RETRY_DELAY_MS)
      runCurrent()
      assertEquals(4, writer.calls.size)
      assertTrue(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun permanentlyStalledWriteGivesUpAndRetiresTheTrackInsteadOfSpinningForever() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      // Never drains. A non-blocking write returning 0 usually means "buffer
      // full, retry", but on some devices the OS stops draining a track for
      // good; the single playout owner must not be wedged by that.
      val writer = ScriptedRealtimeAudioTrackWriter().apply { stalled = true }
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      // Comfortably past realtimePlaybackBufferMs + this frame's own duration.
      advanceTimeBy(2_000)
      runCurrent()
      val callsAfterGivingUp = writer.calls.size

      advanceTimeBy(2_000)
      runCurrent()

      // Bounded: it stopped calling write, retired the dead track, and left no
      // stale speaking state behind (which would keep the mic suppressed on the
      // half-duplex fallback path for the rest of the session).
      assertEquals(callsAfterGivingUp, writer.calls.size)
      assertNull(readPrivateField(manager, "realtimeAudioTrack"))
      assertFalse(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun negativeWriteResultRetiresTheTrackInsteadOfLeavingItInstalled() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      // ERROR_DEAD_OBJECT is terminal for this handle: keeping it installed
      // would make every later Audio command fail the same way in silence.
      val writer = ScriptedRealtimeAudioTrackWriter(scripted = listOf(AudioTrack.ERROR_DEAD_OBJECT))
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      runCurrent()

      assertNull(readPrivateField(manager, "realtimeAudioTrack"))
      assertFalse(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun clearPreemptsInProgressWriteAndDoesNotResumeStaleAudio() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      // Accepts 320 bytes, then stalls (0) until told otherwise.
      val writer = ScriptedRealtimeAudioTrackWriter(scripted = listOf(320)).apply { stalled = true }
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      runCurrent() // owner accepts 320 bytes, then a zero-write, and suspends in delay()
      assertEquals(2, writer.calls.size)

      // Bumps the epoch immediately (no AudioTrack touch); the owner's next
      // retry check (after its current delay() resolves) must see it and
      // discard the remaining 640 bytes of this frame rather than resuming.
      requestRealtimePlaybackClear(manager)
      advanceTimeBy(REALTIME_PLAYBACK_WRITE_RETRY_DELAY_MS)
      runCurrent()

      assertEquals(2, writer.calls.size)
      assertNull(readPrivateField(manager, "realtimeAudioTrack"))
      assertFalse(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun ownerSideStopClearsSpeakingStateSetAfterTheSynchronousStop() =
    runTest {
      // An Audio command that passed its epoch check just before a stop can set
      // _isSpeaking after stopRealtimePlayback() already cleared it on the
      // Gateway thread. The owner is sequential, so its own Stop handling has to
      // be what leaves the state clean; a stuck _isSpeaking keeps
      // isRealtimePlaybackActive() true and suppresses the mic on the
      // half-duplex path. Setting the flag directly here stands in for that
      // interleaving, which a single test dispatcher cannot produce.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ScriptedRealtimeAudioTrackWriter()
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      runCurrent()
      stopRealtimePlayback(manager)
      setMutableStateFlow(manager, "_isSpeaking", true)
      runCurrent()

      assertFalse(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun playbackStopKeepsPendingMarksForTheProviderClearThatFollowsIt() =
    runTest {
      // PTT pause and stopTts stop playback and then ask the relay to cancel the
      // turn; the provider's own "clear" arrives afterwards and is what
      // acknowledges the marks. Discarding them on the stop would leave the
      // cancelled turn unacknowledged forever.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ScriptedRealtimeAudioTrackWriter()
      val acknowledged = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimePlaybackDispatcher = dispatcher,
          realtimeAudioTrackWriter = writer,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledged += sessionId to markName },
        ).also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      queueRealtimePlaybackMark(manager, "relay-1", "cancelled-turn-mark")
      runCurrent()

      stopRealtimePlayback(manager)
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), acknowledged)

      requestRealtimePlaybackClear(manager)
      runCurrent()

      assertEquals(listOf("relay-1" to "cancelled-turn-mark"), acknowledged)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun clearAcknowledgesStillPendingMarkExactlyOnce() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      // ScriptedRealtimeAudioTrackWriter never calls the real AudioTrack.write,
      // so Robolectric's shadow playbackHeadPosition stays at 0 — the mark
      // set against realtimeWrittenFrames (> 0) never auto-completes via
      // PollIdle, keeping it genuinely pending until clear runs.
      val writer = ScriptedRealtimeAudioTrackWriter()
      val acknowledged = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimePlaybackDispatcher = dispatcher,
          realtimeAudioTrackWriter = writer,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledged += sessionId to markName },
        ).also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      queueRealtimePlaybackMark(manager, "relay-1", "old-mark")
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), acknowledged)

      requestRealtimePlaybackClear(manager)
      runCurrent()

      assertEquals(listOf("relay-1" to "old-mark"), acknowledged)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun markEnqueuedJustBeforeClearIsStillAcknowledgedNotLost() =
    runTest {
      // Regression for a race the epoch design can hit: the Gateway thread
      // can bump the epoch (via requestRealtimePlaybackClear) before the
      // owner ever dequeues a Mark command sent moments earlier on the same
      // thread. If Mark processing were epoch-gated, it would drop the mark
      // before either it or the following Clear ever acknowledged it.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val acknowledged = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimePlaybackDispatcher = dispatcher,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledged += sessionId to markName },
        ).also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      // Both enqueued before the owner coroutine gets a chance to run, so the
      // epoch bump from requestRealtimePlaybackClear lands before the owner
      // ever dequeues the Mark command sent just before it.
      queueRealtimePlaybackMark(manager, "relay-1", "raced-mark")
      requestRealtimePlaybackClear(manager)
      runCurrent()

      assertEquals(listOf("relay-1" to "raced-mark"), acknowledged)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun stopDuringInProgressAudioDoesNotLeakIntoNextSession() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ScriptedRealtimeAudioTrackWriter(scripted = listOf(320)).apply { stalled = true }
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      runCurrent() // old session: partial write in flight, then stalled

      val oldTrack = readPrivateField(manager, "realtimeAudioTrack")
      stopRealtimePlayback(manager)
      advanceTimeBy(REALTIME_PLAYBACK_WRITE_RETRY_DELAY_MS)
      runCurrent()
      assertNull(readPrivateField(manager, "realtimeAudioTrack"))
      assertFalse(manager.isSpeaking.value)

      // New session's audio must create a fresh track and play normally —
      // the old session's stalled write must not resume or leak state in.
      writer.stalled = false
      playRealtimeAudio(manager, ByteArray(960))
      runCurrent()

      val newTrack = readPrivateField(manager, "realtimeAudioTrack")
      assertTrue(newTrack != null && newTrack !== oldTrack)
      assertTrue(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun normalTransitionDoesNotTruncateActivePlayback() =
    runTest {
      // Root-cause regression for a one-time Bluetooth truncation seen in
      // physical proof: confirms ordinary next-turn audio (no Clear, no
      // Stop) never retires the still-playing track. ScriptedRealtimeAudioTrackWriter
      // never calls the real AudioTrack.write, so Robolectric's shadow
      // playbackHeadPosition stays at 0 even after A is "accepted" —
      // exactly the "unplayed audio still behind writtenFrames" shape a
      // slow (e.g. Bluetooth) drain produces, without needing real time.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ScriptedRealtimeAudioTrackWriter()
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      runCurrent()
      val trackDuringA = readPrivateField(manager, "realtimeAudioTrack")
      assertTrue(trackDuringA != null)

      // Same session, no Clear/Stop in between: a normal next turn's audio.
      playRealtimeAudio(manager, ByteArray(960))
      runCurrent()

      assertTrue(trackDuringA === readPrivateField(manager, "realtimeAudioTrack"))
      assertEquals(listOf(960, 960), writer.calls.map { it[1] })
      assertTrue(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun normalTransitionPreservesQueuedAudioOrdering() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ScriptedRealtimeAudioTrackWriter()
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      playRealtimeAudio(manager, ByteArray(320))
      runCurrent()

      // B is neither dropped nor written ahead of A, and metering accumulates
      // across the transition instead of resetting mid-turn (§13): the single
      // sequential owner already guarantees order, this pins it as a contract.
      assertEquals(listOf(960, 320), writer.calls.map { it[1] })
      assertEquals(((960 + 320) / 2).toLong(), readPrivateField(manager, "realtimeWrittenFrames") as Long)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun normalTransitionReusesCompatibleTrackAcrossSeveralTurns() =
    runTest {
      // Sustained reuse, not a one-shot coincidence: the same track must
      // survive several consecutive normal turns, matching the "AudioTrack
      // hardware lifetime is not tied to Talk turn lifetime" invariant.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ScriptedRealtimeAudioTrackWriter()
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(320))
      runCurrent()
      val firstTrack = readPrivateField(manager, "realtimeAudioTrack")

      repeat(4) {
        playRealtimeAudio(manager, ByteArray(320))
        runCurrent()
        assertTrue(firstTrack === readPrivateField(manager, "realtimeAudioTrack"))
      }
      assertEquals(5, writer.calls.size)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun marksRemainOrderedAcrossNormalTransition() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ScriptedRealtimeAudioTrackWriter()
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      queueRealtimePlaybackMark(manager, "relay-1", "mark-after-a")
      runCurrent()

      // Normal transition: track reused, no Clear/Stop, second turn's audio
      // and mark queued after the first mark.
      playRealtimeAudio(manager, ByteArray(320))
      queueRealtimePlaybackMark(manager, "relay-1", "mark-after-b")
      runCurrent()

      @Suppress("UNCHECKED_CAST")
      val marks = readPrivateField(manager, "pendingRealtimePlaybackMarks") as Map<String, Any>
      val targetFrameOf = { name: String ->
        val mark = marks.getValue(name)
        readPrivateField(mark, "targetFrame") as Long?
      }
      // mark-after-a's target predates mark-after-b's by exactly B's frames —
      // the transition did not renumber or drop either registration.
      assertEquals(960L / 2, targetFrameOf("mark-after-a"))
      assertEquals((960 + 320).toLong() / 2, targetFrameOf("mark-after-b"))
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun ownerJobSurvivesACommandExceptionAndKeepsProcessingLaterAudio() =
    runTest {
      // Structured-review regression: an uncaught throw while processing one
      // command (e.g. AudioTrack.write failing on a route/dead-object error)
      // must not end realtimeAudioWriterJob's for-loop. The channel is
      // long-lived and never recreated, so a dead owner would silently
      // swallow every later command for the rest of the manager's lifetime.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ThrowingOnceRealtimeAudioTrackWriter()
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960))
      runCurrent() // write() throws; the owner must survive and keep looping.

      val job = readPrivateField(manager, "realtimeAudioWriterJob") as Job
      assertTrue(job.isActive)
      // The failed track is retired rather than reused in whatever state the
      // throw left it.
      assertNull(readPrivateField(manager, "realtimeAudioTrack"))

      // A later, ordinary Audio command must still reach a (fresh) track —
      // proof the owner is still consuming the channel, not just alive.
      playRealtimeAudio(manager, ByteArray(960))
      runCurrent()

      assertEquals(2, writer.calls.size)
      assertTrue(manager.isSpeaking.value)
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun aCommandFailureAcknowledgesStrandedMarksInsteadOfPollingForever() =
    runTest {
      // Structured-review regression: retiring the track on a command
      // failure resets realtimeWrittenFrames to 0, so a mark registered
      // against the pre-failure (positive) frame count would otherwise never
      // be satisfied again -- the idle poll would compare against it forever
      // with no ack ever reaching the provider.
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ThrowingOnceRealtimeAudioTrackWriter(throwOnCallIndex = 1)
      val acknowledged = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimePlaybackDispatcher = dispatcher,
          realtimeAudioTrackWriter = writer,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledged += sessionId to markName },
        ).also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      playRealtimeAudio(manager, ByteArray(960)) // call 0: succeeds, writtenFrames > 0
      runCurrent()
      queueRealtimePlaybackMark(manager, "relay-1", "pending-mark")
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), acknowledged) // not yet satisfied

      playRealtimeAudio(manager, ByteArray(960)) // call 1: throws
      runCurrent()

      assertEquals(listOf("relay-1" to "pending-mark"), acknowledged)
      @Suppress("UNCHECKED_CAST")
      val marks = readPrivateField(manager, "pendingRealtimePlaybackMarks") as Map<String, Any>
      assertTrue(marks.isEmpty())
      cancelRealtimeAudioWriterJob(manager)
    }

  @Test
  fun audioTrackWritesAreSerializedThroughTheSinglePlayoutOwner() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      val writer = ConcurrencyTrackingRealtimeAudioTrackWriter()
      val manager =
        createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope, realtimePlaybackDispatcher = dispatcher, realtimeAudioTrackWriter = writer)
          .also { setPrivateField(it, "realtimeSessionId", "relay-1") }

      repeat(5) { playRealtimeAudio(manager, ByteArray(960)) }
      runCurrent()

      assertEquals(1, writer.maxConcurrentCalls)
      cancelRealtimeAudioWriterJob(manager)
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
          realtimePlaybackOwnerScope = backgroundScope,
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
          realtimePlaybackOwnerScope = backgroundScope,
          realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "realtimeWireAudioSampleRateHz", 24_000)
      setPrivateField(manager, "realtimeWireAudioEncoding", "pcm16")
      setMutableStateFlow(manager, "_isListening", false)
      setMutableStateFlow(manager, "_statusText", nativeText("Thinking…"))

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertTrue(manager.isListening.value)
      assertEquals("Listening", manager.statusText.value)
      assertTrue(readPrivateField(manager, "realtimeOutputSuppressed") as Boolean)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"transcript","role":"user","text":"stale","final":true}""")

      assertTrue(readPrivateField(manager, "realtimeOutputSuppressed") as Boolean)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"inputAudio","byteLength":4800}""")

      assertFalse(readPrivateField(manager, "realtimeOutputSuppressed") as Boolean)
      manager.stopAllCapture()
    }

  @Test
  fun resumingRealtimeCaptureFailsClosedWhenWireAudioContractNeverResolved() =
    runTest {
      // Distinct from an absent talk.session.create `audio` field (which now resolves to
      // the legacy pcm16/24kHz contract, see parseRealtimeWireAudioContract tests below):
      // this is the fields simply never having been populated at all, which must still
      // fail closed rather than silently guess a rate.
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setMutableStateFlow(manager, "_isListening", false)

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertFalse(manager.isListening.value)
      assertFalse(manager.isEnabled.value)
      assertNull(readPrivateField(manager, "realtimeCaptureJob"))
    }

  @Test
  fun declaredWireRateUnreachableFromTheRequestedRateIsNotRejectedBeforeOpening() =
    runTest {
      // The requested capture rate is only a preference; whether a conversion
      // exists is decided by the rate AudioRecord actually negotiates, which is
      // not known until it is open. Rejecting a declared wire rate up front
      // against the requested rate (22.05kHz is no integer divisor of 48kHz)
      // would kill sessions on devices whose recorder negotiates a rate that
      // does reach it. This asserts the gate location only -- capture is
      // installed rather than refused before the microphone is touched.
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "realtimeWireAudioEncoding", "pcm16")
      setPrivateField(manager, "realtimeWireAudioSampleRateHz", 22_050)

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")

      assertTrue(manager.isEnabled.value)
      assertTrue(readPrivateField(manager, "realtimeCaptureJob") != null)
      manager.stopAllCapture()
    }

  @Test
  fun absentAudioContractParsesToTheLegacyPcm16TwentyFourKhzWireFormat() {
    // talk.session.create's `audio` field is optional (TalkSessionCreateResultSchema);
    // older/simpler Gateway peers omit it, and iOS's RealtimeTalkRelaySession still
    // defaults to this exact pcm16/24kHz contract in that case. Android must match, not
    // treat an absent field as an unsupported contract.
    val root = Json.parseToJsonElement("""{"relaySessionId":"relay-1"}""").jsonObject

    val contract = parseRealtimeWireAudioContract(root)

    assertEquals("pcm16", contract.encoding)
    assertEquals(24_000, contract.sampleRateHz)
  }

  @Test
  fun presentAudioContractIsParsedAsDeclared() {
    val root =
      Json
        .parseToJsonElement(
          """{"relaySessionId":"relay-1","audio":{"inputEncoding":"pcm16","inputSampleRateHz":48000}}""",
        ).jsonObject

    val contract = parseRealtimeWireAudioContract(root)

    assertEquals("pcm16", contract.encoding)
    assertEquals(48_000, contract.sampleRateHz)
  }

  @Test
  fun malformedAudioContractStaysUnresolvedForFailClosed() {
    // Present but not an object at all -- an explicitly unsupported shape, not an
    // omission, so it must not fall back to the legacy contract.
    val notAnObject = Json.parseToJsonElement("""{"relaySessionId":"relay-1","audio":"unsupported"}""").jsonObject
    // Present as an object but missing the fields this client understands.
    val emptyObject = Json.parseToJsonElement("""{"relaySessionId":"relay-1","audio":{}}""").jsonObject

    for (root in listOf(notAnObject, emptyObject)) {
      val contract = parseRealtimeWireAudioContract(root)
      assertNull(contract.encoding)
      assertNull(contract.sampleRateHz)
    }
  }

  @Test
  fun legacyFallbackWireRateResolvesToTheSame48kTo24kResamplerPath() {
    // Locks the composition end to end: an absent audio contract must land on exactly
    // the same capture-portable-rate -> wire-rate conversion already proven correct by
    // RealtimeCaptureResamplerTest, not a rate the resampler rejects.
    val contract = parseRealtimeWireAudioContract(Json.parseToJsonElement("""{"relaySessionId":"relay-1"}""").jsonObject)

    val resampler = resolveRealtimeCaptureResampler(48_000, contract.sampleRateHz!!)

    assertTrue(resampler != null)
  }

  @Test
  fun replacementRelayPublishedDuringPushToTalkResumesCapture() =
    runTest {
      val manager =
        createManager(
          scope = this,
          realtimePlaybackOwnerScope = backgroundScope,
          realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-replacement")
      setPrivateField(pause, "restartRelay", true)
      setPrivateField(manager, "realtimeSessionId", "relay-replacement")
      setPrivateField(manager, "realtimeWireAudioSampleRateHz", 24_000)
      setPrivateField(manager, "realtimeWireAudioEncoding", "pcm16")

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
      val manager = createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope)
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
      val manager = createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope)
      assertTrue(manager.shouldAllowSpeechInterrupt())

      manager.pauseRealtimeCaptureForPushToTalk("capture-1")

      assertFalse(manager.shouldAllowSpeechInterrupt())
      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")
      assertTrue(manager.shouldAllowSpeechInterrupt())
    }

  @Test
  fun finishingPushToTalkTurnRejectsReplacementCapture() =
    runTest {
      val manager = createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope)
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
  fun cancelledQueuedFinalizerResumesOnlyItsRealtimeCaptureOnMain() =
    runTest {
      val finalizerDispatcher = StandardTestDispatcher()
      val manager =
        createManager(
          scope = CoroutineScope(SupervisorJob() + finalizerDispatcher),
        )
      withMain(dispatcher = Dispatchers.Unconfined, cleanup = manager::stopAllCapture) {
        setMutableStateFlow(manager, "_isEnabled", true)
        manager.pauseRealtimeCaptureForPushToTalk("capture-1")
        setPrivateField(manager, "activePttCaptureId", "capture-1")
        @Suppress("UNCHECKED_CAST")
        (readPrivateField(manager, "pttFinalSegments") as MutableList<String>) += "finish this capture"

        val payload = manager.endPushToTalk("capture-1")
        val finalizer = readPrivateField(manager, "finishingPttJob") as Job

        assertEquals("queued", payload.status)
        assertEquals("capture-1", manager.finishingPushToTalkCaptureId)
        assertTrue(readPrivateField(manager, "realtimeCapturePause") != null)

        finalizer.cancel()
        finalizerDispatcher.scheduler.runCurrent()

        assertTrue(finalizer.isCancelled)
        assertNull(manager.finishingPushToTalkCaptureId)
        assertNull(readPrivateField(manager, "realtimeCapturePause"))
        assertNull(readPrivateField(manager, "activePttCaptureId"))
      }
    }

  @Test
  fun relayClosePreservesFinishingPushToTalkOwnership() =
    runTest {
      val manager = createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "finishingPttCaptureId", "capture-1")

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"close","reason":"completed"}""")

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
          realtimePlaybackOwnerScope = backgroundScope,
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
  fun chatFinalWaitUsesGatewayEventTimeout() =
    runTest {
      val manager = createManager(scope = this, realtimePlaybackOwnerScope = backgroundScope)

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
    realtimeAudioTrackWriter: RealtimeAudioTrackWriter = RealtimeAudioTrackWriter.Default,
    // Defaults to `scope` (TalkModeManager's own default) unless a test
    // explicitly exempts the playout owner from runTest's child-job
    // completion check — see the constructor parameter's doc comment.
    realtimePlaybackOwnerScope: CoroutineScope? = null,
  ): TalkModeManager {
    val app = RuntimeEnvironment.getApplication()
    val session =
      GatewaySession(
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        identityStore = testDeviceIdentityStore(app),
        deviceAuthStore = DeviceAuthStore(SecurePrefs(app, app.getSharedPreferences("talk-mode-test-${System.nanoTime()}", 0))),
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
      realtimeAudioTrackWriter = realtimeAudioTrackWriter,
      realtimePlaybackOwnerScope = realtimePlaybackOwnerScope ?: scope,
    ).also { createdManagers += it }
  }

  private fun createRealtimeManager(): TalkModeManager = createManager().also { setPrivateField(it, "realtimeSessionId", "relay-1") }

  private suspend fun TestScope.withMain(
    dispatcher: CoroutineDispatcher = StandardTestDispatcher(testScheduler),
    cleanup: () -> Unit = {},
    block: suspend () -> Unit,
  ) {
    Dispatchers.setMain(dispatcher)
    try {
      block()
    } finally {
      cleanup()
      Dispatchers.resetMain()
    }
  }

  private fun TalkModeManager.transcript(
    role: String,
    text: String,
    final: Boolean = false,
  ) = handleGatewayEvent("talk.event", realtimeTranscriptPayload(role, text, final))

  private fun TalkModeManager.realtimeEvent(payload: String) = handleGatewayEvent("talk.event", payload)

  private fun installSpeechRecognitionService() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val speechService = ComponentName(app, "TestSpeechRecognitionService")
    shadowOf(app.packageManager).apply {
      addServiceIfNotPresent(speechService)
      addIntentFilterForService(speechService, IntentFilter(RecognitionService.SERVICE_INTERFACE))
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun playbackGeneration(manager: TalkModeManager) = readPrivateField(manager, "playbackGeneration") as AtomicLong

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

  private fun playRealtimeAudio(
    manager: TalkModeManager,
    bytes: ByteArray,
  ) {
    val method = manager.javaClass.getDeclaredMethod("playRealtimeAudio", ByteArray::class.java)
    method.isAccessible = true
    method.invoke(manager, bytes)
  }

  private fun queueRealtimePlaybackMark(
    manager: TalkModeManager,
    sessionId: String,
    markName: String,
  ) {
    val method = manager.javaClass.getDeclaredMethod("queueRealtimePlaybackMark", String::class.java, String::class.java)
    method.isAccessible = true
    method.invoke(manager, sessionId, markName)
  }

  private fun requestRealtimePlaybackClear(manager: TalkModeManager) {
    val method = manager.javaClass.getDeclaredMethod("requestRealtimePlaybackClear")
    method.isAccessible = true
    method.invoke(manager)
  }

  private fun stopRealtimePlayback(
    manager: TalkModeManager,
    discardMarks: Boolean = false,
  ) {
    val method = manager.javaClass.getDeclaredMethod("stopRealtimePlayback", Boolean::class.javaPrimitiveType)
    method.isAccessible = true
    method.invoke(manager, discardMarks)
  }

  /** realtimeAudioWriterJob (the playout owner) and realtimePlaybackIdleJob
   * (its idle-poll ticker, armed by any successful write/mark) are both
   * intentionally infinite for TalkModeManager's real lifetime (see
   * production comments); tests that drive them via scope = this, realtimePlaybackOwnerScope = backgroundScope must
   * cancel both explicitly or runTest fails waiting for them. */
  private fun cancelRealtimeAudioWriterJob(manager: TalkModeManager) {
    (readPrivateField(manager, "realtimeAudioWriterJob") as Job).cancel()
    (readPrivateField(manager, "realtimePlaybackIdleJob") as Job?)?.cancel()
  }

  private fun invokeStopRealtimeRelay(
    manager: TalkModeManager,
    closeSession: Boolean,
  ) {
    val method =
      manager.javaClass.getDeclaredMethod(
        "stopRealtimeRelay",
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
      )
    method.isAccessible = true
    method.invoke(manager, closeSession, true, true, false)
  }

  private fun recognitionListener(
    manager: TalkModeManager,
    captureId: String,
  ): RecognitionListener {
    val method = manager.javaClass.getDeclaredMethod("recognitionListener", String::class.java)
    method.isAccessible = true
    return method.invoke(manager, captureId) as RecognitionListener
  }

  private fun silenceSegmentedRung(): Any {
    val clazz = Class.forName("ai.openclaw.app.voice.PushToTalkRecognitionRung\$SilenceSegmented")
    return requireNotNull(clazz.getField("INSTANCE").get(null))
  }

  private fun chatFinalPayload(
    runId: String,
    text: String,
    role: String = "assistant",
  ): String = """{"runId":"$runId","sessionKey":"main","state":"final","message":{"role":"$role","content":[{"type":"text","text":"$text"}]}}"""

  private fun realtimeTranscriptPayload(
    role: String,
    text: String,
    final: Boolean = false,
  ): String = """{"relaySessionId":"relay-1","type":"transcript","role":"$role","text":"$text","final":$final}"""
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

// Mirrors TalkModeManager's private realtimePlaybackWriteRetryDelayMs (5L).
// Kept as a separate constant because that value is a private companion
// const not reachable via reflection on a compiled Int/Long constant.
private const val REALTIME_PLAYBACK_WRITE_RETRY_DELAY_MS = 5L

/**
 * Deterministic [RealtimeAudioTrackWriter] fake: never touches the real
 * AudioTrack, so tests control exactly what each write() call reports
 * (partial/zero accept) without depending on Robolectric's shadow to
 * simulate hardware pacing it doesn't actually model.
 */
private class ScriptedRealtimeAudioTrackWriter(
  scripted: List<Int> = emptyList(),
) : RealtimeAudioTrackWriter {
  private val queue = ArrayDeque(scripted)

  /** Once [queue] is drained: true keeps returning 0 (stalled); false accepts the full request. */
  @Volatile var stalled = false
  val calls = mutableListOf<IntArray>()

  override fun write(
    track: AudioTrack,
    bytes: ByteArray,
    offset: Int,
    length: Int,
  ): Int {
    calls += intArrayOf(offset, length)
    if (queue.isNotEmpty()) return queue.removeFirst()
    return if (stalled) 0 else length
  }
}

/** Throws once (simulating a hardware/route failure), then writes normally. */
private class ThrowingOnceRealtimeAudioTrackWriter(
  private val throwOnCallIndex: Int = 0,
) : RealtimeAudioTrackWriter {
  private var thrown = false
  val calls = mutableListOf<IntArray>()

  override fun write(
    track: AudioTrack,
    bytes: ByteArray,
    offset: Int,
    length: Int,
  ): Int {
    val callIndex = calls.size
    calls += intArrayOf(offset, length)
    if (!thrown && callIndex == throwOnCallIndex) {
      thrown = true
      throw RuntimeException("simulated hardware failure")
    }
    return length
  }
}

/** Records the peak number of concurrent write() calls to prove AudioTrack access is serialized. */
private class ConcurrencyTrackingRealtimeAudioTrackWriter : RealtimeAudioTrackWriter {
  private val concurrentCalls = AtomicInteger(0)

  @Volatile var maxConcurrentCalls = 0

  override fun write(
    track: AudioTrack,
    bytes: ByteArray,
    offset: Int,
    length: Int,
  ): Int {
    val current = concurrentCalls.incrementAndGet()
    synchronized(this) { maxConcurrentCalls = maxOf(maxConcurrentCalls, current) }
    try {
      return length
    } finally {
      concurrentCalls.decrementAndGet()
    }
  }
}
