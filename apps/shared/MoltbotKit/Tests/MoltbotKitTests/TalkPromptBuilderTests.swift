import XCTest
@testable import MoltbotKit

final class TalkPromptBuilderTests: XCTestCase {
    func testBuildIncludesTranscript() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertTrue(prompt.contains("Talk Mode active."))
        XCTAssertTrue(prompt.hasSuffix("\n\nHello"))
    }

    func testBuildIncludesInterruptionLineWhenProvided() {
        let prompt = TalkPromptBuilder.build(transcript: "Hi", interruptedAtSeconds: 1.234)
        XCTAssertTrue(prompt.contains("Assistant speech interrupted at 1.2s."))
    }
}
