import AppKit
import Foundation
import Observation
import OpenClawKit
import OSLog
import WebKit

private let dashboardManagerLogger = Logger(subsystem: "ai.openclaw", category: "DashboardManager")

enum DashboardRouteProbePurpose: Sendable {
    case authentication
    case presentation
}

@MainActor
@Observable
final class DashboardManager {
    private struct AuxiliaryWindowInstance {
        var target: DashboardGatewayTarget
        var controller: DashboardWindowController
    }

    private struct WindowConfiguration {
        let url: URL
        let auth: DashboardWindowAuth
        let tlsParams: GatewayTLSParams?
        let mode: AppState.ConnectionMode
        let displayName: String
        var browserSession: GatewayBrowserSession?
    }

    private struct SupersededDashboardPresentation: Error {}

    private struct NavigationIntent {
        let id = UUID()
        let windowID: ObjectIdentifier?
    }

    private final class ProfileObservation {
        let id = UUID()
        var task: Task<Void, Never>?
        var snapshot: GatewayConnection.PushDelivery?
        var revision: UInt64 = 0
        var needsRefresh = false
    }

    @ObservationIgnored private var controller: DashboardWindowController?
    @ObservationIgnored private var mainTarget: DashboardGatewayTarget
    @ObservationIgnored private let selection: MacGatewaySelectionPreferences
    @ObservationIgnored private var pendingInitialSelection: String?
    @ObservationIgnored private var auxiliaryWindows: [UUID: AuxiliaryWindowInstance] = [:]
    @ObservationIgnored private var auxiliaryWindowOrder: [UUID] = []
    @ObservationIgnored private var endpointTask: Task<Void, Never>?
    @ObservationIgnored private var presentationTask: Task<Void, Error>?
    @ObservationIgnored private var pendingOpenCommands: [DashboardNativeCommand] = []
    @ObservationIgnored private var openForCommandTask: Task<Void, Never>?
    @ObservationIgnored private var navigationIntents: [DashboardGatewayTarget: NavigationIntent] = [:]
    @ObservationIgnored private var updater: UpdaterProviding?
    @ObservationIgnored private var displayedPrimaryRoutes:
        [ObjectIdentifier: (revision: UInt64?, authority: UInt64?)] = [:]
    @ObservationIgnored private var endpointGeneration: UInt64 = 0
    @ObservationIgnored private var presentationGeneration: UInt64 = 0
    @ObservationIgnored private var windowLifetime: UInt64 = 0
    @ObservationIgnored private var gatewaySnapshotGeneration: UInt64 = 0
    @ObservationIgnored private var profileCredentialsNeedRefresh = false
    @ObservationIgnored private var profileObservations: [DashboardGatewayTarget: ProfileObservation] = [:]
    @ObservationIgnored private let authTokenProvider: @Sendable (GatewayConnection.Config) async -> String?
    @ObservationIgnored private let connectionProvider: @Sendable (DashboardGatewayTarget) async -> GatewayConnection
    @ObservationIgnored private let browserIdentityURLProvider:
        @Sendable (DashboardGatewayTarget, GatewayConnection.Config) async throws -> URL?
    @ObservationIgnored private let routeProbe: @Sendable (DashboardRouteProbePurpose) async -> Void
    @ObservationIgnored private let endpointStateProvider: @Sendable () async -> GatewayEndpointState
    @ObservationIgnored private let mainWindowAutosaveName: String
    @ObservationIgnored private let websiteDataStore: WKWebsiteDataStore
    @ObservationIgnored private var profileBrowserStores: [String: DashboardBrowserSessionStore] = [:]
    @ObservationIgnored private var profileCredentialRevisions: [String: UInt64] = [:]
    @ObservationIgnored private var unavailableProfileIDs: Set<String> = []
    @ObservationIgnored private var profileRemovalTasks: [String: (id: UUID, task: Task<Void, Error>)] = [:]
    @ObservationIgnored private let observesGatewayChanges: Bool
    @ObservationIgnored private let automaticGatewayProfileRefreshEnabled: Bool
    private(set) var gatewayEntries: [DashboardGatewayEntry] = []
    private(set) var frontmostDashboardTarget: DashboardGatewayTarget?
    @ObservationIgnored private var gatewayRefreshObservers: [NSObjectProtocol] = []
    #if DEBUG
    var testPrimaryEndpointProvider:
        (@Sendable (AppState.ConnectionMode) async throws -> GatewayConnection.EndpointSnapshot)?
    var testProfileEndpointProvider: (@Sendable (String) async throws
        -> GatewayConnection.EndpointSnapshot)?
    var testGatewayEntriesProvider: (@MainActor () async throws -> [DashboardGatewayEntry])?
    #endif
    private static let failureURL = URL(string: "about:blank")!

