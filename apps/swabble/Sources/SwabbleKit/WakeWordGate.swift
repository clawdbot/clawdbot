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

    public var end: TimeInterval {
        self.start + self.duration
    }
}

public struct WakeWordGateConfig: Sendable, Equatable {
    public var triggers: [String]
    public var minPostTriggerGap: TimeInterval
    public var minCommandLength: Int

    public init(
        triggers: [String],
        minPostTriggerGap: TimeInterval = 0.45,
        minCommandLength: Int = 1)
    {
        self.triggers = triggers
        self.minPostTriggerGap = minPostTriggerGap
        self.minCommandLength = minCommandLength
    }
}

public struct WakeWordGateMatch: Sendable, Equatable {
    public let triggerEndTime: TimeInterval
    public let postGap: TimeInterval
    public let command: String
    public let trigger: String?

    public init(
        triggerEndTime: TimeInterval,
        postGap: TimeInterval,
        command: String,
        trigger: String? = nil)
    {
        self.triggerEndTime = triggerEndTime
        self.postGap = postGap
        self.command = command
        self.trigger = trigger
    }
}

public enum WakeWordGate {
    private struct Token {
        let normalized: String
        let start: TimeInterval
        let end: TimeInterval
    }

    private struct TriggerTokens {
        let source: String
        let tokens: [String]
    }

    private struct MatchCandidate {
        let endIndex: Int
        let tokenCount: Int
        let triggerEnd: TimeInterval
        let gap: TimeInterval
        let trigger: String
    }

    public static func match(
        transcript: String,
        segments: [WakeWordSegment],
        config: WakeWordGateConfig)
    -> WakeWordGateMatch? {
        let triggerTokens = self.normalizeTriggers(config.triggers)
        guard !triggerTokens.isEmpty else { return nil }

        let tokens = self.normalizeSegments(segments)
        guard !tokens.isEmpty else { return nil }

        let best = self.bestCandidate(
            triggers: triggerTokens,
            tokens: tokens,
            minimumGap: config.minPostTriggerGap)

        guard let best else { return nil }
        let command = self.commandText(transcript: transcript, segments: segments, triggerEndTime: best.triggerEnd)
            .trimmingCharacters(in: Self.whitespaceAndPunctuation)
        guard command.count >= config.minCommandLength else { return nil }
        return WakeWordGateMatch(
            triggerEndTime: best.triggerEnd,
            postGap: best.gap,
            command: command,
            trigger: best.trigger)
    }

    public static func commandText(
        transcript _: String,
        segments: [WakeWordSegment],
        triggerEndTime: TimeInterval)
    -> String {
        let threshold = triggerEndTime + 0.001
        var commandWords: [String] = []
        commandWords.reserveCapacity(segments.count)
        for segment in segments where segment.start >= threshold {
            let normalized = normalizeToken(segment.text)
            if normalized.isEmpty { continue }
            commandWords.append(segment.text)
        }
        return commandWords.joined(separator: " ").trimmingCharacters(in: Self.whitespaceAndPunctuation)
    }

    public static func matchesTextOnly(text: String, triggers: [String]) -> Bool {
        guard !text.isEmpty else { return false }
        let normalized = text.lowercased()
        for trigger in triggers {
            let token = trigger.trimmingCharacters(in: self.whitespaceAndPunctuation).lowercased()
            if token.isEmpty { continue }
            if normalized.contains(token) { return true }
        }
        return false
    }

    public static func stripWake(text: String, triggers: [String]) -> String {
        var out = text
        for trigger in triggers {
            let token = trigger.trimmingCharacters(in: self.whitespaceAndPunctuation)
            guard !token.isEmpty else { continue }
            out = out.replacingOccurrences(of: token, with: "", options: [.caseInsensitive])
        }
        return out.trimmingCharacters(in: self.whitespaceAndPunctuation)
    }

    private static func normalizeTriggers(_ triggers: [String]) -> [TriggerTokens] {
        var output: [TriggerTokens] = []
        for trigger in triggers {
            let tokens = trigger
                .split(whereSeparator: { $0.isWhitespace })
                .map { self.normalizeToken(String($0)) }
                .filter { !$0.isEmpty }
            if tokens.isEmpty { continue }
            output.append(TriggerTokens(source: tokens.joined(separator: " "), tokens: tokens))
        }
        return output
    }

    private static func bestCandidate(
        triggers: [TriggerTokens],
        tokens: [Token],
        minimumGap: TimeInterval)
    -> MatchCandidate? {
        var best: MatchCandidate?
        for trigger in triggers {
            for index in tokens.indices {
                guard let candidate = self.candidate(
                    trigger: trigger,
                    at: index,
                    tokens: tokens,
                    minimumGap: minimumGap)
                else { continue }
                if self.isPreferred(candidate, over: best) {
                    best = candidate
                }
            }
        }
        return best
    }

    private static func candidate(
        trigger: TriggerTokens,
        at index: Int,
        tokens: [Token],
        minimumGap: TimeInterval)
    -> MatchCandidate? {
        let count = trigger.tokens.count
        guard count > 0, index + count < tokens.count else { return nil }
        guard (0..<count).allSatisfy({ tokens[index + $0].normalized == trigger.tokens[$0] }) else {
            return nil
        }

        let triggerEnd = tokens[index + count - 1].end
        let gap = tokens[index + count].start - triggerEnd
        guard gap >= minimumGap else { return nil }
        return MatchCandidate(
            endIndex: index + count - 1,
            tokenCount: count,
            triggerEnd: triggerEnd,
            gap: gap,
            trigger: trigger.source)
    }

    private static func isPreferred(_ candidate: MatchCandidate, over current: MatchCandidate?) -> Bool {
        guard let current else { return true }
        if candidate.endIndex != current.endIndex {
            return candidate.endIndex > current.endIndex
        }
        return candidate.tokenCount > current.tokenCount
    }

    private static func normalizeSegments(_ segments: [WakeWordSegment]) -> [Token] {
        segments.compactMap { segment in
            let normalized = self.normalizeToken(segment.text)
            guard !normalized.isEmpty else { return nil }
            return Token(
                normalized: normalized,
                start: segment.start,
                end: segment.end)
        }
    }

    private static func normalizeToken(_ token: String) -> String {
        token
            .trimmingCharacters(in: self.whitespaceAndPunctuation)
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
