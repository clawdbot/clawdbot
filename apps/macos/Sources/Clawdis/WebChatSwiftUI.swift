import AppKit
import ClawdisChatUI
import ClawdisProtocol
import Foundation
import OSLog
import SwiftUI

private let webChatSwiftLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChatSwiftUI")

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 1120, height: 840)
    static let panelSize = NSSize(width: 480, height: 640)
    static let anchorPadding: CGFloat = 8
}

struct MacGatewayChatTransport: ClawdisChatTransport, Sendable {
    func requestHistory(sessionKey: String) async throws -> ClawdisChatHistoryPayload {
        try await GatewayConnection.shared.chatHistory(sessionKey: sessionKey)
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        _ = try await GatewayConnection.shared.request(
            method: "chat.abort",
            params: [
                "sessionKey": AnyCodable(sessionKey),
                "runId": AnyCodable(runId),
            ],
            timeoutMs: 10000)
    }

    func listSessions(limit: Int?) async throws -> ClawdisChatSessionsListResponse {
        var params: [String: AnyCodable] = [
            "includeGlobal": AnyCodable(true),
            "includeUnknown": AnyCodable(false),
        ]
        if let limit {
            params["limit"] = AnyCodable(limit)
        }
        let data = try await GatewayConnection.shared.request(
            method: "sessions.list",
            params: params,
            timeoutMs: 15000)
        return try JSONDecoder().decode(ClawdisChatSessionsListResponse.self, from: data)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [ClawdisChatAttachmentPayload]) async throws -> ClawdisChatSendResponse
    {
        try await GatewayConnection.shared.chatSend(
            sessionKey: sessionKey,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        try await GatewayConnection.shared.healthOK(timeoutMs: timeoutMs)
    }

    func events() -> AsyncStream<ClawdisChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    try await GatewayConnection.shared.refresh()
                } catch {
                    webChatSwiftLogger.error("gateway refresh failed \(error.localizedDescription, privacy: .public)")
                }