    init(
        websiteDataStore: WKWebsiteDataStore,
        selection: MacGatewaySelectionPreferences,
        authTokenProvider: @escaping @Sendable (GatewayConnection.Config) async -> String? = { config in
            await GatewayConnection.shared.controlUiAutoAuthToken(config: config)
        },
        connectionProvider: @escaping @Sendable (DashboardGatewayTarget) async -> GatewayConnection = {
            await DashboardManager.gatewayConnection(for: $0)
        },
        browserIdentityURLProvider: (@Sendable (DashboardGatewayTarget, GatewayConnection.Config) async throws
            -> URL?)? = nil,
        routeProbe: @escaping @Sendable (DashboardRouteProbePurpose) async -> Void = { purpose in
            switch purpose {
            case .authentication:
                // Missing credentials must not start recovery or mark the channel degraded.
                _ = try? await GatewayConnection.shared.request(
                    method: "health",
                    params: nil,
                    timeoutMs: 3000,
                    retryTransportFailures: false)
            case .presentation:
                _ = try? await ControlChannel.shared.health(timeout: 3)
            }
        },
        endpointStateProvider: @escaping @Sendable () async -> GatewayEndpointState = {
            await GatewayEndpointStore.shared.currentState()
        },
        observeGatewayChanges: Bool = true,
        automaticGatewayProfileRefreshEnabled: Bool = true,
        mainWindowAutosaveName: String = DashboardWindowLayout.windowFrameAutosaveName)
    {
        self.websiteDataStore = websiteDataStore
        self.selection = selection
        self.mainTarget = selection.target
        self.pendingInitialSelection = selection.profileID
        self.authTokenProvider = authTokenProvider
        self.connectionProvider = connectionProvider
        self.browserIdentityURLProvider = browserIdentityURLProvider ?? { target, config in
            let connection = await connectionProvider(target)
            return try await connection.controlUiBrowserIdentityURL(config: config)
        }
        self.routeProbe = routeProbe
        self.endpointStateProvider = endpointStateProvider
        self.mainWindowAutosaveName = mainWindowAutosaveName
        self.observesGatewayChanges = observeGatewayChanges
        self.automaticGatewayProfileRefreshEnabled = automaticGatewayProfileRefreshEnabled
        if observeGatewayChanges, automaticGatewayProfileRefreshEnabled {
            let names: [Notification.Name] = [
                MacGatewayProfileStore.willChangePrincipalNotification,
                MacGatewayProfileStore.didChangeNotification,
                .openclawConfigDidChange,
                .controlChannelStateDidChange,
            ]
            self.gatewayRefreshObservers = names.map { name in
                NotificationCenter.default.addObserver(
                    forName: name,
                    object: nil,
                    queue: .main)
                { [weak self] notification in
                    if name == MacGatewayProfileStore.willChangePrincipalNotification,
                       let profileID = notification.userInfo?[MacGatewayProfileStore.changedProfileIDKey] as? String
                    {
                        MainActor.assumeIsolated {
                            guard let self else { return }
                            let target = DashboardGatewayTarget.profile(profileID)
                            self.retireNavigation(for: target)
                            for instance in self.dashboardControllers() where instance.target == target {
                                self.retireNavigation(for: target, from: instance.controller)
                                instance.controller.retirePendingSessionCommands()
                            }
                            if self.mainTarget == target {
                                self.retirePresentation()
                                self.pendingOpenCommands.removeAll()
                                self.openForCommandTask?.cancel()
                                self.openForCommandTask = nil
                            }
                            self.invalidateProfileDocument(profileID: profileID, retireManualDocuments: true)
                            self.profileObservations.removeValue(forKey: target)?.task?.cancel()
                        }
                        return
                    }
                    if name == MacGatewayProfileStore.didChangeNotification,
                       let profileID = notification.userInfo?[MacGatewayProfileStore.changedProfileIDKey] as? String
                    {
                        let removed = notification
                            .userInfo?[MacGatewayProfileStore.removedProfileKey] as? Bool == true
                        let changeID = notification.userInfo?[MacGatewayProfileStore.changeIDKey] as? UUID
                        MainActor.assumeIsolated {
                            if removed, let changeID {
                                self?.selection.forget(profileID: profileID)
                                self?.retireRemovedProfile(profileID, removalID: changeID)
                            } else {
                                self?.unavailableProfileIDs.remove(profileID)
                                self?.invalidateProfileDocument(profileID: profileID)
                            }
                        }
                    }
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if name == .controlChannelStateDidChange {
                            await self.handleControlChannelStateChange(ControlChannel.shared.state)
                        }
                        if name == MacGatewayProfileStore.didChangeNotification {
                            // Retain the invalidation until the latest catalog refresh finishes.
                            self.profileCredentialsNeedRefresh = true
                        }
                        await self.refreshGatewaySnapshots()
                    }
                }
            }
            let windowNames: [Notification.Name] = [
                NSWindow.didBecomeKeyNotification,
                NSWindow.willCloseNotification,
            ]
            self.gatewayRefreshObservers += windowNames.map { name in
                NotificationCenter.default.addObserver(
                    forName: name,
                    object: nil,
                    queue: .main)
                { [weak self] _ in
                    Task { @MainActor [weak self] in self?.updateFrontmostDashboardTarget() }
                }
            }
        }
    }

    isolated deinit {
        for observation in self.profileObservations.values {
            observation.task?.cancel()
        }
    }

    private func handleControlChannelStateChange(_ state: ControlChannel.ConnectionState) async {
        guard state == .connected else { return }
        // Endpoint readiness can precede device authentication. Reconcile the
        // existing document after auth arrives without inventing a route change.
        let endpointState = await endpointStateProvider()
        await handleEndpointState(endpointState)
    }

    @discardableResult
    private func retireRemovedProfile(_ profileID: String, removalID: UUID? = nil) -> Task<Void, Error> {
        if removalID == nil, self.unavailableProfileIDs.contains(profileID),
           let removal = self.profileRemovalTasks[profileID] { return removal.task }
        self.unavailableProfileIDs.insert(profileID)
        self.profileCredentialRevisions[profileID, default: 0] &+= 1
        self.navigationIntents[.profile(profileID)] = nil
        let cleanup = self.browserStore(profileID: profileID).removeData()
        self.profileRemovalTasks[profileID] = (removalID ?? UUID(), cleanup)
        if self.mainTarget == .primary, AppStateStore.shared.connectionMode == .unconfigured {
            retirePresentation()
        }
        let windows = self.auxiliaryWindows.values.filter { $0.target == .profile(profileID) }.map(\.controller)
        for controller in windows {
            controller.invalidateBrowserSession()
            controller.closeDashboard()
        }
        if self.mainTarget == .profile(profileID) {
            retirePresentation()
            self.controller?.invalidateBrowserSession()
            self.controller?.closeDashboard()
            self.controller = nil
            self.mainTarget = .primary
        }
        return cleanup
    }

    func finishGatewayRemoval(profileID: String, removalID: UUID) async throws {
        // A completion from an older delete must never close a re-added profile
        // or consume the browser cleanup receipt belonging to its successor.
        if let removal = profileRemovalTasks[profileID], removal.id == removalID {
            self.profileRemovalTasks.removeValue(forKey: profileID)
            do {
                try await removal.task.value
            } catch GatewayBrowserSessionError.superseded {
                // A later explicit sign-in owns the successor cookie and waits
                // for this clear; removal must not erase that newer session.
            }
        }
    }

    /// The remote SSH tunnel can be recreated on a new ephemeral local port while
    /// the dashboard stays open; without following endpoint changes the WebView
    /// keeps reconnecting to the dead old port forever (#100476).
    private func observeEndpointChanges() {
        guard self.observesGatewayChanges, self.endpointTask == nil else { return }
        self.endpointTask = Task { [weak self] in
            let stream = await GatewayEndpointStore.shared.subscribe()
            for await state in stream {
                guard let self else { return }
                await self.handleEndpointState(state)
            }
        }
    }

    func handleEndpointState(_ state: GatewayEndpointState) async {
        // Primary is a route role, independent of which native window displays it.
        // Saved-profile documents keep their own endpoint and credentials.
        self.endpointGeneration &+= 1
        let generation = self.endpointGeneration
        let controllers = dashboardControllers().filter { $0.target == .primary }.map(\.controller)
        guard !controllers.isEmpty else { return }
        guard case let .ready(mode, url, token, password, routeRevision) = state else {
            for controller in controllers {
                self.replaceWithRouteFailure(controller)
            }
            return
        }
        let windows = controllers.map { ($0, $0.windowLifetimeRevision) }
        // A reopened shell starts a new lifetime even when it retains its controller.
        // Other primary windows still receive this endpoint's result.
        let currentControllers = {
            windows.compactMap { controller, lifetime -> DashboardWindowController? in
                guard self.target(for: controller) == .primary, controller.isWindowOpen,
                      controller.windowLifetimeRevision == lifetime else { return nil }
                return controller
            }
        }
        let config: GatewayConnection.Config = (url, token, password)
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: config,
            tls: GatewayTLSRoute.resolve(
                url: url,
                connectionMode: mode,
                configuredFingerprint: mode == .remote
                    ? GatewayRemoteConfig.resolveTLSFingerprint(root: OpenClawConfigFile.loadDict())
                    : nil),
            routeAuthority: nil,
            revision: routeRevision)
        var authToken = await authTokenProvider(config)
        guard self.endpointGeneration == generation else { return }
        if authToken == nil, password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty == nil {
            await self.routeProbe(.authentication)
            guard self.endpointGeneration == generation else { return }
            authToken = await self.authTokenProvider(config)
            guard self.endpointGeneration == generation else { return }
        }
        let configuration: WindowConfiguration
        do {
            configuration = try await dashboardConfiguration(
                endpoint: endpoint, mode: mode, target: .primary, token: authToken)
        } catch {
            guard self.endpointGeneration == generation else { return }
            for controller in currentControllers() {
                controller.showFailure(
                    title: "Dashboard unavailable",
                    message: error.localizedDescription,
                    detail: "Reconnect to the Gateway to verify its dashboard sign-in address.",
                    present: false)
            }
            return
        }
        guard self.endpointGeneration == generation else { return }
        let dashboardURL = configuration.url
        let auth = configuration.auth
        for controller in currentControllers() {
            let key = ObjectIdentifier(controller)
            let previousRoute = self.displayedPrimaryRoutes[key]
            let revisionChanged = (previousRoute?.revision).map { $0 != routeRevision } ?? (routeRevision > 0)
            let routeChanged = revisionChanged || !controller.hasTLSParams(configuration.tlsParams) ||
                controller.auth.gatewayUrl != auth.gatewayUrl
            let credentialChanged = controller.auth != auth
            if routeChanged || credentialChanged {
                guard auth.hasCredential || auth.usesBrowserIdentity else {
                    self.replaceWithRouteFailure(controller)
                    continue
                }
                if let replacement = replaceWindowController(
                    controller,
                    configuration: configuration,
                    target: .primary,
                    present: false)
                {
                    self.displayedPrimaryRoutes[ObjectIdentifier(replacement)] = (routeRevision, nil)
                }
            } else {
                let updateBridgeEnabled = controller === self.controller && Self.updateBridgeEnabled(mode: mode)
                if dashboardURL == controller.currentURL {
                    controller.setUpdateBridgeEnabled(updateBridgeEnabled)
                } else if auth.hasCredential || auth.usesBrowserIdentity {
                    controller.update(url: dashboardURL, auth: auth, updateBridgeEnabled: updateBridgeEnabled)
                }
                self.displayedPrimaryRoutes[key] = (routeRevision, previousRoute?.authority)
            }
        }
    }

    private func replaceWithRouteFailure(_ current: DashboardWindowController) {
        guard current.currentURL != Self.failureURL || current.auth.hasCredential else { return }
        let replacement = self.replaceWindowController(
            current,
            configuration: WindowConfiguration(
                url: Self.failureURL,
                auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
                tlsParams: nil,
                mode: .unconfigured,
                displayName: "OpenClaw"),
            target: .primary,
            present: false)
        replacement?.showFailure(
            title: "Dashboard reconnecting",
            message: "The selected Gateway changed.",
            detail: "Waiting for a fresh authenticated connection.",
            present: false,
            preservingPendingCommands: true)
    }

    func presentDashboard() {
        self.retireNavigation(for: self.mainTarget)
        if self.showConfiguredWindowIfPossible() {
            return
        }
        guard self.presentationTask == nil else { return }
        let presentation = currentPresentationTask()
        Task { @MainActor [weak self] in
            do {
                try await presentation.value
            } catch {
                guard !Task.isCancelled, !presentation.isCancelled, let self else { return }
                self.showFailure(error)
            }
        }
    }

    @discardableResult
    func showConfiguredWindowIfPossible() -> Bool {
        guard self.mainTarget == .primary, self.controller?.pendingGatewaySwitch == nil else { return false }
        let mode = AppStateStore.shared.connectionMode
        // Remote dashboards must resolve the server's sign-in route before any
        // document receives native credentials, including the synchronous fast path.
        guard mode == .local else { return false }
        guard let endpoint = Self.immediateDashboardEndpoint(mode: mode),
              let url = try? GatewayEndpointStore.dashboardURL(
                  for: endpoint.config,
                  mode: mode,
                  authToken: endpoint.config.token)
        else {
            return false
        }
        let config = endpoint.config
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: url),
            token: config.token,
            password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        guard auth.hasCredential else {
            return false
        }
        let previousController = self.controller
        self.presentDashboard(
            configuration: WindowConfiguration(
                url: url, auth: auth, tlsParams: endpoint.tls?.params, mode: mode, displayName: "OpenClaw"),
            endpoint: endpoint,
            target: .primary,
            source: previousController)
        // Synchronous presentation fences pending endpoint work before a newer
        // notification can be admitted; async recovery retires only its captured intent.
        if self.controller !== previousController {
            self.endpointGeneration &+= 1
        }
        Task { await self.refreshGatewaySnapshots() }
        Task { await self.routeProbe(.presentation) }
        return true
    }

    /// Preload failures stay invisible: navigation errors land in the
    /// controller's `showLoadFailure`, which never orders the window front, and
    /// preload skips `observeEndpointChanges()` so no observer path can call
    /// `showFailure`. The failure page is only seen on a later explicit show.
    func preloadIfConfigured() {
        guard self.mainTarget == .primary, self.controller == nil,
              AppStateStore.shared.onboardingSeen,
              let (mode, url, auth, tlsParams) = immediateWindowConfiguration()
        else { return }
        let controller = makePrimaryController(
            url: url,
            auth: auth,
            mode: mode,
            tlsParams: tlsParams)
        self.installMainController(controller)
        controller.loadInBackground(url: url, auth: auth)
    }

    private func showResolvedPrimaryDashboard() async throws {
        let originalController = self.controller
        let resolved: (configuration: WindowConfiguration, endpoint: GatewayConnection.EndpointSnapshot)
        do {
            resolved = try await windowConfiguration(for: .primary)
        } catch {
            guard presentationIsCurrent(controller: originalController) else {
                throw SupersededDashboardPresentation()
            }
            throw error
        }
        guard presentationIsCurrent(controller: originalController) else {
            throw SupersededDashboardPresentation()
        }

        let creatingWindow = self.controller == nil
        self.presentDashboard(
            configuration: resolved.configuration,
            endpoint: resolved.endpoint,
            target: .primary,
            source: self.controller)
        await self.refreshGatewaySnapshots()
        if creatingWindow {
            Task { await self.routeProbe(.presentation) }
        }
    }

    private func beginNavigation(
        for target: DashboardGatewayTarget,
        source: DashboardWindowController?) -> UUID
    {
        // Pending lookup intent is target-owned even before a native window exists.
        let intent = NavigationIntent(windowID: source?.window.map(ObjectIdentifier.init))
        self.navigationIntents[target] = intent
        source?.retirePendingSessionCommands()
        if target == self.mainTarget, source == nil {
            self.pendingOpenCommands.removeAll(where: \.supersedesPendingNavigation)
        }
        return intent.id
    }

    private func finishNavigation(_ intent: UUID, for target: DashboardGatewayTarget) {
        if self.navigationIntents[target]?.id == intent {
            self.navigationIntents[target] = nil
        }
    }

    func show(atPath path: String, search: String? = nil) async {
        let target = self.mainTarget
        let intent = self.beginNavigation(for: target, source: self.controller)
        defer { self.finishNavigation(intent, for: target) }
        do {
            try await self.show()
            guard self.navigationIntents[target]?.id == intent else { return }
            guard let controller,
                  let fallbackURL = DashboardRouteMap.dashboardURL(
                      byAppendingSameAppPath: path,
                      search: search,
                      to: controller.dashboardBaseURL)
            else { return }
            controller.dispatchNativeNavigation(DashboardNativeNavigation(
                path: path,
                search: search,
                fallbackURL: fallbackURL))
        } catch {
            guard self.navigationIntents[target]?.id == intent else { return }
            self.showFailure(error)
        }
    }

    func showFailure(_ error: Error) {
        let message = (error as NSError).localizedDescription
        dashboardManagerLogger.error("dashboard setup failed error=\(message, privacy: .public)")
        let controller = self.controller ?? makePrimaryController(
            url: Self.failureURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            mode: .unconfigured)
        self.pendingOpenCommands.removeAll()
        self.installMainController(controller)
        // Keep observing while the failure page is up so a recovered tunnel
        // swaps the window back to the live dashboard.
        self.observeEndpointChanges()
        controller.showFailure(
            title: "Dashboard unavailable",
            message: message,
            detail: "Check Settings → Connection or use Debug → Reset Remote Tunnel, then try again.")
    }

    func close() {
        self.windowLifetime &+= 1
        self.gatewaySnapshotGeneration &+= 1
        self.endpointGeneration &+= 1
        retirePresentation()
        self.navigationIntents.removeAll()
        self.openForCommandTask?.cancel()
        self.openForCommandTask = nil
        self.pendingOpenCommands.removeAll()
        self.displayedPrimaryRoutes.removeAll()
        self.controller?.closeDashboard()
        let controllers = self.auxiliaryWindows.values.map(\.controller)
        self.auxiliaryWindows.removeAll()
        self.auxiliaryWindowOrder.removeAll()
        for controller in controllers {
            controller.closeDashboard()
        }
        synchronizeProfileObservations()
        self.frontmostDashboardTarget = nil
    }

    func dispatchNativeCommand(_ command: DashboardNativeCommand) {
        let frontmost = frontmostDashboard()
        let source = frontmost?.controller ?? self.controller
        let target = source?.pendingGatewaySwitch?.target ?? frontmost?.target ?? self.mainTarget
        if command.supersedesPendingNavigation {
            // This also invalidates a handoff still suspended in show(atPath:).
            self.retireNavigation(for: target)
        }
        NSApp.activate(ignoringOtherApps: true)
        if let source {
            // Admit once to the native window; replacements transfer its ordered queue before loading.
            let needsRecovery = !source.isWindowOpen || !source.canDeliverNativeCommands
            source.dispatchNativeCommand(command)
            source.show()
            guard needsRecovery, source.pendingGatewaySwitch == nil else { return }
            if source === self.controller, target == .primary, self.showConfiguredWindowIfPossible() {
                return
            }
            self.switchTarget(target, in: source, forceReload: true)
            return
        }
        self.pendingOpenCommands.append(command)
        if self.showConfiguredWindowIfPossible() {
            return
        }
        guard self.openForCommandTask == nil else { return }
        let lifetime = self.windowLifetime
        self.openForCommandTask = Task { @MainActor in
            defer {
                if self.windowLifetime == lifetime {
                    self.openForCommandTask = nil
                }
            }
            guard !Task.isCancelled, self.windowLifetime == lifetime else { return }
            do {
                try await self.show()
            } catch {
                guard !Task.isCancelled, self.windowLifetime == lifetime else { return }
                self.showFailure(error)
            }
        }
    }

    private func installMainController(_ controller: DashboardWindowController) {
        self.controller = controller
        // The manager owns commands only until the first native window exists, including preload races.
        let commands = self.pendingOpenCommands
        self.pendingOpenCommands.removeAll()
        for command in commands {
            controller.dispatchNativeCommand(command)
        }
    }

    private func snapshot(for target: DashboardGatewayTarget) -> DashboardGatewaySnapshot? {
        guard !self.gatewayEntries.isEmpty else { return nil }
        return DashboardGatewaySnapshot(gateways: self.gatewayEntries, currentId: target.bridgeID)
    }

    func refreshGatewaySnapshots() async {
        synchronizeProfileObservations()
        self.gatewaySnapshotGeneration &+= 1
        let generation = self.gatewaySnapshotGeneration
        guard var entries = try? await loadGatewayEntries(),
              gatewaySnapshotGeneration == generation else { return }
        let previousEntries = self.gatewayEntries
        let profileTargets = Set(dashboardControllers().map(\.target).filter { $0 != .primary })
        for target in profileTargets.sorted(by: { $0.bridgeID < $1.bridgeID }) {
            let hasEntry = entries.contains { $0.id == target.bridgeID }
            let observation = self.profileObservations[target]
            let needsRefresh = self.profileCredentialsNeedRefresh || observation?.needsRefresh == true
            guard needsRefresh || !hasEntry else { continue }
            let snapshot = observation?.snapshot
            let revision = observation?.revision
            // Lookup may outlive a close or picker switch; only surviving shells
            // on this target may receive its refreshed document.
            let windows = dashboardControllers().filter { $0.target == target }.compactMap(\.controller.window)
            let resolved: (configuration: WindowConfiguration, endpoint: GatewayConnection.EndpointSnapshot)
            do {
                resolved = try await windowConfiguration(for: target)
            } catch {
                guard self.gatewaySnapshotGeneration == generation else { return }
                guard self.profileObservations[target] === observation, observation?.revision == revision,
                      snapshot?.isCurrent != false else { continue }
                if error as? MacGatewayProfileError == .profileNotFound, case let .profile(profileID) = target {
                    self.retireRemovedProfile(profileID)
                }
                continue
            }
            guard self.gatewaySnapshotGeneration == generation else { return }
            guard self.profileObservations[target] === observation, observation?.revision == revision,
                  snapshot?.isCurrent != false else { continue }
            let (configuration, endpoint) = resolved
            if !hasEntry {
                // Primary-row deduplication is display policy, not profile removal.
                // A saved window keeps its fixed route until the profile owner removes it.
                entries.append(DashboardGatewayEntry(
                    id: target.bridgeID,
                    name: previousEntries.first { $0.id == target.bridgeID }?.name ?? configuration.displayName,
                    kind: "remote",
                    isPrimary: false,
                    canPromote: endpoint.config.token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty != nil,
                    health: .unknown))
            }
            for window in windows {
                guard let controller = controller(in: window, for: target),
                      controller.isWindowOpen else { continue }
                if needsRefresh, requiresIsolatedDashboardDocument(
                    controller, configuration: configuration, endpoint: endpoint, comparePrimaryRoute: false)
                {
                    self.replaceWindowController(
                        controller,
                        configuration: configuration,
                        target: target,
                        present: false)
                }
            }
            observation?.needsRefresh = false
        }
        self.gatewayEntries = entries
        self.profileCredentialsNeedRefresh = false
        if let controller, let snapshot = snapshot(for: mainTarget) {
            controller.updateGatewaySnapshot(snapshot)
        }
        for instance in self.auxiliaryWindows.values {
            if let snapshot = snapshot(for: instance.target) {
                instance.controller.updateGatewaySnapshot(snapshot)
            }
        }
    }

    func target(for source: DashboardWindowController) -> DashboardGatewayTarget? {
        if self.controller === source {
            return self.mainTarget
        }
        return self.auxiliaryWindows.values.first { $0.controller === source }?.target
    }

    private func controller(in window: NSWindow, for target: DashboardGatewayTarget) -> DashboardWindowController? {
        guard let controller = window.windowController as? DashboardWindowController,
              self.target(for: controller) == target else { return nil }
        return controller
    }

    @discardableResult
    func switchTarget(
        _ target: DashboardGatewayTarget,
        in source: DashboardWindowController,
        forceReload: Bool = false,
        present: Bool? = nil) -> Task<Void, Never>?
    {
        guard let currentTarget = self.target(for: source), let window = source.window else { return nil }
        guard !forceReload || source.pendingGatewaySwitch == nil else { return nil }
        if !forceReload {
            self.retireNavigation(for: target, from: source)
            if source === self.controller {
                retirePresentation()
            }
        }
        // User intent belongs to the native shell and survives background document replacement.
        let intent = DashboardGatewaySwitchIntent(target: target)
        let needsReplacement = forceReload || currentTarget != target || !source.canDeliverNativeCommands
        source.pendingGatewaySwitch = needsReplacement ? intent : nil
        guard source.pendingGatewaySwitch != nil else {
            if !forceReload { self.recordSelection(target) }
            return nil
        }
        let retiringNavigationIntent = self.navigationIntents[target]?.id
        return Task { @MainActor in
            guard self.controller(in: window, for: currentTarget)?.pendingGatewaySwitch === intent else { return }
            do {
                let (configuration, endpoint) = try await self.windowConfiguration(for: target)
                guard !Task.isCancelled, let current = self.controller(in: window, for: currentTarget),
                      current.pendingGatewaySwitch === intent else { return }
                current.pendingGatewaySwitch = nil
                self.presentDashboard(
                    configuration: configuration,
                    endpoint: endpoint,
                    target: target,
                    source: current,
                    forceReload: true,
                    present: present,
                    retiringNavigationIntent: retiringNavigationIntent)
                if !forceReload, let presented = window.windowController as? DashboardWindowController,
                   self.target(for: presented) == target { self.recordSelection(target) }
                await self.refreshGatewaySnapshots()
                self.updateFrontmostDashboardTarget()
            } catch {
                guard !Task.isCancelled, let current = self.controller(in: window, for: currentTarget),
                      current.pendingGatewaySwitch === intent else { return }
                current.pendingGatewaySwitch = nil
                _ = current.takePendingNativeActions()
                guard !(error is CancellationError) else { return }
                Self.showGatewayError(error, message: String(localized: "Could Not Switch Gateway"))
            }
        }
    }

    @discardableResult
    private func replaceWindowController(
        _ source: DashboardWindowController,
        configuration: WindowConfiguration,
        target: DashboardGatewayTarget,
        present: Bool? = nil) -> DashboardWindowController?
    {
        let isMainWindow = self.controller === source
        let windowID = self.auxiliaryWindows.first { $0.value.controller === source }?.key
        guard isMainWindow || windowID != nil else { return nil }
        let preserveNavigation = self.target(for: source) == target &&
            Self.notificationRoute(source.currentURL) == Self.notificationRoute(configuration.url)
        let pendingActions = source.takePendingNativeActions()
        self.displayedPrimaryRoutes[ObjectIdentifier(source)] = nil
        // Background reconciliation must not resurrect a window the user closed;
        // explicit show/open callers opt back into presentation.
        let shouldPresent = present ?? source.isWindowOpen
        let autosaveName = availableAutosaveName(for: target, replacing: source)
        let window = source.detachWindowForReplacement()
        let replacement = makeController(
            configuration: configuration,
            target: target,
            windowAutosaveName: autosaveName,
            auxiliary: !isMainWindow,
            reusingWindow: window)
        // Picker admission already retired older actions. Later commands follow this window's successor;
        // session navigation remains bound to its original gateway selection, origin, and mount.
        replacement.restorePendingNativeActions(pendingActions, preservingNavigation: preserveNavigation)
        if isMainWindow {
            self.mainTarget = target
            self.installMainController(replacement)
        } else if let windowID {
            self.auxiliaryWindows[windowID] = AuxiliaryWindowInstance(target: target, controller: replacement)
        }
        replacement.loadInBackground(url: configuration.url, auth: configuration.auth)
        if shouldPresent, present == true || !replacement.isWindowOpen {
            replacement.show()
        }
        return replacement
    }

    @discardableResult
    private func openWindow(for target: DashboardGatewayTarget, reuseExisting: Bool = false) -> Task<Void, Never> {
        // Capture authority at the synchronous request boundary, before any menu/bridge task can outlive close().
        let lifetime = self.windowLifetime
        return Task { @MainActor in
            guard !Task.isCancelled, self.windowLifetime == lifetime else { return }
            if reuseExisting, let controller = self.dashboardController(for: target) {
                controller.show()
                self.recordSelection(target)
                self.updateFrontmostDashboardTarget()
                return
            }
            let opensMain = reuseExisting && self.mainTarget == target
            do {
                if opensMain {
                    try await self.show()
                    guard !Task.isCancelled, self.windowLifetime == lifetime,
                          self.controller?.isWindowOpen == true else { return }
                    self.recordSelection(self.mainTarget)
                } else {
                    let (configuration, endpoint) = try await self.windowConfiguration(for: target)
                    guard !Task.isCancelled, self.windowLifetime == lifetime else { return }
                    let controller = self.openWindow(for: target, configuration: configuration)
                    self.recordSelection(target)
                    if target == .primary {
                        self.rememberPresentedEndpoint(endpoint, controller: controller)
                    }
                    await self.refreshGatewaySnapshots()
                }
                self.updateFrontmostDashboardTarget()
            } catch {
                guard !Task.isCancelled, !(error is CancellationError), self.windowLifetime == lifetime else { return }
                if opensMain {
                    self.showFailure(error)
                } else {
                    Self.showGatewayError(error, message: String(localized: "Could Not Open Gateway Window"))
                }
            }
        }
    }

    @discardableResult
    private func openWindow(
        for target: DashboardGatewayTarget,
        configuration: WindowConfiguration) -> DashboardWindowController
    {
        let windowID = UUID()
        let previous = self.auxiliaryWindowOrder.reversed().lazy
            .compactMap { self.auxiliaryWindows[$0] }
            .first { $0.target == target }?
            .controller
        let controller = self.makeController(
            configuration: configuration,
            target: target,
            windowAutosaveName: self.availableAutosaveName(for: target),
            auxiliary: true)
        self.auxiliaryWindows[windowID] = AuxiliaryWindowInstance(target: target, controller: controller)
        self.auxiliaryWindowOrder.append(windowID)
        if let previous {
            let origin = previous.window?.frame.origin ?? .zero
            controller.window?.setFrameOrigin(NSPoint(x: origin.x + 24, y: origin.y - 24))
        }
        controller.show(url: configuration.url, auth: configuration.auth)
        return controller
    }
}

