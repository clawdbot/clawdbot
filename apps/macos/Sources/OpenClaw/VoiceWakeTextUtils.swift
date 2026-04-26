import Foundation
import SwabbleKit

enum VoiceWakeTextUtils {
    private static let whitespaceAndPunctuation = CharacterSet.whitespacesAndNewlines
        .union(.punctuationCharacters)
        .union(.symbols)
    private static let wakePrefixFillers: Set<String> = [
        "a", "ah", "eh", "er", "erm", "hey", "hmm", "huh", "mhm", "mm", "oh", "uh", "um",
        "yo", "呃", "嗯", "啊", "诶", "欸",
    ]
    typealias TrimWake = (String, [String]) -> String

    static func normalizeToken(_ token: String) -> String {
        token
            .trimmingCharacters(in: self.whitespaceAndPunctuation)
            .lowercased()
    }

    private static func normalizedTriggerTokens(_ trigger: String) -> [String] {
        trigger
            .split(whereSeparator: { $0.isWhitespace })
            .map { self.normalizeToken(String($0)) }
            .filter { !$0.isEmpty }
    }

    private static func isASCIIWordScalar(_ scalar: UnicodeScalar) -> Bool {
        scalar.isASCII && CharacterSet.alphanumerics.contains(scalar)
    }

    private static func requiresASCIIWordBoundaries(_ value: String) -> Bool {
        value.unicodeScalars.contains(where: self.isASCIIWordScalar)
    }

    private static func hasASCIIWordBoundaries(
        transcript: String,
        range: Range<String.Index>,
        trigger: String) -> Bool
    {
        guard self.requiresASCIIWordBoundaries(trigger) else { return true }

        if range.lowerBound > transcript.startIndex {
            let beforeIndex = transcript.index(before: range.lowerBound)
            let beforeScalars = transcript[beforeIndex].unicodeScalars
            if beforeScalars.contains(where: self.isASCIIWordScalar) {
                return false
            }
        }

        if range.upperBound < transcript.endIndex {
            let afterScalars = transcript[range.upperBound].unicodeScalars
            if afterScalars.contains(where: self.isASCIIWordScalar) {
                return false
            }
        }

        return true
    }

    private static func bestRawTriggerMatch(
        transcript: String,
        triggers: [String]) -> (range: Range<String.Index>, normalizedTrigger: String)?
    {
        var bestMatch: (range: Range<String.Index>, normalizedTrigger: String, tokenCount: Int)?

        for trigger in triggers {
            let normalizedTokens = self.normalizedTriggerTokens(trigger)
            guard !normalizedTokens.isEmpty else { continue }
            let rawTrigger = trigger.trimmingCharacters(in: self.whitespaceAndPunctuation)
            let tokenCount = normalizedTokens.count
            guard !rawTrigger.isEmpty else { continue }

            var searchStart = transcript.startIndex
            while searchStart < transcript.endIndex,
                  let range = transcript.range(
                      of: rawTrigger,
                      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                      range: searchStart..<transcript.endIndex)
            {
                defer {
                    searchStart = transcript.index(after: range.lowerBound)
                }
                guard self.hasASCIIWordBoundaries(
                    transcript: transcript,
                    range: range,
                    trigger: rawTrigger)
                else { continue }

                if let bestMatch {
                    if range.lowerBound > bestMatch.range.lowerBound { continue }
                    if range.lowerBound == bestMatch.range.lowerBound,
                       tokenCount <= bestMatch.tokenCount
                    {
                        continue
                    }
                }

                bestMatch = (range, normalizedTokens.joined(separator: " "), tokenCount)
                break
            }

            if let bestMatch,
               bestMatch.range.lowerBound == transcript.startIndex,
               bestMatch.tokenCount >= tokenCount
            {
                // Earlier matches take precedence, so once we match from the
                // start there is no need to scan later triggers with fewer
                // tokens at the same offset.
                if bestMatch.tokenCount > tokenCount {
                    continue
                }
            }
        }

        return bestMatch.map { (range: $0.range, normalizedTrigger: $0.normalizedTrigger) }
    }

    static func startsWithTrigger(transcript: String, triggers: [String]) -> Bool {
        let tokens = transcript
            .split(whereSeparator: { $0.isWhitespace })
            .map { self.normalizeToken(String($0)) }
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return false }
        for trigger in triggers {
            let triggerTokens = self.normalizedTriggerTokens(trigger)
            guard !triggerTokens.isEmpty, tokens.count >= triggerTokens.count else { continue }
            if zip(triggerTokens, tokens.prefix(triggerTokens.count)).allSatisfy({ $0 == $1 }) {
                return true
            }
        }
        return false
    }

    static func textOnlyCommand(
        transcript: String,
        triggers: [String],
        minCommandLength: Int,
        trimWake: TrimWake) -> String?
    {
        guard !transcript.isEmpty else { return nil }
        guard !self.normalizeToken(transcript).isEmpty else { return nil }
        guard WakeWordGate.matchesTextOnly(text: transcript, triggers: triggers) else { return nil }
        guard
            self.startsWithTrigger(transcript: transcript, triggers: triggers)
            || self.hasOnlyFillerBeforeTrigger(transcript: transcript, triggers: triggers)
        else { return nil }
        let trimmed = trimWake(transcript, triggers)
        guard trimmed.count >= minCommandLength else { return nil }
        return trimmed
    }

    static func hasOnlyFillerBeforeTrigger(transcript: String, triggers: [String]) -> Bool {
        guard let match = self.bestRawTriggerMatch(transcript: transcript, triggers: triggers) else { return false }
        let prefixTokens = transcript[..<match.range.lowerBound]
            .split(whereSeparator: {
                $0.isWhitespace || self.whitespaceAndPunctuation.contains($0.unicodeScalars.first!)
            })
            .map { self.normalizeToken(String($0)) }
            .filter { !$0.isEmpty }
        return prefixTokens.allSatisfy { self.wakePrefixFillers.contains($0) }
    }

    static func matchedTriggerWord(transcript: String, triggers: [String]) -> String? {
        if let rawMatch = self.bestRawTriggerMatch(transcript: transcript, triggers: triggers) {
            return rawMatch.normalizedTrigger
        }

        let transcriptTokens = transcript
            .split(whereSeparator: { $0.isWhitespace })
            .map { self.normalizeToken(String($0)) }
            .filter { !$0.isEmpty }
        guard !transcriptTokens.isEmpty else { return nil }

        var bestStartIndex = Int.max
        var bestTokenCount = -1
        var bestTokens: [String]?

        for trigger in triggers {
            let triggerTokens = self.normalizedTriggerTokens(trigger)
            guard !triggerTokens.isEmpty, transcriptTokens.count >= triggerTokens.count else { continue }
            for index in 0...(transcriptTokens.count - triggerTokens.count) {
                let candidate = transcriptTokens[index..<(index + triggerTokens.count)]
                guard zip(triggerTokens, candidate).allSatisfy({ $0 == $1 }) else { continue }
                if index < bestStartIndex || (index == bestStartIndex && triggerTokens.count > bestTokenCount) {
                    bestStartIndex = index
                    bestTokenCount = triggerTokens.count
                    bestTokens = triggerTokens
                }
            }
        }

        return bestTokens?.joined(separator: " ")
    }
}
