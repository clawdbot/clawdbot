import AppKit
import Foundation

/// A borderless panel that can still accept key focus (needed for typing).
final class WebChatPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

enum WebChatPresentation {
    case window
    case panel(anchorProvider: () -> NSRect?)
}

struct WebChatRoute: Equatable, Sendable {
    let sessionKey: String
    let agentID: String?

    init(sessionKey: String, agentID: String?) {
        self.sessionKey = sessionKey
        self.agentID = Self.normalizedAgentID(agentID)
    }

    func replacingSessionKey(_ sessionKey: String) -> Self {
        Self(sessionKey: sessionKey, agentID: self.agentID)
    }

    static func normalizedAgentID(_ agentID: String?) -> String? {
        let normalized = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }
}

@MainActor
final class WebChatManager {
    static let shared = WebChatManager()

    private var windowController: WebChatSwiftUIWindowController?
    private var windowRoute: WebChatRoute?
    private var panelController: WebChatSwiftUIWindowController?
    private var panelRoute: WebChatRoute?
    private var currentChatRoute: WebChatRoute?
    private var cachedPreferredSessionKey: String?

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.currentChatRoute?.sessionKey ?? self.panelRoute?.sessionKey ?? self.windowRoute?.sessionKey
    }

    func show(sessionKey: String, agentID: String? = nil) {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        self.closePanel()
        if let controller = self.windowController {
            // The window shell switches sessions in place (sidebar, /new);
            // full route identity tracks those switches and the global owner.
            if Self.shouldReuseController(currentRoute: self.windowRoute, requestedRoute: route) {
                controller.show()
                return
            }

            controller.close()
            self.windowController = nil
            self.windowRoute = nil
        }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            presentation: .window)
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        controller.onSessionKeyChanged = { [weak self, weak controller] key in
            guard let self, let controller, self.windowController === controller else { return }
            // Retaining the agent is safe: this surface has no in-window agent switcher,
            // and the controller pins explicit agents against gateway-default changes.
            let updatedRoute = (self.windowRoute ?? route).replacingSessionKey(key)
            self.windowRoute = updatedRoute
            self.currentChatRoute = updatedRoute
        }
        self.windowController = controller
        self.windowRoute = route
        self.currentChatRoute = route
        controller.show()
    }

    func togglePanel(
        sessionKey: String,
        agentID: String? = nil,
        anchorProvider: @escaping () -> NSRect?)
    {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        if let controller = self.panelController {
            if !Self.shouldReuseController(currentRoute: self.panelRoute, requestedRoute: route) {
                controller.close()
                self.panelController = nil
                self.panelRoute = nil
            } else {
                if controller.isVisible {
                    controller.close()
                } else {
                    controller.presentAnchored(anchorProvider: anchorProvider)
                }
                return
            }
        }

        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            presentation: .panel(anchorProvider: anchorProvider))
        controller.onClosed = { [weak self] in
            self?.panelHidden()
        }
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        controller.onSessionKeyChanged = { [weak self, weak controller] key in
            guard let self, let controller, self.panelController === controller else { return }
            let updatedRoute = (self.panelRoute ?? route).replacingSessionKey(key)
            self.panelRoute = updatedRoute
            self.currentChatRoute = updatedRoute
        }
        self.panelController = controller
        self.panelRoute = route
        self.currentChatRoute = route
        controller.presentAnchored(anchorProvider: anchorProvider)
    }

    func recordActiveSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let route = self.currentChatRoute ?? self.panelRoute ?? self.windowRoute
        self.currentChatRoute = route?.replacingSessionKey(trimmed)
            ?? WebChatRoute(sessionKey: trimmed, agentID: nil)
    }

    func closePanel() {
        self.panelController?.close()
    }

    func preferredSessionKey() async -> String {
        if let cachedPreferredSessionKey { return cachedPreferredSessionKey }
        let key = await GatewayConnection.shared.mainSessionKey()
        self.cachedPreferredSessionKey = key
        return key
    }

    func resetTunnels() {
        self.windowController?.close()
        self.windowController = nil
        self.windowRoute = nil
        self.panelController?.close()
        self.panelController = nil
        self.panelRoute = nil
        self.currentChatRoute = nil
        self.cachedPreferredSessionKey = nil
    }

    func close() {
        self.resetTunnels()
    }

    private func panelHidden() {
        self.onPanelVisibilityChanged?(false)
        // Keep panel controller cached so reopening doesn't re-bootstrap.
    }

    static func shouldReuseController(
        currentRoute: WebChatRoute?,
        requestedRoute: WebChatRoute) -> Bool
    {
        currentRoute == requestedRoute
    }
}