extension DashboardManager {
    private func retireNavigation(
        for target: DashboardGatewayTarget,
        from source: DashboardWindowController? = nil)
    {
        if let source, let sourceTarget = self.target(for: source) {
            self.navigationIntents[sourceTarget] = nil
            _ = source.takePendingNativeActions()
        }
        self.navigationIntents[target] = nil
    }

    func recordSelection(_ target: DashboardGatewayTarget) {
        if self.pendingInitialSelection != nil, self.controller == nil { self.mainTarget = target }
        self.pendingInitialSelection = nil
        self.selection.select(target)
    }

    private func browserStore(
        profileID: String,
        currentSession: GatewayBrowserSession? = nil) -> DashboardBrowserSessionStore
    {
        if self.websiteDataStore.isPersistent {
            let store = DashboardBrowserSessionStore.persistent(
                profileID: profileID,
                registryNamespace: MacGatewayProfileStore.service,
                currentSession: currentSession)
            self.profileBrowserStores[profileID] = store
            return store
        }
        if let store = profileBrowserStores[profileID] {
            return store
        }
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        self.profileBrowserStores[profileID] = store
        return store
    }

    private func invalidateProfileDocument(
        profileID: String,
        error: GatewayBrowserSessionError? = nil,
        retireManualDocuments: Bool = false)
    {
        self.profileCredentialRevisions[profileID, default: 0] &+= 1
        for instance in dashboardControllers() where instance.target == .profile(profileID) &&
            (instance.controller.browserSession != nil || retireManualDocuments)
        {
            if error == .expired {
                guard let session = instance.controller.browserSession, session.expiresAt <= Date() else { continue }
                self.profileBrowserStores[profileID]?.expire(session)
            }
            instance.controller.invalidateBrowserSession(error: error)
        }
    }

