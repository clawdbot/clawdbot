import Foundation
import Testing
@testable import OpenClaw

struct TalkModeRuntimeIdleTimeoutTests {
    private let now = Date()
    private let idleTimeout: TimeInterval = 30.0
    private let grace: TimeInterval = 1.0

    @Test func `expires when idle deadline has passed`() {
        let anchor = now.addingTimeInterval(-31)
        #expect(TalkModeRuntime.shouldExpireIdleTimeout(
            now: now,
            lastInteractionAt: anchor,
            idleTimeout: idleTimeout,
            lastSpeechEnergyAt: nil,
            speechRecognitionGrace: grace) == true)
    }

    @Test func `does not expire before deadline`() {
        let anchor = now.addingTimeInterval(-20)
        #expect(TalkModeRuntime.shouldExpireIdleTimeout(
            now: now,
            lastInteractionAt: anchor,
            idleTimeout: idleTimeout,
            lastSpeechEnergyAt: nil,
            speechRecognitionGrace: grace) == false)
    }

    @Test func `grants recognition grace when energy arrives near deadline`() {
        let anchor = now.addingTimeInterval(-30.5)
        let deadline = anchor.addingTimeInterval(idleTimeout)
        // Energy arrived 0.3s after the deadline — within the 1s grace window
        let energyAt = deadline.addingTimeInterval(0.3)
        #expect(TalkModeRuntime.shouldExpireIdleTimeout(
            now: energyAt.addingTimeInterval(0.2),
            lastInteractionAt: anchor,
            idleTimeout: idleTimeout,
            lastSpeechEnergyAt: energyAt,
            speechRecognitionGrace: grace) == false)
    }

    @Test func `continuous energy cannot extend grace past deadline plus grace`() {
        let anchor = now.addingTimeInterval(-(idleTimeout + 1.5))
        #expect(TalkModeRuntime.shouldExpireIdleTimeout(
            now: now,
            lastInteractionAt: anchor,
            idleTimeout: idleTimeout,
            lastSpeechEnergyAt: now,
            speechRecognitionGrace: grace) == true)
    }

    @Test func `expires when energy is stale`() {
        let anchor = now.addingTimeInterval(-35)
        // Energy was 10 seconds ago — well outside the grace window
        let energyAt = now.addingTimeInterval(-10)
        #expect(TalkModeRuntime.shouldExpireIdleTimeout(
            now: now,
            lastInteractionAt: anchor,
            idleTimeout: idleTimeout,
            lastSpeechEnergyAt: energyAt,
            speechRecognitionGrace: grace) == true)
    }

    @Test func `does not expire when idle timeout is zero`() {
        let anchor = now.addingTimeInterval(-100)
        #expect(TalkModeRuntime.shouldExpireIdleTimeout(
            now: now,
            lastInteractionAt: anchor,
            idleTimeout: 0,
            lastSpeechEnergyAt: nil,
            speechRecognitionGrace: grace) == false)
    }
}
