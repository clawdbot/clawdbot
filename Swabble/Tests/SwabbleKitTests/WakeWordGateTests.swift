import Foundation
import SwabbleKit
import Testing

@Suite struct WakeWordGateTests {
    @Test func matchRequiresGapAfterTrigger() {
        let transcript = "hey clawd do thing"
        let segments = makeSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("clawd", 0.2, 0.1),
                ("do", 0.35, 0.1),
                ("thing", 0.5, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["clawd"], minPostTriggerGap: 0.3)
        #expect(WakeWordGate.match(transcript: transcript, segments: segments, config: config) == nil)
    }

    @Test func matchAllowsGapAndExtractsCommand() {
        let transcript = "hey clawd do thing"
        let segments = makeSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("clawd", 0.2, 0.1),
                ("do", 0.9, 0.1),
                ("thing", 1.1, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["clawd"], minPostTriggerGap: 0.3)
        let match = WakeWordGate.match(transcript: transcript, segments: segments, config: config)
        #expect(match?.command == "do thing")
    }

    @Test func matchHandlesMultiWordTriggers() {
        let transcript = "hey clawd do it"
        let segments = makeSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("clawd", 0.2, 0.1),
                ("do", 0.8, 0.1),
                ("it", 1.0, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["hey clawd"], minPostTriggerGap: 0.3)
        let match = WakeWordGate.match(transcript: transcript, segments: segments, config: config)
        #expect(match?.command == "do it")
    }

    @Test func matchPrefersMostSpecificTriggerWhenOverlapping() {
        let transcript = "hey clawd do it"
        let segments = makeSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("clawd", 0.2, 0.1),
                ("do", 0.8, 0.1),
                ("it", 1.0, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["clawd", "hey clawd"], minPostTriggerGap: 0.3)
        let match = WakeWordGate.match(transcript: transcript, segments: segments, config: config)
        #expect(match?.trigger == "hey clawd")
    }

    @Test func commandTextHandlesForeignRangeIndices() {
        let transcript = "hey clawd do thing"
        let other = "do thing"
        let foreignRange = other.range(of: "do")
        let segments = [
            WakeWordSegment(text: "hey", start: 0.0, duration: 0.1, range: transcript.range(of: "hey")),
            WakeWordSegment(text: "clawd", start: 0.2, duration: 0.1, range: transcript.range(of: "clawd")),
            WakeWordSegment(text: "do", start: 0.9, duration: 0.1, range: foreignRange),
            WakeWordSegment(text: "thing", start: 1.1, duration: 0.1, range: nil),
        ]

        let command = WakeWordGate.commandText(
            transcript: transcript,
            segments: segments,
            triggerEndTime: 0.3)

        #expect(command == "do thing")
    }
}

private func makeSegments(
    transcript: String,
    words: [(String, TimeInterval, TimeInterval)])
-> [WakeWordSegment] {
    var searchStart = transcript.startIndex
    var output: [WakeWordSegment] = []
    for (word, start, duration) in words {
        let range = transcript.range(of: word, range: searchStart..<transcript.endIndex)
        output.append(WakeWordSegment(text: word, start: start, duration: duration, range: range))
        if let range { searchStart = range.upperBound }
    }
    return output
}