    private func synchronizeProfileObservations() {
        guard self.observesGatewayChanges, self.automaticGatewayProfileRefreshEnabled else { return }
        let targets = Set(dashboardControllers().map(\.target).filter { $0 != .primary })
        for target in self.profileObservations.keys where !targets.contains(target) {
            self.profileObservations.removeValue(forKey: target)?.task?.cancel()
        }
        for target in targets where self.profileObservations[target] == nil {
            let observation = ProfileObservation()
            self.profileObservations[target] = observation
            let id = observation.id
            let provider = self.connectionProvider
            observation.task = Task { [weak self] in
                let connection = await provider(target)
                guard !Task.isCancelled, self?.profileObservations[target]?.id == id else { return }
                await GatewayPushSubscription.consume(connection: connection) { [weak self] delivery in
                    self?.handleProfilePush(delivery, target: target, observationID: id)
                }
            }
        }
    }

    private func handleProfilePush(
        _ delivery: GatewayConnection.PushDelivery,
        target: DashboardGatewayTarget,
        observationID: UUID)
    {
        guard let observation = profileObservations[target], observation.id == observationID else { return }
        if let push = delivery.push {
            guard case .snapshot = push else { return }
            observation.snapshot = delivery
            observation.needsRefresh = true
        } else {
            guard observation.snapshot.map({ $0.serverLease == delivery.serverLease }) != false else { return }
            observation.snapshot = nil
            observation.needsRefresh = false
            if case let .profile(profileID) = target,
               dashboardControllers().contains(where: {
                   $0.target == target && $0.controller.browserSession.map { $0.expiresAt <= Date() } == true
               })
            {
                self.invalidateProfileDocument(profileID: profileID, error: .expired)
            }
        }
        // Retire only this profile's awaited announcement. Another profile's
        // pending refresh must still finish while this connection is offline.
        observation.revision &+= 1
        guard delivery.push != nil else { return }
        Task { @MainActor [weak self] in
            guard self?.profileObservations[target]?.id == observationID, delivery.isCurrent else { return }
            await self?.refreshGatewaySnapshots()
        }
    }

