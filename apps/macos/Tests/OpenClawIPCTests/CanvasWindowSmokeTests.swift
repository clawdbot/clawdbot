import AppKit
import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CanvasWindowSmokeTests {
    @Test func `panel controller shows and hides`() throws {
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
        #expect(controller.webView.configuration.preferences.tabFocusesLinks)
        #expect(controller._testIsFilePollingActive == false)

        controller.applyPreferredPlacement(CanvasPlacement(x: 120, y: 200, width: 520, height: 680))
        controller.load(target: "/")
        #expect(controller._testIsFilePollingActive == false)
        let localURL = try #require(CanvasScheme.makeURL(session: "main", path: "/"))
        controller.updateFilePollingForCommittedNavigation(to: localURL)
        controller.showCanvas()
        #expect(controller._testIsFilePollingActive)
        let remoteURL = try #require(URL(string: "https://example.com"))
        controller.load(target: remoteURL.absoluteString)
        #expect(controller._testIsFilePollingActive)
        controller.updateFilePollingForCommittedNavigation(to: remoteURL)
        #expect(controller._testIsFilePollingActive == false)
        controller.load(target: "/")
        #expect(controller._testIsFilePollingActive == false)
        controller.updateFilePollingForCommittedNavigation(to: localURL)
        #expect(controller._testIsFilePollingActive)
        controller.windowDidMove(Notification(name: NSWindow.didMoveNotification))
        controller.windowDidEndLiveResize(Notification(name: NSWindow.didEndLiveResizeNotification))
        controller.hideCanvas()
        #expect(controller._testIsFilePollingActive == false)
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

        #expect(controller.window?.isRestorable == false)
        controller.showCanvas(path: "/")
        controller.windowWillClose(Notification(name: NSWindow.willCloseNotification))
        controller.hideCanvas()
        controller.close()
    }

    @Test func `hosted Canvas URL resolver keeps capability scope`() throws {
        let surface = "https://gateway.example/root/__openclaw__/cap/token%20value"
        let canvas = try #require(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/demo%20page.html?mode=proof#result"))
        #expect(canvas.absoluteString ==
            "https://gateway.example/root/__openclaw__/cap/token%20value/__openclaw__/canvas/demo%20page.html?mode=proof#result")

        #expect(CanvasHostedURLResolver.resolve(surfaceURL: surface, target: "/local.html") == nil)
        #expect(CanvasHostedURLResolver.resolve(surfaceURL: surface, target: "https://example.com/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/../other/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/%252e%252e/other/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/%25252525252e%25252525252e/other/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: "https://gateway.example/not-capability-scoped",
            target: "/__openclaw__/canvas/") == nil)
    }

    @Test func `Canvas target resolver accepts only hosted paths and app-local URLs`() {
        #expect(CanvasHostedURLResolver.isHostedTarget(
            "/__openclaw__/canvas/documents/widget/index.html"))
        #expect(CanvasHostedURLResolver.isAppLocalTarget("openclaw-canvas://main/widget/index.html"))

        #expect(!CanvasHostedURLResolver.isAppLocalTarget("https://example.com/widget.html"))
        #expect(!CanvasHostedURLResolver.isAppLocalTarget("file:///tmp/widget.html"))
        #expect(!CanvasHostedURLResolver.isAppLocalTarget("openclaw-canvas:///widget.html"))
        #expect(!CanvasHostedURLResolver.isAppLocalTarget("openclaw-canvas://main/%252e%252e/secret"))
    }
}
