package ai.openclaw.app.ui

import ai.openclaw.app.VoiceCaptureMode
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthLogsSettingsScreenTest {
  @Test
  fun voiceReadinessUsesTypedCaptureMode() {
    assertTrue(
      voiceRuntimeReady(
        voiceCaptureMode = VoiceCaptureMode.ManualMic,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkAwaitingAgent = false,
      ),
    )
  }

  @Test
  fun voiceReadinessIncludesTransientTalkActivity() {
    assertTrue(
      voiceRuntimeReady(
        voiceCaptureMode = VoiceCaptureMode.Off,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkAwaitingAgent = true,
      ),
    )
  }

  @Test
  fun voiceReadinessIsFalseWhenTypedRuntimeIsInactive() {
    assertFalse(
      voiceRuntimeReady(
        voiceCaptureMode = VoiceCaptureMode.Off,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkAwaitingAgent = false,
      ),
    )
  }
}
