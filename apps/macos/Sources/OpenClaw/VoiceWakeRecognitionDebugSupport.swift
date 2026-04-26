import Foundation
import SwabbleKit

enum VoiceWakeRecognitionDebugSupport {
    struct TranscriptSummary {
        let textOnly: Bool
        let timingCount: Int
    }

    static func shouldLogTranscript(
        transcript: String,
        isFinal: Bool,
        loggerLevel: Logger.Level,
        lastLoggedText: inout String?,
        lastLoggedAt: inout Date?,
        minRepeatInterval: TimeInterval = 0.25) -> Bool
    {
        guard !transcript.isEmpty else { return false }
        guard loggerLevel == .debug || loggerLevel == .trace else { return false }
        if transcript == lastLoggedText,
           !isFinal,
           let last = lastLoggedAt,
           Date().timeIntervalSince(last) < minRepeatInterval
        {
            return false
        }
        lastLoggedText = transcript
        lastLoggedAt = Date()
        return true
    }

    static func textOnlyFallbackMatch(
        transcript: String,
        triggers: [String],
        config: WakeWordGateConfig,
        trimWake: (String, [String]) -> String) -> WakeWordGateMatch?
    {
        guard let command = VoiceWakeTextUtils.textOnlyCommand(
            transcript: transcript,
            triggers: triggers,
            minCommandLength: config.minCommandLength,
            trimWake: trimWake)
        else { return nil }
        return WakeWordGateMatch(
            triggerEndTime: 0,
            postGap: 0,
            command: command,
            trigger: VoiceWakeTextUtils.matchedTriggerWord(transcript: transcript, triggers: triggers))
    }

    static func transcriptSummary(
        transcript: String,
        triggers: [String],
        segments: [WakeWordSegment]) -> TranscriptSummary
    {
        TranscriptSummary(
            textOnly: WakeWordGate.matchesTextOnly(text: transcript, triggers: triggers),
            timingCount: segments.count(where: { $0.start > 0 || $0.duration > 0 }))
    }

    static func matchSummary(_ match: WakeWordGateMatch?) -> String {
        match.map {
            "match=true gap=\(String(format: "%.2f", $0.postGap))s cmdLen=\($0.command.count)"
        } ?? "match=false"
    }
}
