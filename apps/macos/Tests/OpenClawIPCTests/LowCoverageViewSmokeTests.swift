import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct LowCoverageViewSmokeTests {
    @Test func `notify overlay keeps replacement visible`() async {
        let controller = NotifyOverlayController()
        controller.present(title: "Hello", body: "World", autoDismissAfter: 0.05)
        controller.present(title: "Updated", body: "Again", autoDismissAfter: 0)
        try? await Task.sleep(nanoseconds: 250_000_000)
        #expect(controller.model.isVisible)
        #expect(controller.model.title == "Updated")

        controller.dismiss()
    }

    @Test func `talk overlay presents twice and dismisses`() async {
        let controller = TalkOverlayController()
        controller.present()
        controller.updateLevel(0.4)
        controller.present()
        controller.dismiss()
        try? await Task.sleep(nanoseconds: 250_000_000)
    }
}
