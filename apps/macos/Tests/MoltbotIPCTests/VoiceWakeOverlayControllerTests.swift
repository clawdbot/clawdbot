import Foundation
import Testing
@testable import Moltbot

@Suite(.serialized)
@MainActor
struct VoiceWakeOverlayControllerTests {
    @Test func overlayControllerLifecycleWithoutUI() async {
        let controller = VoiceWakeOverlayController(enableUI: false)
        let token = controller.startSession(
            source: .wakeWord,
            transcript: "hello",
            attributed: nil,
            forwardEnabled: true,
            isFinal: false)

        #expect(controller.snapshot().token == token)
        #expect(controller.snapshot().isVisible == true)

        controller.updatePartial(token: token, transcript: "hello world")
        #expect(controller.snapshot().text == "hello world")

        controller.updateLevel(token: token, -0.5)
        #expect(controller.model.level == 0)
        try? await Task.sleep(nanoseconds: 120_000_000)
        controller.updateLevel(token: token, 2.0)
        #expect(controller.model.level == 1)

        controller.dismiss(token: token, reason: .explicit, outcome: .empty)
        #expect(controller.snapshot().isVisible == false)
        #expect(controller.snapshot().token == nil)
    }

    @Test func evaluateTokenDropsMismatchAndNoActive() {
        let active = UUID()
        #expect(VoiceWakeOverlayController.evaluateToken(active: nil, incoming: active) == .dropNoActive)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: UUID()) == .dropMismatch)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: active) == .accept)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: nil) == .accept)
    }

    @Test func updateLevelThrottlesRapidChanges() async {
        let controller = VoiceWakeOverlayController(enableUI: false)
        let token = controller.startSession(
            source: .wakeWord,
            transcript: "level test",
            attributed: nil,
            forwardEnabled: false,
            isFinal: false)

        controller.updateLevel(token: token, 0.25)
        let first = controller.model.level

        controller.updateLevel(token: token, 0.9)
        #expect(controller.model.level == first)

        controller.updateLevel(token: token, 0)
        #expect(controller.model.level == 0)

        try? await Task.sleep(nanoseconds: 120_000_000)
        controller.updateLevel(token: token, 0.9)
        #expect(controller.model.level == 0.9)
    }

    @Test func overlayControllerExercisesHelpers() async {
        await VoiceWakeOverlayController.exerciseForTesting()
    }
}
