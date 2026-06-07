package ai.openclaw.app.ui

import ai.openclaw.app.VoiceCaptureMode
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
}
