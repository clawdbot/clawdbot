import Foundation
import OpenClawKit
import XCTest
@testable import OpenClawWatchApp

@MainActor
final class WatchSpeechPlaybackTests: XCTestCase {
    func testLiveReplacementAndStopRetainCurrentPlaybackState() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_LIVE_TEST"] == "1",
            "Requires working native speech/audio services; run with OPENCLAW_LIVE_TEST=1.")
        let speaker = TalkSystemSpeechSynthesizer.shared
        defer { speaker.stop() }
        var nativeSpeechStarted = false
        try await speaker.speak(
            text: "Native speech is ready.",
            language: "en-US",
            onStart: { nativeSpeechStarted = true })
        try XCTSkipUnless(nativeSpeechStarted, "Native speech callbacks are unavailable.")

        let playback = WatchSpeechPlayback()
        defer { playback.stop() }
        let text = String(repeating: "The replacement must keep its playback controls active. ", count: 40)
        for delayMs in [0, 50] {
            playback.speak(text)
            if delayMs > 0 {
                try await Task.sleep(for: .milliseconds(delayMs))
            }
            playback.speak(text)
            XCTAssertTrue(playback.isSpeaking)
            let deadline = ContinuousClock.now.advanced(by: .milliseconds(500))
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
                guard playback.isSpeaking else {
                    XCTFail("Replaced speech cleared the current playback state.")
                    return
                }
            }

            playback.stop()
            XCTAssertFalse(playback.isSpeaking)
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertFalse(playback.isSpeaking)
        }
    }
}
