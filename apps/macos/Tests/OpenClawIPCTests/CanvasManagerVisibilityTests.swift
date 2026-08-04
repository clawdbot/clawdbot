import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CanvasManagerVisibilityTests {
    @Test func `eval on fresh state creates a hidden surface`() async throws {
        let manager = CanvasManager.shared
        manager._testResetPanel()
        defer { manager._testResetPanel() }

        let result = try await manager.eval(sessionKey: "visibility-eval", javaScript: "1 + 1")

        #expect(result == "2")
        #expect(manager._testHasPanelController)
        #expect(manager._testPanelWindowIsVisible == false)
    }

    @Test func `showDetailed presents the panel`() throws {
        let manager = CanvasManager.shared
        manager._testResetPanel()
        defer { manager._testResetPanel() }

        _ = try manager.showDetailed(sessionKey: "visibility-present")

        #expect(manager._testPanelWindowIsVisible == true)
    }

    @Test func `content operations respect a user hide`() async throws {
        let manager = CanvasManager.shared
        manager._testResetPanel()
        defer { manager._testResetPanel() }

        _ = try manager.showDetailed(sessionKey: "visibility-hidden")
        manager.hideAll()
        try manager.prepare(sessionKey: "visibility-hidden", target: "/")
        _ = try await manager.eval(sessionKey: "visibility-hidden", javaScript: "1 + 1")

        #expect(manager._testPanelWindowIsVisible == false)
    }

    @Test func `snapshot while hidden throws without presenting`() async throws {
        let manager = CanvasManager.shared
        manager._testResetPanel()
        defer { manager._testResetPanel() }

        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-canvas-hidden-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: output) }

        try manager.prepare(sessionKey: "visibility-snapshot", target: "/")
        do {
            _ = try await manager.snapshot(sessionKey: "visibility-snapshot", outPath: output.path)
            Issue.record("hidden snapshot should throw CANVAS_HIDDEN")
        } catch {
            #expect(error.localizedDescription.contains("CANVAS_HIDDEN"))
        }

        #expect(manager._testHasPanelController)
        #expect(manager._testPanelWindowIsVisible == false)
        #expect(FileManager.default.fileExists(atPath: output.path) == false)
    }

    @Test func `snapshot for another session leaves the visible panel alone`() async throws {
        let manager = CanvasManager.shared
        manager._testResetPanel()
        defer { manager._testResetPanel() }

        _ = try manager.showDetailed(sessionKey: "visibility-live")
        #expect(manager._testPanelWindowIsVisible == true)

        await #expect(throws: (any Error).self) {
            try await manager.snapshot(sessionKey: "visibility-other", outPath: nil)
        }

        // Read-only snapshot must not close or switch the live panel.
        #expect(manager._testPanelWindowIsVisible == true)
    }
}