    private func makePrimaryController(
        url: URL,
        auth: DashboardWindowAuth,
        mode: AppState.ConnectionMode,
        tlsParams: GatewayTLSParams? = nil,
        reusingWindow: NSWindow? = nil) -> DashboardWindowController
    {
        self.makeController(
            configuration: WindowConfiguration(
                url: url, auth: auth, tlsParams: tlsParams, mode: mode, displayName: "OpenClaw"),
            target: .primary,
            windowAutosaveName: self.mainWindowAutosaveName,
            auxiliary: false,
            reusingWindow: reusingWindow)
    }

    private func makeController(
        configuration: WindowConfiguration,
        target: DashboardGatewayTarget,
        windowAutosaveName: String,
        auxiliary: Bool,
        reusingWindow: NSWindow? = nil) -> DashboardWindowController
    {
        let primaryLocal = !auxiliary && target == .primary && configuration.mode == .local
        let browserStore: DashboardBrowserSessionStore? = if configuration.browserSession != nil,
                                                             case let .profile(profileID) = target
        {
            self.browserStore(profileID: profileID, currentSession: configuration.browserSession)
        } else {
            nil
        }
        let controller = DashboardWindowController(
            url: configuration.url,
            auth: configuration.auth,
            websiteDataStore: browserStore?.dataStore ?? self.websiteDataStore,
            updater: self.updater,
            updateBridgeEnabled: primaryLocal && Self.updateBridgeEnabled(mode: configuration.mode),
            tlsParams: configuration.tlsParams,
            browserSessionLease: browserStore?.lease(for: configuration.browserSession),
            gatewaySnapshot: self.snapshot(for: target),
            windowTitle: configuration.displayName,
            windowAutosaveName: windowAutosaveName,
            reusingWindow: reusingWindow,
            requestBrowserProfileImportOffer: { shouldApply in
                guard primaryLocal else { return false }
                return await BrowserProfileImportModel.shared.requestAutomaticOfferIfEligible(while: shouldApply)
            })
        controller.onBackgroundSessionOpen = { [weak self] completion, sourceURL in
            Task { @MainActor in
                await self?.openBackgroundSession(
                    completion, target: target, sourceURL: sourceURL)
            }
        }
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller else { return }
            self.handleWindowClosed(controller)
        }
        return controller
    }

    @discardableResult
    private func presentDashboard(
        configuration: WindowConfiguration,
        endpoint: GatewayConnection.EndpointSnapshot,
        target: DashboardGatewayTarget,
        source: DashboardWindowController?,
        forceReload: Bool = false,
        present: Bool? = true,
        retiringNavigationIntent: UUID? = nil) -> DashboardWindowController?
    {
        let requiresIsolation = source.map {
            self.requiresIsolatedDashboardDocument(
                $0, configuration: configuration, endpoint: endpoint, comparePrimaryRoute: target == .primary)
        } ?? false
        let documentChanged = source.flatMap { self.target(for: $0) } != target || requiresIsolation
        let presented: DashboardWindowController?
        if let source {
            if forceReload || requiresIsolation {
                presented = self.replaceWindowController(
                    source, configuration: configuration, target: target, present: present)
            } else {
                // The URL can be unchanged while the document is a failure page.
                source.show(
                    url: configuration.url,
                    auth: configuration.auth,
                    updateBridgeEnabled: source === self.controller && target == .primary &&
                        Self.updateBridgeEnabled(mode: configuration.mode))
                presented = source
            }
        } else if self.mainTarget == target, self.controller == nil {
            let controller = self.makeController(
                configuration: configuration,
                target: target,
                windowAutosaveName: self.mainWindowAutosaveName,
                auxiliary: false)
            self.installMainController(controller)
            controller.show(url: configuration.url, auth: configuration.auth)
            presented = controller
        } else {
            presented = self.openWindow(for: target, configuration: configuration)
        }
        // A changed document retires only navigation older than this recovery.
        // Same-route reloads and notifications admitted during lookup keep their intent.
        if presented != nil, documentChanged, let retiringNavigationIntent,
           navigationIntents[target]?.id == retiringNavigationIntent
        {
            self.navigationIntents[target] = nil
        }
        if target == .primary, let presented {
            rememberPresentedEndpoint(endpoint, controller: presented)
        }
        updateFrontmostDashboardTarget()
        return presented
    }

    private func autosaveName(for target: DashboardGatewayTarget) -> String {
        switch target {
        case .primary:
            self.mainWindowAutosaveName
        case let .profile(profileID):
            "\(self.mainWindowAutosaveName)-\(profileID)"
        }
    }

    private func availableAutosaveName(
        for target: DashboardGatewayTarget,
        replacing source: DashboardWindowController? = nil) -> String
    {
        let base = self.autosaveName(for: target)
        let mainOwnsTarget = self.controller !== source && self.mainTarget == target
        let auxiliaryOwnsTarget = self.auxiliaryWindows.values.contains {
            $0.controller !== source && $0.target == target
        }
        return mainOwnsTarget || auxiliaryOwnsTarget ? "\(base)-\(UUID().uuidString)" : base
    }
}

