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
import android.content.Context
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Bundle
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
import kotlinx.coroutines.cancel
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
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.util.ReflectionHelpers
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TalkModeManagerTest {
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
  fun browserOnlyRealtimeConfigStartsNativeTalkInsteadOfRelay() =
    runTest {
      installSpeechRecognitionService()
      val manager =
        createManager(
          scope = this,
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
  fun realtimeAudioIsSubmittedUnderTheCurrentRenderGeneration() {
    val engine = FakeRealtimeMediaEngine()
    val manager = createManager(realtimeMediaEngine = engine)
    setPrivateField(manager, "realtimeSessionId", "relay-1")
    setPrivateField(manager, "mediaEngine", engine)

    manager.realtimeEvent(audioEvent("relay-1", byteArrayOf(1, 2, 3, 4)))
    assertEquals(1, engine.submittedAudio.size)
    val firstGeneration = engine.submittedAudio[0].first

    // A clear opens the next generation, and audio after it must not carry the
    // cancelled one — that is what let cancelled assistant speech resume.
    manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"clear"}""")
    manager.realtimeEvent(audioEvent("relay-1", byteArrayOf(5, 6, 7, 8)))
    assertEquals(2, engine.submittedAudio.size)
    assertTrue(engine.submittedAudio[1].first > firstGeneration)
    assertEquals(1, engine.clearCount)
  }

  @Test
  fun assistantAudioArrivingBeforeTheEngineStartsIsNotLost() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      // The engine is not published yet — exactly the window between the relay
      // session being announced and the device streams opening.

      manager.realtimeEvent(audioEvent("relay-1", byteArrayOf(1, 2, 3, 4)))
      assertEquals(0, engine.submittedAudio.size)

      flushPendingAssistantAudio(manager, "relay-1", engine)
      assertEquals(1, engine.submittedAudio.size)
      assertEquals(4, engine.submittedAudio[0].second.size)
    }

  @Test
  fun aBarrierBufferedBeforeStartupIsNotAnsweredAheadOfItsAudio() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val engine = FakeRealtimeMediaEngine()
      val manager =
        createManager(
          scope = this,
          realtimeMediaEngine = engine,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")

      manager.realtimeEvent(audioEvent("relay-1", byteArrayOf(1, 2, 3, 4)))
      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()
      // Answering the barrier now would claim the buffered audio had played.
      assertEquals(emptyList<Pair<String, String>>(), acknowledgements)
      assertEquals(0, engine.submittedMarks.size)

      flushPendingAssistantAudio(manager, "relay-1", engine)
      // It reaches the engine behind its audio, in arrival order.
      assertEquals(1, engine.submittedAudio.size)
      assertEquals(1, engine.submittedMarks.size)
    }

  @Test
  fun audioBufferedBeforeStartupIsDiscardedByAnInterruption() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setPrivateField(manager, "realtimeSessionId", "relay-1")

      manager.realtimeEvent(audioEvent("relay-1", byteArrayOf(1, 2, 3, 4)))
      // The user interrupts before the device streams finished opening.
      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"clear"}""")
      flushPendingAssistantAudio(manager, "relay-1", engine)

      // Cancelled audio must not arrive one device-open later.
      assertEquals(0, engine.submittedAudio.size)
    }

  @Test
  fun aRefusedPlaybackBarrierIsNeverAcknowledgedAsPlayed() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val engine = FakeRealtimeMediaEngine(markSubmissionSucceeds = false)
      val manager =
        createManager(
          scope = this,
          realtimeMediaEngine = engine,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()

      // Audio queued in front of the barrier may still be pending, so claiming
      // the device reached it would be a lie to the Gateway.
      assertEquals(emptyList<Pair<String, String>>(), acknowledgements)
    }

  @Test
  fun aPlaybackBarrierIsNotAnsweredUntilTheEngineResolvesIt() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val engine = FakeRealtimeMediaEngine()
      val manager =
        createManager(
          scope = this,
          realtimeMediaEngine = engine,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()
      // The barrier is queued in the engine, not answered.
      assertEquals(emptyList<Pair<String, String>>(), acknowledgements)
      assertEquals(1, engine.submittedMarks.size)

      engine.markEvents += RealtimeMarkEvent(engine.submittedMarks[0], RealtimeMarkOutcome.Completed)
      drainMarkEvents(manager, "relay-1", engine)
      runCurrent()
      assertEquals(listOf("relay-1" to "audio-1"), acknowledgements)
    }

  @Test
  fun aBarrierInvalidatedByTheEngineIsStillAnsweredToTheGateway() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val engine = FakeRealtimeMediaEngine()
      val manager =
        createManager(
          scope = this,
          realtimeMediaEngine = engine,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()
      engine.markEvents += RealtimeMarkEvent(engine.submittedMarks[0], RealtimeMarkOutcome.InvalidatedByEpoch)
      drainMarkEvents(manager, "relay-1", engine)
      runCurrent()

      // The acknowledgement releases the provider's playback gate; it is not a
      // claim that the audio was heard. A provider that holds its next response
      // until the barrier drains would otherwise never speak again.
      assertEquals(listOf("relay-1" to "audio-1"), acknowledgements)
    }

  @Test
  fun aBarrierHeldForAnEngineThatNeverStartedIsAnsweredWhenTheResponseIsCleared() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = this,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      // No engine published: the barrier is held with the audio in front of it.
      manager.realtimeEvent(audioEvent("relay-1", byteArrayOf(1, 2, 3, 4)))
      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), acknowledgements)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"clear"}""")
      runCurrent()

      // The engine never saw this barrier, so no outcome is coming for it. The
      // interruption discarded the audio behind it, which makes the barrier
      // resolved — dropping it instead would hold the provider's next response.
      assertEquals(listOf("relay-1" to "audio-1"), acknowledgements)
    }

  @Test
  fun pushToTalkPauseReleasesTheRealtimeMediaEngine() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)
      setPrivateField(manager, "mediaControlJob", Job())

      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      runCurrent()

      // Push-to-talk takes the microphone, so both device streams are released
      // before the recognizer opens its own.
      assertTrue(engine.released)
      assertNull(readPrivateField(manager, "mediaEngine"))
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

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"transcript","role":"user","text":"stale","final":true}""")

      assertTrue(readPrivateField(manager, "realtimeOutputSuppressed") as Boolean)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"inputAudio","byteLength":4800}""")

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
      assertTrue((readPrivateField(manager, "mediaControlJob") as Job).isActive)
      manager.stopAllCapture()
    }

  @Test
  fun bufferedAssistantAudioTheEngineRefusesEndsTheSession() =
    runTest {
      val engine = FakeRealtimeMediaEngine(audioSubmissionSucceeds = false)
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setMutableStateFlow(manager, "_isEnabled", true)
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      // Audio and a barrier arrive while the engine is still starting.
      manager.realtimeEvent(audioEvent("relay-1", byteArrayOf(1, 2, 3, 4)))
      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()

      flushPendingAssistantAudio(manager, "relay-1", engine)
      runCurrent()

      // The barrier behind that audio would otherwise still resolve and report
      // a turn as played in full when the middle of it never reached the
      // device — the same fact the live submission path already ends on.
      assertFalse(manager.isEnabled.value)
      assertTrue(manager.statusText.value.contains("assistant playback queue overflowed"))
    }

  @Test
  fun aRejectedSubmissionFromAnEndedSessionNeverEndsItsReplacement() =
    runTest {
      val engine = FakeRealtimeMediaEngine(audioSubmissionSucceeds = false)
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setMutableStateFlow(manager, "_isEnabled", true)
      setPrivateField(manager, "realtimeSessionId", "relay-2")
      // No engine published, so the audio is held rather than submitted.
      manager.realtimeEvent(audioEvent("relay-2", byteArrayOf(1, 2, 3, 4)))
      runCurrent()

      // The old session's held audio is flushed after the replacement started,
      // and the engine refuses it.
      flushPendingAssistantAudio(manager, "relay-1", engine)
      runCurrent()

      // The refusal belongs to "relay-1"; ending "relay-2" for it would kill a
      // conversation that is working.
      assertTrue(manager.isEnabled.value)
    }

  @Test
  fun theFallbacksAppliedMicrophoneSurvivesTheSnapshotTick() =
    runTest {
      val applied = mutableListOf<String?>()
      val engine = FakeRealtimeMediaEngine(appliesInputDevice = false)
      val manager =
        createManager(scope = this, realtimeMediaEngine = engine, onAppliedAudioInputChanged = { applied += it })
      setMutableStateFlow(manager, "_isEnabled", true)
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)
      // The capture session reported the microphone it opened, moments ago.
      setPrivateField(manager, "lastAppliedInputKey", "usb|mic")

      applyRealtimeMediaSnapshot(manager, "relay-1", engine)
      runCurrent()

      // The fallback's snapshot carries no device id because it does not own
      // the selection; publishing that would blank the microphone the capture
      // session had just reported.
      assertEquals(emptyList<String?>(), applied)
    }

  @Test
  fun aSnapshotFromARetiredEngineNeverOverwritesTheNewSession() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setMutableStateFlow(manager, "_isEnabled", true)
      setPrivateField(manager, "realtimeSessionId", "relay-2")
      setPrivateField(manager, "mediaEngine", engine)
      setMutableStateFlow(manager, "_isSpeaking", true)

      // The old loop is still inside its snapshot when the session moved on.
      applyRealtimeMediaSnapshot(manager, "relay-1", engine)
      runCurrent()

      // The retired engine reports nothing presenting; publishing that would
      // tell the new session it had stopped speaking.
      assertTrue(manager.isSpeaking.value)
    }

  @Test
  fun aStreamFaultOnARetiredEngineNeverEndsTheSessionThatReplacedIt() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setMutableStateFlow(manager, "_isEnabled", true)
      setPrivateField(manager, "realtimeSessionId", "relay-2")
      setPrivateField(manager, "mediaEngine", engine)
      engine.telemetry += RealtimeMediaEvent(RealtimeMediaEventKind.StreamError, 1, 0, 0, 0)

      // The old loop drains its engine's telemetry after teardown, while a
      // replacement relay is already running.
      drainRealtimeMediaTelemetry(manager, "relay-1", engine)
      runCurrent()

      // The fault belongs to the retired engine; ending "relay-2" because of it
      // would kill a conversation that is working.
      assertTrue(manager.isEnabled.value)
    }

  @Test
  fun endingTheRelayAnswersTheBarriersItsEngineStillHeld() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val engine = FakeRealtimeMediaEngine()
      val manager =
        createManager(
          scope = this,
          realtimeMediaEngine = engine,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)
      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()

      manager.stopAllCapture()
      runCurrent()

      // Teardown clears the session id before sweeping the barriers, so the
      // sweep has to be told which session they belonged to — otherwise they
      // are erased and the provider's playback gate never opens.
      assertEquals(listOf("relay-1" to "audio-1"), acknowledgements)
    }

  @Test
  fun audioFromAnEndedSessionNeverReachesTheEngineThatReplacedIt() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setPrivateField(manager, "realtimeSessionId", "relay-2")
      setPrivateField(manager, "mediaEngine", engine)

      // A `talk.event` from the previous session that lost the teardown race.
      playRealtimeAudio(manager, "relay-1", byteArrayOf(1, 2, 3, 4))
      queueRealtimePlaybackMark(manager, "relay-1", "audio-old")
      runCurrent()

      // Neither the audio nor the barrier belongs to the session that is live.
      assertEquals(0, engine.submittedAudio.size)
      assertEquals(0, engine.submittedMarks.size)

      playRealtimeAudio(manager, "relay-2", byteArrayOf(5, 6, 7, 8))
      runCurrent()
      assertEquals(1, engine.submittedAudio.size)
    }

  @Test
  fun audioFromTheResponseAClearCancelledIsRefusedWhenItLandsLate() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)

      manager.realtimeEvent(audioEventForResponse("relay-1", "resp-1", byteArrayOf(1, 2, 3, 4)))
      runCurrent()
      assertEquals(1, engine.submittedAudio.size)

      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"clear"}""")
      runCurrent()

      // A delta of the cancelled response that was already on the wire.
      manager.realtimeEvent(audioEventForResponse("relay-1", "resp-1", byteArrayOf(5, 6, 7, 8)))
      runCurrent()
      assertEquals(1, engine.submittedAudio.size)

      // The next response plays: it is a different response, not a later time.
      manager.realtimeEvent(audioEventForResponse("relay-1", "resp-2", byteArrayOf(9, 10, 11, 12)))
      runCurrent()
      assertEquals(2, engine.submittedAudio.size)
    }

  @Test
  fun turningPlaybackOffLeavesTheStatusOnListening() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setMutableStateFlow(manager, "_isEnabled", true)
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)
      setMutableStateFlow(manager, "_isSpeaking", true)
      setMutableStateFlow(manager, "_statusText", nativeText("Speaking…"))

      manager.setPlaybackEnabled(false)
      runCurrent()

      // `stopSpeaking` only repairs the status when it is the one that clears
      // `_isSpeaking`; this path already did, so the UI would otherwise read
      // "Speaking…" with nothing playing.
      assertFalse(manager.isSpeaking.value)
      assertEquals("Listening", manager.statusText.value)
    }

  @Test
  fun anEngineThatDoesNotApplyADeviceIdIsNeverToldOne() =
    runTest {
      val audioManager = RuntimeEnvironment.getApplication().getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val shadowAudioManager = shadowOf(audioManager)
      val mic = inputDevice(AudioDeviceInfo.TYPE_USB_HEADSET, id = 21)
      shadowAudioManager.setInputDevices(listOf(mic))
      val key = audioInputDeviceKey(mic.type, mic.address.orEmpty(), mic.productName.toString())

      // The half-duplex fallback resolves the operator's microphone itself when
      // it opens the recorder, and does not reopen it mid-session.
      val engine = FakeRealtimeMediaEngine(appliesInputDevice = false)
      val manager = createManager(scope = this, realtimeMediaEngine = engine, preferredAudioInputDevice = { key })
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)

      setPendingRoute(manager, "relay-1", RealtimeRouteProfile.BuiltInSpeaker)
      applyPendingRoute(manager, "relay-1", engine)

      // Recording 21 as applied would be a claim about a device nothing
      // switched to, and would suppress the next attempt.
      assertEquals(RealtimeMediaConfig.UNSPECIFIED_DEVICE_ID, engine.inputDeviceId)
      shadowAudioManager.setInputDevices(emptyList())
    }

  @Test
  fun pushToTalkTeardownAnswersTheBarriersItsEngineCanNoLongerReach() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val engine = FakeRealtimeMediaEngine()
      val manager =
        createManager(
          scope = this,
          realtimeMediaEngine = engine,
          realtimeMarkAcknowledger = { sessionId, markName -> acknowledgements += sessionId to markName },
        )
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)
      setPrivateField(manager, "mediaControlJob", Job())
      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"mark","markName":"audio-1"}""")
      runCurrent()
      assertEquals(emptyList<Pair<String, String>>(), acknowledgements)

      // Push-to-talk takes the microphone: the engine goes away while the relay
      // session keeps running.
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      runCurrent()

      // Nothing left in the process can resolve that barrier, and the provider
      // holds its next response behind it until it is answered.
      assertEquals(listOf("relay-1" to "audio-1"), acknowledgements)
    }

  @Test
  fun aRepluggedMicrophoneIsReResolvedRatherThanReappliedByItsOldId() =
    runTest {
      val audioManager = RuntimeEnvironment.getApplication().getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val shadowAudioManager = shadowOf(audioManager)
      val first = inputDevice(AudioDeviceInfo.TYPE_USB_HEADSET, id = 11)
      shadowAudioManager.setInputDevices(listOf(first))
      val key = audioInputDeviceKey(first.type, first.address.orEmpty(), first.productName.toString())

      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine, preferredAudioInputDevice = { key })
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)

      setPendingRoute(manager, "relay-1", RealtimeRouteProfile.BuiltInSpeaker)
      applyPendingRoute(manager, "relay-1", engine)
      assertEquals(11, engine.inputDeviceId)

      // The same microphone unplugged and plugged back in: the operator's
      // preference is unchanged, but the platform hands out a new per-boot id.
      shadowAudioManager.setInputDevices(listOf(inputDevice(AudioDeviceInfo.TYPE_USB_HEADSET, id = 12)))
      setPendingRoute(manager, "relay-1", RealtimeRouteProfile.BuiltInSpeaker)
      applyPendingRoute(manager, "relay-1", engine)

      // Reapplying the id the session opened with would point the stream at a
      // device that is gone.
      assertEquals(12, engine.inputDeviceId)
      assertEquals(2, engine.routeChanges)

      // Nothing changed this time, so the streams are not reopened for nothing.
      setPendingRoute(manager, "relay-1", RealtimeRouteProfile.BuiltInSpeaker)
      applyPendingRoute(manager, "relay-1", engine)
      assertEquals(2, engine.routeChanges)
      shadowAudioManager.setInputDevices(emptyList())
    }

  @Test
  fun aDroppedPlaybackBarrierOutcomeEndsTheSessionEvenWhenNoEventDrains() =
    runTest {
      val engine = FakeRealtimeMediaEngine()
      val manager = createManager(scope = this, realtimeMediaEngine = engine)
      setMutableStateFlow(manager, "_isEnabled", true)
      setPrivateField(manager, "realtimeSessionId", "relay-1")
      setPrivateField(manager, "mediaEngine", engine)
      // The engine dropped an outcome; the ring has since been emptied, so the
      // next drain hands back nothing at all.
      engine.markEventOverflows = 1
      engine.markEvents.clear()

      applyRealtimeMediaSnapshot(manager, "relay-1", engine)
      runCurrent()

      // A dropped outcome is permanent: the barrier it belonged to can never be
      // answered, so the turn would hang rather than finish.
      assertFalse(manager.isEnabled.value)
      assertTrue(manager.statusText.value.contains("playback barrier outcomes were lost"))
    }

  @Test
  fun aMediaEngineThatThrowsWhileStartingEndsTheSessionWithAReason() =
    runTest {
      val engine = FakeRealtimeMediaEngine(startFailure = IllegalStateException("audio device busy"))
      val manager =
        createManager(
          scope = this,
          realtimeMediaEngine = engine,
          realtimeCaptureDispatcher = StandardTestDispatcher(testScheduler),
        )
      setMutableStateFlow(manager, "_isEnabled", true)
      manager.pauseRealtimeCaptureForPushToTalk("capture-1")
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      setPrivateField(pause, "restartRelay", true)
      setPrivateField(manager, "realtimeSessionId", "relay-1")

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-1")
      runCurrent()

      // The engine is released either way. Without the failure being reported,
      // Talk stays published as listening with no microphone and no reason —
      // the silent-failure class the product doctrine puts above a crash.
      assertTrue(engine.released)
      assertFalse(manager.isListening.value)
      assertFalse(manager.isEnabled.value)
      assertTrue(manager.statusText.value.contains("audio device busy"))
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
      val manager = createManager(scope = this)
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
      assertNull(readPrivateField(manager, "mediaControlJob"))
    }

  @Test
  fun chatFinalWaitUsesGatewayEventTimeout() =
    runTest {
      val manager = createManager(scope = this)

      setPrivateField(manager, "pendingRunId", "run-missing-final")
      setPrivateField(manager, "pendingFinal", CompletableDeferred<Boolean>())

      assertFalse(manager.waitForChatFinal("run-missing-final"))
      assertEquals(45_000, currentTime)
    }

  private val sessionScopes = mutableListOf<CoroutineScope>()

  @After
  fun cancelLeakedSessionScopes() {
    sessionScopes.forEach { it.cancel() }
    sessionScopes.clear()
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
    realtimeMediaEngine: RealtimeMediaEngine? = null,
    preferredAudioInputDevice: () -> String? = { null },
    onAppliedAudioInputChanged: (String?) -> Unit = {},
  ): TalkModeManager {
    val app = RuntimeEnvironment.getApplication()
    // Tracked so it is cancelled with the test. Left running, its coroutines
    // outlive the Robolectric environment they hold a Context from, and the
    // exception that follows is reported against whichever test starts next.
    val sessionScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    sessionScopes += sessionScope
    val session =
      GatewaySession(
        scope = sessionScope,
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
      preferredAudioInputDevice = preferredAudioInputDevice,
      onAppliedAudioInputChanged = onAppliedAudioInputChanged,
      realtimeMediaEngineFactory = { realtimeMediaEngine ?: FakeRealtimeMediaEngine() },
    )
  }

  private fun audioEventForResponse(
    sessionId: String,
    responseId: String,
    pcm: ByteArray,
  ): String {
    val encoded = android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP)
    return """{"relaySessionId":"$sessionId","type":"audio","responseId":"$responseId","audioBase64":"$encoded"}"""
  }

  private fun audioEvent(
    sessionId: String,
    pcm: ByteArray,
  ): String {
    val encoded = android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP)
    return """{"relaySessionId":"$sessionId","type":"audio","audioBase64":"$encoded"}"""
  }

  private fun flushPendingAssistantAudio(
    manager: TalkModeManager,
    sessionId: String,
    engine: RealtimeMediaEngine,
  ) {
    val method =
      manager.javaClass.getDeclaredMethod(
        "flushPendingAssistantAudio",
        String::class.java,
        RealtimeMediaEngine::class.java,
      )
    method.isAccessible = true
    method.invoke(manager, sessionId, engine)
  }

  private fun drainMarkEvents(
    manager: TalkModeManager,
    sessionId: String,
    engine: RealtimeMediaEngine,
  ) {
    val method =
      manager.javaClass.getDeclaredMethod(
        "drainRealtimeMarkEvents",
        String::class.java,
        RealtimeMediaEngine::class.java,
      )
    method.isAccessible = true
    method.invoke(manager, sessionId, engine)
  }

  private fun playRealtimeAudio(
    manager: TalkModeManager,
    sessionId: String,
    pcm: ByteArray,
  ) {
    val method = manager.javaClass.getDeclaredMethod("playRealtimeAudio", String::class.java, ByteArray::class.java)
    method.isAccessible = true
    method.invoke(manager, sessionId, pcm)
  }

  private fun queueRealtimePlaybackMark(
    manager: TalkModeManager,
    sessionId: String,
    markName: String,
  ) {
    val method =
      manager.javaClass.getDeclaredMethod("queueRealtimePlaybackMark", String::class.java, String::class.java)
    method.isAccessible = true
    method.invoke(manager, sessionId, markName)
  }

  private fun drainRealtimeMediaTelemetry(
    manager: TalkModeManager,
    sessionId: String,
    engine: RealtimeMediaEngine,
  ) {
    val method =
      manager.javaClass.getDeclaredMethod(
        "drainRealtimeMediaTelemetry",
        String::class.java,
        RealtimeMediaEngine::class.java,
      )
    method.isAccessible = true
    method.invoke(manager, sessionId, engine)
  }

  private fun applyPendingRoute(
    manager: TalkModeManager,
    sessionId: String,
    engine: RealtimeMediaEngine,
  ) {
    val method =
      manager.javaClass.getDeclaredMethod(
        "applyPendingRoute",
        String::class.java,
        RealtimeMediaEngine::class.java,
      )
    method.isAccessible = true
    method.invoke(manager, sessionId, engine)
  }

  private fun applyRealtimeMediaSnapshot(
    manager: TalkModeManager,
    sessionId: String,
    engine: RealtimeMediaEngine,
  ) {
    val method =
      manager.javaClass.getDeclaredMethod(
        "applyRealtimeMediaSnapshot",
        String::class.java,
        RealtimeMediaEngine::class.java,
      )
    method.isAccessible = true
    method.invoke(manager, sessionId, engine)
  }

  private fun setPendingRoute(
    manager: TalkModeManager,
    sessionId: String,
    route: RealtimeRouteProfile,
  ) {
    val pendingClass = Class.forName("ai.openclaw.app.voice.PendingRouteChange")
    val ctor = pendingClass.declaredConstructors.first()
    ctor.isAccessible = true
    val pending = ctor.newInstance(sessionId, route)
    val ref = readPrivateField(manager, "pendingRoute") as AtomicReference<*>
    val setter = AtomicReference::class.java.getMethod("set", Any::class.java)
    setter.invoke(ref, pending)
  }

  private fun inputDevice(
    type: Int,
    id: Int,
  ): AudioDeviceInfo {
    val device = AudioDeviceInfoBuilder.newBuilder().setType(type).build()
    val port = ReflectionHelpers.getField<Any>(device, "mPort")
    val handle = ReflectionHelpers.getField<Any>(port, "mHandle")
    ReflectionHelpers.setField(handle, "mId", id)
    return device
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

/**
 * Stands in for the realtime data plane so TalkMode's conversational ownership
 * can be tested without a device stream. It records what it was asked to do
 * rather than simulating audio: what these tests protect is which generation an
 * assistant chunk carries and when a barrier may be reported as played.
 */
internal class FakeRealtimeMediaEngine(
  private val routeChangeSucceeds: Boolean = true,
  private val markSubmissionSucceeds: Boolean = true,
  private val audioSubmissionSucceeds: Boolean = true,
  private val appliesInputDevice: Boolean = true,
  private val startFailure: Throwable? = null,
) : RealtimeMediaEngine {
  val submittedAudio = mutableListOf<Pair<Long, ByteArray>>()
  val submittedMarks = mutableListOf<Long>()
  val markEvents = mutableListOf<RealtimeMarkEvent>()
  val telemetry = mutableListOf<RealtimeMediaEvent>()
  var markEventOverflows = 0L
  var clearCount = 0
    private set
  var released = false
    private set
  var route: RealtimeRouteProfile = RealtimeRouteProfile.Unknown
    private set
  var inputPreset: RealtimeInputPreset? = null
    private set
  var inputDeviceId: Int = RealtimeMediaConfig.UNSPECIFIED_DEVICE_ID
    private set
  var routeChanges = 0
    private set

  private var generation = 1L

  override val supportsConcurrentCapture: Boolean = true

  override val appliesInputDeviceSelection: Boolean = appliesInputDevice

  override fun start(config: RealtimeMediaConfig): Boolean {
    startFailure?.let { throw it }
    route = config.route
    return true
  }

  override fun stop() = Unit

  override fun release() {
    released = true
  }

  override fun setRoute(
    route: RealtimeRouteProfile,
    inputPreset: RealtimeInputPreset,
    preferredInputDeviceId: Int,
  ): Boolean {
    this.route = route
    this.inputPreset = inputPreset
    this.inputDeviceId = preferredInputDeviceId
    routeChanges += 1
    return routeChangeSucceeds
  }

  override fun beginRenderGeneration(): Long = ++generation

  override fun submitAssistantAudio(
    generation: Long,
    pcm: ByteArray,
  ): Boolean {
    if (!audioSubmissionSucceeds) return false
    submittedAudio += generation to pcm
    return true
  }

  override fun clearRender() {
    clearCount += 1
  }

  override fun submitMark(markId: Long): Boolean {
    if (!markSubmissionSucceeds) return false
    submittedMarks += markId
    return true
  }

  override fun drainUplink(into: ByteArray): Int = 0

  override fun drainMarkEvents(): List<RealtimeMarkEvent> {
    val drained = markEvents.toList()
    markEvents.clear()
    return drained
  }

  override fun drainTelemetry(): List<RealtimeMediaEvent> {
    val drained = telemetry.toList()
    telemetry.clear()
    return drained
  }

  override fun snapshot(): RealtimeMediaSnapshot =
    RealtimeMediaSnapshot(
      readiness = RealtimeMediaReadiness.FullDuplexReady,
      route = route,
      echoControlOwner = RealtimeEchoControlOwner.PlatformVoiceCommunication,
      renderPresenting = false,
      captureEligibleNow = true,
      rates = RealtimeMediaRates(24_000, 24_000, 48_000, 48_000, 48_000, 48_000),
      deviceClockEpoch = 1,
      renderContentGeneration = generation,
      captureEligibilityGeneration = 1,
      acousticProcessorLifetime = 0,
      measuredStreamDelayMs = 40,
      render = RealtimeRenderStats(0, 0, 0, 0, 0, 0, 0, 0, markEventOverflows),
      capture = RealtimeCaptureStats(0, 0, 0, 0, 0, 0, 0, 0),
      acoustic = RealtimeAcousticStats(false, 0, 0, 0, 0, 0, null, null, null),
      referenceRingDroppedSamples = 0,
      telemetryDroppedEvents = 0,
      device = RealtimeDeviceStreamStats(192, 192, 0, 0, true, 0),
      renderLevel = null,
      captureLevel = 0f,
    )
}
