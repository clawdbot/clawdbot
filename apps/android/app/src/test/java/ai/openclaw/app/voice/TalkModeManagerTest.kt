package ai.openclaw.app.voice

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayClientInfo
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.testDeviceIdentityStore
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import android.Manifest
import android.content.ComponentName
import android.content.IntentFilter
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.Base64
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
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertArrayEquals
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
import org.robolectric.shadows.ShadowAudioTrack
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.shadows.ShadowTextToSpeech
import java.time.Duration
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.CoroutineContext

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
  fun stopTtsWithoutOutputIdentityCancelsPlaybackWithoutReplacingCancellationWaiter() =
    runTest {
      withStartedLocalPlayback { manager, playbackJob, player ->
        val pendingClear = CompletableDeferred<String?>()
        setPrivateField(manager, "realtimeSessionId", "relay-1")
        setPrivateField(manager, "realtimeOutputTurnId", " ")
        setPrivateField(manager, "pendingRealtimeOutputClear", pendingClear)
        val stops = player.stopCalls

        manager.stopTts()
        runCurrent()

        assertTrue(playbackJob.isCancelled)
        assertEquals(stops + 1, player.stopCalls)
        assertTrue(readPrivateField(manager, "pendingRealtimeOutputClear") === pendingClear)
      }
    }

  @Test
  fun stopTtsCancelsTheOutputOwnedWhenTheActionStarted() =
    runTest {
      val manager = createManager(scope = this)
      val priorClear = CompletableDeferred<String?>()
      setPrivateField(manager, "realtimeSessionId", "relay-a")
      setPrivateField(manager, "realtimeOutputTurnId", "turn-a")
      setPrivateField(manager, "pendingRealtimeOutputClear", priorClear)

      manager.stopTts()
      setPrivateField(manager, "realtimeSessionId", null)
      setPrivateField(manager, "realtimeOutputTurnId", "turn-b")
      runCurrent()

      assertNull(readPrivateField(manager, "pendingRealtimeOutputClear"))
    }

  @Test
  fun disablingPlaybackCancelsTrackedJobOnce() =
    runTest {
      withStartedLocalPlayback { manager, playbackJob, player ->
        val stops = player.stopCalls
        manager.setPlaybackEnabled(false)
        manager.setPlaybackEnabled(false)
        runCurrent()

        assertTrue(playbackJob.isCancelled)
        assertEquals(stops + 1, player.stopCalls)
      }
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
  fun realtimePlaybackMarkAcknowledgesAfterQueuedAudioBarrier() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = this,
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
  fun cancelledPlaybackCompletionKeepsReplacementSpeaking() =
    runTest {
      val synthesizer = FakeTalkSpeechSynthesizer()
      synthesizer.result.complete(
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
      val player = FakeTalkAudioPlayer()
      val managerJob = SupervisorJob()
      var callbackDepth = 0
      val manager =
        createManager(
          talkSpeakClient = synthesizer,
          talkAudioPlayer = player,
          scope = CoroutineScope(coroutineContext + managerJob),
          onBeforeSpeak = { callbackDepth += 1 },
          onAfterSpeak = { callbackDepth -= 1 },
        )
      withMain {
        val first = launch { manager.speakAssistantReply("First reply") }
        var replacement: Job? = null
        try {
          runCurrent()
          assertEquals(1, player.playCalls)
          assertEquals(1, callbackDepth)
          assertTrue(manager.isSpeaking.value)

          // Cancellation queues the old caller's cleanup; the replacement may
          // start before that cleanup runs on another dispatcher.
          val next = launch(start = CoroutineStart.UNDISPATCHED) { manager.speakAssistantReply("Replacement reply") }
          replacement = next
          assertEquals(2, player.playCalls)
          assertEquals(2, callbackDepth)
          assertTrue(first.isCancelled)
          assertFalse(first.isCompleted)
          assertTrue(manager.isSpeaking.value)

          runCurrent()
          assertTrue(first.isCompleted)
          assertTrue(next.isActive)
          assertFalse(player.finished.isCompleted)
          assertEquals(1, callbackDepth)
          assertTrue("The replacement is still playing after the cancelled caller finishes", manager.isSpeaking.value)

          player.finished.complete(Unit)
          next.join()
          assertFalse(manager.isSpeaking.value)
          assertEquals(0, callbackDepth)
        } finally {
          manager.stopAllCapture()
          first.cancelAndJoin()
          replacement?.cancelAndJoin()
          managerJob.cancelAndJoin()
          runCurrent()
          shadowOf(Looper.getMainLooper()).idle()
          runCurrent()
        }
      }
    }

  @Test
  fun localPreparationKeepsRealtimePlaybackSpeaking() =
    runBlocking {
      withRealtimePlayback { proof ->
        val track = startRealtimeAudio(proof)
        val local = proof.scope.launch { proof.manager.speakAssistantReply("Local reply") }
        proof.scheduler.runCurrent()

        assertTrue(proof.synthesizer.requested.isCompleted)
        assertFalse(proof.synthesizer.result.isCompleted)
        assertTrue(local.isActive)
        assertEquals(1, proof.callbackDepth())
        assertEquals(AudioTrack.PLAYSTATE_PLAYING, track.playState)
        assertTrue("Preparing a local reply must not hide realtime playback", proof.manager.isSpeaking.value)
      }
    }

  @Test
  fun localCompletionKeepsRealtimePlaybackSpeaking() =
    runBlocking {
      withRealtimePlayback { proof ->
        completeRemoteSynthesis(proof.synthesizer)
        val local = proof.scope.launch { proof.manager.speakAssistantReply("Local reply") }
        proof.scheduler.runCurrent()
        assertEquals(1, proof.player.playCalls)
        val track = startRealtimeAudio(proof)

        proof.player.finished.complete(Unit)
        proof.scheduler.runCurrent()

        assertTrue(local.isCompleted)
        assertEquals(0, proof.callbackDepth())
        assertEquals(AudioTrack.PLAYSTATE_PLAYING, track.playState)
        assertTrue("Completing a local reply must not hide realtime playback", proof.manager.isSpeaking.value)
      }
    }

  @Test
  fun realtimeClearKeepsLocalPlaybackSpeaking() = assertRealtimeEndKeepsLocalPlaybackSpeaking(clear = true)

  @Test
  fun realtimeIdleKeepsLocalPlaybackSpeaking() = assertRealtimeEndKeepsLocalPlaybackSpeaking(clear = false)

  private fun assertRealtimeEndKeepsLocalPlaybackSpeaking(clear: Boolean) =
    runBlocking {
      withRealtimePlayback { proof ->
        val track = startRealtimeAudio(proof)
        completeRemoteSynthesis(proof.synthesizer)
        val local = proof.scope.launch { proof.manager.speakAssistantReply("Local reply") }
        proof.scheduler.runCurrent()
        assertEquals(1, proof.player.playCalls)
        assertTrue(proof.manager.isSpeaking.value)
        val localStops = proof.player.stopCalls

        finishRealtimeAudio(proof, track, clear)

        assertTrue(local.isActive)
        assertFalse(proof.player.finished.isCompleted)
        assertEquals(localStops, proof.player.stopCalls)
        assertEquals(1, proof.callbackDepth())
        assertTrue("Ending realtime output must not hide the local reply", proof.manager.isSpeaking.value)
        proof.player.finished.complete(Unit)
        proof.scheduler.runCurrent()
        assertTrue(local.isCompleted)
        assertFalse(proof.manager.isSpeaking.value)
      }
    }

  private fun finishRealtimeAudio(
    proof: RealtimePlaybackProof,
    track: AudioTrack,
    clear: Boolean,
  ) {
    if (clear) {
      proof.manager.handleGatewayEvent(
        "talk.event",
        """{"relaySessionId":"playback-relay","type":"clear","talkEvent":{"turnId":"realtime-turn"}}""",
      )
      assertEquals(AudioTrack.STATE_UNINITIALIZED, track.state)
    } else {
      // The stock shadow accounts written frames immediately. Advance both
      // Android's playback clock and the coroutine idle poll beyond the PCM.
      val frames = proof.writes.sumOf { it.second.size } / 2
      assertEquals(frames, track.playbackHeadPosition)
      ShadowSystemClock.advanceBy(Duration.ofMillis(frames * 1_000L / 24_000 + 20))
      proof.scheduler.advanceTimeBy(20)
    }
    proof.scheduler.runCurrent()
  }

  private fun startRealtimeAudio(proof: RealtimePlaybackProof): AudioTrack {
    val pcm = ByteArray(4_800) { if (it % 2 == 0) 0x20 else 0x01 }
    val priorWrites = proof.writes.size
    proof.manager.handleGatewayEvent(
      "talk.event",
      """{"relaySessionId":"playback-relay","type":"audio","talkEvent":{"turnId":"realtime-turn"},"audioBase64":"${Base64.encodeToString(pcm, Base64.NO_WRAP)}"}""",
    )
    proof.scheduler.runCurrent()
    assertEquals(priorWrites + 1, proof.writes.size)
    val (track, written, format) = proof.writes.last()
    assertArrayEquals(pcm, written)
    assertEquals(24_000, format.sampleRate)
    assertEquals(AudioFormat.ENCODING_PCM_16BIT, format.encoding)
    assertEquals(AudioTrack.PLAYSTATE_PLAYING, track.playState)
    assertTrue(proof.manager.isSpeaking.value)
    return track
  }

  @Test
  fun relayConsultReturnsCanonicalOwnedResultOverGatewayConnection() =
    runBlocking {
      for ((voiceKey, agentKey) in listOf("main" to "agent:voice:main", "global" to "global")) {
        for (early in listOf(false, true)) {
          val socket = CompletableDeferred<WebSocket>()
          val result = CompletableDeferred<JsonObject>()
          val final = """{"type":"event","event":"chat","payload":{"sessionKey":"$agentKey","runId":"owned-run","state":"final","message":{"role":"assistant","content":"Owned reply"}}}"""
          withRealtimePlayback(
            sessionKey = voiceKey,
            responseForRequest = { request, webSocket ->
              socket.complete(webSocket)
              val params = request["params"]?.jsonObject
              when (request.getValue("method").jsonPrimitive.content) {
                "talk.client.toolCall" -> {
                  assertEquals(voiceKey, params?.getValue("sessionKey")?.jsonPrimitive?.content)
                  if (early) webSocket.send(final)
                  """{"runId":"owned-run","agentId":"voice","agentSessionKey":"$agentKey"}"""
                }

                "talk.session.submitToolResult" -> {
                  result.complete(checkNotNull(params))
                  "{}"
                }

                else -> {
                  null
                }
              }
            },
          ) { proof ->
            proof.manager.ttsOnAllResponses = true
            socket.await().send("""{"type":"event","event":"chat","payload":{"sessionKey":"other-session","runId":"private-run","state":"final","message":{"role":"assistant","content":"Private reply"}}}""")
            socket.await().send("""{"type":"event","event":"talk.event","payload":{"relaySessionId":"playback-relay","type":"toolCall","callId":"owned-call","name":"openclaw_agent_consult","args":{"question":"Synthetic question"}}}""")
            val deadline = System.nanoTime() + 5_000_000_000L
            var finalSent = early
            while (!result.isCompleted) {
              proof.scheduler.runCurrent()
              if (!finalSent && proof.manager.awaitingAgent.value) {
                socket.await().send(final)
                finalSent = true
              }
              check(System.nanoTime() < deadline) { "Android did not return the owned consult result (key=$voiceKey, early=$early)" }
              withContext(Dispatchers.Default) { delay(10) }
            }
            val submitted = result.await()
            assertEquals("playback-relay", submitted.getValue("sessionId").jsonPrimitive.content)
            assertEquals("owned-call", submitted.getValue("callId").jsonPrimitive.content)
            assertEquals(
              "Owned reply",
              submitted
                .getValue("result")
                .jsonObject
                .getValue("text")
                .jsonPrimitive.content,
            )
            assertFalse(proof.synthesizer.requested.isCompleted)
          }
        }
      }
    }

  private suspend fun withRealtimePlayback(
    sessionKey: String = "main",
    responseForRequest: (JsonObject, WebSocket) -> String? = { _, _ -> null },
    block: suspend (RealtimePlaybackProof) -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val sessionJob = SupervisorJob()
    val managerJob = SupervisorJob()
    val scheduler = TestCoroutineScheduler()
    val managerScope = CoroutineScope(StandardTestDispatcher(scheduler) + managerJob)
    val captureTasks = ConcurrentLinkedQueue<Runnable>()
    val captureDispatcher =
      object : CoroutineDispatcher() {
        override fun dispatch(
          context: CoroutineContext,
          block: Runnable,
        ) {
          captureTasks.add(block)
        }
      }
    val connected = CompletableDeferred<Unit>()
    lateinit var manager: TalkModeManager
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = testDeviceIdentityStore(app),
        deviceAuthStore = DeviceAuthStore(SecurePrefs(app, app.getSharedPreferences("talk-playback-${System.nanoTime()}", 0))),
        onConnected = { connected.complete(Unit) },
        onDisconnected = {},
        onEvent = { event, payload -> manager.handleGatewayEvent(event, payload) },
      )
    val synthesizer = FakeTalkSpeechSynthesizer()
    val player = FakeTalkAudioPlayer()
    var callbackDepth = 0
    manager =
      TalkModeManager(
        context = app,
        scope = managerScope,
        session = session,
        isConnected = { connected.isCompleted },
        talkSpeakClient = synthesizer,
        talkAudioPlayer = player,
        onBeforeSpeak = { callbackDepth += 1 },
        onAfterSpeak = { callbackDepth -= 1 },
        realtimeCaptureDispatcher = captureDispatcher,
        realtimePlaybackDispatcher = StandardTestDispatcher(scheduler),
      )
    val writes = mutableListOf<Triple<AudioTrack, ByteArray, AudioFormat>>()
    val listener = ShadowAudioTrack.OnAudioDataWrittenListener { track, bytes, format -> writes += Triple(track, bytes, format) }
    val server = MockWebServer()
    Dispatchers.setMain(StandardTestDispatcher(scheduler))
    try {
      try {
        server.enqueue(
          MockResponse().withWebSocketUpgrade(
            object : WebSocketListener() {
              override fun onOpen(
                webSocket: WebSocket,
                response: Response,
              ) {
                webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"talk-playback-test","ts":1700000000123}}""")
              }

              override fun onMessage(
                webSocket: WebSocket,
                text: String,
              ) {
                val request = Json.parseToJsonElement(text).jsonObject
                if (request["type"]?.jsonPrimitive?.content != "req") return
                val id = request.getValue("id").jsonPrimitive.content
                val payload =
                  responseForRequest(request, webSocket) ?: when (request.getValue("method").jsonPrimitive.content) {
                    "connect" -> """{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}"""
                    "talk.config" -> """{"config":{}}"""
                    "talk.session.create" -> """{"relaySessionId":"playback-relay"}"""
                    else -> "{}"
                  }
                webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":$payload}""")
              }
            },
          ),
        )
        server.start()
        session.connect(
          endpoint =
            GatewayEndpoint(
              stableId = "manual|127.0.0.1|${server.port}",
              name = "Playback test",
              host = "127.0.0.1",
              port = server.port,
              tlsEnabled = false,
            ),
          token = "test-token",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "operator",
              scopes = listOf("operator.admin"),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client = GatewayClientInfo("openclaw-android", "Android playback test", "1.0.0-test", "android", "ui", "playback-test", "android", "test"),
            ),
        )
        withContext(Dispatchers.Default) { withTimeout(5_000) { connected.await() } }
        manager.setMainSessionKey(sessionKey)
        manager.setEnabled(true)
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!manager.isListening.value) {
          scheduler.runCurrent()
          check(System.nanoTime() < deadline) { "Real gateway session did not start realtime Talk: ${manager.statusText.value}" }
          withContext(Dispatchers.Default) { delay(10) }
        }
        ShadowAudioTrack.addAudioDataListener(listener)
        block(RealtimePlaybackProof(manager, managerScope, scheduler, synthesizer, player, writes) { callbackDepth })
      } finally {
        manager.stopAllCapture()
        managerJob.cancel()
        scheduler.runCurrent()
        while (true) (captureTasks.poll() ?: break).run()
        scheduler.runCurrent()
        withTimeout(5_000) { managerJob.join() }
        shadowOf(Looper.getMainLooper()).idle()
        scheduler.runCurrent()
        ShadowAudioTrack.removeAudioDataListener(listener)
        withContext(Dispatchers.Default) {
          session.disconnectAndJoin()
          sessionJob.cancelAndJoin()
          server.shutdown()
        }
      }
    } finally {
      Dispatchers.resetMain()
    }
  }

  private fun completeRemoteSynthesis(synthesizer: FakeTalkSpeechSynthesizer) {
    synthesizer.result.complete(
      TalkSpeakResult.Success(
        TalkSpeakAudio(byteArrayOf(1, 2, 3), "test", "mp3_44100_128", true, "audio/mpeg", ".mp3"),
      ),
    )
  }

  private suspend fun TestScope.withStartedLocalPlayback(block: suspend (TalkModeManager, Job, FakeTalkAudioPlayer) -> Unit) {
    val synthesizer = FakeTalkSpeechSynthesizer()
    completeRemoteSynthesis(synthesizer)
    val player = FakeTalkAudioPlayer()
    val managerJob = SupervisorJob()
    val manager =
      createManager(
        talkSpeakClient = synthesizer,
        talkAudioPlayer = player,
        scope = CoroutineScope(coroutineContext + managerJob),
      )
    withMain {
      val playback = launch { manager.speakAssistantReply("Local reply") }
      try {
        runCurrent()
        assertEquals(1, player.playCalls)
        assertTrue(playback.isActive)
        assertTrue(manager.isSpeaking.value)
        block(manager, playback, player)
      } finally {
        manager.stopAllCapture()
        playback.cancelAndJoin()
        managerJob.cancelAndJoin()
        runCurrent()
        shadowOf(Looper.getMainLooper()).idle()
        runCurrent()
      }
    }
  }

  @Test
  fun localFallbackKeepsWholeReplyAndBalancesCallbacksOnCompletionOrStop() =
    runTest {
      for (stopAfterFirst in listOf(false, true)) {
        val callbacks = mutableListOf<String>()
        val synthesizer = FakeTalkSpeechSynthesizer()
        synthesizer.result.complete(TalkSpeakResult.FallbackToLocal("Gateway TTS unavailable"))
        val manager =
          createManager(
            talkSpeakClient = synthesizer,
            scope = this,
            onBeforeSpeak = { callbacks += "before" },
            onAfterSpeak = { callbacks += "after" },
          )
        setPrivateField(manager, "configLoaded", true)
        ShadowTextToSpeech.addLanguageAvailability(Locale.GERMAN)
        withMain(cleanup = { manager.stopAllCapture() }) {
          val reply = "Ein Wort. ".repeat(500).trim()
          val speech = launch { manager.speakAssistantReply("{\"language\":\"de\",\"speed\":1.25}\n$reply") }
          runCurrent()
          val shadow = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
          shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
          runCurrent()

          assertEquals(listOf("before"), callbacks)
          assertTrue(manager.isSpeaking.value)
          assertEquals(Locale.GERMAN, shadow.currentLanguage)
          assertEquals(1, shadow.spokenTextList.size)
          if (stopAfterFirst) manager.stopTts()
          while (!speech.isCompleted) {
            val submitted = shadow.spokenTextList.size
            shadowOf(Looper.getMainLooper()).idle()
            runCurrent()
            assertEquals(submitted + if (speech.isCompleted) 0 else 1, shadow.spokenTextList.size)
          }

          assertEquals(listOf("before", "after"), callbacks)
          assertFalse(manager.isSpeaking.value)
          val submittedText = shadow.spokenTextList.joinToString("")
          if (stopAfterFirst) {
            assertEquals(1, shadow.spokenTextList.size)
            assertTrue(reply.startsWith(submittedText) && submittedText.length < reply.length)
          } else {
            assertEquals(reply, submittedText)
          }
          assertTrue(shadow.spokenTextList.all { it.length <= TextToSpeech.getMaxSpeechInputLength() })
        }
        shadowOf(Looper.getMainLooper()).idle()
      }
    }

  @Test
  fun realtimeAudioFramesStreamUntilPlaybackOrCancellationStarts() {
    val manager = createManager()

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 0))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 16))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 4_800))

    setPrivateField(manager, "realtimePlaybackEndsAtMs", SystemClock.elapsedRealtime() + 1_000)

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 4_800))

    setPrivateField(manager, "realtimePlaybackEndsAtMs", SystemClock.elapsedRealtime() - 1)

    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 4_800))
    setPrivateField(manager, "pendingRealtimeOutputClear", CompletableDeferred<String?>())
    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 4_800))
    setPrivateField(manager, "pendingRealtimeOutputClear", null)
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
  fun pushToTalkWithoutOutputIdentityClosesRealtimeRelayWithoutWaitingForClear() =
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
      assertNull(readPrivateField(manager, "pendingRealtimeOutputClear"))
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      assertEquals("capture-1", readPrivateField(pause, "pttCaptureId"))
      assertTrue(readPrivateField(pause, "restartRelay") as Boolean)
      assertTrue(manager.isEnabled.value)
      assertFalse(stoppedByRelay)
    }

  @Test
  fun outputCancellationResultPreservesLegacyAndRecognizedRaceOutcomes() {
    val accepted =
      listOf(
        """{"ok":true}""" to null,
        """{"ok":true,"status":"applied"}""" to "applied",
        """{"ok":true,"turnId":"turn-1"}""" to null,
        """{"ok":true,"status":"applied","turnId":"turn-1"}""" to "applied",
        """{"ok":true,"status":"stale"}""" to "stale",
        """{"ok":true,"status":"idle"}""" to "idle",
      )

    accepted.forEach { (response, status) ->
      assertEquals(status, requireAcceptedRealtimeOutputCancellation(response, "turn-1").status)
    }
    assertEquals(
      "turn-from-server",
      requireAcceptedRealtimeOutputCancellation(
        """{"ok":true,"status":"applied","turnId":"turn-from-server"}""",
        null,
      ).turnId,
    )
  }

  @Test
  fun malformedOutputCancellationResultFailsClosed() {
    listOf(
      """{"ok":true,"status":"applied","turnId":"turn-2"}""",
      """{"status":"stale"}""",
      """{"ok":false}""",
      """{"ok":true,"status":"unknown"}""",
      """{"ok":true,"extra":1}""",
    ).forEach { response ->
      assertTrue(runCatching { requireAcceptedRealtimeOutputCancellation(response, "turn-1") }.isFailure)
    }
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
      assertNull(readPrivateField(manager, "realtimeCaptureJob"))
      assertNull(readPrivateField(manager, "realtimeAppendJob"))
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

  private fun createManager(
    talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(),
    talkAudioPlayer: TalkAudioPlaying? = null,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    isConnected: () -> Boolean = { true },
    onBeforeSpeak: suspend () -> Unit = {},
    onAfterSpeak: suspend () -> Unit = {},
    onStoppedByRelay: () -> Unit = {},
    realtimeCaptureDispatcher: CoroutineDispatcher = Dispatchers.IO,
    realtimePlaybackDispatcher: CoroutineDispatcher = Dispatchers.IO,
    realtimeMarkAcknowledger: (suspend (String, String) -> Unit)? = null,
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
      onBeforeSpeak = onBeforeSpeak,
      onAfterSpeak = onAfterSpeak,
      onStoppedByRelay = onStoppedByRelay,
      talkSpeakClient = talkSpeakClient,
      talkAudioPlayer = talkAudioPlayer ?: TalkAudioPlayer(app),
      realtimeCaptureDispatcher = realtimeCaptureDispatcher,
      realtimePlaybackDispatcher = realtimePlaybackDispatcher,
      realtimeMarkAcknowledger = realtimeMarkAcknowledger,
    )
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

private data class RealtimePlaybackProof(
  val manager: TalkModeManager,
  val scope: CoroutineScope,
  val scheduler: TestCoroutineScheduler,
  val synthesizer: FakeTalkSpeechSynthesizer,
  val player: FakeTalkAudioPlayer,
  val writes: List<Triple<AudioTrack, ByteArray, AudioFormat>>,
  val callbackDepth: () -> Int,
)

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
  var playCalls = 0
    private set
  var stopCalls = 0
    private set

  override suspend fun play(audio: TalkSpeakAudio) {
    playCalls += 1
    started.complete(Unit)
    finished.await()
  }

  override fun stop() {
    stopCalls += 1
    stopped = true
  }
}