extension DashboardManager {
    private func windowConfiguration(for target: DashboardGatewayTarget) async throws
        -> (configuration: WindowConfiguration, endpoint: GatewayConnection.EndpointSnapshot)
    {
        switch target {
        case .primary:
            while true {
                try Task.checkCancellation()
                let generation = self.endpointGeneration
                let mode = AppStateStore.shared.connectionMode
                do {
                    let endpoint = try await primaryEndpoint(mode: mode)
                    let config = endpoint.config
                    let token = await authTokenProvider(config)
                    guard self.endpointGeneration == generation else { continue }
                    let configuration = try await dashboardConfiguration(
                        endpoint: endpoint, mode: mode, target: target, token: token)
                    guard self.endpointGeneration == generation else { continue }
                    return (configuration, endpoint)
                } catch {
                    guard self.endpointGeneration == generation else { continue }
                    throw error
                }
            }
        case let .profile(profileID):
            while true {
                try Task.checkCancellation()
                guard !self.unavailableProfileIDs.contains(profileID) else { throw CancellationError() }
                let revision = self.profileCredentialRevisions[profileID, default: 0]
                do {
                    let endpoint = try await profileEndpoint(profileID: profileID)
                    let configuration = try await dashboardConfiguration(
                        endpoint: endpoint, mode: .remote, target: target, token: endpoint.config.token)
                    guard self.profileCredentialRevisions[profileID, default: 0] == revision else { continue }
                    return (configuration, endpoint)
                } catch {
                    guard self.profileCredentialRevisions[profileID, default: 0] == revision else { continue }
                    throw error
                }
            }
        }
    }

