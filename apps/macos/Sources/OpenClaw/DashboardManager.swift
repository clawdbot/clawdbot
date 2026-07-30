import AppKit
import Foundation
import Observation
import OpenClawKit
import OSLog

private let dashboardManagerLogger = Logger(subsystem: "ai.openclaw", category: "DashboardManager")

@MainActor
@Observable
final class DashboardManager {
    static let shared = DashboardManager()

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
    }

    @ObservationIgnored private var controller: DashboardWindowController?
    @ObservationIgnored private var mainTarget = DashboardGatewayTarget.primary
    @ObservationIgnored private var auxiliaryWindows: [UUID: AuxiliaryWindowInstance] = [:]
    @ObservationIgnored private var auxiliaryWindowOrder: [UUID] = []
    @ObservationIgnored private var endpointTask: Task<Void, Never>?
    @ObservationIgnored private var pendingOpenCommands: [DashboardNativeCommand] = []
    @ObservationIgnored private var openForCommandTask: Task<Void, Never>?
    @ObservationIgnored private var navigationGeneration: UInt64 = 0
    @ObservationIgnored private var updater: UpdaterProviding?
    @ObservationIgnored private var displayedRouteRevision: UInt64?
    @ObservationIgnored private var switchGenerations: [ObjectIdentifier: UInt64] = [:]
    @ObservationIgnored private let authTokenProvider: @Sendable (GatewayConnection.Config) async -> String?
    @ObservationIgnored private let routeProbe: @Sendable () async -> Void
    @ObservationIgnored private let endpointStateProvider: @Sendable () async -> GatewayEndpointState
    @ObservationIgnored private let mainWindowAutosaveName: String
    private(set) var gatewayEntries: [DashboardGatewayEntry] = []
    private(set) var frontmostDashboardTarget: DashboardGatewayTarget?
    @ObservationIgnored private var gatewayRefreshObservers: [NSObjectProtocol] = []
    #if DEBUG
    private var testPrimaryEndpointProvider:
        (@Sendable (AppState.ConnectionMode) async throws -> GatewayConnection.EndpointSnapshot)?
    private var testProfileEndpointProvider: (@Sendable (String) async throws
        -> GatewayConnection.EndpointSnapshot)?
    private var testGatewayEntriesProvider: (@MainActor () async throws -> [DashboardGatewayEntry])?
    #endif
    private static let failureURL = URL(string: "about:blank")!

    private init(
        authTokenProvider: @escaping @Sendable (GatewayConnection.Config) async -> String? = { config in
            await GatewayConnection.shared.controlUiAutoAuthToken(config: config)
        },
        routeProbe: @escaping @Sendable () async -> Void = {
            _ = try? await GatewayConnection.shared.request(
                method: "health",
                params: nil,
                timeoutMs: 3000,
                retryTransportFailures: false)
        },
        endpointStateProvider: @escaping @Sendable () async -> GatewayEndpointState = {
            await GatewayEndpointStore.shared.currentState()
        },
        observeGatewayChanges: Bool = true,
        mainWindowAutosaveName: String = DashboardWindowLayout.windowFrameAutosaveName)
    {
        self.authTokenProvider = authTokenProvider
        self.routeProbe = routeProbe
        self.endpointStateProvider = endpointStateProvider
        self.mainWindowAutosaveName = mainWindowAutosaveName
        if observeGatewayChanges {
            let names: [Notification.Name] = [
                MacGatewayProfileStore.didChangeNotification,
                .openclawConfigDidChange,
                .controlChannelStateDidChange,
            ]
            self.gatewayRefreshObservers = names.map { name in
                NotificationCenter.default.addObserver(
                    forName: name,
                    object: nil,
                    queue: .main)
                { [weak self] _ in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if name == .controlChannelStateDidChange {
                            await self.handleControlChannelStateChange(ControlChannel.shared.state)
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

    private func handleControlChannelStateChange(_ state: ControlChannel.ConnectionState) async {
        guard state == .connected else { return }
        // Endpoint readiness can precede device authentication. Replay the
        // unchanged route once the control socket owns a usable credential.
        let endpointState = await self.endpointStateProvider()
        await self.handleEndpointState(endpointState, forceRouteReplacement: true)
    }

    func configure(updater: UpdaterProviding) {
        self.updater = updater
        Task { await self.refreshGatewaySnapshots() }
    }

    /// The card's native update path only makes sense when the app owns the
    /// local gateway and the post-relaunch repair is allowed to run; otherwise
    /// (external CLI, write-disabled launchd, extended-stable pin) the card
    /// must keep the direct gateway `update.run` flow, so no bridge is exposed.
    static func updateBridgeEnabled(mode: AppState.ConnectionMode) -> Bool {
        guard mode == .local else { return false }
        return CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: CLIInstallPrompter.launchAgentUsesManagedCLI(
                programArguments: GatewayLaunchAgentManager.launchdConfigSnapshot()?.programArguments ?? []),
            gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
            installPolicy: CLIInstallPolicy.storedPolicy(),
            launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled())
    }

    /// The remote SSH tunnel can be recreated on a new ephemeral local port while
    /// the dashboard stays open; without following endpoint changes the WebView
    /// keeps reconnecting to the dead old port forever (#100476).
    private func observeEndpointChanges() {
        guard self.endpointTask == nil else { return }
        self.endpointTask = Task { [weak self] in
            let stream = await GatewayEndpointStore.shared.subscribe()
            for await state in stream {
                guard let self else { return }
                await self.handleEndpointState(state)
            }
        }
    }

    func handleEndpointState(
        _ state: GatewayEndpointState,
        forceRouteReplacement: Bool = false) async
    {
        // The shared endpoint stream owns only the main window's primary route.
        // Profile-targeted documents keep their saved endpoint and credentials.
        guard self.mainTarget == .primary else { return }
        guard let controller, controller.isWindowOpen else { return }
        guard case let .ready(mode, url, token, password, routeRevision) = state else {
            self.replaceWithRouteFailure(controller)
            self.displayedRouteRevision = nil
            return
        }
        let config: GatewayConnection.Config = (url, token, password)
        let tlsParams = Self.primaryTLSParams(for: config, mode: mode)
        let routeChanged = forceRouteReplacement ||
            (self.displayedRouteRevision.map { $0 != routeRevision }
                ?? (routeRevision > 0) || !controller.hasTLSParams(tlsParams))
        var authToken = await self.authTokenProvider(config)
        if authToken == nil, password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty == nil {
            await self.routeProbe()
            authToken = await self.authTokenProvider(config)
        }
        guard let dashboardURL = try? GatewayEndpointStore.dashboardURL(
            for: config,
            mode: mode,
            authToken: authToken)
        else {
            return
        }
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: dashboardURL),
            token: authToken,
            password: password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        if routeChanged {
            self.displayedRouteRevision = routeRevision
            guard auth.hasCredential else {
                self.replaceWithRouteFailure(controller)
                return
            }
            self.replaceController(
                controller,
                url: dashboardURL,
                auth: auth,
                mode: mode,
                tlsParams: tlsParams)
            return
        }
        if dashboardURL == controller.currentURL {
            self.displayedRouteRevision = routeRevision
            controller.setUpdateBridgeEnabled(Self.updateBridgeEnabled(mode: mode))
            return
        }
        guard auth.hasCredential, controller.isWindowOpen else { return }
        dashboardManagerLogger.info(
            "dashboard endpoint changed; reloading url=\(dashboardLogString(for: dashboardURL), privacy: .public)")
        controller.update(url: dashboardURL, auth: auth, updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
        self.displayedRouteRevision = routeRevision
    }

    private func replaceController(
        _ current: DashboardWindowController,
        url: URL,
        auth: DashboardWindowAuth,
        mode: AppState.ConnectionMode,
        tlsParams: GatewayTLSParams?)
    {
        self.switchGenerations[ObjectIdentifier(current)] = nil
        current.releaseFrameAutosaveForReplacement()
        current.closeDashboard()
        let replacement = DashboardWindowController(
            url: url,
            auth: auth,
            updater: self.updater,
            updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode),
            tlsParams: tlsParams,
            gatewaySnapshot: self.snapshot(for: .primary))
        self.controller = replacement
        replacement.show(url: url, auth: auth)
    }

    private func replaceWithRouteFailure(_ current: DashboardWindowController) {
        self.switchGenerations[ObjectIdentifier(current)] = nil
        current.releaseFrameAutosaveForReplacement()
        current.closeDashboard()
        let replacement = DashboardWindowController(
            url: Self.failureURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            updater: self.updater,
            updateBridgeEnabled: false,
            gatewaySnapshot: self.snapshot(for: .primary))
        self.controller = replacement
        replacement.showFailure(
            title: "Dashboard reconnecting",
            message: "The selected Gateway changed.",
            detail: "Waiting for a fresh authenticated connection.")
    }

    @discardableResult
    func showConfiguredWindowIfPossible() -> Bool {
        guard self.mainTarget == .primary else { return false }
        let mode = AppStateStore.shared.connectionMode
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
        if let controller, !controller.hasTLSParams(endpoint.tls?.params) {
            self.replaceController(
                controller,
                url: url,
                auth: auth,
                mode: mode,
                tlsParams: endpoint.tls?.params)
        } else if let controller {
            controller.show(url: url, auth: auth, updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
        } else {
            let controller = DashboardWindowController(
                url: url,
                auth: auth,
                updater: self.updater,
                updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode),
                tlsParams: endpoint.tls?.params)
            self.controller = controller
            controller.show(url: url, auth: auth)
        }
        self.observeEndpointChanges()
        Task { await self.refreshGatewaySnapshots() }
        Task { _ = try? await ControlChannel.shared.health(timeout: 3) }
        return true
    }

    /// Preload failures stay invisible: navigation errors land in the
    /// controller's `showLoadFailure`, which never orders the window front, and
    /// preload skips `observeEndpointChanges()` so no observer path can call
    /// `showFailure`. The failure page is only seen on a later explicit show.
    func preloadIfConfigured() {
        guard self.controller == nil,
              AppStateStore.shared.onboardingSeen,
              let (mode, url, auth, tlsParams) = self.immediateWindowConfiguration()
        else { return }
        let controller = DashboardWindowController(
            url: url,
            auth: auth,
            updater: self.updater,
            updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode),
            tlsParams: tlsParams,
            gatewaySnapshot: self.snapshot(for: .primary))
        self.controller = controller
        controller.loadInBackground(url: url, auth: auth)
    }

    func show() async throws {
        if let controller, self.mainTarget != .primary {
            if controller.isWindowOpen {
                controller.show()
                await self.refreshGatewaySnapshots()
                return
            }
            await self.switchTarget(self.mainTarget, in: controller, forceReload: true, present: true)
            return
        }
        let mode = AppStateStore.shared.connectionMode
        dashboardManagerLogger.info("dashboard show requested mode=\(String(describing: mode), privacy: .public)")
        let endpoint = try await self.primaryEndpoint(mode: mode)
        let config = endpoint.config
        dashboardManagerLogger.info("dashboard config url=\(config.url.absoluteString, privacy: .public)")
        let token = await GatewayConnection.shared.controlUiAutoAuthToken(config: config)
        let url = try GatewayEndpointStore.dashboardURL(for: config, mode: mode, authToken: token)
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: url),
            token: token,
            password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)

        if let controller, !controller.hasTLSParams(endpoint.tls?.params) {
            self.replaceController(
                controller,
                url: url,
                auth: auth,
                mode: mode,
                tlsParams: endpoint.tls?.params)
            self.observeEndpointChanges()
            await self.refreshGatewaySnapshots()
            return
        } else if let controller {
            dashboardManagerLogger.info("dashboard reuse window url=\(dashboardLogString(for: url), privacy: .public)")
            controller.show(url: url, auth: auth, updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode))
            self.observeEndpointChanges()
            await self.refreshGatewaySnapshots()
            return
        }

        dashboardManagerLogger.info("dashboard create window url=\(dashboardLogString(for: url), privacy: .public)")
        let controller = DashboardWindowController(
            url: url,
            auth: auth,
            updater: self.updater,
            updateBridgeEnabled: Self.updateBridgeEnabled(mode: mode),
            tlsParams: endpoint.tls?.params,
            gatewaySnapshot: self.snapshot(for: .primary))
        self.controller = controller
        controller.show(url: url, auth: auth)
        self.observeEndpointChanges()
        await self.refreshGatewaySnapshots()

        // Refresh the cached hello payload without blocking window creation.
        Task { _ = try? await ControlChannel.shared.health(timeout: 3) }
    }

    func show(atPath path: String) async {
        self.navigationGeneration &+= 1
        let generation = self.navigationGeneration
        do {
            try await self.show()
            guard generation == self.navigationGeneration else { return }
            guard let controller,
                  let fallbackURL = DashboardRouteMap.dashboardURL(
                      byAppendingSameAppPath: path,
                      to: controller.dashboardBaseURL)
            else { return }
            controller.dispatchNativeNavigation(DashboardNativeNavigation(path: path, fallbackURL: fallbackURL))
        } catch {
            guard generation == self.navigationGeneration else { return }
            self.showFailure(error)
        }
    }

    func showFailure(_ error: Error) {
        let message = (error as NSError).localizedDescription
        dashboardManagerLogger.error("dashboard setup failed error=\(message, privacy: .public)")
        let controller = self.controller ?? DashboardWindowController(
            url: Self.failureURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            updater: self.updater,
            updateBridgeEnabled: Self.updateBridgeEnabled(mode: AppStateStore.shared.connectionMode))
        self.controller = controller
        // Keep observing while the failure page is up so a recovered tunnel
        // swaps the window back to the live dashboard.
        self.observeEndpointChanges()
        controller.showFailure(
            title: "Dashboard unavailable",
            message: message,
            detail: "Check Settings → Connection or use Debug → Reset Remote Tunnel, then try again.")
    }

    func close() {
        self.switchGenerations.removeAll()
        self.controller?.closeDashboard()
        let controllers = self.auxiliaryWindows.values.map(\.controller)
        self.auxiliaryWindows.removeAll()
        self.auxiliaryWindowOrder.removeAll()
        for controller in controllers {
            controller.closeDashboard()
        }
        self.frontmostDashboardTarget = nil
    }

    func handleOnboardingCompletion() {
        self.controller?.handleOnboardingCompletion()
    }

    func navigateBack() {
        guard self.controller?.window?.isKeyWindow == true else { return }
        self.controller?.navigateBack()
    }

    func navigateForward() {
        guard self.controller?.window?.isKeyWindow == true else { return }
        self.controller?.navigateForward()
    }

    func handleGatewayRequest(_ request: DashboardGatewaysRequest, from source: DashboardWindowController) {
        switch request {
        case let .select(target):
            Task { await self.switchTarget(target, in: source) }
        case let .openWindow(target):
            Task { await self.openWindow(for: target) }
        case let .setPrimary(target):
            guard self.target(for: source) == target else { return }
            self.presentSetPrimaryConfirmation(target, source: source)
        case .openSettings:
            AppNavigationActions.openSettings(tab: .gateways)
        }
    }

    func dispatchNativeCommand(_ command: DashboardNativeCommand) {
        if command.supersedesPendingNavigation {
            // This also invalidates a handoff still suspended in show(atPath:).
            self.navigationGeneration &+= 1
        }
        NSApp.activate(ignoringOtherApps: true)
        if let controller, controller.isWindowOpen, controller.canDeliverNativeCommands {
            controller.show()
            controller.dispatchNativeCommand(command)
            return
        }
        // One coalesced open drains the queue in press order; a Task per key
        // press would race window creation and reorder ⌘N/⌘K delivery.
        self.pendingOpenCommands.append(command)
        guard self.openForCommandTask == nil else { return }
        self.openForCommandTask = Task { @MainActor in
            defer { self.openForCommandTask = nil }
            if !self.showConfiguredWindowIfPossible() {
                do {
                    try await self.show()
                } catch {
                    // Commands are moment-bound; drop them with the failed open.
                    self.pendingOpenCommands = []
                    self.showFailure(error)
                    return
                }
            }
            let commands = self.pendingOpenCommands
            self.pendingOpenCommands = []
            for command in commands {
                self.controller?.dispatchNativeCommand(command)
            }
        }
    }

    private func snapshot(for target: DashboardGatewayTarget) -> DashboardGatewaySnapshot? {
        guard !self.gatewayEntries.isEmpty else { return nil }
        return DashboardGatewaySnapshot(gateways: self.gatewayEntries, currentId: target.bridgeID)
    }

    private func refreshGatewaySnapshots() async {
        guard let entries = try? await self.loadGatewayEntries() else { return }
        self.gatewayEntries = entries
        if let controller, !Self.targetIsAvailable(self.mainTarget, in: entries) {
            await self.switchTarget(.primary, in: controller)
            return
        }
        if let invalid = self.auxiliaryWindows.values.first(where: {
            !Self.targetIsAvailable($0.target, in: entries)
        }) {
            await self.switchTarget(.primary, in: invalid.controller)
            return
        }
        if let controller, let snapshot = self.snapshot(for: self.mainTarget) {
            controller.updateGatewaySnapshot(snapshot)
        }
        for instance in self.auxiliaryWindows.values {
            if let snapshot = self.snapshot(for: instance.target) {
                instance.controller.updateGatewaySnapshot(snapshot)
            }
        }
    }

    private func target(for source: DashboardWindowController) -> DashboardGatewayTarget? {
        if self.controller === source { return self.mainTarget }
        return self.auxiliaryWindows.values.first { $0.controller === source }?.target
    }

    private static func targetIsAvailable(
        _ target: DashboardGatewayTarget,
        in entries: [DashboardGatewayEntry]) -> Bool
    {
        entries.contains { $0.id == target.bridgeID }
    }

    private func beginSwitch(for source: DashboardWindowController) -> UInt64 {
        let key = ObjectIdentifier(source)
        let generation = (self.switchGenerations[key] ?? 0) &+ 1
        self.switchGenerations[key] = generation
        return generation
    }

    private func switchIsCurrent(_ generation: UInt64, for source: DashboardWindowController) -> Bool {
        self.switchGenerations[ObjectIdentifier(source)] == generation && self.target(for: source) != nil
    }

    private func finishSwitch(_ generation: UInt64, for source: DashboardWindowController) {
        let key = ObjectIdentifier(source)
        if self.switchGenerations[key] == generation {
            self.switchGenerations[key] = nil
        }
    }

    private func switchTarget(
        _ target: DashboardGatewayTarget,
        in source: DashboardWindowController,
        forceReload: Bool = false,
        present: Bool? = nil) async
    {
        guard let currentTarget = self.target(for: source) else { return }
        // Each source window has its own generation so the latest selection wins
        // without serializing unrelated dashboard windows.
        let generation = self.beginSwitch(for: source)
        guard forceReload || currentTarget != target else {
            self.finishSwitch(generation, for: source)
            return
        }
        do {
            let configuration = try await self.windowConfiguration(for: target)
            guard self.switchIsCurrent(generation, for: source), self.target(for: source) == currentTarget else {
                return
            }
            // Background reconciliation must not resurrect a window the user closed;
            // explicit show/open callers opt back into presentation.
            let shouldPresent = present ?? source.isWindowOpen
            if self.controller === source {
                let frame = source.window?.frame
                if self.mainTarget == .primary, target != .primary {
                    self.displayedRouteRevision = nil
                }
                source.releaseFrameAutosaveForReplacement()
                source.closeDashboard()
                self.mainTarget = target
                let replacement = self.makeController(
                    configuration: configuration,
                    target: target,
                    windowAutosaveName: self.availableAutosaveName(for: target, replacing: source),
                    auxiliary: false)
                // In-place switches preserve the frame the user is viewing;
                // target autosaves seed only newly opened windows.
                if let frame { replacement.window?.setFrame(frame, display: false) }
                self.controller = replacement
                if shouldPresent {
                    replacement.show(url: configuration.url, auth: configuration.auth)
                } else {
                    replacement.loadInBackground(url: configuration.url, auth: configuration.auth)
                }
            } else if let windowID = self.auxiliaryWindows.first(where: { $0.value.controller === source })?.key {
                let frame = source.window?.frame
                let autosaveName = self.availableAutosaveName(for: target, replacing: source)
                source.onClosed = nil
                source.releaseFrameAutosaveForReplacement()
                source.closeDashboard()
                let replacement = self.makeController(
                    configuration: configuration,
                    target: target,
                    windowAutosaveName: autosaveName,
                    auxiliary: true)
                if let frame { replacement.window?.setFrame(frame, display: false) }
                self.installAuxiliaryWindowCloseHandler(replacement, windowID: windowID)
                self.auxiliaryWindows[windowID] = AuxiliaryWindowInstance(target: target, controller: replacement)
                if shouldPresent {
                    replacement.show(url: configuration.url, auth: configuration.auth)
                } else {
                    replacement.loadInBackground(url: configuration.url, auth: configuration.auth)
                }
            }
            self.finishSwitch(generation, for: source)
            await self.refreshGatewaySnapshots()
            self.updateFrontmostDashboardTarget()
        } catch {
            guard self.switchIsCurrent(generation, for: source) else { return }
            self.finishSwitch(generation, for: source)
            Self.showGatewayError(error, message: "Could Not Switch Gateway")
        }
    }

    private func openWindow(for target: DashboardGatewayTarget) async {
        do {
            let configuration = try await self.windowConfiguration(for: target)
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
            self.installAuxiliaryWindowCloseHandler(controller, windowID: windowID)
            self.auxiliaryWindows[windowID] = AuxiliaryWindowInstance(target: target, controller: controller)
            self.auxiliaryWindowOrder.append(windowID)
            if let previous {
                let origin = previous.window?.frame.origin ?? .zero
                controller.window?.setFrameOrigin(NSPoint(x: origin.x + 24, y: origin.y - 24))
            }
            controller.show(url: configuration.url, auth: configuration.auth)
            await self.refreshGatewaySnapshots()
            self.updateFrontmostDashboardTarget()
        } catch {
            Self.showGatewayError(error, message: "Could Not Open Gateway Window")
        }
    }

    private func windowConfiguration(for target: DashboardGatewayTarget) async throws -> WindowConfiguration {
        switch target {
        case .primary:
            let mode = AppStateStore.shared.connectionMode
            let endpoint = try await self.primaryEndpoint(mode: mode)
            let config = endpoint.config
            let token = await self.authTokenProvider(config)
            let url = try GatewayEndpointStore.dashboardURL(for: config, mode: mode, authToken: token)
            let auth = DashboardWindowAuth(
                gatewayUrl: Self.websocketURLString(for: url),
                token: token,
                password: config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
            return WindowConfiguration(
                url: url,
                auth: auth,
                tlsParams: endpoint.tls?.params,
                mode: mode,
                displayName: "OpenClaw")
        case let .profile(profileID):
            let endpoint = try await self.profileEndpoint(profileID: profileID)
            let url = try GatewayEndpointStore.dashboardURL(
                for: endpoint.config,
                mode: .remote,
                authToken: endpoint.config.token)
            let auth = DashboardWindowAuth(
                gatewayUrl: Self.websocketURLString(for: url),
                token: endpoint.config.token,
                password: endpoint.config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
            let name = self.gatewayEntries.first { $0.id == target.bridgeID }?.name ?? url.host ?? "Gateway"
            return WindowConfiguration(
                url: url,
                auth: auth,
                tlsParams: endpoint.tls?.params,
                mode: .remote,
                displayName: name)
        }
    }

    private func makeController(
        configuration: WindowConfiguration,
        target: DashboardGatewayTarget,
        windowAutosaveName: String,
        auxiliary: Bool) -> DashboardWindowController
    {
        let primaryLocal = !auxiliary && target == .primary && configuration.mode == .local
        if primaryLocal {
            return DashboardWindowController(
                url: configuration.url,
                auth: configuration.auth,
                updater: self.updater,
                updateBridgeEnabled: Self.updateBridgeEnabled(mode: configuration.mode),
                tlsParams: configuration.tlsParams,
                gatewaySnapshot: self.snapshot(for: target),
                windowTitle: configuration.displayName,
                windowAutosaveName: windowAutosaveName)
        }
        return DashboardWindowController(
            url: configuration.url,
            auth: configuration.auth,
            updater: self.updater,
            updateBridgeEnabled: false,
            tlsParams: configuration.tlsParams,
            gatewaySnapshot: self.snapshot(for: target),
            windowTitle: configuration.displayName,
            windowAutosaveName: windowAutosaveName,
            requestBrowserProfileImportOffer: { _ in false })
    }

    private func installAuxiliaryWindowCloseHandler(_ controller: DashboardWindowController, windowID: UUID) {
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller,
                  self.auxiliaryWindows[windowID]?.controller === controller
            else {
                return
            }
            self.switchGenerations[ObjectIdentifier(controller)] = nil
            self.auxiliaryWindows.removeValue(forKey: windowID)
            self.auxiliaryWindowOrder.removeAll { $0 == windowID }
            self.updateFrontmostDashboardTarget()
        }
    }

    private func autosaveName(for target: DashboardGatewayTarget) -> String {
        switch target {
        case .primary:
            self.mainWindowAutosaveName
        case let .profile(profileID):
            "OpenClawDashboardWindow-\(profileID)"
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

    private static func showGatewayError(_ error: Error, message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    private static func websocketURLString(for dashboardURL: URL) -> String {
        guard var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false) else {
            return dashboardURL.absoluteString
        }
        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        default:
            components.scheme = "ws"
        }
        components.queryItems = nil
        components.fragment = nil
        return components.url?.absoluteString ?? dashboardURL.absoluteString
    }

    private func primaryEndpoint(
        mode: AppState.ConnectionMode) async throws -> GatewayConnection.EndpointSnapshot
    {
        #if DEBUG
        if let testPrimaryEndpointProvider {
            return try await testPrimaryEndpointProvider(mode)
        }
        #endif
        return try await Self.resolvePrimaryEndpoint(mode: mode)
    }

    private func profileEndpoint(profileID: String) async throws -> GatewayConnection.EndpointSnapshot {
        #if DEBUG
        if let testProfileEndpointProvider {
            return try await testProfileEndpointProvider(profileID)
        }
        #endif
        return try await MacGatewayProfileStore.shared.endpoint(profileID: profileID)
    }

    private func loadGatewayEntries() async throws -> [DashboardGatewayEntry] {
        #if DEBUG
        if let testGatewayEntriesProvider {
            return try await testGatewayEntriesProvider()
        }
        #endif
        return try await DashboardGatewayCatalog.loadEntries()
    }

    private static func resolvePrimaryEndpoint(
        mode: AppState.ConnectionMode) async throws -> GatewayConnection.EndpointSnapshot
    {
        if let endpoint = self.immediateDashboardEndpoint(mode: mode) {
            return endpoint
        }
        return try await Task.detached(priority: .userInitiated) {
            await GatewayEndpointStore.shared.refresh()
            return try await GatewayEndpointStore.shared.requireEndpoint()
        }.value
    }

    private static func immediateDashboardEndpoint(
        mode: AppState.ConnectionMode) -> GatewayConnection.EndpointSnapshot?
    {
        let root = OpenClawConfigFile.loadDict()
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        if mode == .remote,
           resolution.transport == .direct,
           let url = resolution.directURL
        {
            return GatewayConnection.EndpointSnapshot(
                config: (
                    url,
                    GatewayRemoteConfig.resolveTokenString(root: root),
                    GatewayRemoteConfig.resolvePasswordString(root: root)),
                tls: GatewayTLSRoute.resolve(
                    url: url,
                    connectionMode: mode,
                    configuredFingerprint: GatewayRemoteConfig.resolveTLSFingerprint(root: root)),
                routeAuthority: nil)
        }

        if mode == .local {
            let config = GatewayEndpointStore.localConfig()
            return GatewayConnection.EndpointSnapshot(
                config: config,
                tls: GatewayTLSRoute.resolve(
                    url: config.url,
                    connectionMode: mode,
                    configuredFingerprint: nil),
                routeAuthority: nil)
        }

        return nil
    }

    private static func primaryTLSParams(
        for config: GatewayConnection.Config,
        mode: AppState.ConnectionMode) -> GatewayTLSParams?
    {
        let root = OpenClawConfigFile.loadDict()
        return GatewayTLSRoute.resolve(
            url: config.url,
            connectionMode: mode,
            configuredFingerprint: mode == .remote
                ? GatewayRemoteConfig.resolveTLSFingerprint(root: root)
                : nil)?.params
    }

    private func immediateWindowConfiguration()
        -> (AppState.ConnectionMode, URL, DashboardWindowAuth, GatewayTLSParams?)?
    {
        let mode = AppStateStore.shared.connectionMode
        guard let endpoint = Self.immediateDashboardEndpoint(mode: mode),
              let url = try? GatewayEndpointStore.dashboardURL(
                  for: endpoint.config,
                  mode: mode,
                  authToken: endpoint.config.token)
        else { return nil }
        let config = endpoint.config
        let auth = DashboardWindowAuth(
            gatewayUrl: Self.websocketURLString(for: url),
            token: config.token,
            password: (config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty))
        return auth.hasCredential ? (mode, url, auth, endpoint.tls?.params) : nil
    }
}

extension DashboardManager {
    func openOrFocusDashboard(for target: DashboardGatewayTarget) {
        Task { await self.performOpenOrFocusDashboard(for: target) }
    }

    func switchFrontmostDashboard(to target: DashboardGatewayTarget) {
        Task { await self.performSwitchFrontmostDashboard(to: target) }
    }

    func confirmSetPrimary(_ target: DashboardGatewayTarget) {
        self.presentSetPrimaryConfirmation(target, source: nil)
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

    private func frontmostDashboard()
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
        self.frontmostDashboardTarget = self.frontmostDashboard()?.target
    }

    private func dashboardController(for target: DashboardGatewayTarget) -> DashboardWindowController? {
        if let frontmost = self.frontmostDashboard(), frontmost.target == target {
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

    private func performOpenOrFocusDashboard(for target: DashboardGatewayTarget) async {
        if let controller = self.dashboardController(for: target) {
            NSApp.activate(ignoringOtherApps: true)
            controller.show()
            self.updateFrontmostDashboardTarget()
            return
        }
        if self.mainTarget == target || (target == .primary && self.controller == nil) {
            do {
                try await self.show()
            } catch {
                self.showFailure(error)
            }
        } else {
            await self.openWindow(for: target)
        }
        self.updateFrontmostDashboardTarget()
    }

    private func performSwitchFrontmostDashboard(to target: DashboardGatewayTarget) async {
        guard let frontmost = self.frontmostDashboard() else {
            await self.performOpenOrFocusDashboard(for: target)
            return
        }
        await self.switchTarget(target, in: frontmost.controller, present: true)
        self.updateFrontmostDashboardTarget()
    }

    private func presentSetPrimaryConfirmation(
        _ target: DashboardGatewayTarget,
        source: DashboardWindowController?)
    {
        guard case let .profile(profileID) = target,
              let entry = self.gatewayEntries.first(where: { $0.id == target.bridgeID }),
              entry.canPromote
        else {
            return
        }
        let alert = DashboardWindowController.makeSetPrimaryAlert(gatewayName: entry.name)
        let apply: (NSApplication.ModalResponse) -> Void = { [weak self, weak source] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task { @MainActor in
                do {
                    try await DashboardPrimaryGatewayAdapter(state: AppStateStore.shared).apply(profileID: profileID)
                    if let source, self.target(for: source) != nil {
                        await self.switchTarget(.primary, in: source)
                    } else {
                        await self.refreshGatewaySnapshots()
                    }
                } catch {
                    Self.showGatewayError(error, message: "Could Not Set Primary Gateway")
                }
            }
        }
        if let window = source?.window {
            alert.beginSheetModal(for: window, completionHandler: apply)
        } else {
            apply(alert.runModal())
        }
    }
}

#if DEBUG
extension DashboardManager {
    /// Test instances skip `observeEndpointChanges()` so the shared endpoint
    /// store cannot race test-driven `handleEndpointState` calls.
    static func _testMake(
        authTokenProvider: @escaping @Sendable (GatewayConnection.Config) async -> String? = { $0.token },
        routeProbe: @escaping @Sendable () async -> Void = {},
        endpointStateProvider: @escaping @Sendable () async -> GatewayEndpointState = {
            .unavailable(mode: .unconfigured, reason: "not configured")
        },
        primaryEndpointProvider: (@Sendable (AppState.ConnectionMode) async throws
            -> GatewayConnection.EndpointSnapshot)? = nil,
        profileEndpointProvider: (@Sendable (String) async throws
            -> GatewayConnection.EndpointSnapshot)? = nil,
        gatewayEntriesProvider: (@MainActor () async throws -> [DashboardGatewayEntry])? = nil)
        -> DashboardManager
    {
        let manager = DashboardManager(
            authTokenProvider: authTokenProvider,
            routeProbe: routeProbe,
            endpointStateProvider: endpointStateProvider,
            observeGatewayChanges: false,
            mainWindowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        manager.testPrimaryEndpointProvider = primaryEndpointProvider
        manager.testProfileEndpointProvider = profileEndpointProvider
        manager.testGatewayEntriesProvider = gatewayEntriesProvider
        return manager
    }

    func _testSetController(_ controller: DashboardWindowController?) {
        self.controller = controller
    }

    func _testController() -> DashboardWindowController? {
        self.controller
    }

    func _testMainTarget() -> DashboardGatewayTarget {
        self.mainTarget
    }

    func _testOpenWindow(for target: DashboardGatewayTarget) async {
        await self.openWindow(for: target)
    }

    func _testSwitchTarget(_ target: DashboardGatewayTarget, in source: DashboardWindowController) async {
        await self.switchTarget(target, in: source)
    }

    func _testSwitchFrontmostDashboard(to target: DashboardGatewayTarget) async {
        await self.performSwitchFrontmostDashboard(to: target)
    }

    func _testHandleControlChannelStateChange(_ state: ControlChannel.ConnectionState) async {
        await self.handleControlChannelStateChange(state)
    }

    func _testWindowTLSParams(for target: DashboardGatewayTarget) async throws -> GatewayTLSParams? {
        try await self.windowConfiguration(for: target).tlsParams
    }

    func _testAuxiliaryWindows() -> [(target: DashboardGatewayTarget, controller: DashboardWindowController)] {
        self.auxiliaryWindows.values.map { ($0.target, $0.controller) }
    }

    func _testSetMainTarget(_ target: DashboardGatewayTarget) {
        self.mainTarget = target
        if target != .primary {
            self.displayedRouteRevision = nil
        }
    }

    static func _testAutosaveName(for target: DashboardGatewayTarget) -> String {
        switch target {
        case .primary:
            DashboardWindowLayout.windowFrameAutosaveName
        case let .profile(profileID):
            "OpenClawDashboardWindow-\(profileID)"
        }
    }

    static func _testTargetIsAvailable(
        _ target: DashboardGatewayTarget,
        in entries: [DashboardGatewayEntry]) -> Bool
    {
        self.targetIsAvailable(target, in: entries)
    }
}
#endif