                let stream = await GatewayConnection.shared.subscribe()
                for await push in stream {
                    if Task.isCancelled { return }
                    if let evt = Self.mapPushToTransportEvent(push) {
                        continuation.yield(evt)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    static func mapPushToTransportEvent(_ push: GatewayPush) -> ClawdisChatTransportEvent? {
        switch push {
        case let .snapshot(hello):
            let ok = (try? JSONDecoder().decode(
                ClawdisGatewayHealthOK.self,
                from: JSONEncoder().encode(hello.snapshot.health)))?.ok ?? true
            return .health(ok: ok)

        case let .event(evt):
            switch evt.event {
            case "health":
                guard let payload = evt.payload else { return nil }
                let ok = (try? JSONDecoder().decode(
                    ClawdisGatewayHealthOK.self,
                    from: JSONEncoder().encode(payload)))?.ok ?? true
                return .health(ok: ok)
            case "tick":
                return .tick
            case "chat":
                guard let payload = evt.payload else { return nil }
                guard let chat = try? JSONDecoder().decode(
                    ClawdisChatEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .chat(chat)
            case "agent":
                guard let payload = evt.payload else { return nil }
                guard let agent = try? JSONDecoder().decode(
                    ClawdisAgentEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .agent(agent)
            default:
                return nil
            }

        case .seqGap:
            return .seqGap
        }
    }
}

// MARK: - Window controller

@MainActor
final class WebChatSwiftUIWindowController {
    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let hosting: NSHostingController<ClawdisChatView>
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?

    convenience init(sessionKey: String, presentation: WebChatPresentation) {
        self.init(sessionKey: sessionKey, presentation: presentation, transport: MacGatewayChatTransport())
    }

    init(sessionKey: String, presentation: WebChatPresentation, transport: any ClawdisChatTransport) {
        self.sessionKey = sessionKey
        self.presentation = presentation
        let vm = ClawdisChatViewModel(sessionKey: sessionKey, transport: transport)
        self.hosting = NSHostingController(rootView: ClawdisChatView(viewModel: vm))
        self.hosting.view.wantsLayer = true
        self.hosting.view.layer?.cornerCurve = .continuous
        self.hosting.view.layer?.cornerRadius = 16
        self.hosting.view.layer?.masksToBounds = true
        self.window = Self.makeWindow(for: presentation, contentViewController: self.hosting)
    }

    deinit {}

    var isVisible: Bool {
        self.window?.isVisible ?? false
    }

    func show() {
        guard let window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func presentAnchored(anchorProvider: () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.reposition(using: anchorProvider)
        self.installDismissMonitor()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func close() {
        self.window?.orderOut(nil)
        self.onVisibilityChanged?(false)
        self.onClosed?()
        self.removeDismissMonitor()
    }

    private func reposition(using anchorProvider: () -> NSRect?) {
        guard let window else { return }
        guard let anchor = anchorProvider() else {
            window.setFrame(
                WindowPlacement.topRightFrame(
                    size: WebChatSwiftUILayout.panelSize,
                    padding: WebChatSwiftUILayout.anchorPadding),
                display: false)
            return
        }
        let screen = NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? NSScreen.main
        var frame = window.frame
        if let screen {
            let bounds = screen.visibleFrame.insetBy(
                dx: WebChatSwiftUILayout.anchorPadding,
                dy: WebChatSwiftUILayout.anchorPadding)

            let desiredX = round(anchor.midX - frame.width / 2)
            let desiredY = anchor.minY - frame.height - WebChatSwiftUILayout.anchorPadding

            let maxX = bounds.maxX - frame.width
            let maxY = bounds.maxY - frame.height

            frame.origin.x = maxX >= bounds.minX ? min(max(desiredX, bounds.minX), maxX) : bounds.minX
            frame.origin.y = maxY >= bounds.minY ? min(max(desiredY, bounds.minY), maxY) : bounds.minY
        } else {
            frame.origin.x = round(anchor.midX - frame.width / 2)
            frame.origin.y = anchor.minY - frame.height
        }
        window.setFrame(frame, display: false)
    }

    private func installDismissMonitor() {
        guard self.dismissMonitor == nil, self.window != nil else { return }
        self.dismissMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown])
        { [weak self] _ in
            guard let self, let win = self.window else { return }
            let pt = NSEvent.mouseLocation
            if !win.frame.contains(pt) {
                self.close()
            }
        }
    }

    private func removeDismissMonitor() {
        if let monitor = self.dismissMonitor {
            NSEvent.removeMonitor(monitor)
            self.dismissMonitor = nil
        }
    }

    private static func makeWindow(
        for presentation: WebChatPresentation,
        contentViewController: NSViewController) -> NSWindow
    {
        switch presentation {
        case .window:
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = "Clawdis Chat (SwiftUI)"
            window.contentViewController = contentViewController
            window.isReleasedWhenClosed = false
            window.titleVisibility = .visible
            window.titlebarAppearsTransparent = false
            window.backgroundColor = .windowBackgroundColor
            window.isOpaque = true
            window.center()
            WindowPlacement.ensureOnScreen(window: window, defaultSize: WebChatSwiftUILayout.windowSize)
            window.minSize = NSSize(width: 880, height: 680)
            return window
        case .panel:
            let panel = WebChatPanel(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.panelSize),
                styleMask: [.borderless],
                backing: .buffered,
                defer: false)
            panel.level = .statusBar
            panel.hidesOnDeactivate = true
            panel.hasShadow = true
            panel.isMovable = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.contentViewController = contentViewController
            panel.becomesKeyOnlyIfNeeded = true
            panel.setFrame(
                WindowPlacement.topRightFrame(
                    size: WebChatSwiftUILayout.panelSize,
                    padding: WebChatSwiftUILayout.anchorPadding),
                display: false)
            return panel
        }
    }
}
