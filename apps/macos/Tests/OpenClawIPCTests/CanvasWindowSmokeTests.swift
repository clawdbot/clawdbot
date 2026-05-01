import AppKit
import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CanvasWindowSmokeTests {
    @Test func `panel controller shows and hides`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-canvas-test-\(UUID().uuidString)")
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: root) }

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

    @Test func `window controller shows and closes`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-canvas-test-\(UUID().uuidString)")
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: root) }

        let controller = try CanvasWindowController(
            sessionKey: "main",
            root: root,
            presentation: .window)

        controller.showCanvas(path: "/")
        controller.windowWillClose(Notification(name: NSWindow.willCloseNotification))
        controller.hideCanvas()
        controller.close()
    }

    @Test func `A2UI auto navigation is idempotent for current host target`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-canvas-test-\(UUID().uuidString)")
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: root) }

        let controller = try CanvasWindowController(
            sessionKey: "main",
            root: root,
            presentation: .window)
        defer { controller.close() }

        let oldTarget = "http://127.0.0.1:18789/__openclaw__/a2ui/?platform=macos"
        let currentTarget = "http://127.0.0.1:18790/__openclaw__/a2ui/?platform=macos"
        let userTarget = "https://github.com/openclaw/openclaw"

        #expect(controller.shouldAutoNavigateToA2UI(lastAutoTarget: nil, candidateTarget: currentTarget) == true)

        controller.load(target: "/")
        #expect(controller.shouldAutoNavigateToA2UI(lastAutoTarget: nil, candidateTarget: currentTarget) == true)

        controller.load(target: currentTarget)
        #expect(controller
            .shouldAutoNavigateToA2UI(lastAutoTarget: currentTarget, candidateTarget: currentTarget) == false)

        controller.load(target: oldTarget)
        #expect(controller.shouldAutoNavigateToA2UI(lastAutoTarget: oldTarget, candidateTarget: currentTarget) == true)

        controller.load(target: userTarget)
        #expect(controller
            .shouldAutoNavigateToA2UI(lastAutoTarget: currentTarget, candidateTarget: currentTarget) == false)
    }
}
