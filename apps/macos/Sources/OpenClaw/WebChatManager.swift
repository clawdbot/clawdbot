import AppKit
import Foundation
import OpenClawChatUI

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

struct WebChatSessionObserverVisibilityOwners {
    private var ownersByConnection: [ObjectIdentifier: Set<ObjectIdentifier>] = [:]

    mutating func setVisible(
        _ visible: Bool,
        owner: ObjectIdentifier,
        connection: ObjectIdentifier) -> Bool?
    {
        let wasVisible = self.isVisible(connection: connection)
        if visible {
            self.ownersByConnection[connection, default: []].insert(owner)
        } else {
            self.ownersByConnection[connection]?.remove(owner)
            if self.ownersByConnection[connection]?.isEmpty == true {
                self.ownersByConnection.removeValue(forKey: connection)
            }
        }
        let isVisible = self.isVisible(connection: connection)
        return wasVisible == isVisible ? nil : isVisible
    }

    func isVisible(connection: ObjectIdentifier) -> Bool {
        self.ownersByConnection[connection]?.isEmpty == false
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
    private var currentChatRoute: WebChatRoute?
    private var cachedPreferredSessionKey: String?
    private var profileWindows: [UUID: ProfileWindowInstance] = [:]
    private var profileWindowOrder: [UUID] = []
    private var unavailableProfileIDs: Set<String> = []
    private var sessionObserverOwners = WebChatSessionObserverVisibilityOwners()
    private var sessionObserverMonitors: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var sessionObserverRequests: [ObjectIdentifier: (id: UUID, task: Task<Void, Never>)] = [:]
    private var sessionObserverDeclarations:
        [ObjectIdentifier: (lease: GatewayConnection.ServerLease, visible: Bool)] = [:]

    private static let lastGatewayProfileIDKey = "openclaw.webchat.lastGatewayProfileID"

    var onChatWindowVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.currentChatRoute?.sessionKey ?? self.windowRoute?.sessionKey
    }

