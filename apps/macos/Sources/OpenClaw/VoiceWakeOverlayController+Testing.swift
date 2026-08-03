import AppKit

#if DEBUG
@MainActor
extension VoiceWakeOverlayController {
    static func exerciseForTesting() async {
        let controller = VoiceWakeOverlayController(enableUI: false)
        let token = controller.startSession(
            source: .wakeWord,
            transcript: "Hello",
            attributed: nil,
            forwardEnabled: true,
            isFinal: false)

        controller.updatePartial(token: token, transcript: "Hello world")
        controller.presentFinal(token: token, transcript: "Final", autoSendAfter: nil)
        controller.userBeganEditing()
        controller.endEditing()
        controller.updateText("Edited text")

        _ = controller.makeAttributed(from: "Attributed")
        _ = controller.targetFrame()
        _ = controller.measuredHeight()
        _ = controller.dismissTargetFrame(
            for: NSRect(x: 0, y: 0, width: 120, height: 60),
            reason: .empty,
            outcome: .empty)
        _ = controller.dismissTargetFrame(
            for: NSRect(x: 0, y: 0, width: 120, height: 60),
            reason: .explicit,
            outcome: .sent)
        _ = controller.dismissTargetFrame(
            for: NSRect(x: 0, y: 0, width: 120, height: 60),
            reason: .explicit,
            outcome: .empty)

        controller.beginSendUI(token: token, sendChime: .none)
        try? await Task.sleep(nanoseconds: 350_000_000)

        controller.scheduleAutoSend(token: token, after: 10)
        controller.autoSendTask?.cancel()
        controller.autoSendTask = nil
        controller.autoSendToken = nil

        controller.dismiss(token: token, reason: .explicit, outcome: .sent)
        controller.bringToFrontIfVisible()
    }
}
#endif
