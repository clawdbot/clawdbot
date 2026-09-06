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
        let connection: GatewayConnection
        let controller: WebChatSwiftUIWindowController
    }

    private var windowController: WebChatSwiftUIWindowController?
    private var windowRoute: WebChatRoute?
    private var currentChatRoute: WebChatRoute?
    private var cachedPreferredSessionKey: String?
    private var primaryGatewayID: String?
    private let primaryConnection: GatewayConnection
    private let selection: MacGatewaySelectionPreferences
    private var profileChangeObservers: [NSObjectProtocol] = []

    init(primaryConnection: GatewayConnection = .shared, selection: MacGatewaySelectionPreferences = .shared) {
        self.primaryConnection = primaryConnection
        self.selection = selection
        self.profileChangeObservers = [
            MacGatewayProfileStore.willChangePrincipalNotification,
            MacGatewayProfileStore.didChangeNotification,
        ].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let id = note.userInfo?[MacGatewayProfileStore.changedProfileIDKey] as? String else { return }
                let removed = note.userInfo?[MacGatewayProfileStore.removedProfileKey] as? Bool == true
                MainActor.assumeIsolated {
                    if name == MacGatewayProfileStore.willChangePrincipalNotification {
                        self?.closeGatewayWindows(profileID: id)
                    } else if removed {
                        self?.selection.forget(profileID: id)
                        self?.closeGatewayWindows(profileID: id)
                    } else {
                        self?.gatewayProfileDidSave(profileID: id)
                    }
                }
            }
        }
    }

    isolated deinit {
        for observer in self.profileChangeObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    private var primaryGeneration: UInt64 = 0
    private var primaryOpenTask: Task<Void, Never>?
    private var windowGeneration: UInt64 = 0
    private var fleetShutdownTask: Task<Void, Never>?
    private var profileWindows: [UUID: ProfileWindowInstance] = [:]
    private var profileWindowOrder: [UUID] = []
    private var unavailableProfileIDs: Set<String> = []
    private var sessionObserverOwners = WebChatSessionObserverVisibilityOwners()
    private var sessionObserverMonitors: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var sessionObserverRequests: [ObjectIdentifier: (id: UUID, task: Task<Void, Never>)] = [:]
    private var sessionObserverDeclarations:
        [ObjectIdentifier: (lease: GatewayConnection.ServerLease, visible: Bool)] = [:]

    var onChatWindowVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.currentChatRoute?.sessionKey ?? self.windowRoute?.sessionKey
    }

    func show(sessionKey: String? = nil, agentID: String? = nil, draft: String? = nil) {
        self.primaryOpenTask?.cancel()
        self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
            root: OpenClawConfigFile.loadDict()))
        if let sessionKey = sessionKey ?? self.cachedPreferredSessionKey {
            self.presentChat(sessionKey: sessionKey, agentID: agentID, draft: draft)
            return
        }

        let generation = self.primaryGeneration
        let connection = self.primaryConnection
        self.primaryOpenTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled else { return }
            let sessionKey = await connection.mainSessionKey()
            guard !Task.isCancelled, let self else { return }
            self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
                root: OpenClawConfigFile.loadDict()))
            guard generation == self.primaryGeneration else { return }
            self.cachedPreferredSessionKey = sessionKey
            self.presentChat(sessionKey: sessionKey, agentID: agentID, draft: draft)
        }
    }

    func show(
        sessionKey: String,
        ifCurrentRouteFrom lease: GatewayConnection.ServerLease,
        onRejected: @escaping @MainActor () -> Void)
    {
        self.primaryOpenTask?.cancel()
        let root = OpenClawConfigFile.loadDict()
        guard self.primaryConnection.serverLeaseMatchesCurrentRoute(lease),
              let owner = lease.route.deviceAuthGatewayID,
              owner == GatewayDiscoveryPreferences.deviceAuthGatewayID(root: root),
              let cacheID = MacChatTranscriptCache.gatewayID(root: root)
        else {
            onRejected()
            return
        }
        self.preparePrimaryGateway(gatewayID: owner)
        let generation = self.primaryGeneration
        let connection = self.primaryConnection
        // Resolve the complete route before presentation: its storage identity
        // intentionally omits credential rotations and TLS pin changes.
        self.primaryOpenTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled else { return }
            let current = await connection.isCurrentRoute(lease.route)
            guard !Task.isCancelled, let self, generation == self.primaryGeneration else { return }
            guard current, connection.serverLeaseMatchesCurrentRoute(lease) else {
                onRejected()
                return
            }
            self.presentChat(sessionKey: sessionKey, agentID: nil, draft: nil, gatewayID: cacheID)
        }
    }

    private func presentChat(sessionKey: String, agentID: String?, draft: String?, gatewayID: String? = nil) {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        if let controller = windowController {
            // The window shell switches sessions in place (sidebar, /new);
            // full route identity tracks those switches and the global owner.
            if Self.shouldReuseController(currentRoute: self.windowRoute, requestedRoute: route) {
                controller.applyDraftIfEmpty(draft)
                controller.show()
                return
            }

            // Detach before closing so the retired controller's callback cannot
            // cancel this already-admitted successor.
            self.windowController = nil
            self.windowRoute = nil
            controller.close()
        }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            initialDraft: draft,
            connection: self.primaryConnection,
            gatewayID: gatewayID)
        controller.onVisibilityChanged = { [weak self, weak controller] visible in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(visible, owner: controller, connection: self.primaryConnection)
            self.onChatWindowVisibilityChanged?(visible)
        }
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(false, owner: controller, connection: self.primaryConnection)
            guard self.windowController === controller else { return }
            self.cancelPrimaryOpen()
            if self.currentChatRoute == self.windowRoute {
                self.currentChatRoute = nil
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
        let generation = self.windowGeneration
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let profiles = try await MacGatewayProfileStore.shared.profiles()
                guard generation == self.windowGeneration else { return }
                guard !profiles.isEmpty else {
                    AppNavigationActions.openConnection(tab: .gateways)
                    return
                }
                let preferredID = self.selection.profileID
                switch Self.promptForGatewayProfile(profiles: profiles, preferredID: preferredID) {
                case let .profile(profile):
                    guard generation == self.windowGeneration else { return }
                    try await self.show(profile: profile)
                case .manage:
                    AppNavigationActions.openConnection(tab: .gateways)
                case nil:
                    break
                }
            } catch is CancellationError {
            } catch {
                Self.showProfileError(error, message: "Could Not Open Gateway Window")
            }
        }
    }

    func openGatewayWindow(profile: MacGatewayProfile) {
        let generation = self.windowGeneration
        Task { @MainActor [weak self] in
            guard let self, generation == self.windowGeneration else { return }
            do {
                try await self.show(profile: profile)
            } catch is CancellationError {
            } catch {
                Self.showProfileError(error, message: "Could Not Open Gateway Window")
            }
        }
    }

    func show(profile: MacGatewayProfile) async throws {
        let generation = self.windowGeneration
        // An older close must finish retiring the fleet before this open can acquire its successor.
        await self.fleetShutdownTask?.value
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
        let connection = binding.connection
        let chatStoreID = binding.chatStoreID
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        let sessionKey = await connection.mainSessionKey()
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
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
            gatewayID: chatStoreID,
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
            connection: connection,
            controller: controller)
        self.profileWindowOrder.append(windowID)
        controller.cascade(from: previousController)
        controller.show()
        self.selection.select(.profile(profile.id))
    }

    private func requireCurrentWindowRequest(_ generation: UInt64, profileID: String) throws {
        try Task.checkCancellation()
        guard generation == self.windowGeneration else { throw CancellationError() }
        guard !self.unavailableProfileIDs.contains(profileID) else {
            throw MacGatewayProfileError.profileNotFound
        }
    }

    func closeGatewayWindows(profileID: String) {
        // Removal fences in-flight window creation before awaiting connection
        // shutdown, so an old picker selection cannot resurrect this profile.
        self.unavailableProfileIDs.insert(profileID)
        self.windowGeneration &+= 1
        let windowIDs = self.profileWindowOrder.filter { self.profileWindows[$0]?.profileID == profileID }
        let instances = windowIDs.compactMap { self.profileWindows.removeValue(forKey: $0) }
        let windowIDSet = Set(windowIDs)
        self.profileWindowOrder.removeAll { windowIDSet.contains($0) }
        for instance in instances {
            instance.controller.close()
            self.retireSessionObserver(connection: instance.connection)
        }
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

    private func cancelPrimaryOpen() {
        self.primaryGeneration &+= 1
        self.primaryOpenTask?.cancel()
        self.primaryOpenTask = nil
    }

    func resetPrimaryConnections() {
        self.cancelPrimaryOpen()
        let controller = self.windowController
        self.windowController = nil
        self.windowRoute = nil
        self.currentChatRoute = nil
        self.cachedPreferredSessionKey = nil
        controller?.close()
    }

    func preparePrimaryGateway(gatewayID: String?) {
        guard self.primaryGatewayID != gatewayID else { return }
        self.resetPrimaryConnections()
        self.primaryGatewayID = gatewayID
    }

    func close() {
        // Invalidate admitted opens before closing windows or awaiting fleet retirement.
        self.windowGeneration &+= 1
        self.resetPrimaryConnections()
        let profileControllers = self.profileWindows.values.map(\.controller)
        self.profileWindows.removeAll()
        self.profileWindowOrder.removeAll()
        for controller in profileControllers {
            controller.close()
        }
        let previousShutdown = self.fleetShutdownTask
        self.fleetShutdownTask = Task {
            await previousShutdown?.value
            for connection in await MacGatewayConnectionFleet.shared.shutdown() {
                self.retireSessionObserver(connection: connection)
            }
        }
    }

    private func retireSessionObserver(connection: GatewayConnection) {
        let connectionID = ObjectIdentifier(connection)
        // A retired profile has no future socket on which to declare hidden.
        // Its subscription must end even when the final hide cannot acquire a lease.
        self.sessionObserverMonitors.removeValue(forKey: connectionID)?.cancel()
        self.sessionObserverRequests.removeValue(forKey: connectionID)?.task.cancel()
        self.sessionObserverDeclarations.removeValue(forKey: connectionID)
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
                for await delivery in pushes {
                    guard !Task.isCancelled else { return }
                    guard delivery.isCurrent, case .snapshot = delivery.push else { continue }
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
            defer { self?.finishSessionObserverRequest(connection: connectionID, id: requestID) }
            guard !Task.isCancelled, let self,
                  self.sessionObserverOwners.isVisible(connection: connectionID) == visible,
                  let lease = await connection.captureServerLease(),
                  !Task.isCancelled,
                  self.sessionObserverOwners.isVisible(connection: connectionID) == visible
            else { return }

            if let declaration = self.sessionObserverDeclarations[connectionID],
               declaration.visible == visible,
               await connection.isCurrentServerLease(declaration.lease)
            { return }

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
                guard !Task.isCancelled,
                      self.sessionObserverOwners.isVisible(connection: connectionID) == visible
                else { return }
                let request = OpenClawChatGatewayRequests.setSessionObserverVisibility(visible)
                _ = try await connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: lease)
                guard !Task.isCancelled else { return }
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
                   !Task.isCancelled,
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

    enum GatewayProfileSelection {
        case profile(MacGatewayProfile)
        case manage
    }

    static func promptForGatewayProfile(
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