    func show(sessionKey: String, agentID: String? = nil, draft: String? = nil) {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
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
            initialDraft: draft)
        controller.onVisibilityChanged = { [weak self, weak controller] visible in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(visible, owner: controller, connection: .shared)
            self.onChatWindowVisibilityChanged?(visible)
        }
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(false, owner: controller, connection: .shared)
            guard self.windowController === controller else { return }
            if self.currentChatRoute == self.windowRoute {
                self.currentChatRoute = nil
            }
            self.windowController = nil
            self.windowRoute = nil
        }
        controller.onSessionKeyChanged = { [weak self, weak controller] key in
            guard let self, let controller, self.windowController === controller else { return }
            // Retain the explicit or in-window selected agent while the shell
            // switches sessions so route reuse cannot fall back to presentation defaults.
            let updatedRoute = (self.windowRoute ?? route).replacingSessionKey(key)
            self.windowRoute = updatedRoute
            self.currentChatRoute = updatedRoute
        }
        controller.onAgentIDChanged = { [weak self, weak controller] agentID in
            guard let self, let controller, self.windowController === controller else { return }
            let key = self.windowRoute?.sessionKey ?? route.sessionKey
            let updatedRoute = WebChatRoute(sessionKey: key, agentID: agentID)
            self.windowRoute = updatedRoute
            self.currentChatRoute = updatedRoute
        }
        self.windowController = controller
        self.windowRoute = route
        self.currentChatRoute = route
        controller.show()
    }

    #if DEBUG
    func showSwarmFixture() {
        self.windowController?.close()
        let transport = MacSwarmFixtureChatTransport()
        let controller = WebChatSwiftUIWindowController(
            sessionKey: transport.sessionKey,
            transport: transport,
            windowTitle: "OpenClaw Swarm Fixture",
            windowAutosaveName: "OpenClawSwarmFixture")
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller, self.windowController === controller else { return }
            self.windowController = nil
            self.windowRoute = nil
        }
        self.windowController = controller
        self.windowRoute = WebChatRoute(sessionKey: transport.sessionKey, agentID: nil)
        controller.show()
    }
    #endif

    func newGatewayWindow() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let profiles = try await MacGatewayProfileStore.shared.profiles()
                guard !profiles.isEmpty else {
                    AppNavigationActions.openSettings(tab: .gateways)
                    return
                }
                let preferredID = AppDefaults.standard.string(forKey: Self.lastGatewayProfileIDKey)
                switch Self.promptForGatewayProfile(profiles: profiles, preferredID: preferredID) {
                case let .profile(profile):
                    AppDefaults.standard.set(profile.id, forKey: Self.lastGatewayProfileIDKey)
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
                AppDefaults.standard.set(profile.id, forKey: Self.lastGatewayProfileIDKey)
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
            connection: connection,
            gatewayID: profile.id,
            windowTitle: "\(profile.name) — OpenClaw",
            windowAutosaveName: "OpenClawChatWindow-\(profile.id)")
        controller.onVisibilityChanged = { [weak self, weak controller] visible in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(visible, owner: controller, connection: connection)
        }
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(false, owner: controller, connection: connection)
            guard self.profileWindows[windowID]?.controller === controller else { return }
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

    func recordActiveSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let route = self.currentChatRoute ?? self.windowRoute
        self.currentChatRoute = route?.replacingSessionKey(trimmed)
            ?? WebChatRoute(sessionKey: trimmed, agentID: nil)
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

    private func setSessionObserverVisible(
        _ visible: Bool,
        owner: WebChatSwiftUIWindowController,
        connection: GatewayConnection)
    {
        let connectionID = ObjectIdentifier(connection)
        guard let aggregateVisibility = self.sessionObserverOwners.setVisible(
            visible,
            owner: ObjectIdentifier(owner),
            connection: connectionID)
        else { return }

        if aggregateVisibility, self.sessionObserverMonitors[connectionID] == nil {
            // Visibility and subscriptions belong to a physical socket; a reconnect
            // must redeclare both while any window on that connection remains open.
            self.sessionObserverMonitors[connectionID] = Task { @MainActor [weak self] in
                let pushes = await connection.subscribe(bufferingNewest: 1)
                for await push in pushes {
                    guard !Task.isCancelled else { return }
                    guard case .snapshot = push else { continue }
                    guard let self else { return }
                    self.scheduleSessionObserverVisibility(
                        self.sessionObserverOwners.isVisible(connection: connectionID),
                        connection: connection)
                }
            }
        }
        self.scheduleSessionObserverVisibility(aggregateVisibility, connection: connection)
    }

    private func scheduleSessionObserverVisibility(
        _ visible: Bool,
        connection: GatewayConnection,
        remainingHiddenRetries: Int = 1)
    {
        let connectionID = ObjectIdentifier(connection)
        let previous = self.sessionObserverRequests[connectionID]?.task
        let requestID = UUID()
        let task = Task { @MainActor [weak self] in
            await previous?.value
            guard let self,
                  self.sessionObserverOwners.isVisible(connection: connectionID) == visible,
                  let lease = await connection.captureServerLease(),
                  self.sessionObserverOwners.isVisible(connection: connectionID) == visible
            else {
                self?.finishSessionObserverRequest(connection: connectionID, id: requestID)
                return
            }

            if let declaration = self.sessionObserverDeclarations[connectionID],
               declaration.visible == visible,
               await connection.isCurrentServerLease(declaration.lease)
            {
                self.finishSessionObserverRequest(connection: connectionID, id: requestID)
                return
            }

            // A timed-out mutation may already have changed the Gateway. Clear
            // the old confirmation before dispatch so reopening retries truthfully.
            self.sessionObserverDeclarations.removeValue(forKey: connectionID)
            do {
                if visible {
                    let subscribe = OpenClawChatGatewayRequests.subscribeSessions()
                    _ = try await connection.request(
                        method: subscribe.method,
                        params: subscribe.params,
                        timeoutMs: subscribe.timeoutMs,
                        ifCurrentServerLease: lease)
                }
                guard self.sessionObserverOwners.isVisible(connection: connectionID) == visible else {
                    self.finishSessionObserverRequest(connection: connectionID, id: requestID)
                    return
                }
                let request = OpenClawChatGatewayRequests.setSessionObserverVisibility(visible)
                _ = try await connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: lease)
                if visible {
                    self.sessionObserverDeclarations[connectionID] = (lease: lease, visible: true)
                } else {
                    self.sessionObserverDeclarations.removeValue(forKey: connectionID)
                    if !self.sessionObserverOwners.isVisible(connection: connectionID) {
                        self.sessionObserverMonitors.removeValue(forKey: connectionID)?.cancel()
                    }
                }
            } catch {
                // A hidden mutation can time out after dispatch. Retry once on its
                // original socket; keep the snapshot monitor for a replaced socket.
                if !visible,
                   remainingHiddenRetries > 0,
                   await connection.isCurrentServerLease(lease),
                   !self.sessionObserverOwners.isVisible(connection: connectionID)
                {
                    self.scheduleSessionObserverVisibility(
                        false,
                        connection: connection,
                        remainingHiddenRetries: remainingHiddenRetries - 1)
                }
            }
            self.finishSessionObserverRequest(connection: connectionID, id: requestID)
        }
        self.sessionObserverRequests[connectionID] = (id: requestID, task: task)
    }

    private func finishSessionObserverRequest(connection: ObjectIdentifier, id: UUID) {
        guard self.sessionObserverRequests[connection]?.id == id else { return }
        self.sessionObserverRequests.removeValue(forKey: connection)
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
    func _testSessionObserverVisible(connection: GatewayConnection) -> Bool {
        self.sessionObserverOwners.isVisible(connection: ObjectIdentifier(connection))
    }

    func _testProfileWindowCount(profileID: String) -> Int {
        self.profileWindows.values.count { $0.profileID == profileID }
    }
    #endif
}
