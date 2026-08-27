import XCTest
@testable import OpenClawKit

@MainActor
final class TalkSystemSpeechSynthesizerTests: XCTestCase {
    func testLiveOldCancellationDoesNotStopReplacement() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_LIVE_TEST"] == "1",
            "Requires working native speech/audio services; run with OPENCLAW_LIVE_TEST=1.")
        let speaker = TalkSystemSpeechSynthesizer.shared
        defer { speaker.stop() }
        let first = await self.startSpeech()
        defer { first.cancel() }

        first.cancel()
        var replacementStarts = 0
        try await speaker.speak(
            text: "Replacement speech.", language: "en-US",
            onStart: { replacementStarts += 1 })

        XCTAssertEqual(replacementStarts, 1)
        try await self.assertCanceled(first)
    }

    private func startSpeech() async -> Task<Void, Error> {
        let started = self.expectation(description: "utterance started")
        let speech = Task { @MainActor in
            try await TalkSystemSpeechSynthesizer.shared.speak(
                text: String(repeating: "This utterance will be interrupted. ", count: 20),
                language: "en-US",
                onStart: { started.fulfill() })
        }
        await self.fulfillment(of: [started], timeout: 10)
        return speech
    }

    private func assertCanceled(_ speech: Task<Void, Error>) async throws {
        do {
            try await speech.value
            XCTFail("Interrupted speech completed successfully")
        } catch TalkSystemSpeechSynthesizer.SpeakError.canceled {}
    }

    func testWatchdogTimeoutDefaultsToLatinProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "a", count: 100),
            language: nil)

        XCTAssertEqual(timeout, 24.0, accuracy: 0.001)
    }

    func testWatchdogTimeoutUsesKoreanProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "가", count: 100),
            language: "ko-KR")

        XCTAssertEqual(timeout, 75.0, accuracy: 0.001)
    }

    func testWatchdogTimeoutUsesChineseProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "你", count: 100),
            language: "zh-CN")

        XCTAssertEqual(timeout, 84.0, accuracy: 0.001)
    }

    func testWatchdogTimeoutUsesJapaneseProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "あ", count: 100),
            language: "ja-JP")

        XCTAssertEqual(timeout, 60.0, accuracy: 0.001)
    }

    func testWatchdogTimeoutClampsVeryLongUtterances() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "a", count: 10000),
            language: "en-US")

        XCTAssertEqual(timeout, 900.0, accuracy: 0.001)
    }
}
