import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct HoverHUDControllerTests {
    @Test func `hover HUD controller presents and dismisses`() async {
        let controller = HoverHUDController()
        controller.setSuppressed(false)

        controller.statusItemHoverChanged(
            inside: true,
            anchorProvider: { NSRect(x: 10, y: 10, width: 24, height: 24) })
        try? await Task.sleep(nanoseconds: 260_000_000)

        controller.panelHoverChanged(inside: true)
        controller.panelHoverChanged(inside: false)
        controller.statusItemHoverChanged(
            inside: false,
            anchorProvider: { NSRect(x: 10, y: 10, width: 24, height: 24) })

        controller.dismiss()
        controller.setSuppressed(true)
    }
}
