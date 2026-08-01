package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class PushToTalkRecognitionLadderTest {
  @Test
  fun api33StartsWithRawAudioThenFallsThroughInOrder() {
    assertEquals(
      listOf(
        PushToTalkRecognitionCandidate.RawAudioSegmented,
        PushToTalkRecognitionCandidate.SilenceSegmented,
        PushToTalkRecognitionCandidate.RestartingSingleSession,
      ),
      pushToTalkRecognitionCandidates(supportsSegmentedRecognition = true, first = null),
    )
  }

  @Test
  fun olderApisUseRestartingSingleSessionOnly() {
    assertEquals(
      listOf(PushToTalkRecognitionCandidate.RestartingSingleSession),
      pushToTalkRecognitionCandidates(supportsSegmentedRecognition = false, first = null),
    )
  }

  @Test
  fun degradedHoldNeverClimbsBackUpTheLadder() {
    assertEquals(
      listOf(
        PushToTalkRecognitionCandidate.SilenceSegmented,
        PushToTalkRecognitionCandidate.RestartingSingleSession,
      ),
      pushToTalkRecognitionCandidates(
        supportsSegmentedRecognition = true,
        first = PushToTalkRecognitionCandidate.SilenceSegmented,
      ),
    )
  }

  @Test
  fun rawSegmentedSessionEndAdvancesToSilenceButSilenceSessionEndRearms() {
    assertEquals(
      true,
      shouldAdvancePushToTalkRungAfterSegmentedSession(
        PushToTalkRecognitionCandidate.RawAudioSegmented,
      ),
    )
    assertEquals(
      false,
      shouldAdvancePushToTalkRungAfterSegmentedSession(
        PushToTalkRecognitionCandidate.SilenceSegmented,
      ),
    )
  }
}
