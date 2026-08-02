import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AppStateVoiceEarsTests {
    @Test func `indefinite ear boost survives cancelled expiry`() async throws {
        let state = AppState(preview: true)
        state.triggerVoiceEars(ttl: 60)
        state.triggerVoiceEars(ttl: nil)

        try await Task.sleep(for: .milliseconds(20))

        #expect(state.earBoostActive)
        state.stopVoiceEars()
    }

    @Test func `replacement expiry owns ear boost lifetime`() async throws {
        let state = AppState(preview: true)
        state.triggerVoiceEars(ttl: 60)
        state.triggerVoiceEars(ttl: 0.05)

        #expect(state.earBoostActive)

        let deadline = ContinuousClock.now + .seconds(1)
        while state.earBoostActive, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(!state.earBoostActive)
    }
}
