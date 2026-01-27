import Foundation
import Testing
@testable import Moltbot

@Suite struct VoiceWakeOverlayTests {
    @Test func guardTokenDropsWhenNoActive() {
        let outcome = VoiceWakeOverlayController.evaluateToken(active: nil, incoming: UUID())
        #expect(outcome == .dropNoActive)
    }

    @Test func guardTokenAcceptsMatching() {
        let token = UUID()
        let outcome = VoiceWakeOverlayController.evaluateToken(active: token, incoming: token)
        #expect(outcome == .accept)
    }

    @Test func guardTokenDropsMismatchWithoutDismissing() {
        let outcome = VoiceWakeOverlayController.evaluateToken(active: UUID(), incoming: UUID())
        #expect(outcome == .dropMismatch)
    }
}
