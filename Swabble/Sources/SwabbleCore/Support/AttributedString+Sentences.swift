import CoreMedia
import Foundation
import NaturalLanguage

extension AttributedString {
    public func sentences(maxLength: Int? = nil) -> [AttributedString] {
        let tokenizer = NLTokenizer(unit: .sentence)
        let string = String(characters)
        tokenizer.string = string
        let sentenceRanges = tokenizer.tokens(for: string.startIndex..<string.endIndex).map {
            (
                $0,
                AttributedString.Index($0.lowerBound, within: self)!
                    ..<
                    AttributedString.Index($0.upperBound, within: self)!)
        }
        let ranges = sentenceRanges.flatMap { sentenceStringRange, sentenceRange in
            let sentence = self[sentenceRange]
            guard let maxLength, sentence.characters.count > maxLength else {
                return [sentenceRange]
            }

            let wordTokenizer = NLTokenizer(unit: .word)
            wordTokenizer.string = string
            var wordRanges = wordTokenizer.tokens(for: sentenceStringRange).map {
                AttributedString.Index($0.lowerBound, within: self)!
                    ..<
                    AttributedString.Index($0.upperBound, within: self)!
            }
            guard !wordRanges.isEmpty else { return [sentenceRange] }
            wordRanges[0] = sentenceRange.lowerBound..<wordRanges[0].upperBound
            wordRanges[wordRanges.count - 1] = wordRanges[wordRanges.count - 1].lowerBound..<sentenceRange.upperBound

            var ranges: [Range<AttributedString.Index>] = []
            for wordRange in wordRanges {
                if let lastRange = ranges.last,
                   self[lastRange].characters.count + self[wordRange].characters.count <= maxLength {
                    ranges[ranges.count - 1] = lastRange.lowerBound..<wordRange.upperBound
                } else {
                    ranges.append(wordRange)
                }
            }

            return ranges
        }

        return ranges.compactMap { range in
            let audioTimeRanges = self[range].runs.filter {
                !String(self[$0.range].characters)
                    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }.compactMap(\.audioTimeRange)
            guard !audioTimeRanges.isEmpty else { return nil }
            let start = audioTimeRanges.first!.start
            let end = audioTimeRanges.last!.end
            var attributes = AttributeContainer()
            attributes[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] = CMTimeRange(
                start: start,
                end: end)
            return AttributedString(self[range].characters, attributes: attributes)
        }
    }
}
