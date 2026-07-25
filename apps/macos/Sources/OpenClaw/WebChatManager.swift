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

    private struct ProfileWindowInstance {
        let profileID: String
        let controller: WebChatSwiftUIWindowController
    }

    private var windowController: WebChatSwiftUIWindowController?
    private var windowRoute: WebChatRoute?
    private var panelController: WebChatSwiftUIWindowController?
    private var panelRoute: WebChatRoute?
    private var currentChatRoute: WebChatRoute?
    private var cachedPreferredSessionKey: String?
    private var profileWindows: [UUID: ProfileWindowInstance] = [:]
    private var profileWindowOrder: [UUID] = []
    private var unavailableProfileIDs: Set<String> = []

    private static let lastGatewayProfileIDKey = "openclaw.webchat.lastGatewayProfileID"

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.currentChatRoute?.sessionKey ?? self.panelRoute?.sessionKey ?? self.windowRoute?.sessionKey
    }

    func show(sessionKey: String, agentID: String? = nil, draft: String? = nil) {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        self.closePanel()
        if let controller = windowController {
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
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller, self.windowController === controller else { return }
            if self.currentChatRoute == self.windowRoute {
                self.currentChatRoute = self.panelRoute
            }
            self.windowController = nil
            self.windowRoute = nil
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
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let profiles = try await MacGatewayProfileStore.shared.profiles()
                guard !profiles.isEmpty else {
                    AppNavigationActions.openSettings(tab: .gateways)
                    return
                }
                let preferredID = UserDefaults.standard.string(forKey: Self.lastGatewayProfileIDKey)
                switch Self.promptForGatewayProfile(profiles: profiles, preferredID: preferredID) {
                case let .profile(profile):
                    UserDefaults.standard.set(profile.id, forKey: Self.lastGatewayProfileIDKey)
                    try await self.show(profile: profile)
                case .manage:
                    AppNavigationActions.openSettings(tab: .gateways)
                case nil:
                    break
                }
            } catch {
                Self.showProfileError(error, message: "Could Not Open Gateway Window")
            }
        }
    }

    func openGatewayWindow(profile: MacGatewayProfile) {
        Task { @MainActor [weak self] in
            do {
                UserDefaults.standard.set(profile.id, forKey: Self.lastGatewayProfileIDKey)
                try await self?.show(profile: profile)
            } catch {
                Self.showProfileError(error, message: "Could Not Open Gateway Window")
            }
        }
    }

    func show(profile: MacGatewayProfile) async throws {
        guard !self.unavailableProfileIDs.contains(profile.id) else {
            throw MacGatewayProfileError.profileNotFound
        }
        let connection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
        guard !self.unavailableProfileIDs.contains(profile.id) else {
            throw MacGatewayProfileError.profileNotFound
        }
        let sessionKey = await connection.mainSessionKey()
        guard !self.unavailableProfileIDs.contains(profile.id) else {
            throw MacGatewayProfileError.profileNotFound
        }
        let windowID = UUID()
        let route = WebChatRoute(sessionKey: sessionKey, agentID: nil)
        let previousController = self.profileWindowOrder.reversed().lazy
            .compactMap { self.profileWindows[$0] }
            .first { $0.profileID == profile.id }?
            .controller
        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            presentation: .window,
            connection: connection,
            gatewayID: profile.id,
            windowTitle: "\(profile.name) — OpenClaw",
            windowAutosaveName: "OpenClawChatWindow-\(profile.id)")
        controller.onClosed = { [weak self, weak controller] in
            guard let self,
                  let controller,
                  self.profileWindows[windowID]?.controller === controller
            else { return }
            self.profileWindows.removeValue(forKey: windowID)
            self.profileWindowOrder.removeAll { $0 == windowID }
        }
        self.profileWindows[windowID] = ProfileWindowInstance(
            profileID: profile.id,
            controller: controller)
        self.profileWindowOrder.append(windowID)
        controller.cascade(from: previousController)
        controller.show()
        Task {
            try? await connection.refresh()
        }
    }

    func closeGatewayWindows(profileID: String) async {
        // Removal fences in-flight window creation before awaiting connection
        // shutdown, so an old picker selection cannot resurrect this profile.
        self.unavailableProfileIDs.insert(profileID)
        let windowIDs = self.profileWindowOrder.filter { self.profileWindows[$0]?.profileID == profileID }
        let controllers = windowIDs.compactMap { self.profileWindows.removeValue(forKey: $0)?.controller }
        let windowIDSet = Set(windowIDs)
        self.profileWindowOrder.removeAll { windowIDSet.contains($0) }
        for controller in controllers {
            controller.close()
        }
        await MacGatewayConnectionFleet.shared.remove(profileID: profileID)
    }

    func gatewayProfileDidSave(profileID: String) {
        self.unavailableProfileIDs.remove(profileID)
    }

    func togglePanel(
        sessionKey: String,
        agentID: String? = nil,
        anchorProvider: @escaping () -> NSRect?)
    {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        if let controller = panelController {
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
        if let cachedPreferredSessionKey {
            return cachedPreferredSessionKey
        }
        let key = await GatewayConnection.shared.mainSessionKey()
        cachedPreferredSessionKey = key
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
        let profileControllers = self.profileWindows.values.map(\.controller)
        self.profileWindows.removeAll()
        self.profileWindowOrder.removeAll()
        self.unavailableProfileIDs.removeAll()
        for controller in profileControllers {
            controller.close()
        }
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

    private enum GatewayProfileSelection {
        case profile(MacGatewayProfile)
        case manage
    }

    private static func promptForGatewayProfile(
        profiles: [MacGatewayProfile],
        preferredID: String?) -> GatewayProfileSelection?
    {
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 28), pullsDown: false)
        popup.addItems(withTitles: profiles.map(Self.profilePickerTitle))
        popup.selectItem(at: Self.preferredProfileIndex(profiles: profiles, preferredID: preferredID))

        let alert = NSAlert()
        alert.messageText = "New Gateway Window"
        alert.informativeText = "Choose a saved Gateway. You can open more than one window for the same Gateway."
        alert.accessoryView = popup
        alert.addButton(withTitle: "Open Window")
        alert.addButton(withTitle: "Manage Gateways…")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            guard profiles.indices.contains(popup.indexOfSelectedItem) else { return nil }
            return .profile(profiles[popup.indexOfSelectedItem])
        case .alertSecondButtonReturn:
            return .manage
        default:
            return nil
        }
    }

    nonisolated static func preferredProfileIndex(profiles: [MacGatewayProfile], preferredID: String?) -> Int {
        profiles.firstIndex { $0.id == preferredID } ?? 0
    }

    private static func profilePickerTitle(_ profile: MacGatewayProfile) -> String {
        "\(profile.name) — \(profile.url.absoluteString)"
    }

    private static func showProfileError(_ error: Error, message: String) {
        let alert = NSAlert(error: error)
        alert.messageText = message
        alert.runModal()
    }

    #if DEBUG
    func _testProfileWindowCount(profileID: String) -> Int {
        self.profileWindows.values.count { $0.profileID == profileID }
    }
    #endif
}
