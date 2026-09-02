package ai.openclaw.app.voice

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayClientInfo
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.testDeviceIdentityStore
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.notifyNativeLocaleChanged
import ai.openclaw.app.i18n.verbatimText
import android.Manifest
import android.content.ComponentName
import android.content.IntentFilter
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.Base64
import androidx.core.os.LocaleListCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ThreadContextElement
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
import kotlinx.coroutines.withTimeoutOrNull
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.AbstractCoroutineContextElement
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
        installRealtimeSession(manager, "relay-1")
        manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"audio","talkEvent":{"turnId":" "},"audioBase64":""}""")
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
  fun retiredStopTtsCannotReplaceAnotherCancellationWaiter() =
    runTest {
      val manager = createManager(scope = backgroundScope)
      val priorClear = CompletableDeferred<String?>()
      installRealtimeSession(manager, "relay-a")
      manager.realtimeEvent("""{"relaySessionId":"relay-a","type":"audio","talkEvent":{"turnId":"turn-a"},"audioBase64":""}""")
      setPrivateField(manager, "pendingRealtimeOutputClear", priorClear)

      manager.stopTts()
      installRealtimeSession(manager, "relay-b")
      manager.realtimeEvent("""{"relaySessionId":"relay-b","type":"audio","talkEvent":{"turnId":"turn-b"},"audioBase64":""}""")
      runCurrent()

      assertTrue(readPrivateField(manager, "pendingRealtimeOutputClear") === priorClear)
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

    installRealtimeSession(manager, "relay-1")
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
  fun aDeferredTerminalNotificationCannotStopAReplacementTalkStart() {
    var claim: (() -> Boolean)? = null
    val manager = createManager(onStoppedByRelay = { claim = it })
    installRealtimeSession(manager, "relay-1")
    setMutableStateFlow(manager, "_isEnabled", true)
    manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"close","reason":"completed"}""")
    assertTrue(checkNotNull(claim).invoke())
    // NodeRuntime invalidates capture before its asynchronous voice-wake suppression work.
    manager.stopAllCapture()
    assertFalse(checkNotNull(claim).invoke())
  }

  @Test
  fun realtimeClosePreservesTypedFailureWithoutEnglishPrefix() {
    val manager = createManager()

    installRealtimeSession(manager, "relay-1")
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
      NativeStringResources.install(RuntimeEnvironment.getApplication())
      try {
        NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
        notifyNativeLocaleChanged()
        assertEquals("Désactivé", manager.statusText.value)
        advanceUntilIdle()
        assertTrue(turn.await() is TimeoutCancellationException)
      } finally {
        NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
        notifyNativeLocaleChanged()
      }
    }

  @Test
  fun realtimePlaybackMarkAcknowledgesAfterQueuedAudioBarrier() =
    runTest {
      val acknowledgements = mutableListOf<Pair<String, String>>()
      val manager =
        createManager(
          scope = backgroundScope,
          realtimePlaybackDispatcher = StandardTestDispatcher(testScheduler),
          realtimeMarkAcknowledger = { sessionId, markName ->
            acknowledgements += sessionId to markName
          },
        )
      installRealtimeSession(manager, "relay-1")

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
  fun responseStartMarksAwaitingAgentUntilStatusMovesOn() {
    val manager = createRealtimeManager()

    assertFalse(manager.awaitingAgent.value)
    manager.transcript("user", "hello", final = true)
    assertFalse("A transcript does not prove response work has started", manager.awaitingAgent.value)
    manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"responseStarted","turnId":"response-turn"}""")
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
      val manager = createManager(scope = backgroundScope)

      installRealtimeSession(manager, "relay-1")
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
  fun localPlaybackReleasesItsAudioFocusForEveryTerminalOutcome() =
    runTest {
      for (outcome in listOf("completed", "failed", "focus-lost", "cancelled")) {
        withStartedLocalPlayback { manager, playback, player ->
          val audio = shadowOf(RuntimeEnvironment.getApplication().getSystemService(AudioManager::class.java))
          val focus = checkNotNull(audio.lastAudioFocusRequest.audioFocusRequest)
          when (outcome) {
            "completed" -> player.finished.complete(Unit)
            "failed" -> player.finished.completeExceptionally(IllegalStateException("speaker failed"))
            "focus-lost" -> audio.lastAudioFocusRequest.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
            "cancelled" -> manager.stopTts()
          }
          runCurrent()
          assertTrue("Playback must finish after $outcome", playback.isCompleted)
          assertFalse(manager.isSpeaking.value)
          assertSame("Focus must return after $outcome", focus, audio.lastAbandonedAudioFocusRequest)
        }
      }
    }

  @Test
  fun cancelledPlaybackCompletionKeepsReplacementSpeaking() =
    runTest {
      val audio = shadowOf(RuntimeEnvironment.getApplication().getSystemService(AudioManager::class.java))
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
          val firstFocus = checkNotNull(audio.lastAudioFocusRequest)

          // Cancellation queues the old caller's cleanup; the replacement may
          // start before that cleanup runs on another dispatcher.
          val next = launch(start = CoroutineStart.UNDISPATCHED) { manager.speakAssistantReply("Replacement reply") }
          replacement = next
          assertEquals(2, player.playCalls)
          assertEquals(2, callbackDepth)
          assertTrue(first.isCancelled)
          assertFalse(first.isCompleted)
          assertTrue(manager.isSpeaking.value)
          val replacementFocus = checkNotNull(audio.lastAudioFocusRequest.audioFocusRequest)
          firstFocus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)

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
          assertSame(replacementFocus, audio.lastAbandonedAudioFocusRequest)
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
  @Config(shadows = [PlayoutAudioTrack::class])
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
      proof.scheduler.runCurrent()
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
  @Config(shadows = [DeadRealtimeAudioTrack::class])
  fun realtimeDeviceFailureStopsTheRelayWithVisibleFailure() =
    runBlocking {
      withRealtimePlayback { proof ->
        val pcm = ByteArray(100)
        proof.manager.handleGatewayEvent(
          "talk.event",
          """{"relaySessionId":"playback-relay","type":"audio","talkEvent":{"turnId":"failed-turn"},"audioBase64":"${Base64.encodeToString(pcm, Base64.NO_WRAP)}"}""",
        )
        proof.scheduler.runCurrent()
        assertFalse("A failed output device must not leave Talk silently enabled", proof.manager.isEnabled.value)
        assertTrue(
          proof.manager.statusText.value
            .contains("audio playback device error"),
        )
        assertFalse(proof.manager.isSpeaking.value)
      }
    }

  @Test
  fun retiredPttRestartCannotReopenRecognition() {
    val manager = createManager()
    val recognizer = SpeechRecognizer.createSpeechRecognizer(RuntimeEnvironment.getApplication())
    setPrivateField(manager, "recognizer", recognizer)
    setPrivateField(manager, "activePttCaptureId", "replacement-capture")
    val start =
      manager.javaClass
        .getDeclaredMethod(
          "startPushToTalkRecognition",
          String::class.java,
          PushToTalkRecognitionCandidate::class.java,
        ).also { it.isAccessible = true }
    try {
      start.invoke(manager, "retired-capture", PushToTalkRecognitionCandidate.SilenceSegmented)
      assertNull("A stale restart must not reacquire native recognition", shadowOf(recognizer).lastRecognizerIntent)
      assertFalse(manager.isListening.value)
    } finally {
      manager.stopAllCapture()
    }
  }

  @Test
  fun rawPttCloseWaitsForInFlightDeviceCleanup() =
    runBlocking {
      val releaseEntered = CountDownLatch(1)
      val finishRelease = CountDownLatch(1)
      val recorder =
        object : AudioRecord(
          MediaRecorder.AudioSource.VOICE_RECOGNITION,
          16_000,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          16_000,
        ) {
          override fun release() {
            releaseEntered.countDown()
            check(finishRelease.await(10, TimeUnit.SECONDS))
            super.release()
          }
        }
      val pipe = ParcelFileDescriptor.createPipe()
      val type = Class.forName("ai.openclaw.app.voice.PushToTalkAudioSource")
      val source =
        type
          .getDeclaredConstructor(
            ParcelFileDescriptor::class.java,
            ParcelFileDescriptor.AutoCloseOutputStream::class.java,
            AudioRecord::class.java,
          ).also { it.isAccessible = true }
          .newInstance(pipe[0], ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]), recorder)
      val finish = type.getDeclaredMethod("finishFromPump").also { it.isAccessible = true }
      val close = type.getDeclaredMethod("close").also { it.isAccessible = true }
      val finishing = async(Dispatchers.Default) { finish.invoke(source) }
      val closeStarted = CompletableDeferred<Unit>()
      var closing: kotlinx.coroutines.Deferred<*>? = null
      try {
        assertTrue(releaseEntered.await(5, TimeUnit.SECONDS))
        closing =
          async(Dispatchers.Default) {
            closeStarted.complete(Unit)
            close.invoke(source)
          }
        closeStarted.await()
        assertNull(
          "close must wait for the cleanup that owns the recorder",
          withTimeoutOrNull(250) {
            closing.await()
            true
          },
        )
      } finally {
        finishRelease.countDown()
        finishing.await()
        closing?.await() ?: close.invoke(source)
      }
      assertEquals(AudioRecord.STATE_UNINITIALIZED, recorder.state)
    }

  @Test
  fun destroyedContinuousRecognizerCannotFailItsReplacement() =
    runTest {
      val manager = createManager(scope = this)
      val app = RuntimeEnvironment.getApplication()
      val retired = SpeechRecognizer.createSpeechRecognizer(app)
      setPrivateField(manager, "recognizer", retired)
      val retiredListener = recognitionListener(manager, null)
      manager.stopAllCapture()
      val replacement = SpeechRecognizer.createSpeechRecognizer(app)
      setPrivateField(manager, "recognizer", replacement)
      setPrivateField(manager, "stopRequested", false)
      setMutableStateFlow(manager, "_isEnabled", true)
      setMutableStateFlow(manager, "_isListening", true)
      val status = manager.statusText.value
      try {
        retiredListener.onError(SpeechRecognizer.ERROR_AUDIO)
        assertTrue("A late native callback must not stop the replacement listener", manager.isListening.value)
        assertEquals(status, manager.statusText.value)
      } finally {
        manager.stopAllCapture()
      }
    }

  @Test
  fun manualMicWaitsForRealtimeDeviceAndCaptureRetirement() =
    runBlocking {
      withNodeOwningRealtimePlayback { runtime, proof ->
        val track = startRealtimeAudio(proof)
        runtime.setMicEnabled(true)
        assertFalse("Manual mic cannot overlap the old Talk device", runtime.micEnabled.value)
        proof.scheduler.runCurrent()
        assertEquals(AudioTrack.STATE_UNINITIALIZED, track.state)
        assertFalse("Capture cancellation must also finish before the handoff", runtime.micEnabled.value)
        proof.drainCancelledCapture()
        withTimeout(5_000) {
          while (!runtime.micEnabled.value) {
            proof.scheduler.runCurrent()
            withContext(Dispatchers.Default) { delay(10) }
          }
        }
        assertEquals(VoiceCaptureMode.ManualMic, runtime.voiceCaptureMode.value)
      }
    }

  @Test
  fun sameTalkModeReassertionStopsManualMicCapture() =
    runBlocking {
      withNodeOwningRealtimePlayback { runtime, proof ->
        val mic = (readPrivateField(runtime, "micCapture\$delegate") as Lazy<*>).value as MicCaptureManager
        mic.setMicEnabled(true)
        assertTrue(runtime.micEnabled.value)
        runtime.setTalkModeEnabled(true)
        assertFalse(runtime.micEnabled.value)
        proof.drainCancelledCapture()
        withTimeout(5_000) {
          while (!proof.manager.isEnabled.value) {
            proof.scheduler.runCurrent()
            withContext(Dispatchers.Default) { delay(10) }
          }
        }
        assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
        assertTrue(proof.manager.isEnabled.value)
      }
    }

  @Test
  fun repeatedStopKeepsOtherMicOwnersBlockedUntilRealtimeCleanupFinishes() =
    runBlocking {
      withNodeOwningRealtimePlayback { runtime, proof ->
        val track = startRealtimeAudio(proof)
        runtime.setTalkModeEnabled(false)
        runtime.setTalkModeEnabled(false)
        assertFalse(runtime.tryAcquireVoiceNoteMic())
        assertFalse(runtime.tryAcquireDictationMic())
        assertFalse(runtime.setCameraAudioCaptureActive(true))
        proof.scheduler.runCurrent()
        assertEquals(AudioTrack.STATE_UNINITIALIZED, track.state)
        assertFalse(runtime.tryAcquireVoiceNoteMic())
        proof.drainCancelledCapture()
        withTimeout(5_000) {
          while (!runtime.tryAcquireVoiceNoteMic()) {
            proof.scheduler.runCurrent()
            withContext(Dispatchers.Default) { delay(10) }
          }
        }
        runtime.releaseVoiceNoteMic()
        assertTrue(runtime.tryAcquireDictationMic())
        runtime.releaseDictationMic()
        assertTrue(runtime.setCameraAudioCaptureActive(true))
        runtime.setCameraAudioCaptureActive(false)
      }
    }

  private suspend fun withNodeOwningRealtimePlayback(block: suspend (NodeRuntime, RealtimePlaybackProof) -> Unit) {
    val app = RuntimeEnvironment.getApplication()
    val prefs = SecurePrefs(app, app.getSharedPreferences("node-playback-${System.nanoTime()}", 0))
    val runtime = NodeRuntime(app, prefs, mode = NodeRuntimeMode.ScreenshotFixture)
    try {
      ((readPrivateField(runtime, "micCapture\$delegate") as Lazy<*>).value as MicCaptureManager).onGatewayConnectionChanged(false)
      withRealtimePlayback { proof ->
        setPrivateField(runtime, "talkMode\$delegate", lazyOf(proof.manager))
        setMutableStateFlow(runtime, "_voiceCaptureMode", VoiceCaptureMode.TalkMode)
        setMutableStateFlow(runtime, "externalAudioCaptureActive", true)
        block(runtime, proof)
      }
    } finally {
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  @Test
  fun relayFailureRetainsTheCaptureOwnerFromAdmissionDuringNewPttPreparation() =
    runBlocking {
      var captureEpoch = 1
      var stoppedReplacement = false
      withRealtimePlayback(captureRelayStopNotification = {
        val admittedEpoch = captureEpoch

        fun(isCurrent: () -> Boolean) {
          if (admittedEpoch == captureEpoch && isCurrent()) stoppedReplacement = true
        }
      }) { proof ->
        // PTT preparation claims the outer owner before it enters the Talk manager.
        captureEpoch++
        proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"close","reason":"error"}""")
        assertFalse(proof.manager.isEnabled.value)
        assertFalse(stoppedReplacement)
      }
    }

  @Test
  fun finalAssistantTextRestoresIdleWithoutConsumingLaterAudio() =
    runBlocking {
      for ((playbackEnabled, responseStarted) in listOf(false, true).flatMap { playback -> listOf(playback to false, playback to true) }) {
        withRealtimePlayback { proof ->
          proof.manager.setPlaybackEnabled(playbackEnabled)
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Question","final":true}""")
          if (responseStarted) proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"realtime-turn"}""")
          assertEquals(responseStarted, proof.manager.awaitingAgent.value)
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"Answer","final":true,"talkEvent":{"turnId":"realtime-turn"}}""")
          proof.scheduler.runCurrent()
          assertEquals("Answer", proof.manager.lastAssistantText.value)
          assertFalse("Final text with no pending playback must leave Thinking", proof.manager.awaitingAgent.value)
          assertEquals("Listening", proof.manager.statusText.value)
          if (playbackEnabled) {
            // Google can finish output transcription before a later audio part arrives.
            startRealtimeAudio(proof)
            assertEquals("Speaking…", proof.manager.statusText.value)
          }
        }
      }
    }

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun finalAssistantTextWaitsForQueuedAudioPresentation() =
    runBlocking {
      PlayoutAudioTrack.reset()
      PlayoutAudioTrack.presentedFrames = 0
      PlayoutAudioTrack.timestampFrames = 0
      val acknowledged = CompletableDeferred<Unit>()
      try {
        withRealtimePlayback(responseForRequest = { request, _ ->
          if (request.getValue("method").jsonPrimitive.content == "talk.session.acknowledgeMark") acknowledged.complete(Unit)
          null
        }) { proof ->
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Question","final":true}""")
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"realtime-turn"}""")
          val pcm = ByteArray(4_800)
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","talkEvent":{"turnId":"realtime-turn"},"audioBase64":"${Base64.encodeToString(pcm, Base64.NO_WRAP)}"}""")
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"mark","markName":"last-chunk"}""")
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"Answer","final":true,"talkEvent":{"turnId":"realtime-turn"}}""")
          assertTrue("Queued audio must be observed before changing response status", proof.manager.awaitingAgent.value)
          proof.scheduler.runCurrent()
          assertTrue(proof.manager.isSpeaking.value)
          assertEquals("Speaking…", proof.manager.statusText.value)
          assertFalse("Final text cannot acknowledge unpresented audio", acknowledged.isCompleted)
          PlayoutAudioTrack.presentedFrames = pcm.size / 2
          PlayoutAudioTrack.timestampFrames = pcm.size / 2L
          proof.scheduler.advanceTimeBy(20)
          proof.scheduler.runCurrent()
          withTimeout(5_000) { acknowledged.await() }
          assertFalse(proof.manager.isSpeaking.value)
          assertFalse(proof.manager.awaitingAgent.value)
          assertEquals("Listening", proof.manager.statusText.value)
        }
      } finally {
        PlayoutAudioTrack.reset()
      }
    }

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun providerClearStopsPreviousAudioAfterNextResponseStarts() =
    runBlocking {
      PlayoutAudioTrack.reset()
      try {
        withRealtimePlayback { proof ->
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"First question","final":true,"talkEvent":{"turnId":"realtime-turn"}}""")
          val track = startRealtimeAudio(proof)
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"First answer","final":true,"talkEvent":{"turnId":"realtime-turn"}}""")
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Second question","final":true,"talkEvent":{"turnId":"next-turn"}}""")
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"next-turn"}""")
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"Second answer","final":false,"talkEvent":{"turnId":"next-turn"}}""")
          proof.scheduler.runCurrent()
          assertTrue(proof.manager.isSpeaking.value)
          assertTrue(proof.manager.awaitingAgent.value)

          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"clear","talkEvent":{"type":"output.audio.done","turnId":"realtime-turn","final":true}}""")
          proof.scheduler.runCurrent()

          assertEquals("A newer transcript cannot prevent clearing queued playback", AudioTrack.STATE_UNINITIALIZED, track.state)
          assertFalse(proof.manager.isSpeaking.value)
          assertTrue("Clearing old audio cannot finish the next response", proof.manager.awaitingAgent.value)
          assertEquals("Thinking…", proof.manager.statusText.value)
          assertEquals(
            listOf("First question", "First answer", "Second question", "Second answer"),
            proof.manager.conversation.value
              .map { it.text },
          )
        }
      } finally {
        PlayoutAudioTrack.reset()
      }
    }

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun queuedFinalTextCannotFinishNewerUserThinking() = assertOldOutputPreservesNewerUserThinking(withAudio = false)

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun presentedOldAudioCannotFinishNewerUserThinking() = assertOldOutputPreservesNewerUserThinking(withAudio = true)

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun continuingOldOutputCannotFinishNewerUserThinking() {
    for (lateEvent in listOf("audio", "final-text")) {
      for (playback in listOf("playing", "drained", "cleared")) {
        assertOldOutputPreservesNewerUserThinking(withAudio = true, lateEvent = lateEvent, drainedBeforeInput = playback == "drained", clearBeforeInput = playback == "cleared")
      }
    }
  }

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun responseLifecycleOwnsStatusAcrossContinuationAndLateInput() =
    runBlocking {
      for (drainedBeforeInput in listOf(false, true)) {
        PlayoutAudioTrack.reset()
        try {
          withRealtimePlayback { proof ->
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"First question","final":true}""")
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"realtime-turn"}""")
            startRealtimeAudio(proof)
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audioDone","talkEvent":{"type":"turn.ended","turnId":"realtime-turn","final":true}}""")
            PlayoutAudioTrack.timestampFrames = 2_400L
            proof.scheduler.advanceTimeBy(20)
            proof.scheduler.runCurrent()
            assertEquals("Listening", proof.manager.statusText.value)

            val continuationStart = """{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"continuation-turn"}"""
            proof.manager.realtimeEvent(continuationStart)
            assertTrue("A continuation is admitted work without a new user transcript", proof.manager.awaitingAgent.value)
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","audioBase64":"${Base64.encodeToString(ByteArray(4_800), Base64.NO_WRAP)}","talkEvent":{"turnId":"continuation-turn"}}""")
            proof.scheduler.runCurrent()
            assertTrue(proof.manager.isSpeaking.value)
            proof.manager.realtimeEvent(continuationStart)
            assertEquals("A duplicate response start cannot reset playback", "Speaking…", proof.manager.statusText.value)
            assertFalse(proof.manager.awaitingAgent.value)
            if (drainedBeforeInput) {
              PlayoutAudioTrack.timestampFrames = 4_800L
              proof.scheduler.advanceTimeBy(20)
              proof.scheduler.runCurrent()
              assertFalse(proof.manager.isSpeaking.value)
            }
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Next question","final":true,"talkEvent":{"turnId":"continuation-turn"}}""")
            assertEquals(
              "Next question",
              proof.manager.conversation.value
                .last()
                .text,
            )
            assertFalse("Late input does not identify what the continuation answered", proof.manager.awaitingAgent.value)
            assertEquals(if (drainedBeforeInput) "Listening" else "Speaking…", proof.manager.statusText.value)

            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"next-turn"}""")
            assertTrue(proof.manager.awaitingAgent.value)
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audioDone","talkEvent":{"type":"turn.ended","turnId":"continuation-turn","final":true}}""")
            proof.scheduler.runCurrent()
            assertEquals(!drainedBeforeInput, proof.manager.isSpeaking.value)
            assertTrue("A stale terminal cannot finish newer work", proof.manager.awaitingAgent.value)
            assertEquals("Thinking…", proof.manager.statusText.value)
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audioDone","talkEvent":{"type":"turn.ended","turnId":"next-turn","final":true}}""")
            proof.scheduler.runCurrent()
            assertEquals(!drainedBeforeInput, proof.manager.isSpeaking.value)
            assertFalse("An empty matching terminal must finish its response while earlier audio remains buffered", proof.manager.awaitingAgent.value)
            assertEquals(if (drainedBeforeInput) "Listening" else "Speaking…", proof.manager.statusText.value)
            PlayoutAudioTrack.timestampFrames = 4_800L
            proof.scheduler.advanceTimeBy(20)
            proof.scheduler.runCurrent()
            assertFalse(proof.manager.isSpeaking.value)
            assertEquals("Listening", proof.manager.statusText.value)
          }
        } finally {
          PlayoutAudioTrack.reset()
        }
      }
    }

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun consultWorkCannotBeFinishedByEarlierPlayback() =
    runBlocking {
      PlayoutAudioTrack.reset()
      try {
        withRealtimePlayback(responseForRequest = { request, _ ->
          if (request.getValue("method").jsonPrimitive.content == "talk.client.toolCall") """{"runId":"working-run"}""" else null
        }) { proof ->
          startRealtimeAudio(proof)
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"toolCall","callId":"next-consult","name":"openclaw_agent_consult","args":{"question":"Next question"}}""")
          withTimeout(5_000) {
            while (!proof.manager.awaitingAgent.value) {
              proof.scheduler.runCurrent()
              withContext(Dispatchers.Default) { delay(10) }
            }
          }
          PlayoutAudioTrack.timestampFrames = 2_400L
          proof.scheduler.advanceTimeBy(20)
          proof.scheduler.runCurrent()
          assertFalse(proof.manager.isSpeaking.value)
          assertTrue("Earlier playback cannot finish an admitted consult", proof.manager.awaitingAgent.value)
          assertEquals("Thinking…", proof.manager.statusText.value)
          startRealtimeAudio(proof)
          assertFalse("Newly admitted audio can advance the current work phase", proof.manager.awaitingAgent.value)
          assertEquals("Speaking…", proof.manager.statusText.value)
        }
      } finally {
        PlayoutAudioTrack.reset()
      }
    }

  @Test
  @Config(shadows = [PlayoutAudioTrack::class])
  fun lateFinalUserTranscriptKeepsTheAnsweredUtteranceStatus() =
    runBlocking {
      val cases =
        listOf("consult-audio", "stopped-audio", "cleared-audio", "active-audio", "drained-audio", "local-replay")
          .flatMap { mode -> listOf(Triple(mode, true, false), Triple(mode, false, false)) } +
          listOf(Triple("active-audio", false, true), Triple("drained-audio", false, true))
      for ((mode, earlyPartial, completedPreviousTurn) in cases) {
        PlayoutAudioTrack.reset()
        try {
          withRealtimePlayback(responseForRequest = { request, _ ->
            if (request.getValue("method").jsonPrimitive.content == "talk.client.toolCall") """{"runId":"consult-run"}""" else null
          }) { proof ->
            val encodedAudio = Base64.encodeToString(ByteArray(4_800), Base64.NO_WRAP)
            if (completedPreviousTurn) {
              proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Previous question","final":true,"talkEvent":{"turnId":"previous-turn"}}""")
              proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","audioBase64":"$encodedAudio","talkEvent":{"turnId":"previous-turn"}}""")
              proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"Previous answer","final":true,"talkEvent":{"turnId":"previous-turn"}}""")
              proof.scheduler.runCurrent()
              assertTrue(proof.manager.isSpeaking.value)
              PlayoutAudioTrack.timestampFrames = 2_400L
              proof.scheduler.advanceTimeBy(20)
              proof.scheduler.runCurrent()
              assertFalse(proof.manager.isSpeaking.value)
              assertEquals("Listening", proof.manager.statusText.value)
            }
            val completedFrames = if (completedPreviousTurn) 4_800L else 2_400L
            if (earlyPartial) {
              proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Can you tack","final":false,"talkEvent":{"turnId":"active-turn"}}""")
            }
            val partialUserId =
              proof.manager.conversation.value
                .lastOrNull { it.role == VoiceConversationRole.User }
                ?.id
            if (mode == "consult-audio") {
              proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"toolCall","callId":"consult-call","name":"openclaw_agent_consult","args":{"question":"Synthetic question"}}""")
              withTimeout(5_000) {
                while (!proof.manager.awaitingAgent.value) {
                  proof.scheduler.runCurrent()
                  withContext(Dispatchers.Default) { delay(10) }
                }
              }
            }
            val audio = """{"relaySessionId":"playback-relay","type":"audio","audioBase64":"$encodedAudio","talkEvent":{"turnId":"active-turn"}}"""
            if (mode == "local-replay") {
              proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"Checking","final":true}""")
            } else {
              proof.manager.realtimeEvent(audio)
            }
            proof.scheduler.runCurrent()
            assertEquals(mode != "local-replay", proof.manager.isSpeaking.value)
            if (mode == "stopped-audio") {
              proof.manager.stopTts()
              proof.scheduler.runCurrent()
              assertFalse(proof.manager.isSpeaking.value)
            }
            if (mode == "cleared-audio") {
              proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"clear","talkEvent":{"turnId":"active-turn"}}""")
              proof.scheduler.runCurrent()
              assertFalse(proof.manager.isSpeaking.value)
            }
            if (mode == "drained-audio") {
              PlayoutAudioTrack.timestampFrames = completedFrames
              proof.scheduler.advanceTimeBy(20)
              proof.scheduler.runCurrent()
              assertFalse(proof.manager.isSpeaking.value)
            }
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Can you check?","final":true,"talkEvent":{"turnId":"active-turn"}}""")
            val userEntry =
              proof.manager.conversation.value
                .last { it.role == VoiceConversationRole.User }
            if (earlyPartial) assertEquals(partialUserId, userEntry.id)
            val userId = userEntry.id
            assertEquals("Can you check?", userEntry.text)
            val awaitingAfterUserTranscript = proof.manager.awaitingAgent.value
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"Checking","final":true,"talkEvent":{"turnId":"active-turn"}}""")
            PlayoutAudioTrack.timestampFrames = completedFrames
            proof.scheduler.advanceTimeBy(20)
            proof.scheduler.runCurrent()
            assertFalse(proof.manager.isSpeaking.value)
            assertEquals(
              "Finalizing an answered utterance cannot restart Thinking or outlive playback ($mode, earlyPartial=$earlyPartial, completedPreviousTurn=$completedPreviousTurn)",
              false to "Listening",
              awaitingAfterUserTranscript to proof.manager.statusText.value,
            )
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Second question","final":false,"talkEvent":{"turnId":"active-turn"}}""")
            if (mode != "local-replay") {
              proof.manager.realtimeEvent(audio)
              proof.scheduler.runCurrent()
              assertEquals("A partial transcript does not replace the physical playback phase", if (mode == "stopped-audio") "Listening" else "Speaking…", proof.manager.statusText.value)
            }
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Second question","final":true,"talkEvent":{"turnId":"active-turn"}}""")
            assertFalse("Even a distinct transcript does not prove new work was admitted", proof.manager.awaitingAgent.value)
            assertTrue(
              userId !=
                proof.manager.conversation.value
                  .last()
                  .id,
            )
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"inputAudio","byteLength":960}""")
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"next-turn"}""")
            assertTrue("An admitted response owns the waiting status", proof.manager.awaitingAgent.value)
            PlayoutAudioTrack.timestampFrames = completedFrames + 2_400L
            proof.scheduler.advanceTimeBy(20)
            proof.scheduler.runCurrent()
            assertFalse(proof.manager.isSpeaking.value)
            assertTrue("Earlier audio cannot finish newly admitted work", proof.manager.awaitingAgent.value)
            assertEquals("Thinking…", proof.manager.statusText.value)
          }
        } finally {
          PlayoutAudioTrack.reset()
        }
      }
    }

  private fun assertOldOutputPreservesNewerUserThinking(
    withAudio: Boolean,
    lateEvent: String? = null,
    drainedBeforeInput: Boolean = false,
    clearBeforeInput: Boolean = false,
  ) = runBlocking {
    PlayoutAudioTrack.reset()
    try {
      withRealtimePlayback { proof ->
        proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"First question","final":true,"talkEvent":{"turnId":"active-turn"}}""")
        proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"active-turn"}""")
        if (withAudio) {
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","audioBase64":"${Base64.encodeToString(ByteArray(4_800), Base64.NO_WRAP)}","talkEvent":{"turnId":"active-turn"}}""")
          proof.scheduler.runCurrent()
          assertTrue(proof.manager.isSpeaking.value)
        }
        val finalText = """{"relaySessionId":"playback-relay","type":"transcript","role":"assistant","text":"First answer","final":true,"talkEvent":{"turnId":"active-turn"}}"""
        if (lateEvent == null) proof.manager.realtimeEvent(finalText)
        if (drainedBeforeInput) {
          PlayoutAudioTrack.timestampFrames = 2_400L
          proof.scheduler.advanceTimeBy(20)
          proof.scheduler.runCurrent()
          assertFalse(proof.manager.isSpeaking.value)
        }
        if (clearBeforeInput) {
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"clear","talkEvent":{"turnId":"active-turn"}}""")
          proof.scheduler.runCurrent()
        }
        // Old output can be queued before the next response starts, even after its input transcript.
        proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"transcript","role":"user","text":"Second question","final":true,"talkEvent":{"turnId":"active-turn"}}""")
        when (lateEvent) {
          "audio" -> proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","audioBase64":"${Base64.encodeToString(ByteArray(4_800), Base64.NO_WRAP)}","talkEvent":{"turnId":"active-turn"}}""")
          "final-text" -> proof.manager.realtimeEvent(finalText)
        }
        proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"responseStarted","turnId":"next-turn"}""")
        proof.scheduler.runCurrent()
        assertTrue("Queued old output cannot claim a newly admitted response", proof.manager.awaitingAgent.value)
        if (withAudio) PlayoutAudioTrack.timestampFrames = if (lateEvent == "audio") 4_800L else 2_400L
        proof.scheduler.advanceTimeBy(20)
        proof.scheduler.runCurrent()
        assertFalse(proof.manager.isSpeaking.value)
        assertTrue("Old output completion cannot finish a newer admitted response", proof.manager.awaitingAgent.value)
        assertEquals("Thinking…", proof.manager.statusText.value)
        if (lateEvent != null) {
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","audioBase64":"${Base64.encodeToString(ByteArray(4_800), Base64.NO_WRAP)}","talkEvent":{"turnId":"next-turn"}}""")
          proof.scheduler.runCurrent()
          assertTrue("A new output turn must claim the current request", proof.manager.isSpeaking.value)
          assertFalse(proof.manager.awaitingAgent.value)
        }
      }
    } finally {
      PlayoutAudioTrack.reset()
    }
  }

  @Test
  fun createdRelayRejectedAtAdmissionIsClosed() =
    runBlocking {
      val creates =
        java.util.concurrent.atomic
          .AtomicInteger()
      val pending = CompletableDeferred<Pair<String, WebSocket>>()
      val closed = CompletableDeferred<Unit>()
      withRealtimePlayback(interceptRequest = { request, socket ->
        val method = request.getValue("method").jsonPrimitive.content
        if (method == "talk.session.close" && request["params"]
            ?.jsonObject
            ?.get("sessionId")
            ?.jsonPrimitive
            ?.content == "unadmitted-relay"
        ) {
          closed.complete(Unit)
        }
        if (method == "talk.session.create" && creates.incrementAndGet() == 2) {
          pending.complete(request.getValue("id").jsonPrimitive.content to socket)
          true
        } else {
          false
        }
      }) { proof ->
        proof.manager.stopAllCapture()
        proof.drainCancelledCapture()
        proof.manager.setEnabled(true)
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!pending.isCompleted) {
          proof.scheduler.runCurrent()
          check(System.nanoTime() < deadline) { "Replacement relay create was not requested" }
          withContext(Dispatchers.Default) { delay(10) }
        }
        val (requestId, socket) = pending.await()
        val pumping =
          java.util.concurrent.atomic
            .AtomicBoolean(true)
        var worker: Thread? = null
        try {
          synchronized(readPrivateField(proof.manager, "realtimeCapturePauseLock")!!) {
            socket.send("""{"type":"res","id":"$requestId","ok":true,"payload":{"relaySessionId":"unadmitted-relay"}}""")
            worker =
              Thread {
                while (pumping.get()) {
                  proof.scheduler.runCurrent()
                  Thread.yield()
                }
              }.also { it.start() }
            val lockDeadline = System.nanoTime() + 5_000_000_000L
            while (worker.state != Thread.State.BLOCKED) {
              check(System.nanoTime() < lockDeadline) { "Create response did not reach locked admission" }
              Thread.yield()
            }
            proof.manager.stopAllCapture()
          }
          assertNotNull("A remotely created but unadmitted relay must be closed", withTimeoutOrNull(5_000) { closed.await() })
          assertFalse(proof.manager.isEnabled.value)
        } finally {
          pumping.set(false)
          worker?.join(5_000)
          assertFalse("Scheduler worker must terminate", worker?.isAlive == true)
        }
      }
    }

  @Test
  fun stoppedPushToTalkAdmissionCannotPauseLaterTalk() =
    runBlocking {
      installSpeechRecognitionService()
      withRealtimePlayback { proof ->
        var stopped = false
        val stopBeforePause =
          object : ThreadContextElement<Unit>, AbstractCoroutineContextElement(object : CoroutineContext.Key<ThreadContextElement<Unit>> {}) {
            override fun updateThreadContext(context: CoroutineContext) {
              if (!stopped && proof.manager.activePushToTalkCaptureId != null) {
                stopped = true
                proof.manager.stopAllCapture()
              }
            }

            override fun restoreThreadContext(
              context: CoroutineContext,
              oldState: Unit,
            ) = Unit
          }
        val obsolete = proof.scope.async(stopBeforePause) { runCatching { proof.manager.beginPushToTalk(allowNewCapture = true) } }

        suspend fun awaitState(condition: () -> Boolean) {
          val deadline = System.nanoTime() + 5_000_000_000L
          while (!condition()) {
            proof.scheduler.runCurrent()
            check(System.nanoTime() < deadline) { "Timed out waiting for PTT admission boundary" }
            withContext(Dispatchers.Default) { delay(10) }
          }
        }
        awaitState {
          if (stopped) proof.drainCancelledCapture()
          obsolete.isCompleted
        }
        assertTrue("Stop must occur after PTT admission and before its awaited completion", stopped)
        assertTrue(obsolete.await().isFailure)
        proof.manager.setEnabled(true)
        awaitState { readPrivateField(proof.manager, "realtimeSessionId") != null }
        assertTrue("A retired PTT admission cannot leave later Talk paused", proof.manager.isListening.value)
      }
    }

  @Test
  fun retiredPushToTalkCannotEnqueueCancellationAfterPhysicalCleanup() =
    runBlocking {
      installSpeechRecognitionService()
      val cancellations =
        java.util.concurrent.atomic
          .AtomicInteger()
      withRealtimePlayback(responseForRequest = { request, _ ->
        if (request.getValue("method").jsonPrimitive.content == "talk.session.cancelOutput") {
          cancellations.incrementAndGet()
          """{"ok":true,"status":"idle","turnId":"old-turn"}"""
        } else {
          null
        }
      }) { proof ->
        proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","talkEvent":{"turnId":"old-turn"},"audioBase64":"AAA="}""")
        val obsolete = proof.scope.async { runCatching { proof.manager.beginPushToTalk(allowNewCapture = true) } }
        val admissionDeadline = System.nanoTime() + 5_000_000_000L
        while (proof.manager.activePushToTalkCaptureId == null) {
          proof.scheduler.runCurrent()
          check(System.nanoTime() < admissionDeadline) { "Timed out admitting push-to-talk" }
          withContext(Dispatchers.Default) { delay(10) }
        }
        assertNotNull(proof.manager.activePushToTalkCaptureId)
        assertTrue("PTT must still await its retired physical input", proof.manager.audioRetirement.pending)
        assertEquals(0, cancellations.get())

        proof.manager.stopAllCapture()
        proof.drainCancelledCapture()
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!obsolete.isCompleted) {
          proof.scheduler.runCurrent()
          proof.drainCancelledCapture()
          check(System.nanoTime() < deadline) { "Timed out retiring push-to-talk" }
          withContext(Dispatchers.Default) { delay(10) }
        }
        assertTrue(obsolete.await().isFailure)
        assertEquals("Retired PTT must not send cancellation after physical cleanup", 0, cancellations.get())
      }
    }

  @Test
  fun retiredPushToTalkCancellationCannotStopReplacementRelay() =
    runBlocking {
      installSpeechRecognitionService()
      for (applied in listOf(false, true)) {
        val pending = CompletableDeferred<Pair<String, WebSocket>>()
        withRealtimePlayback(interceptRequest = { request, socket ->
          if (request.getValue("method").jsonPrimitive.content == "talk.session.cancelOutput") {
            pending.complete(request.getValue("id").jsonPrimitive.content to socket)
            true
          } else {
            false
          }
        }) { proof ->
          suspend fun awaitState(condition: () -> Boolean) {
            val deadline = System.nanoTime() + 5_000_000_000L
            while (!condition()) {
              proof.scheduler.runCurrent()
              check(System.nanoTime() < deadline) { "Timed out waiting for push-to-talk transition" }
              withContext(Dispatchers.Default) { delay(10) }
            }
          }
          proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","talkEvent":{"turnId":"old-turn"},"audioBase64":"AAA="}""")
          val oldStart = proof.scope.async { runCatching { proof.manager.beginPushToTalk(allowNewCapture = true) } }
          proof.scheduler.runCurrent()
          proof.drainCancelledCapture()
          awaitState {
            proof.drainCancelledCapture()
            pending.isCompleted
          }
          proof.manager.stopAllCapture()
          proof.drainCancelledCapture()
          proof.manager.setEnabled(true)
          awaitState { proof.manager.isListening.value }
          val (requestId, socket) = pending.await()
          socket.send(
            if (applied) {
              """{"type":"res","id":"$requestId","ok":true,"payload":{"ok":true,"status":"applied","turnId":"old-turn"}}"""
            } else {
              """{"type":"res","id":"$requestId","ok":false,"error":{"code":"UNAVAILABLE","message":"old cancellation failed"}}"""
            },
          )
          awaitState { oldStart.isCompleted }
          assertTrue("The retired PTT request must reject capture", oldStart.await().isFailure)
          assertTrue("Old cancellation must leave the replacement relay enabled", proof.manager.isEnabled.value)
          assertTrue("Old cancellation must leave the replacement relay listening", proof.manager.isListening.value)
        }
      }
    }

  @Test
  fun providerClearCannotCompletePushToTalkCancellation() =
    runBlocking {
      installSpeechRecognitionService()
      val pending = CompletableDeferred<Pair<String, WebSocket>>()
      val providerClearDrained = mapOf("unkeyed" to CompletableDeferred<Unit>(), "keyed" to CompletableDeferred<Unit>())
      withRealtimePlayback(interceptRequest = { request, socket ->
        when (request.getValue("method").jsonPrimitive.content) {
          "talk.session.cancelOutput" -> {
            pending.complete(request.getValue("id").jsonPrimitive.content to socket)
            true
          }

          "talk.session.acknowledgeMark" -> {
            request["params"]
              ?.jsonObject
              ?.get("markName")
              ?.jsonPrimitive
              ?.content
              ?.let { providerClearDrained[it]?.complete(Unit) }
            false
          }

          else -> {
            false
          }
        }
      }) { proof ->
        suspend fun awaitState(condition: () -> Boolean) {
          val deadline = System.nanoTime() + 5_000_000_000L
          while (!condition()) {
            proof.scheduler.runCurrent()
            proof.drainCancelledCapture()
            check(System.nanoTime() < deadline) { "Timed out waiting for push-to-talk cancellation boundary" }
            withContext(Dispatchers.Default) { delay(10) }
          }
        }
        proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","talkEvent":{"turnId":"old-turn"},"audioBase64":"AAA="}""")
        val starting = proof.scope.async { runCatching { proof.manager.beginPushToTalk(allowNewCapture = true) } }
        awaitState { pending.isCompleted }
        val clear = readPrivateField(proof.manager, "pendingRealtimeOutputClear") as CompletableDeferred<*>
        val (requestId, socket) = pending.await()
        var replied = false
        try {
          val completedByProviderClear = mutableMapOf<String, Boolean>()
          for ((kind, drained) in providerClearDrained) {
            val talkEvent = if (kind == "keyed") """, "talkEvent":{"type":"output.audio.done","turnId":"old-turn","final":true}""" else ""
            socket.send("""{"type":"event","event":"talk.event","payload":{"relaySessionId":"playback-relay","type":"clear","reason":"barge-in"$talkEvent}}""")
            // A mark after clear observes the real playback queue retiring before its acknowledgement.
            socket.send("""{"type":"event","event":"talk.event","payload":{"relaySessionId":"playback-relay","type":"mark","markName":"$kind"}}""")
            awaitState { drained.isCompleted && !proof.manager.audioRetirement.pending }
            completedByProviderClear[kind] = clear.isCompleted
            assertFalse("PTT must still await the cancellation RPC", starting.isCompleted)
          }

          socket.send("""{"type":"event","event":"talk.event","payload":{"relaySessionId":"playback-relay","type":"clear","talkEvent":{"type":"turn.cancelled","turnId":"old-turn"}}}""")
          socket.send("""{"type":"res","id":"$requestId","ok":true,"payload":{"ok":true,"status":"applied","turnId":"old-turn"}}""")
          replied = true
          awaitState { starting.isCompleted }

          assertEquals(
            "Provider playback clears cannot acknowledge explicit push-to-talk cancellation",
            mapOf("providerClearCompletedCancellation" to mapOf("unkeyed" to false, "keyed" to false), "relaySessionId" to "playback-relay", "pushToTalkStarted" to true),
            mapOf(
              "providerClearCompletedCancellation" to completedByProviderClear,
              "relaySessionId" to readPrivateField(proof.manager, "realtimeSessionId"),
              "pushToTalkStarted" to starting.await().isSuccess,
            ),
          )
        } finally {
          if (!replied) socket.send("""{"type":"res","id":"$requestId","ok":true,"payload":{"ok":true,"status":"idle"}}""")
        }
      }
    }

  @Test
  fun delayedStartFailureCannotStopTheReplacementRelay() =
    runBlocking {
      val creates =
        java.util.concurrent.atomic
          .AtomicInteger()
      val pending = CompletableDeferred<Pair<String, WebSocket>>()
      withRealtimePlayback(interceptRequest = { request, socket ->
        if (request.getValue("method").jsonPrimitive.content == "talk.session.create" && creates.incrementAndGet() == 2) {
          pending.complete(request.getValue("id").jsonPrimitive.content to socket)
          true
        } else {
          false
        }
      }) { proof ->
        suspend fun awaitState(condition: () -> Boolean) {
          val deadline = System.nanoTime() + 5_000_000_000L
          while (!condition()) {
            proof.scheduler.runCurrent()
            check(System.nanoTime() < deadline) { "Timed out waiting for relay transition" }
            withContext(Dispatchers.Default) { delay(10) }
          }
        }
        proof.manager.stopAllCapture()
        proof.drainCancelledCapture()
        proof.manager.setEnabled(true)
        val work = readPrivateField(proof.manager, "gatewayWorkJob") as Job
        awaitState { pending.isCompleted && work.children.count { it.isActive } == 1 }
        val oldStart = work.children.single { it.isActive }
        proof.manager.stopAllCapture()
        proof.drainCancelledCapture()
        proof.manager.setEnabled(true)
        awaitState { proof.manager.isListening.value }
        val (requestId, socket) = pending.await()
        socket.send("""{"type":"res","id":"$requestId","ok":false,"error":{"code":"UNAVAILABLE","message":"delayed start failure"}}""")
        awaitState { oldStart.isCompleted }
        assertTrue("An obsolete start error must not disable its replacement", proof.manager.isEnabled.value)
        assertTrue(proof.manager.isListening.value)
      }
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
    captureRelayStopNotification: () -> ((() -> Boolean) -> Unit) = { {} },
    responseForRequest: (JsonObject, WebSocket) -> String? = { _, _ -> null },
    interceptRequest: (JsonObject, WebSocket) -> Boolean = { _, _ -> false },
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
        captureRelayStopNotification = captureRelayStopNotification,
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
                if (interceptRequest(request, webSocket)) return
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
        block(
          RealtimePlaybackProof(manager, managerScope, scheduler, synthesizer, player, writes, {
            while (true) (captureTasks.poll() ?: break).run()
          }) { callbackDepth },
        )
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
  fun stopTtsDiscardsQueuedAudioWithoutStoppingLaterCapture() =
    runBlocking {
      val frames = java.util.concurrent.LinkedBlockingQueue<ByteArray>()
      val reads =
        java.util.concurrent.atomic
          .AtomicInteger()
      val firstFrameQueued = CountDownLatch(1)
      val resumedFrameQueued = CountDownLatch(1)
      val appends = ConcurrentLinkedQueue<String>()
      val cancelled = CompletableDeferred<Pair<String, WebSocket>>()
      val resumed = CompletableDeferred<Unit>()
      org.robolectric.shadows.ShadowAudioRecord.setSourceProvider {
        object : org.robolectric.shadows.ShadowAudioRecord.AudioRecordSource {
          override fun readInByteArray(
            bytes: ByteArray,
            offset: Int,
            size: Int,
            blocking: Boolean,
          ): Int {
            when (reads.incrementAndGet()) {
              2 -> firstFrameQueued.countDown()
              3 -> resumedFrameQueued.countDown()
            }
            val frame = checkNotNull(frames.poll(5, TimeUnit.SECONDS)) { "Capture fixture did not receive its next frame" }
            frame.copyInto(bytes, destinationOffset = offset)
            return frame.size
          }
        }
      }
      try {
        withRealtimePlayback(interceptRequest = { request, socket ->
          when (request.getValue("method").jsonPrimitive.content) {
            "talk.session.cancelOutput" -> {
              cancelled.complete(request.getValue("id").jsonPrimitive.content to socket)
              true
            }

            "talk.session.appendAudio" -> {
              appends +=
                request
                  .getValue("params")
                  .jsonObject
                  .getValue("audioBase64")
                  .jsonPrimitive.content
              resumed.complete(Unit)
              false
            }

            else -> {
              false
            }
          }
        }) { proof ->
          val gateway = readPrivateField(proof.manager, "session") as GatewaySession
          val transport = readPrivateField(gateway, "writeLock") as kotlinx.coroutines.sync.Mutex
          val lockOwner = Any()
          transport.lock(lockOwner)
          var held = true
          var capture: Thread? = null
          try {
            frames.put(byteArrayOf(1, 2))
            capture = Thread { proof.drainCancelledCapture() }.also { it.start() }
            assertTrue("Capture must queue the first frame", firstFrameQueued.await(5, TimeUnit.SECONDS))
            proof.drainCancelledCapture()
            proof.manager.realtimeEvent("""{"relaySessionId":"playback-relay","type":"audio","talkEvent":{"turnId":"old-turn"},"audioBase64":"AAA="}""")
            proof.manager.stopTts()
            proof.scheduler.runCurrent()
            assertNotNull(readPrivateField(proof.manager, "pendingRealtimeOutputClear"))

            transport.unlock(lockOwner)
            held = false
            val cancellationDeadline = System.nanoTime() + 5_000_000_000L
            while (!cancelled.isCompleted) {
              proof.drainCancelledCapture()
              proof.scheduler.runCurrent()
              check(System.nanoTime() < cancellationDeadline) { "Cancellation did not reach the peer" }
              withContext(Dispatchers.Default) { delay(10) }
            }
            val (id, socket) = withTimeout(5_000) { cancelled.await() }
            assertTrue("The peer must not receive a pre-cancellation frame", appends.isEmpty())
            socket.send("""{"type":"res","id":"$id","ok":true,"payload":{"ok":true,"status":"idle","turnId":"old-turn"}}""")
            val deadline = System.nanoTime() + 5_000_000_000L
            while (readPrivateField(proof.manager, "pendingRealtimeOutputClear") != null) {
              proof.scheduler.runCurrent()
              check(System.nanoTime() < deadline) { "Cancellation did not settle" }
              withContext(Dispatchers.Default) { delay(10) }
            }

            frames.put(byteArrayOf(3, 4))
            assertTrue("Capture must queue a new frame after cancellation", resumedFrameQueued.await(5, TimeUnit.SECONDS))
            proof.drainCancelledCapture()
            withTimeout(5_000) { resumed.await() }
            assertEquals(listOf(Base64.encodeToString(byteArrayOf(3, 4), Base64.NO_WRAP)), appends.toList())
            assertTrue(proof.manager.isEnabled.value)
          } finally {
            if (held) transport.unlock(lockOwner)
            proof.manager.stopAllCapture()
            frames.offer(byteArrayOf())
            capture?.join(5_000)
            assertFalse("Capture worker must terminate", capture?.isAlive == true)
            proof.drainCancelledCapture()
          }
        }
      } finally {
        org.robolectric.shadows.ShadowAudioRecord
          .clearSource()
      }
    }

  @Test
  fun realtimeAudioFramesStreamUntilPlaybackOrCancellationStarts() {
    val manager = createManager()

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 0))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 16))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, 4_800))

    setPrivateField(manager, "localMediaPlaybackActive", true)
    assertFalse(shouldAppendRealtimeCapturedFrame(manager, 4_800))
    setPrivateField(manager, "localMediaPlaybackActive", false)

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

      manager.prepareRealtimeCapturePause("capture-1", lease = null)()

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
      installRealtimeSession(manager, "relay-1")
      setMutableStateFlow(manager, "_isEnabled", true)

      manager.prepareRealtimeCapturePause("capture-1", lease = null)()

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
      manager.prepareRealtimeCapturePause("capture-new", lease = null)()
      setPrivateField(manager, "activePttCaptureId", "capture-new")

      manager.resumeRealtimeCaptureAfterPushToTalk("capture-old")

      assertTrue(readPrivateField(manager, "realtimeCapturePause") != null)
      assertEquals("capture-new", readPrivateField(manager, "activePttCaptureId"))
    }

  @Test
  fun pushToTalkPauseOutlivesRecognitionWhileRelayConnects() =
    runTest {
      val manager = createManager()

      manager.prepareRealtimeCapturePause("capture-1", lease = null)()
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
      manager.prepareRealtimeCapturePause("capture-1", lease = null)()
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      installRealtimeSession(manager, "relay-1")
      setMutableStateFlow(manager, "_isListening", false)
      manager.realtimeEvent("""{"relaySessionId":"relay-1","type":"transcript","role":"user","text":"Question","final":true}""")

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
      manager.prepareRealtimeCapturePause("capture-1", lease = null)()
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-replacement")
      setPrivateField(pause, "restartRelay", true)
      installRealtimeSession(manager, "relay-replacement")

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
      manager.prepareRealtimeCapturePause("capture-1", lease = null)()
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "restartRelay", true)
      setPrivateField(manager, "stopRequested", true)

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

      manager.prepareRealtimeCapturePause("capture-1", lease = null)()

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
        manager.prepareRealtimeCapturePause("capture-1", lease = null)()
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
      manager.prepareRealtimeCapturePause("capture-1", lease = null)()
      installRealtimeSession(manager, "relay-1")
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
      manager.prepareRealtimeCapturePause("capture-1", lease = null)()
      val pause = readPrivateField(manager, "realtimeCapturePause")!!
      setPrivateField(pause, "sessionId", "relay-1")
      installRealtimeSession(manager, "relay-1")
      setMutableStateFlow(manager, "_isListening", false)

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
    onStoppedByRelay: (isCurrent: () -> Boolean) -> Unit = {},
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
      captureRelayStopNotification = { onStoppedByRelay },
      talkSpeakClient = talkSpeakClient,
      talkAudioPlayer = talkAudioPlayer ?: TalkAudioPlayer(app),
      realtimeCaptureDispatcher = realtimeCaptureDispatcher,
      realtimePlaybackDispatcher = realtimePlaybackDispatcher,
      realtimeMarkAcknowledger = realtimeMarkAcknowledger,
    ).also { setPrivateField(it, "relayStopNotification", onStoppedByRelay) }
  }

  private fun createRealtimeManager(): TalkModeManager = createManager().also { installRealtimeSession(it, "relay-1") }

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

  private fun installRealtimeSession(
    manager: TalkModeManager,
    id: String?,
  ) {
    setPrivateField(manager, "realtimeSessionId", id)
    val owner =
      if (id == null) {
        null
      } else {
        val lease =
          GatewaySession.RequestLease("synthetic-gateway") { _, _, _, enqueue ->
            enqueue {}
            "{}"
          }
        val method = TalkModeManager::class.java.getDeclaredMethod("createRealtimePlayoutSession", String::class.java, GatewaySession.RequestLease::class.java)
        method.isAccessible = true
        method.invoke(manager, id, lease)
      }
    setPrivateField(manager, "realtimePlayoutSession", owner)
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
    captureId: String?,
  ): RecognitionListener {
    val owner =
      (readPrivateField(manager, "recognizer") as? SpeechRecognizer)
        ?: SpeechRecognizer.createSpeechRecognizer(RuntimeEnvironment.getApplication()).also { setPrivateField(manager, "recognizer", it) }
    val method = manager.javaClass.getDeclaredMethod("recognitionListener", String::class.java, SpeechRecognizer::class.java)
    method.isAccessible = true
    return method.invoke(manager, captureId, owner) as RecognitionListener
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
  val drainCancelledCapture: () -> Unit,
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

@org.robolectric.annotation.Implements(AudioTrack::class)
class DeadRealtimeAudioTrack : ShadowAudioTrack() {
  @org.robolectric.annotation.Implementation(minSdk = 23)
  override fun native_write_byte(
    audioData: ByteArray,
    offsetInBytes: Int,
    sizeInBytes: Int,
    format: Int,
    isBlocking: Boolean,
  ): Int = AudioTrack.ERROR_DEAD_OBJECT
}
