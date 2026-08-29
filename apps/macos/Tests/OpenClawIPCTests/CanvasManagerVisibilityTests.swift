import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CanvasManagerVisibilityTests {
    @Test func `showDetailed presents the panel`() throws {
        let manager = CanvasManager.shared
        manager._testResetPanel()
        defer { manager._testResetPanel() }

        _ = try manager.showDetailed(sessionKey: "visibility-present")

        #expect(manager._testPanelWindowIsVisible == true)
    }
}
