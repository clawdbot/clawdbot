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

    @Test func `hosted Canvas URL resolver keeps capability scope and only trusts A2UI`() throws {
        let surface = "https://gateway.example/root/__openclaw__/cap/token%20value"
        let canvas = try #require(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/demo%20page.html?mode=proof#result"))
        #expect(canvas.url.absoluteString ==
            "https://gateway.example/root/__openclaw__/cap/token%20value/__openclaw__/canvas/demo%20page.html?mode=proof#result")
        #expect(canvas.allowsA2UIActions == false)

        let a2ui = try #require(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/a2ui/?platform=macos"))
        #expect(a2ui.url.absoluteString ==
            "https://gateway.example/root/__openclaw__/cap/token%20value/__openclaw__/a2ui/?platform=macos")
        #expect(a2ui.allowsA2UIActions)

        #expect(CanvasHostedURLResolver.resolve(surfaceURL: surface, target: "/local.html") == nil)
        #expect(CanvasHostedURLResolver.resolve(surfaceURL: surface, target: "https://example.com/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/a2ui/../canvas/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/a2ui/%252e%252e/canvas/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/a2ui/%25252525252e%25252525252e/canvas/") == nil)
        #expect(CanvasHostedURLResolver.resolve(
            surfaceURL: "https://gateway.example/not-capability-scoped",
            target: "/__openclaw__/canvas/") == nil)
    }

    @Test func `A2UI action trust is exact and capability scoped`() throws {
        let expected = try #require(URL(string:
            "https://gateway.example/__openclaw__/cap/current-token/__openclaw__/a2ui/?platform=macos"))
        let sameWithFragment = try #require(URL(string: expected.absoluteString + "#card"))
        let staleCapability = try #require(URL(string:
            "https://gateway.example/__openclaw__/cap/stale-token/__openclaw__/a2ui/?platform=macos"))
        let changedQuery = try #require(URL(string:
            "https://gateway.example/__openclaw__/cap/current-token/__openclaw__/a2ui/?platform=other"))
        let canvasPage = try #require(URL(string:
            "https://gateway.example/__openclaw__/cap/current-token/__openclaw__/canvas/"))
        let traversingA2UI = try #require(URL(string:
            "https://gateway.example/__openclaw__/cap/current-token/__openclaw__/a2ui/%2e%2e/canvas/"))
        let localCanvas = try #require(URL(string: "openclaw-canvas://main/"))

        #expect(CanvasA2UIActionMessageHandler.isTrustedSourceURL(expected, expectedRemoteURL: expected))
        #expect(CanvasA2UIActionMessageHandler.isTrustedSourceURL(sameWithFragment, expectedRemoteURL: expected))
        #expect(!CanvasA2UIActionMessageHandler.isTrustedSourceURL(staleCapability, expectedRemoteURL: expected))
        #expect(!CanvasA2UIActionMessageHandler.isTrustedSourceURL(changedQuery, expectedRemoteURL: expected))
        #expect(!CanvasA2UIActionMessageHandler.isTrustedSourceURL(canvasPage, expectedRemoteURL: expected))
        #expect(!CanvasHostedURLResolver.isCapabilityScopedA2UIURL(traversingA2UI))
        #expect(CanvasA2UIActionMessageHandler.isTrustedSourceURL(localCanvas, expectedRemoteURL: nil))

        let handler = CanvasA2UIActionMessageHandler(sessionKey: "main")
        handler.setTrustedRemoteURL(expected)
        #expect(handler.isTrustedSourceURL(expected))
        handler.updateTrustForMainFrameNavigation(to: canvasPage)
        #expect(!handler.isTrustedSourceURL(expected))
    }
}
