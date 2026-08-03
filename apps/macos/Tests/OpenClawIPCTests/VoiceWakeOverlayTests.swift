import Foundation
import Testing
@testable import OpenClaw

struct VoiceWakeOverlayTests {
    @Test func `guard token drops when no active`() {
        let outcome = VoiceWakeOverlayController.evaluateToken(active: nil, incoming: UUID())
        #expect(outcome == .dropNoActive)
    }

    @Test func `guard token accepts matching`() {
        let token = UUID()
        let outcome = VoiceWakeOverlayController.evaluateToken(active: token, incoming: token)
        #expect(outcome == .accept)
    }

    @Test func `guard token drops mismatch without dismissing`() {
        let outcome = VoiceWakeOverlayController.evaluateToken(active: UUID(), incoming: UUID())
        #expect(outcome == .dropMismatch)
    }
}
