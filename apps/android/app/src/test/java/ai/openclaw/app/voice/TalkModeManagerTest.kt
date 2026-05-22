package ai.openclaw.app.voice

import ai.openclaw.app.gateway.DeviceAuthEntry
import ai.openclaw.app.gateway.DeviceAuthTokenStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import android.os.SystemClock
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
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

      setPrivateField(manager, "executionMode", TalkModeExecutionMode.RealtimeRelay)
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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun chatFinalWaitWithoutSubscribeUsesShortTimeout() =
    runTest {
      val manager = createManager(scope = this, supportsChatSubscribe = false)

      setPrivateField(manager, "pendingRunId", "run-missing-final")
      setPrivateField(manager, "pendingFinal", CompletableDeferred<Boolean>())

      assertFalse(manager.waitForChatFinal("run-missing-final"))
      assertEquals(6_000, currentTime)
    }

  private fun createManager(
    talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(),
    talkAudioPlayer: TalkAudioPlaying? = null,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    supportsChatSubscribe: Boolean = false,
    isConnected: () -> Boolean = { true },
    onStoppedByRelay: () -> Unit = {},
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
      supportsChatSubscribe = supportsChatSubscribe,
      isConnected = isConnected,
      onStoppedByRelay = onStoppedByRelay,
      talkSpeakClient = talkSpeakClient,
      talkAudioPlayer = talkAudioPlayer ?: TalkAudioPlayer(app),
    )
  }

  @Suppress("UNCHECKED_CAST")
  private fun playbackGeneration(manager: TalkModeManager) = readPrivateField(manager, "playbackGeneration") as AtomicLong

  @Suppress("UNCHECKED_CAST")
  private fun realtimeToolRuns(manager: TalkModeManager) = readPrivateField(manager, "realtimeToolRuns") as MutableMap<String, RealtimeToolRun>

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
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) = Unit

  override fun clearToken(
    deviceId: String,
    role: String,
  ) = Unit
}
