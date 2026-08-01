import AVFoundation
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

    func testLivePreCancelledSpeechDoesNotReplaceCurrentUtterance() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_LIVE_TEST"] == "1",
            "Requires working native speech/audio services; run with OPENCLAW_LIVE_TEST=1.")
        let speaker = TalkSystemSpeechSynthesizer.shared
        defer { speaker.stop() }
        let current = await self.startSpeech()
        defer { current.cancel() }

        let currentFinished = self.expectation(description: "current utterance must keep playing")
        currentFinished.isInverted = true
        let observer = Task { @MainActor in
            _ = await current.result
            guard !Task.isCancelled else { return }
            currentFinished.fulfill()
        }
        defer { observer.cancel() }

        var successorStarts = 0
        let successor = Task { @MainActor in
            XCTAssertTrue(Task.isCancelled)
            try await speaker.speak(
                text: "Cancelled successor speech.", language: "en-US",
                onStart: { successorStarts += 1 })
        }
        successor.cancel()
        try await self.assertCanceled(successor)

        await self.fulfillment(of: [currentFinished], timeout: 0.25)
        XCTAssertEqual(successorStarts, 0)
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

    func testResolveVoicePrefersIdentifierMatch() {
        let identifierVoice = AVSpeechSynthesisVoice(language: "en-GB")
        let languageVoice = AVSpeechSynthesisVoice(language: "en-US")
        let resolved = TalkSystemSpeechSynthesizer.resolveVoice(
            voiceIdentifier: "some-identifier",
            language: "en-US",
            voiceLookup: { _ in identifierVoice },
            languageLookup: { _ in languageVoice })

        XCTAssertEqual(resolved, identifierVoice)
    }

    func testResolveVoiceFallsBackToLanguageWhenIdentifierLanguageMismatches() {
        // A voice picked for English must not be used when the resolved synthesis
        // language (from a Talk directive, for example) requests French instead.
        let identifierVoice = AVSpeechSynthesisVoice(language: "en-US")
        let languageVoice = AVSpeechSynthesisVoice(language: "fr-FR")
        let resolved = TalkSystemSpeechSynthesizer.resolveVoice(
            voiceIdentifier: "english-voice",
            language: "fr-FR",
            voiceLookup: { _ in identifierVoice },
            languageLookup: { _ in languageVoice })

        XCTAssertEqual(resolved, languageVoice)
    }

    func testResolveVoiceAllowsRegionVarianceWithinSameLanguage() {
        // en-GB identifier voice still applies when the resolved language is en-US:
        // same primary language, different region, matching the picker's own
        // subtag-only filtering.
        let identifierVoice = AVSpeechSynthesisVoice(language: "en-GB")
        let languageVoice = AVSpeechSynthesisVoice(language: "en-US")
        let resolved = TalkSystemSpeechSynthesizer.resolveVoice(
            voiceIdentifier: "british-voice",
            language: "en-US",
            voiceLookup: { _ in identifierVoice },
            languageLookup: { _ in languageVoice })

        XCTAssertEqual(resolved, identifierVoice)
    }

    func testResolveVoiceUsesIdentifierWhenNoLanguageIsResolved() {
        let identifierVoice = AVSpeechSynthesisVoice(language: "en-US")
        let resolved = TalkSystemSpeechSynthesizer.resolveVoice(
            voiceIdentifier: "some-identifier",
            language: nil,
            voiceLookup: { _ in identifierVoice },
            languageLookup: { _ in XCTFail("should not be called")
                return nil
            })

        XCTAssertEqual(resolved, identifierVoice)
    }

    func testResolveVoiceFallsBackToLanguageWhenIdentifierMisses() {
        let languageVoice = AVSpeechSynthesisVoice(language: "en-US")
        let resolved = TalkSystemSpeechSynthesizer.resolveVoice(
            voiceIdentifier: "not-installed",
            language: "en-US",
            voiceLookup: { _ in nil },
            languageLookup: { _ in languageVoice })

        XCTAssertEqual(resolved, languageVoice)
    }

    func testResolveVoiceReturnsNilWhenBothMiss() {
        let resolved = TalkSystemSpeechSynthesizer.resolveVoice(
            voiceIdentifier: "not-installed",
            language: "zz-ZZ",
            voiceLookup: { _ in nil },
            languageLookup: { _ in nil })

        XCTAssertNil(resolved)
    }

    func testResolveVoiceReturnsNilWithNoIdentifierOrLanguage() {
        let resolved = TalkSystemSpeechSynthesizer.resolveVoice(
            voiceIdentifier: nil,
            language: nil,
            voiceLookup: { _ in XCTFail("should not be called")
                return nil
            },
            languageLookup: { _ in XCTFail("should not be called")
                return nil
            })

        XCTAssertNil(resolved)
    }
}
