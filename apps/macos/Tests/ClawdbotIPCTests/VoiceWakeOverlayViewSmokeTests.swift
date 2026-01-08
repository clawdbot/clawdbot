import SwiftUI
import Testing
@testable import Clawdbot

@Suite(.serialized)
@MainActor
struct VoiceWakeOverlayViewSmokeTests {
    @Test func overlayViewBuildsBodyInDisplayMode() {
        let controller = VoiceWakeOverlayController(enableUI: false)
        _ = controller.startSession(source: .wakeWord, transcript: "hello", forwardEnabled: true)
        let view = VoiceWakeOverlayView(controller: controller)
        _ = view.body
    }

    @Test func overlayViewBuildsBodyInEditingMode() {
        let controller = VoiceWakeOverlayController(enableUI: false)
        let token = controller.startSession(source: .pushToTalk, transcript: "edit me", forwardEnabled: true)
        controller.userBeganEditing()
        controller.updateLevel(token: token, 0.6)
        let view = VoiceWakeOverlayView(controller: controller)
        _ = view.body
    }

    @Test func closeButtonOverlayBuildsBody() {
        let view = CloseButtonOverlay(isVisible: true, onHover: { _ in }, onClose: {})
        _ = view.body
    }
}
