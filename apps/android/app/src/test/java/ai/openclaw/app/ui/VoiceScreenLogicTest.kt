package ai.openclaw.app.ui

import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.ui.design.TalkWaveformPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceScreenLogicTest {
  @Test
  fun voiceAttentionStatusKeepsFailedTalkStartVisibleAfterModeStops() {
    val attention =
      voiceAttentionStatus(
        talkModeStatusText = "Start failed: Error: Realtime voice provider \"openai\" is not configured",
        voiceCaptureMode = VoiceCaptureMode.Off,
        micEnabled = false,
        micIsSending = false,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
      )

    assertEquals("Realtime voice provider is not configured.", attention)
    assertEquals(
      attention,
      voiceStatusLabel(
        gatewayStatus = "Online",
        voiceCaptureMode = VoiceCaptureMode.Off,
        micStatusText = "Mic off",
        micQueuedMessages = 0,
        micIsSending = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        voiceAttentionStatus = attention,
      ),
    )
  }

  @Test
  fun voiceAttentionStatusDoesNotOverrideActiveTalkState() {
    assertNull(
      voiceAttentionStatus(
        talkModeStatusText = "Start failed: provider unavailable",
        voiceCaptureMode = VoiceCaptureMode.TalkMode,
        micEnabled = false,
        micIsSending = false,
        talkModeEnabled = true,
        talkModeListening = false,
        talkModeSpeaking = false,
      ),
    )
  }

  @Test
  fun voiceAttentionStatusDoesNotOverrideDictationState() {
    assertNull(
      voiceAttentionStatus(
        talkModeStatusText = "Start failed: provider unavailable",
        voiceCaptureMode = VoiceCaptureMode.ManualMic,
        micEnabled = true,
        micIsSending = false,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
      ),
    )
  }

  @Test
  fun voiceRuntimeAttentionStatusSanitizesTranscriptionProviderFailures() {
    assertEquals(
      "Realtime transcription provider is not configured.",
      voiceRuntimeAttentionStatus("Transcription unavailable: UNAVAILABLE: Error: No realtime transcription provider registered"),
    )
  }

  @Test
  fun voiceRuntimeAttentionStatusPreservesUtf16BoundariesAtLimit() {
    val splitPairPrefix = "failed: ${"x".repeat(78)}"
    assertEquals(
      "$splitPairPrefix...",
      voiceRuntimeAttentionStatus("$splitPairPrefix😀${"y".repeat(10)}"),
    )

    val completePairPrefix = "failed: ${"x".repeat(77)}"
    assertEquals(
      "$completePairPrefix😀...",
      voiceRuntimeAttentionStatus("$completePairPrefix😀${"y".repeat(10)}"),
    )
  }

  @Test
  fun talkSessionWaveformPhaseFollowsTalkState() {
    assertEquals(
      TalkWaveformPhase.Speaking(0.4f),
      talkSessionWaveformPhase(speaking = true, listening = true, awaitingAgent = false, inputLevel = 0.2f, speechActive = true, outputLevel = 0.4f),
    )
    // Awaiting the agent wins over the still-running capture loop.
    assertEquals(
      TalkWaveformPhase.Thinking,
      talkSessionWaveformPhase(speaking = false, listening = true, awaitingAgent = true, inputLevel = 0.2f, speechActive = false, outputLevel = null),
    )
    assertEquals(
      TalkWaveformPhase.Listening(level = 0.2f, speechActive = true),
      talkSessionWaveformPhase(speaking = false, listening = true, awaitingAgent = false, inputLevel = 0.2f, speechActive = true, outputLevel = null),
    )
    assertEquals(
      TalkWaveformPhase.Idle,
      talkSessionWaveformPhase(speaking = false, listening = false, awaitingAgent = false, inputLevel = 0f, speechActive = false, outputLevel = null),
    )
  }

  @Test
  fun voiceHeroWaveformPhasePrefersTalkOverDictation() {
    assertEquals(
      TalkWaveformPhase.Speaking(null),
      voiceHeroWaveformPhase(
        micEnabled = true,
        micInputLevel = 0.5f,
        talkModeEnabled = true,
        talkModeListening = true,
        talkModeSpeaking = true,
        talkInputLevel = 0.1f,
        talkOutputLevel = null,
        talkSpeechActive = false,
      ),
    )
    assertEquals(
      TalkWaveformPhase.Listening(level = 0.5f, speechActive = false),
      voiceHeroWaveformPhase(
        micEnabled = true,
        micInputLevel = 0.5f,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkInputLevel = 0f,
        talkOutputLevel = null,
        talkSpeechActive = false,
      ),
    )
    assertEquals(
      TalkWaveformPhase.Thinking,
      voiceHeroWaveformPhase(
        micEnabled = false,
        micInputLevel = 0f,
        talkModeEnabled = true,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkInputLevel = 0f,
        talkOutputLevel = null,
        talkSpeechActive = false,
      ),
    )
  }
}
