import AppKit
import ClawdbotIPC
import Foundation
import Testing
@testable import Clawdbot

@Suite(.serialized)
@MainActor
struct CanvasWindowSmokeTests {
    @Test func panelControllerShowsAndHides() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-canvas-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let anchor = { NSRect(x: 200, y: 400, width: 40, height: 40) }
        let controller = try CanvasWindowController(
            sessionKey: "  main/invalid⚡️  ",
            root: root,
            presentation: .panel(anchorProvider: anchor))

        #expect(controller.directoryPath.contains("main_invalid__") == true)

        controller.applyPreferredPlacement(CanvasPlacement(x: 120, y: 200, width: 520, height: 680))
        controller.showCanvas(path: "/")
        _ = try await controller.eval(javaScript: "1 + 1")
        controller.windowDidMove(Notification(name: NSWindow.didMoveNotification))
        controller.windowDidEndLiveResize(Notification(name: NSWindow.didEndLiveResizeNotification))
        controller.hideCanvas()
        controller.close()
    }

    @Test func windowControllerShowsAndCloses() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-canvas-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let controller = try CanvasWindowController(
            sessionKey: "main",
            root: root,
            presentation: .window)

        controller.showCanvas(path: "/")
        controller.windowWillClose(Notification(name: NSWindow.willCloseNotification))
        controller.hideCanvas()
        controller.close()
    }
}
