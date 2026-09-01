import Testing
@testable import OpenClawChatUI

@Suite struct AssistantTextParserTests {
    @Test func splitsThinkAndFinalSegments() {
        let segments = AssistantTextParser.segments(
            from: "<think>internal</think>\n\n<final>Hello there</final>")

        #expect(segments.count == 2)
        #expect(segments[0].kind == .thinking)
        #expect(segments[0].text == "internal")
        #expect(segments[1].kind == .response)
        #expect(segments[1].text == "Hello there")
    }

    @Test func keepsTextWithoutTags() {
        let segments = AssistantTextParser.segments(from: "Just text.")

        #expect(segments.count == 1)
        #expect(segments[0].kind == .response)
        #expect(segments[0].text == "Just text.")
    }

    @Test func ignoresThinkingLikeTags() {
        let raw = "<thinking>example</thinking>\nKeep this."
        let segments = AssistantTextParser.segments(from: raw)

        #expect(segments.count == 1)
        #expect(segments[0].kind == .response)
        #expect(segments[0].text == raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    @Test func dropsEmptyTaggedContent() {
        let segments = AssistantTextParser.segments(from: "<think></think>")
        #expect(segments.isEmpty)
    }

    @Test func hidesThinkingSegmentsFromVisibleOutput() {
        let segments = AssistantTextParser.visibleSegments(
            from: "<think>internal</think>\n\n<final>Hello there</final>")

        #expect(segments.count == 1)
        #expect(segments[0].kind == .response)
        #expect(segments[0].text == "Hello there")
    }

    @Test func thinkingOnlyTextIsNotVisibleByDefault() {
        #expect(AssistantTextParser.hasVisibleContent(in: "<think>internal</think>") == false)
        #expect(AssistantTextParser.hasVisibleContent(in: "<think>internal</think>", includeThinking: true))
    }

    @Test func usesStableSegmentIDsAcrossRepeatedParses() {
        let raw = "<think>internal</think>\n\n<final>Hello there</final>"
        let first = AssistantTextParser.segments(from: raw, includeThinking: true)
        let second = AssistantTextParser.segments(from: raw, includeThinking: true)

        #expect(first.map(\.id) == [0, 1])
        #expect(first.map(\.id) == second.map(\.id))
    }
}
