import Foundation

public struct WakeWordSegment: Sendable, Equatable {
    public let text: String
    public let start: TimeInterval
    public let duration: TimeInterval
    public let range: Range<String.Index>?

    public init(text: String, start: TimeInterval, duration: TimeInterval, range: Range<String.Index>? = nil) {
        self.text = text
        self.start = start
        self.duration = duration
        self.range = range
    }

    public var end: TimeInterval { start + duration }
}

public struct WakeWordGateConfig: Sendable, Equatable {
    public var triggers: [String]
    public var minPostTriggerGap: TimeInterval
    public var minCommandLength: Int

    public init(
        triggers: [String],
        minPostTriggerGap: TimeInterval = 0.45,
        minCommandLength: Int = 1) {
        self.triggers = triggers
        self.minPostTriggerGap = minPostTriggerGap
        self.minCommandLength = minCommandLength
    }
}

public struct WakeWordGateMatch: Sendable, Equatable {
    public let triggerEndTime: TimeInterval
    public let postGap: TimeInterval
    public let command: String

    public init(triggerEndTime: TimeInterval, postGap: TimeInterval, command: String) {
        self.triggerEndTime = triggerEndTime
        self.postGap = postGap
        self.command = command
    }
}

public enum WakeWordGate {
    private struct Token {
        let normalized: String
        let start: TimeInterval
        let end: TimeInterval
        let range: Range<String.Index>?
        let text: String
    }

    private struct TriggerTokens {
        let tokens: [String]
    }

    private struct MatchCandidate {
        let index: Int
        let triggerEnd: TimeInterval
        let gap: TimeInterval
    }

    public static func match(
        transcript: String,
        segments: [WakeWordSegment],
        config: WakeWordGateConfig)
    -> WakeWordGateMatch? {
        let triggerTokens = normalizeTriggers(config.triggers)
        guard !triggerTokens.isEmpty else { return nil }

        let tokens = normalizeSegments(segments)
        guard !tokens.isEmpty else { return nil }

        var best: MatchCandidate?

        for trigger in triggerTokens {
            let count = trigger.tokens.count
            guard count > 0, tokens.count > count else { continue }
            for i in 0...(tokens.count - count - 1) {
                let matched = (0..<count).allSatisfy { tokens[i + $0].normalized == trigger.tokens[$0] }
                if !matched { continue }

                let triggerEnd = tokens[i + count - 1].end
                let nextToken = tokens[i + count]
                let gap = nextToken.start - triggerEnd
                if gap < config.minPostTriggerGap { continue }

                if let best, i <= best.index { continue }

                best = MatchCandidate(index: i, triggerEnd: triggerEnd, gap: gap)
            }
        }

        guard let best else { return nil }
        let command = commandText(transcript: transcript, segments: segments, triggerEndTime: best.triggerEnd)
            .trimmingCharacters(in: Self.whitespaceAndPunctuation)
        guard command.count >= config.minCommandLength else { return nil }
        return WakeWordGateMatch(triggerEndTime: best.triggerEnd, postGap: best.gap, command: command)
    }

    public static func commandText(
        transcript: String,
        segments: [WakeWordSegment],
        triggerEndTime: TimeInterval)
    -> String {
        let threshold = triggerEndTime + 0.001
        for segment in segments where segment.start >= threshold {
            if normalizeToken(segment.text).isEmpty { continue }
            if let range = segment.range {
                let slice = transcript[range.lowerBound...]
                return String(slice).trimmingCharacters(in: Self.whitespaceAndPunctuation)
            }
            break
        }

        let text = segments
            .filter { $0.start >= threshold && !normalizeToken($0.text).isEmpty }
            .map(\.text)
            .joined(separator: " ")
        return text.trimmingCharacters(in: Self.whitespaceAndPunctuation)
    }

    public static func matchesTextOnly(text: String, triggers: [String]) -> Bool {
        guard !text.isEmpty else { return false }
        let normalized = text.lowercased()
        for trigger in triggers {
            let token = trigger.trimmingCharacters(in: whitespaceAndPunctuation).lowercased()
            if token.isEmpty { continue }
            if normalized.contains(token) { return true }
        }
        return false
    }

    public static func stripWake(text: String, triggers: [String]) -> String {
        var out = text
        for trigger in triggers {
            let token = trigger.trimmingCharacters(in: whitespaceAndPunctuation)
            guard !token.isEmpty else { continue }
            out = out.replacingOccurrences(of: token, with: "", options: [.caseInsensitive])
        }
        return out.trimmingCharacters(in: whitespaceAndPunctuation)
    }

    private static func normalizeTriggers(_ triggers: [String]) -> [TriggerTokens] {
        var output: [TriggerTokens] = []
        for trigger in triggers {
            let tokens = trigger
                .split(whereSeparator: { $0.isWhitespace })
                .map { normalizeToken(String($0)) }
                .filter { !$0.isEmpty }
            if tokens.isEmpty { continue }
            output.append(TriggerTokens(tokens: tokens))
        }
        return output
    }

    private static func normalizeSegments(_ segments: [WakeWordSegment]) -> [Token] {
        segments.compactMap { segment in
            let normalized = normalizeToken(segment.text)
            guard !normalized.isEmpty else { return nil }
            return Token(
                normalized: normalized,
                start: segment.start,
                end: segment.end,
                range: segment.range,
                text: segment.text)
        }
    }

    private static func normalizeToken(_ token: String) -> String {
        token
            .trimmingCharacters(in: whitespaceAndPunctuation)
            .lowercased()
    }

    private static let whitespaceAndPunctuation = CharacterSet.whitespacesAndNewlines
        .union(.punctuationCharacters)
}

#if canImport(Speech)
import Speech

public enum WakeWordSpeechSegments {
    public static func from(transcription: SFTranscription, transcript: String) -> [WakeWordSegment] {
        transcription.segments.map { segment in
            let range = Range(segment.substringRange, in: transcript)
            return WakeWordSegment(
                text: segment.substring,
                start: segment.timestamp,
                duration: segment.duration,
                range: range)
        }
    }
}
#endif
