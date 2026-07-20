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
    private var profileWindowControllers: [String: WebChatSwiftUIWindowController] = [:]
    private var profileWindowRoutes: [String: WebChatRoute] = [:]

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.currentChatRoute?.sessionKey ?? self.panelRoute?.sessionKey ?? self.windowRoute?.sessionKey
    }

    func show(sessionKey: String, agentID: String? = nil, draft: String? = nil) {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        self.closePanel()
        if let controller = self.windowController {
            // The window shell switches sessions in place (sidebar, /new);
            // full route identity tracks those switches and the global owner.
            if Self.shouldReuseController(currentRoute: self.windowRoute, requestedRoute: route) {
                controller.applyDraftIfEmpty(draft)
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
            initialDraft: draft,
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

    func newGatewayWindow() {
        guard let draft = Self.promptForGatewayProfile() else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let profile = try await MacGatewayProfileStore.shared.upsert(
                    name: draft.name,
                    url: draft.url,
                    token: draft.token,
                    password: draft.password)
                try await self.show(profile: profile)
            } catch {
                Self.showProfileError(error)
            }
        }
    }

    func show(profile: MacGatewayProfile) async throws {
        let connection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
        if let existing = self.profileWindowControllers[profile.id] {
            existing.show()
            Task {
                try? await connection.refresh()
            }
            return
        }
        let sessionKey = await connection.mainSessionKey()
        // MainActor methods are reentrant across the fleet and connection awaits.
        // A concurrent Cmd-N for the same profile must reuse the first completed window.
        if let existing = self.profileWindowControllers[profile.id] {
            existing.show()
            Task {
                try? await connection.refresh()
            }
            return
        }
        let route = WebChatRoute(sessionKey: sessionKey, agentID: nil)
        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            presentation: .window,
            connection: connection,
            gatewayID: profile.id,
            windowTitle: "\(profile.name) — OpenClaw",
            windowAutosaveName: "OpenClawChatWindow-\(profile.id)")
        controller.onSessionKeyChanged = { [weak self, weak controller] key in
            guard let self, let controller, self.profileWindowControllers[profile.id] === controller else { return }
            self.profileWindowRoutes[profile.id] = (self.profileWindowRoutes[profile.id] ?? route)
                .replacingSessionKey(key)
        }
        self.profileWindowControllers[profile.id] = controller
        self.profileWindowRoutes[profile.id] = route
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
        for controller in self.profileWindowControllers.values {
            controller.close()
        }
        self.profileWindowControllers.removeAll()
        self.profileWindowRoutes.removeAll()
        Task { await MacGatewayConnectionFleet.shared.shutdown() }
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

    private struct GatewayProfileDraft {
        let name: String
        let url: URL
        let token: String?
        let password: String?
    }

    private static func promptForGatewayProfile() -> GatewayProfileDraft? {
        let nameField = NSTextField(string: "")
        nameField.placeholderString = "Gateway name"
        let urlField = NSTextField(string: "wss://")
        urlField.placeholderString = "wss://gateway.example.com"
        let tokenField = NSSecureTextField(string: "")
        tokenField.placeholderString = "Token (optional)"
        let passwordField = NSSecureTextField(string: "")
        passwordField.placeholderString = "Password (optional)"
        let grid = NSGridView(views: [
            [NSTextField(labelWithString: "Name"), nameField],
            [NSTextField(labelWithString: "Gateway URL"), urlField],
            [NSTextField(labelWithString: "Token"), tokenField],
            [NSTextField(labelWithString: "Password"), passwordField],
        ])
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 1).width = 320
        grid.rowSpacing = 8

        let alert = NSAlert()
        alert.messageText = "New Gateway Window"
        alert.informativeText = "This window keeps an independent connection to its Gateway."
        alert.accessoryView = grid
        alert.addButton(withTitle: "Open Window")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn,
              let url = URL(string: urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        else { return nil }
        return GatewayProfileDraft(
            name: nameField.stringValue,
            url: url,
            token: tokenField.stringValue,
            password: passwordField.stringValue)
    }

    private static func showProfileError(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.messageText = "Could Not Open Gateway Window"
        alert.runModal()
    }
}
