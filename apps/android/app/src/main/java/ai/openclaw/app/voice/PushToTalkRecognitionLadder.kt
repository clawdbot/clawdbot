package ai.openclaw.app.voice

internal enum class PushToTalkRecognitionCandidate {
  RawAudioSegmented,
  SilenceSegmented,
  RestartingSingleSession,
}

internal fun pushToTalkRecognitionCandidates(
  supportsSegmentedRecognition: Boolean,
  first: PushToTalkRecognitionCandidate?,
): List<PushToTalkRecognitionCandidate> {
  val available =
    if (supportsSegmentedRecognition) {
      PushToTalkRecognitionCandidate.entries
    } else {
      listOf(PushToTalkRecognitionCandidate.RestartingSingleSession)
    }
  if (first == null) return available
  return available.dropWhile { it != first }.ifEmpty { listOf(PushToTalkRecognitionCandidate.RestartingSingleSession) }
}

internal fun shouldAdvancePushToTalkRungAfterSegmentedSession(
  candidate: PushToTalkRecognitionCandidate,
): Boolean = candidate == PushToTalkRecognitionCandidate.RawAudioSegmented