    private func dashboardConfiguration(
        endpoint: GatewayConnection.EndpointSnapshot,
        mode: AppState.ConnectionMode,
        target: DashboardGatewayTarget,
        token: String?) async throws -> WindowConfiguration
    {
        let config = endpoint.config
        let browserSession = endpoint.browserSession
        try browserSession?.validate(for: config.url)
        let identityURL = mode == .remote
            ? try await browserIdentityURLProvider(target, config)
            : nil
        let dashboardConfig: GatewayConnection.Config = browserSession == nil
            ? config : (url: config.url, token: nil, password: nil)
        let url = try identityURL ?? GatewayEndpointStore.dashboardURL(
            for: dashboardConfig, mode: mode, authToken: browserSession == nil ? token : nil)
        try browserSession?.validate(for: url)
        let auth: DashboardWindowAuth = if identityURL != nil || browserSession != nil {
            .browserIdentity(gatewayUrl: Self.websocketURLString(for: url))
        } else {
            DashboardWindowAuth(
                gatewayUrl: Self.websocketURLString(for: url),
                token: token,
                password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        }
        let name = target == .primary ? "OpenClaw"
            : self.gatewayEntries.first { $0.id == target.bridgeID }?.name ?? url.host ?? "Gateway"
        // The public sign-in origin owns normal HTTPS trust; an SSH/native TLS
        // pin and its bearer credentials belong only to the device connection.
        return WindowConfiguration(
            url: url,
            auth: auth,
            tlsParams: identityURL == nil && browserSession == nil ? endpoint.tls?.params : nil,
            mode: mode,
            displayName: name,
            browserSession: browserSession)
    }
}

extension DashboardManager {
    func openBackgroundSession(
        _ completion: DashboardBackgroundSessionCompletion,
        target: DashboardGatewayTarget,
        sourceURL: URL) async
    {
        let endpointGeneration = self.endpointGeneration
        let source = self.dashboardController(for: target) ?? (self.mainTarget == target ? self.controller : nil)
        let window = source?.window
        let currentController = {
            guard let window else {
                return self.dashboardController(for: target) ?? (self.mainTarget == target ? self.controller : nil)
            }
            // AppKit updates this owner when the privileged document is replaced;
            // changing focus must not retarget an already admitted click.
            guard let controller = window.windowController as? DashboardWindowController,
                  self.target(for: controller) == target else { return nil }
            return controller
        }
        let intent = self.beginNavigation(for: target, source: source)
        defer { self.finishNavigation(intent, for: target) }
        let sourceGeneration = source?.windowIntentGeneration
        let isCurrent = {
            guard !Task.isCancelled, self.navigationIntents[target]?.id == intent,
                  target != .primary || self.endpointGeneration == endpointGeneration else { return false }
            guard let window else { return source == nil }
            guard let current = currentController(), let sourceGeneration else { return false }
            return current.window === window && current.windowIntentGeneration == sourceGeneration
        }
        do {
            let (configuration, endpoint) = try await windowConfiguration(for: target)
            guard isCurrent() else { return }
            guard sourceURL == Self.notificationRoute(configuration.url) else {
                throw NSError(domain: "Dashboard", code: 1, userInfo: [
                    NSLocalizedDescriptionKey:
                        "This Gateway connection changed. Open the session from its Gateway's session list.",
                ])
            }
            // Configuration lookup is the only suspension: a newer navigation or
            // window close cannot interleave restoration and dispatch.
            guard let controller = presentDashboard(
                configuration: configuration, endpoint: endpoint, target: target, source: currentController()),
                let fallbackURL = DashboardRouteMap.dashboardURL(
                    byAppendingSameAppPath: completion.path,
                    search: completion.search,
                    to: configuration.url)
            else {
                throw NSError(domain: "Dashboard", code: 1, userInfo: [
                    NSLocalizedDescriptionKey:
                        "The originating Gateway window is no longer available. " +
                        "Open the session from its Gateway's session list.",
                ])
            }
            controller.dispatchNativeNavigation(DashboardNativeNavigation(
                path: completion.path, search: completion.search, fallbackURL: fallbackURL))
            Task { await self.refreshGatewaySnapshots() }
        } catch {
            guard isCurrent() else { return }
            Self.showGatewayError(error, message: String(localized: "Could Not Open Background Session"))
        }
    }

    private func handleWindowClosed(_ controller: DashboardWindowController) {
        guard let target = target(for: controller) else { return }
        if let intent = navigationIntents[target],
           intent.windowID == nil || intent.windowID == controller.window.map(ObjectIdentifier.init)
        {
            self.navigationIntents[target] = nil
        }
        controller.pendingGatewaySwitch = nil
        _ = controller.takePendingNativeActions()
        self.displayedPrimaryRoutes[ObjectIdentifier(controller)] = nil
        // Auxiliary windows can share the primary target, but only the main window owns presentation.
        if self.controller === controller {
            self.retirePresentation()
        } else if let windowID = auxiliaryWindows.first(where: { $0.value.controller === controller })?.key {
            self.auxiliaryWindows.removeValue(forKey: windowID)
            self.auxiliaryWindowOrder.removeAll { $0 == windowID }
        }
        self.updateFrontmostDashboardTarget()
        if target != .primary {
            Task { await self.refreshGatewaySnapshots() }
        }
    }

    func show() async throws {
        try await self.currentPresentationTask().value
    }

    private func showResolvedDashboard() async throws {
        if let profileID = self.pendingInitialSelection {
            let lifetime = self.windowLifetime
            let profiles = try await MacGatewayProfileStore.shared.profiles()
            guard !Task.isCancelled, self.windowLifetime == lifetime,
                  self.pendingInitialSelection == profileID else { return }
            self.pendingInitialSelection = nil
            if !profiles.contains(where: { $0.id == profileID }) {
                self.selection.forget(profileID: profileID)
                self.mainTarget = .primary
            }
        }
        if self.mainTarget == .primary, AppStateStore.shared.connectionMode == .unconfigured {
            let lifetime = self.windowLifetime
            let target = try await defaultSavedDashboardTarget()
            guard !Task.isCancelled, self.windowLifetime == lifetime, self.mainTarget == .primary else { return }
            guard let target else { return }
            self.mainTarget = target
        }
        if controller == nil, self.mainTarget != .primary,
           let existing = auxiliaryWindows.first(where: { $0.value.target == self.mainTarget })
        {
            self.auxiliaryWindows.removeValue(forKey: existing.key)
            self.auxiliaryWindowOrder.removeAll { $0 == existing.key }
            self.installMainController(existing.value.controller)
        }
        if let controller, mainTarget != .primary {
            if controller.isWindowOpen {
                controller.show()
                await self.refreshGatewaySnapshots()
                return
            }
            await self.switchTarget(self.mainTarget, in: controller, forceReload: true, present: true)?.value
            return
        }
        if self.mainTarget != .primary {
            let target = self.mainTarget
            let lifetime = self.windowLifetime
            let (configuration, endpoint) = try await windowConfiguration(for: target)
            guard !Task.isCancelled, self.windowLifetime == lifetime, self.mainTarget == target else { return }
            self.presentDashboard(configuration: configuration, endpoint: endpoint, target: target, source: nil)
            await self.refreshGatewaySnapshots()
            return
        }
        self.observeEndpointChanges()
        while true {
            do {
                try await self.showResolvedPrimaryDashboard()
                return
            } catch is SupersededDashboardPresentation {
                guard !Task.isCancelled, self.mainTarget == .primary else {
                    // Selection or close already retired this presentation; callers have no setup error to show.
                    return
                }
                if let controller, controller.isWindowOpen {
                    controller.show()
                    return
                }
            }
        }
    }

    private func defaultSavedDashboardTarget() async throws -> DashboardGatewayTarget? {
        if let frontmost = frontmostDashboard(), frontmost.target != .primary {
            return frontmost.target
        }
        let entries = try await loadGatewayEntries().filter { !$0.isPrimary }
        try Task.checkCancellation()
        if entries.isEmpty {
            return .primary
        }
        if entries.count == 1 {
            return DashboardGatewayTarget(bridgeID: entries[0].id)
        }
        let profiles = try await MacGatewayProfileStore.shared.profiles()
        try Task.checkCancellation()
        let available = profiles.filter { profile in
            !self.unavailableProfileIDs.contains(profile.id) &&
                entries.contains { $0.id == DashboardGatewayTarget.profile(profile.id).bridgeID }
        }
        guard !available.isEmpty else { return nil }
        if available.count == 1 {
            return .profile(available[0].id)
        }
        switch WebChatManager.promptForGatewayProfile(profiles: available, preferredID: nil) {
        case let .profile(profile): return .profile(profile.id)
        case .manage:
            AppNavigationActions.openSettings(tab: .gateways)
            return nil
        case nil:
            self.pendingOpenCommands.removeAll()
            return nil
        }
    }

