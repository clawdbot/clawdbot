import XCTest
@testable import OpenClawKit

@MainActor
final class TalkSystemSpeechSynthesizerTests: XCTestCase {
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
            text: String(repeating: "a", count: 10_000),
            language: "en-US")

        XCTAssertEqual(timeout, 900.0, accuracy: 0.001)
    }
}
