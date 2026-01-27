import Testing
@testable import MoltbotChatUI

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
}