    private func currentPresentationTask() -> Task<Void, Error> {
        if let presentationTask {
            return presentationTask
        }
        self.presentationGeneration &+= 1
        let generation = self.presentationGeneration
        let presentationTask = Task<Void, Error> { @MainActor [weak self] in
            guard let self else { throw CancellationError() }
            defer {
                if self.presentationGeneration == generation {
                    self.presentationTask = nil
                }
            }
            try await self.showResolvedDashboard()
        }
        self.presentationTask = presentationTask
        return presentationTask
    }

    private func retirePresentation() {
        self.presentationGeneration &+= 1
        self.presentationTask?.cancel()
        self.presentationTask = nil
    }

    private func presentationIsCurrent(controller originalController: DashboardWindowController?) -> Bool {
        guard !Task.isCancelled, self.mainTarget == .primary else {
            return false
        }
        return originalController.map { self.controller === $0 } ?? (self.controller == nil)
    }

    private func requiresIsolatedDashboardDocument(
        _ controller: DashboardWindowController,
        configuration: WindowConfiguration,
        endpoint: GatewayConnection.EndpointSnapshot,
        comparePrimaryRoute: Bool = true) -> Bool
    {
        let displayedRoute = self.displayedPrimaryRoutes[ObjectIdentifier(controller)]
        return !controller.hasTLSParams(configuration.tlsParams) ||
            controller.auth != configuration.auth ||
            !controller.hasCurrentBrowserSession ||
            controller.browserSession != configuration.browserSession ||
            (comparePrimaryRoute && (endpoint.routeAuthority != displayedRoute?.authority ||
                    endpoint.revision.map { $0 != displayedRoute?.revision } == true))
    }

    private func rememberPresentedEndpoint(
        _ endpoint: GatewayConnection.EndpointSnapshot,
        controller: DashboardWindowController)
    {
        let key = ObjectIdentifier(controller)
        self.displayedPrimaryRoutes[key] = (
            endpoint.revision ?? self.displayedPrimaryRoutes[key]?.revision,
            endpoint.routeAuthority)
        self.observeEndpointChanges()
    }

    func handleOnboardingCompletion() {
        self.controller?.handleOnboardingCompletion()
    }

    func handleGatewayRequest(_ request: DashboardGatewaysRequest, from source: DashboardWindowController) {
        // Retained WebViews may still emit callbacks after their window closes or document is replaced.
        guard self.target(for: source) != nil, source.isWindowOpen else { return }
        switch request {
        case let .select(target):
            self.switchTarget(target, in: source)
        case let .openWindow(target):
            self.retireNavigation(for: target)
            self.openWindow(for: target)
        case let .setPrimary(target):
            guard self.target(for: source) == target else { return }
            self.presentSetPrimaryConfirmation(target, source: source)
        case .openSettings:
            AppNavigationActions.openSettings(tab: .gateways)
        }
    }

    func handleGatewaySetup(_ link: GatewayConnectDeepLink) {
        NSApp.activate(ignoringOtherApps: true)
        let coordinator = DashboardGatewaySetupCoordinator(
            adapter: DashboardPrimaryGatewayAdapter(state: AppStateStore.shared),
            confirm: { title, message in
                let alert = DashboardWindowController.makeGatewaySetupAlert(title: title, message: message)
                return alert.runModal() == .alertFirstButtonReturn
            },
            presentError: { title, message in
                let alert = NSAlert()
                alert.messageText = title
                alert.informativeText = message
                alert.alertStyle = .warning
                alert.runModal()
            },
            openConnectionSettings: {
                AppNavigationActions.openSettings(tab: .connection)
            })
        coordinator.handle(link)
    }

    func openOrFocusDashboard(for target: DashboardGatewayTarget) {
        self.retireNavigation(for: target)
        self.openWindow(for: target, reuseExisting: true)
    }

    private func dashboardControllers() -> [(target: DashboardGatewayTarget, controller: DashboardWindowController)] {
        var result: [(DashboardGatewayTarget, DashboardWindowController)] = []
        if let controller, controller.isWindowOpen {
            result.append((self.mainTarget, controller))
        }
        result += self.auxiliaryWindowOrder.compactMap { windowID in
            guard let instance = self.auxiliaryWindows[windowID], instance.controller.isWindowOpen else { return nil }
            return (instance.target, instance.controller)
        }
        return result
    }

    func frontmostDashboard()
        -> (target: DashboardGatewayTarget, controller: DashboardWindowController)?
    {
        let controllers = self.dashboardControllers()
        if let key = controllers.first(where: { $0.controller.window?.isKeyWindow == true }) {
            return key
        }
        for window in NSApp.orderedWindows {
            if let match = controllers.first(where: { $0.controller.window === window }) {
                return match
            }
        }
        return controllers.last
    }

    private func updateFrontmostDashboardTarget() {
        self.synchronizeProfileObservations()
        self.frontmostDashboardTarget = self.frontmostDashboard()?.target
    }

    private func dashboardController(for target: DashboardGatewayTarget) -> DashboardWindowController? {
        if let frontmost = frontmostDashboard(), frontmost.target == target {
            return frontmost.controller
        }
        if self.mainTarget == target, let controller, controller.isWindowOpen {
            return controller
        }
        return self.auxiliaryWindowOrder.reversed().lazy
            .compactMap { self.auxiliaryWindows[$0] }
            .first { $0.target == target && $0.controller.isWindowOpen }?
            .controller
    }

    @discardableResult
    func performSwitchFrontmostDashboard(to target: DashboardGatewayTarget) -> Task<Void, Never>? {
        guard let frontmost = frontmostDashboard() else {
            self.retireNavigation(for: target)
            return self.openWindow(for: target, reuseExisting: true)
        }
        return self.switchTarget(target, in: frontmost.controller, present: true)
    }
}

extension DashboardManager {
    func configure(updater: UpdaterProviding) {
        self.updater = updater
        guard self.automaticGatewayProfileRefreshEnabled else { return }
        Task { await self.refreshGatewaySnapshots() }
    }
}

#if DEBUG
extension DashboardManager {
    func _testSetController(_ controller: DashboardWindowController) {
        self.installMainController(controller)
    }

    func _testController() -> DashboardWindowController? {
        self.controller
    }

    func _testMainTarget() -> DashboardGatewayTarget {
        self.mainTarget
    }

    func _testGatewayRefreshObserverCount() -> Int {
        self.gatewayRefreshObservers.count
    }

    func _testOpenWindow(for target: DashboardGatewayTarget) async {
        await self.openWindow(for: target).value
    }

    func _testSwitchTarget(_ target: DashboardGatewayTarget, in source: DashboardWindowController) async {
        await self.switchTarget(target, in: source)?.value
    }

    func _testSwitchFrontmostDashboard(to target: DashboardGatewayTarget) async {
        await self.performSwitchFrontmostDashboard(to: target)?.value
    }

    func _testHandleControlChannelStateChange(_ state: ControlChannel.ConnectionState) async {
        await self.handleControlChannelStateChange(state)
    }

    func _testWindowTLSParams(for target: DashboardGatewayTarget) async throws -> GatewayTLSParams? {
        try await self.windowConfiguration(for: target).configuration.tlsParams
    }

    func _testAuxiliaryWindows() -> [(target: DashboardGatewayTarget, controller: DashboardWindowController)] {
        self.auxiliaryWindows.values.map { ($0.target, $0.controller) }
    }

    func _testSetMainTarget(_ target: DashboardGatewayTarget) {
        self.mainTarget = target
        if target != .primary, let controller {
            self.displayedPrimaryRoutes[ObjectIdentifier(controller)] = nil
        }
    }
}
#endif
