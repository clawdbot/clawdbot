import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import OSLog

struct MacNodeGatewayTLSSessionCache {
    private struct Key: Equatable {
        let url: URL
        let required: Bool
        let expectedFingerprint: String?
        let allowTOFU: Bool
        let storeKey: String?

        init(url: URL, params: GatewayTLSParams) {
            self.url = url
            self.required = params.required
            self.expectedFingerprint = params.expectedFingerprint
            self.allowTOFU = params.allowTOFU
            self.storeKey = params.storeKey
        }
    }

    private var cachedKey: Key?
    private var cachedBox: WebSocketSessionBox?

    mutating func sessionBox(url: URL, params: GatewayTLSParams) -> WebSocketSessionBox {
        let key = Key(url: url, params: params)
        if let cachedKey = self.cachedKey, cachedKey == key, let cachedBox = self.cachedBox {
            return cachedBox
        }
        let box = WebSocketSessionBox(session: GatewayTLSPinningSession(params: params))
        self.cachedKey = key
        self.cachedBox = box
        return box
    }

    mutating func invalidate() {
        self.cachedKey = nil
        self.cachedBox = nil
    }
}

private struct EffectiveEndpoint: Equatable {
    let mode: AppState.ConnectionMode
    let url: URL
    let token: String?
    let password: String?
    let routeRevision: UInt64
}

private struct ConnectionAttempt {
    let endpointGeneration: UInt64
    let routeAuthorityGeneration: UInt64
    let codexThreadCatalogAdvertised: Bool
    let claudeSessionCatalogAdvertised: Bool
    let workerUnavailableReason: String?
    let endpoint: GatewayConnection.EndpointSnapshot
    let options: GatewayConnectOptions
    let sessionBox: WebSocketSessionBox?
    let fallbackMainSessionKey: String
}

private enum RouteInvalidationMode {
    case ordinaryDisconnect
    case reconnectRefresh
    case workerRestart
    case terminalStop
}

@MainActor
final class MacNodeModeCoordinator: NSObject {
    static let shared = MacNodeModeCoordinator()
    static var nodeIdentityProfile: GatewayDeviceIdentityProfile {
        self.resolveNodeIdentityProfile(
            defaults: AppDefaults.standard,
            isExistingInstallation: AppStateStore.shared.onboardingSeen)
    }

    static func prepareNodeIdentityProfile(isExistingInstallation: Bool) {
        _ = self.resolveNodeIdentityProfile(
            defaults: AppDefaults.standard,
            isExistingInstallation: isExistingInstallation)
    }

    static func resolveNodeIdentityProfile(
        defaults: UserDefaults,
        isExistingInstallation: Bool) -> GatewayDeviceIdentityProfile
    {
        if let rawValue = defaults.string(forKey: macNodeIdentityProfileKey),
           let stored = GatewayDeviceIdentityProfile(rawValue: rawValue),
           stored == .primary || stored == .node
        {
            return stored
        }
        // Released builds used the primary identity for the Mac node. Persist the
        // install-era choice before onboarding can change connection state.
        let selected: GatewayDeviceIdentityProfile = isExistingInstallation ? .primary : .node
        defaults.set(selected.rawValue, forKey: macNodeIdentityProfileKey)
        return selected
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "mac-node")
    private var task: Task<Void, Never>?
    private var endpointRefreshTask: Task<Void, Never>?
    private var reconnectProbeTask: Task<Void, Never>?
    private var routeInvalidationTask: Task<Void, Never>?
    private var terminalStopTask: Task<Void, Never>?
    private var nodeHostWorkerRetryTask: Task<Void, Never>?
    private var endpointAttemptGeneration: UInt64 = 0
    private var routeAuthorityGeneration: UInt64 = 0
    private var completedRouteAuthorityGeneration: UInt64 = 0
    private var nodeHostWorkerConfigurationGeneration: UInt64 = 0
    private var nodeHostWorkerRetryTaskGeneration: UInt64 = 0
    private var pendingEndpoint: GatewayConnection.EndpointSnapshot?
    private var activeNodeHostWorkerInput: MacNodeHostWorkerRetryPolicy.Input?
    private var lastNodeHostWorkerStartFailure: String?
    private var lastObservedPaused: Bool
    private var lastObservedComputerControlEnabled: Bool
    private var lastObservedComputerControlProvider: ComputerControlProvider
    private let runtime: MacNodeRuntime
    private let session: GatewayNodeSession
    private let channelStatus: MacNodeChannelStatusStore
    private let nodeHostWorker: (any MacNodeHostWorking)?
    private let presenceReporter: MacNodePresenceReporter
    private let notificationCenter: NotificationCenter
    private let nodeHostWorkerRetrySleep: @Sendable (UInt64) async throws -> Void
    private let refreshEvents: AsyncStream<Void>
    private let refreshContinuation: AsyncStream<Void>.Continuation
    private var tlsSessionCache = MacNodeGatewayTLSSessionCache()
    private var nodeHostWorkerRetryPolicy: MacNodeHostWorkerRetryPolicy

    override private convenience init() {
        let session = GatewayNodeSession()
        let nodeHostWorker = MacNodeHostWorker(session: session) { generation in
            NotificationCenter.default.post(name: .openclawNodeHostWorkerFailed, object: NSNumber(value: generation))
        }
        self.init(
            session: session,
            runtime: MacNodeRuntime(
                nodeHostWorker: nodeHostWorker,
                canvasSurfaceUrl: { await session.currentCanvasHostUrl() },
                refreshCanvasSurfaceUrl: { observedURL in
                    await session.refreshCanvasHostUrl(replacing: observedURL)
                }),
            nodeHostWorker: nodeHostWorker,
            presenceReporter: MacNodePresenceReporter(),
            observeNotifications: true,
            initialPaused: nil,
            initialComputerControlEnabled: nil)
    }

    init(
        session: GatewayNodeSession,
        runtime: MacNodeRuntime,
        nodeHostWorker: (any MacNodeHostWorking)? = nil,
        presenceReporter: MacNodePresenceReporter = MacNodePresenceReporter(),
        channelStatus: MacNodeChannelStatusStore = .shared,
        notificationCenter: NotificationCenter = .default,
        observeNotifications: Bool = false,
        initialPaused: Bool? = nil,
        initialComputerControlEnabled: Bool? = nil,
        initialComputerControlProvider: ComputerControlProvider? = nil,
        nodeHostWorkerRetrySleep: @escaping @Sendable (UInt64) async throws -> Void = {
            try await Task.sleep(nanoseconds: $0)
        },
        nodeHostWorkerRetryPolicy: MacNodeHostWorkerRetryPolicy = MacNodeHostWorkerRetryPolicy())
    {
        let refreshEvents = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        self.session = session
        self.runtime = runtime
        self.nodeHostWorker = nodeHostWorker
        self.presenceReporter = presenceReporter
        self.channelStatus = channelStatus
        self.notificationCenter = notificationCenter
        self.nodeHostWorkerRetrySleep = nodeHostWorkerRetrySleep
        self.nodeHostWorkerRetryPolicy = nodeHostWorkerRetryPolicy
        self.refreshEvents = refreshEvents.stream
        self.refreshContinuation = refreshEvents.continuation
        self.lastObservedPaused = initialPaused ?? AppLaunchRuntimePlan.current.resolvePaused(
            AppDefaults.standard.bool(forKey: pauseDefaultsKey))
        self.lastObservedComputerControlEnabled = initialComputerControlEnabled ??
            isComputerControlEnabled()
        self.lastObservedComputerControlProvider = initialComputerControlProvider ??
            ComputerControlProvider.current()
        super.init()

        guard observeNotifications else { return }
        self.notificationCenter.addObserver(
            self,
            selector: #selector(self.refreshNodeConfiguration),
            name: UserDefaults.didChangeNotification,
            object: AppDefaults.standard)
        self.notificationCenter.addObserver(
            self,
            selector: #selector(self.refreshNodeConfiguration),
            name: NSApplication.didBecomeActiveNotification,
            object: nil)
        self.notificationCenter.addObserver(
            self,
            selector: #selector(self.refreshNodeConfiguration),
            name: .openclawPermissionsChanged,
            object: nil)
        self.notificationCenter.addObserver(
            self,
            selector: #selector(self.nodeHostWorkerFailed),
            name: .openclawNodeHostWorkerFailed,
            object: nil)
        self.notificationCenter.addObserver(
            self,
            selector: #selector(self.nodeHostConfigurationChanged),
            name: .openclawConfigDidChange,
            object: nil)
        self.notificationCenter.addObserver(
            self,
            selector: #selector(self.nodeHostConfigurationChanged),
            name: .openclawCLIInstalled,
            object: nil)
        self.notificationCenter.addObserver(
            self,
            selector: #selector(self.nodeHostConfigurationChanged),
            name: .openclawCuaDriverAvailabilityChanged,
            object: nil)
    }

    deinit {
        self.notificationCenter.removeObserver(self)
        self.refreshContinuation.finish()
    }

    func start() {
        guard self.task == nil else { return }
        self.task = Task { [weak self] in
            await self?.run()
        }
        self.endpointRefreshTask = Task { [weak self] in
            let states = await GatewayEndpointStore.shared.subscribe()
            var previousState: GatewayEndpointState?
            for await state in states {
                guard let self else { return }
                let initialStateMissedAttempt = previousState == nil &&
                    self.pendingEndpoint.map { !Self.endpointState(state, matches: $0) } == true
                let endpointChanged = previousState.map {
                    Self.endpointTransitionRequiresDisconnect(from: $0, to: state)
                } ?? false
                if initialStateMissedAttempt || endpointChanged {
                    // Endpoint loss and replacement are ownership changes. Tear down the
                    // old route (including held input) before waking the connect loop.
                    self.enqueueRouteInvalidation(mode: .reconnectRefresh)
                }
                previousState = state
            }
        }
    }

    func stop() {
        self.cancelCoordinatorTasks()
        _ = self.beginTerminalStop()
    }

    func stopAndWait() async {
        self.cancelCoordinatorTasks()
        await self.beginTerminalStop().value
    }

    func prepareForCuaDaemonStop() async {
        await self.enqueueRouteInvalidation(mode: .workerRestart).value
    }

    private func beginTerminalStop() -> Task<Void, Never> {
        if let terminalStopTask = self.terminalStopTask {
            return terminalStopTask
        }
        let task = self.enqueueRouteInvalidation(mode: .terminalStop)
        self.terminalStopTask = task
        return task
    }

    private func cancelCoordinatorTasks() {
        self.channelStatus.record(.idle)
        self.task?.cancel()
        self.task = nil
        self.endpointRefreshTask?.cancel()
        self.endpointRefreshTask = nil
        self.reconnectProbeTask?.cancel()
        self.reconnectProbeTask = nil
    }

    func setPreferredGatewayStableID(
        _ stableID: String?,
        state: AppState = AppStateStore.shared)
    {
        let routeBinding = stableID == nil ? nil : GatewayDiscoveryPreferences.routeBinding(
            connectionMode: .remote,
            remoteTransport: state.remoteTransport,
            remoteURL: state.remoteUrl,
            remoteTarget: state.remoteTarget)
        GatewayDiscoveryPreferences.setPreferredStableID(stableID, routeBinding: routeBinding)
        // Revoke a suspended endpoint attempt before its preference change is
        // reflected back through GatewayEndpointStore's async subscription.
        self.enqueueRouteInvalidation(mode: .reconnectRefresh)
    }

    func refresh() {
        self.refresh(
            isPaused: AppLaunchRuntimePlan.current.resolvePaused(
                AppDefaults.standard.bool(forKey: pauseDefaultsKey)),
            computerControlEnabled: isComputerControlEnabled(),
            computerControlProvider: ComputerControlProvider.current())
    }

    func currentCanvasPluginSurfaceRoute() async -> GatewayCanvasHostRoute? {
        await self.session.currentCanvasHostRoute()
    }

    func setPresenceActivityReportingEnabled(_ enabled: Bool) async {
        await self.presenceReporter.setReportingEnabled(enabled)
    }

    private func clearPresenceActivity(
        ifCurrentRoute route: GatewayNodeSessionRoute) async -> MacNodePresenceReporter.ClearDeliveryResult
    {
        do {
            let result = try await self.session.requestEventResult(
                event: "node.presence.activity",
                payloadJSON: #"{"action":"clear"}"#,
                ifCurrentRoute: route)
            guard let result else { return .unsupported }
            return result.ok && result.handled ? .cleared : .unsupported
        } catch is GatewayResponseError {
            // Gateways predating the structured node-event result can reject the
            // new payload at the request boundary instead of returning handled=false.
            return .unsupported
        } catch {
            self.logger.error(
                "mac node presence clear failed: \(error.localizedDescription, privacy: .public)")
            return .retry
        }
    }

    func refreshCanvasPluginSurfaceRoute(replacing observedURL: String?) async -> GatewayCanvasHostRoute? {
        await self.session.refreshCanvasHostRoute(replacing: observedURL)
    }

    private func refresh(
        isPaused: Bool,
        computerControlEnabled: Bool,
        computerControlProvider: ComputerControlProvider)
    {
        let providerChanged = self.lastObservedComputerControlProvider != computerControlProvider
        let shouldRevoke = Self.controlTransitionRequiresRouteInvalidation(
            previousPaused: self.lastObservedPaused,
            nextPaused: isPaused,
            previousComputerControlEnabled: self.lastObservedComputerControlEnabled,
            nextComputerControlEnabled: computerControlEnabled,
            previousComputerControlProvider: self.lastObservedComputerControlProvider,
            nextComputerControlProvider: computerControlProvider)
        self.lastObservedPaused = isPaused
        self.lastObservedComputerControlEnabled = computerControlEnabled
        self.lastObservedComputerControlProvider = computerControlProvider

        if shouldRevoke {
            self.enqueueRouteInvalidation(mode: providerChanged ? .workerRestart : .reconnectRefresh)
        } else {
            // Routine permission/foreground/defaults refreshes invalidate only
            // suspended setup. The installed route remains authoritative.
            self.invalidateEndpointAttempt()
            self.refreshContinuation.yield()
        }
    }

    private func invalidateEndpointAttempt() {
        self.endpointAttemptGeneration &+= 1
    }

    private func revokeRouteAuthority() {
        self.invalidateEndpointAttempt()
        self.routeAuthorityGeneration &+= 1
    }

    /// Serializes route revocation for endpoint, settings, pause, and stop flows.
    /// Generation advances synchronously; disconnect then cancels active computer
    /// invokes and runs the held-input release hook before the latest refresh wakes.
    @discardableResult
    private func enqueueRouteInvalidation(
        mode: RouteInvalidationMode) -> Task<Void, Never>
    {
        // Worker replacement advances synchronously so a queued exit from the
        // old process cannot revoke or consume retry budget from its successor.
        switch mode {
        case .workerRestart, .terminalStop:
            self.nodeHostWorkerConfigurationGeneration &+= 1
            self.resetNodeHostWorkerRetryState()
        case .ordinaryDisconnect, .reconnectRefresh:
            break
        }
        self.revokeRouteAuthority()
        let invalidationGeneration = self.endpointAttemptGeneration
        let invalidatedRouteAuthorityGeneration = self.routeAuthorityGeneration
        let previous = self.routeInvalidationTask
        let session = self.session
        let presenceReporter = self.presenceReporter
        let nodeHostWorker = self.nodeHostWorker
        let runtime = self.runtime
        let task = Task { @MainActor [weak self] in
            await previous?.value
            await session.disconnect()
            await Self.invalidateRuntimeRoute(
                presenceReporter: presenceReporter,
                nodeHostWorker: nodeHostWorker,
                runtime: runtime,
                authorityGeneration: invalidatedRouteAuthorityGeneration)
            let yieldRefresh: Bool
            switch mode {
            case .ordinaryDisconnect:
                yieldRefresh = false
            case .reconnectRefresh:
                yieldRefresh = true
            case .workerRestart:
                await nodeHostWorker?.stop()
                yieldRefresh = true
            case .terminalStop:
                await nodeHostWorker?.stop()
                await runtime.shutdown()
                yieldRefresh = false
            }
            guard let self else { return }
            self.completedRouteAuthorityGeneration = invalidatedRouteAuthorityGeneration
            guard yieldRefresh,
                  invalidationGeneration == self.endpointAttemptGeneration,
                  !Task.isCancelled
            else { return }
            self.refreshContinuation.yield()
        }
        self.routeInvalidationTask = task
        return task
    }

    private func invalidateRuntimeRoute(authorityGeneration: UInt64) async {
        await Self.invalidateRuntimeRoute(
            presenceReporter: self.presenceReporter,
            nodeHostWorker: self.nodeHostWorker,
            runtime: self.runtime,
            authorityGeneration: authorityGeneration)
    }

    private static func invalidateRuntimeRoute(
        presenceReporter: MacNodePresenceReporter,
        nodeHostWorker: (any MacNodeHostWorking)?,
        runtime: MacNodeRuntime,
        authorityGeneration: UInt64) async
    {
        presenceReporter.stop()
        _ = await nodeHostWorker?.setRoute(nil, authorityGeneration: authorityGeneration)
        await runtime.releaseHeldComputerInput()
    }

    private func awaitStableRouteInvalidationDrain(
        onPendingSnapshot: (@Sendable () async -> Void)? = nil) async
    {
        while self.completedRouteAuthorityGeneration != self.routeAuthorityGeneration {
            let pendingInvalidation = self.routeInvalidationTask
            await onPendingSnapshot?()
            await pendingInvalidation?.value
        }
    }

    private func run() async {
        var retryDelay: UInt64 = 1_000_000_000
        var refreshIterator = self.refreshEvents.makeAsyncIterator()
        let defaults = AppDefaults.standard

        while !Task.isCancelled {
            // A stop/refresh immediately followed by start/unpause must not install
            // a successor route ahead of the serialized disconnect/input release.
            await self.awaitStableRouteInvalidationDrain()
            guard !Task.isCancelled else { return }
            let isPaused = AppStateStore.shared.isPaused
            if Self.pausedStateRequiresDisconnect(isPaused) {
                // Pause revokes the node route, not only the outer retry loop. A
                // connected gateway was revoked before this refresh wake was emitted.
                self.channelStatus.record(.idle)
                guard await refreshIterator.next() != nil else { return }
                continue
            }

            let cameraEnabled = defaults.object(forKey: cameraEnabledKey) as? Bool ?? false
            let browserControlEnabled = OpenClawConfigFile.browserControlEnabled()
            let codexThreadCatalogEnabled = MacNodeCodexThreadCatalog.shouldAdvertise()
            let claudeSessionCatalogEnabled = MacNodeClaudeSessionCatalog.shouldAdvertise()

            var attemptedEndpoint: GatewayConnection.EndpointSnapshot?
            do {
                let endpointAttemptGeneration = self.endpointAttemptGeneration
                let routeAuthorityGeneration = self.routeAuthorityGeneration
                let endpoint = try await GatewayEndpointStore.shared.requireEndpoint()
                self.pendingEndpoint = endpoint
                guard Self.endpointAttemptIsCurrent(
                    capturedGeneration: endpointAttemptGeneration,
                    currentGeneration: self.endpointAttemptGeneration),
                    Self.routeAuthorityAllowsInvoke(
                        capturedRouteAuthorityGeneration: routeAuthorityGeneration,
                        currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
                        completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
                        isPaused: false)
                else { continue }
                attemptedEndpoint = endpoint
                guard let attempt = try await self.prepareConnectionAttempt(
                    endpoint: endpoint,
                    endpointGeneration: endpointAttemptGeneration,
                    routeAuthorityGeneration: routeAuthorityGeneration,
                    browserControlEnabled: browserControlEnabled,
                    cameraEnabled: cameraEnabled,
                    codexThreadCatalogEnabled: codexThreadCatalogEnabled,
                    claudeSessionCatalogEnabled: claudeSessionCatalogEnabled)
                else { continue }

                try await self.connect(attempt)
                guard try await self.validatePostConnect(attempt) else { continue }

                retryDelay = 1_000_000_000
                // GatewayNodeSession owns transport reconnects. Wait until inputs can
                // actually change instead of rereading config and TCC state every second.
                guard await refreshIterator.next() != nil else { return }
            } catch {
                if error is MacNodeHostWorkerRetryPolicy.RetryBackoffPending {
                    // The lifecycle-owned delayed wake is the only event allowed
                    // to admit this same worker input after an unexpected exit.
                    self.channelStatus.record(.unavailable(
                        reason: self.lastNodeHostWorkerStartFailure ?? error.localizedDescription))
                    guard await refreshIterator.next() != nil else { return }
                    continue
                }
                if let tlsError = error as? GatewayTLSValidationError,
                   let attemptedEndpoint,
                   await GatewayTLSRepairCoordinator.shared.repair(
                       route: attemptedEndpoint.tls,
                       url: attemptedEndpoint.config.url,
                       failure: tlsError.failure)
                {
                    await self.session.disconnect()
                    retryDelay = 1_000_000_000
                    continue
                }
                self.logger.error("mac node gateway connect failed: \(error.localizedDescription, privacy: .public)")
                self.channelStatus.record(.unavailable(reason: error.localizedDescription))
                try? await Task.sleep(nanoseconds: min(retryDelay, 10_000_000_000))
                retryDelay = min(retryDelay * 2, 10_000_000_000)
            }
        }
    }

    private func prepareConnectionAttempt(
        endpoint: GatewayConnection.EndpointSnapshot,
        endpointGeneration: UInt64,
        routeAuthorityGeneration: UInt64,
        browserControlEnabled: Bool,
        cameraEnabled: Bool,
        codexThreadCatalogEnabled: Bool,
        claudeSessionCatalogEnabled: Bool) async throws -> ConnectionAttempt?
    {
        let config = endpoint.config
        let provider = ComputerControlProvider.current()
        let (workerManifest, workerUnavailableReason) =
            try await self.resolveWorkerManifestForConnection(provider: provider)
        let nativeCaps = self.currentCaps(
            browserControlEnabled: browserControlEnabled,
            cameraEnabled: cameraEnabled,
            computerControlProvider: provider,
            codexThreadCatalogEnabled: codexThreadCatalogEnabled,
            claudeSessionCatalogEnabled: claudeSessionCatalogEnabled)
        // If Computer Control was turned off, release any button the
        // computer.act service is still holding rather than waiting for
        // the idle watchdog. This refresh loop re-runs on the settings
        // change that drops the cap.
        if !nativeCaps.contains(OpenClawCapability.computer.rawValue) {
            await self.runtime.releaseHeldComputerInput()
        }
        let caps = Self.mergingUnique(nativeCaps, workerManifest?.caps ?? [])
        let commands = Self.mergingUnique(
            self.currentCommands(caps: nativeCaps, computerControlProvider: provider),
            workerManifest?.commands ?? [])
        let permissions = await self.currentPermissions()
        // TCC queries suspend. An endpoint loss/replacement during that
        // hop must not let this stale continuation install old credentials.
        guard Self.endpointAttemptIsCurrent(
            capturedGeneration: endpointGeneration,
            currentGeneration: self.endpointAttemptGeneration),
            Self.routeAuthorityAllowsInvoke(
                capturedRouteAuthorityGeneration: routeAuthorityGeneration,
                currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
                completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
                isPaused: false)
        else { return nil }
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: caps,
            commands: commands,
            computerUse: Self.computerUseDescriptor(
                provider: provider,
                commands: commands,
                workerManifest: workerManifest),
            pathEnv: workerManifest?.pathEnv,
            permissions: permissions,
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: InstanceIdentity.displayName,
            deviceIdentityProfile: Self.nodeIdentityProfile)
        let sessionBox = self.buildSessionBox(url: config.url, tls: endpoint.tls)

        // Resolve compatibility fallback before node admission. Operator recovery
        // here cannot block the node lifecycle callback or its successor cleanup.
        let fallbackMainSessionKey = await GatewayConnection.shared.refreshMainSessionKey()
        let currentEndpoint = try await GatewayEndpointStore.shared.requireEndpoint()
        guard Self.endpointAttemptCanConnect(
            capturedGeneration: endpointGeneration,
            currentGeneration: self.endpointAttemptGeneration,
            isCancelled: Task.isCancelled,
            isPaused: AppStateStore.shared.isPaused,
            capturedEndpoint: endpoint,
            currentEndpoint: currentEndpoint),
            Self.routeAuthorityAllowsInvoke(
                capturedRouteAuthorityGeneration: routeAuthorityGeneration,
                currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
                completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
                isPaused: AppStateStore.shared.isPaused)
        else { return nil }

        return ConnectionAttempt(
            endpointGeneration: endpointGeneration,
            routeAuthorityGeneration: routeAuthorityGeneration,
            codexThreadCatalogAdvertised: commands.contains(
                MacNodeCodexThreadCatalogContract.listCommand),
            claudeSessionCatalogAdvertised: commands.contains(
                MacNodeClaudeSessionCatalogContract.listCommand),
            workerUnavailableReason: workerUnavailableReason,
            endpoint: endpoint,
            options: options,
            sessionBox: sessionBox,
            fallbackMainSessionKey: fallbackMainSessionKey)
    }

    private func connect(_ attempt: ConnectionAttempt) async throws {
        try await self.session.connect(
            url: attempt.endpoint.config.url,
            credentials: GatewayNodeSessionCredentials(
                token: attempt.endpoint.config.token,
                password: attempt.endpoint.config.password),
            connectOptions: attempt.options,
            sessionBox: attempt.sessionBox,
            onConnected: { [weak self] in
                guard let self else { return }
                guard await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration) else { return }
                // Capture this callback's admission before setup suspends. The
                // sender lease then drops already-captured events after replacement.
                guard let installedRoute = await self.session.currentRoute() else { return }
                guard await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration) else { return }
                let workerRouteInstalled = await self.nodeHostWorker?.setRoute(
                    installedRoute,
                    authorityGeneration: attempt.routeAuthorityGeneration) ?? true
                guard workerRouteInstalled else { return }
                await self.nodeHostWorker?.publishInventory(ifCurrentRoute: installedRoute)
                await self.cancelReconnectProbe()
                await self.channelStatus.record(.connected(
                    workerUnavailableReason: attempt.workerUnavailableReason))
                self.logger.info("mac node connected to gateway")
                // The node hello owns this route's session defaults. Reusing the operator
                // connection here can trigger remote-tunnel recovery while the node connects.
                let snapshotMainSessionKey = await self.session.waitForCurrentMainSessionKey(
                    ifCurrentRoute: installedRoute)
                let mainSessionKey = snapshotMainSessionKey ?? attempt.fallbackMainSessionKey
                let routeStillAuthoritative = await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration)
                let currentRoute = await self.session.currentRoute()
                guard routeStillAuthoritative, currentRoute == installedRoute else { return }
                await self.runtime.updateMainSessionKey(mainSessionKey)
                await self.presenceReporter.start(
                    sender: { [weak self] event, payload in
                        guard let self else { return false }
                        return await self.session.sendEvent(
                            event: event,
                            payloadJSON: payload,
                            ifCurrentRoute: installedRoute)
                    },
                    clearer: { [weak self] in
                        guard let self else { return .retry }
                        return await self.clearPresenceActivity(ifCurrentRoute: installedRoute)
                    },
                    onUnsupportedClear: { [weak self] in
                        guard let self else { return }
                        // Disconnect is the only clear operation older Gateways understand.
                        // Fresh disabled routes emit no clear, so this fallback is one-shot.
                        self.logger.info("reconnecting mac node to clear legacy presence activity")
                        _ = self.enqueueRouteInvalidation(mode: .reconnectRefresh)
                    })
            },
            onDisconnected: { [weak self] reason in
                guard let self else { return }
                await self.channelStatus.record(.unavailable(reason: reason))
                await self.invalidateRuntimeRoute(authorityGeneration: attempt.routeAuthorityGeneration)
                await self.scheduleReconnectProbe()
                self.logger.error("mac node disconnected: \(reason, privacy: .public)")
            },
            onInvoke: { [weak self] req in
                guard let self else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(code: .unavailable, message: "UNAVAILABLE: node not ready"))
                }
                guard await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration) else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: node route changed before dispatch"))
                }
                // The connect options are this route's capability lease. A later
                // config enable must not broaden an already-admitted connection;
                // MacNodeRuntime separately rechecks current config to fail closed.
                guard Self.routeSnapshotAllowsCodexCatalogInvoke(
                    command: req.command,
                    catalogAdvertised: attempt.codexThreadCatalogAdvertised)
                else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: Codex session catalog was not advertised for this route"))
                }
                guard Self.routeSnapshotAllowsClaudeCatalogInvoke(
                    command: req.command,
                    catalogAdvertised: attempt.claudeSessionCatalogAdvertised)
                else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: Claude session catalog was not advertised for this route"))
                }
                return await self.runtime.handleInvoke(req)
            },
            onInvokeInput: { [weak self] input in
                guard let self,
                      await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration)
                else { return }
                await self.nodeHostWorker?.handleInput(
                    invokeId: input.id,
                    seq: input.seq,
                    payloadJSON: input.payloadjson)
            },
            onInvokeCancel: { [weak self] invokeId in
                guard let self,
                      await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration)
                else { return }
                await self.nodeHostWorker?.cancel(invokeId: invokeId)
            },
            onRouteInvalidated: { [weak self] in
                await self?.invalidateRuntimeRoute(authorityGeneration: attempt.routeAuthorityGeneration)
            })
    }

    private func validatePostConnect(_ attempt: ConnectionAttempt) async throws -> Bool {
        let postConnectEndpoint = try await GatewayEndpointStore.shared.requireEndpoint()
        guard Self.endpointAttemptCanConnect(
            capturedGeneration: attempt.endpointGeneration,
            currentGeneration: self.endpointAttemptGeneration,
            isCancelled: Task.isCancelled,
            isPaused: AppStateStore.shared.isPaused,
            capturedEndpoint: attempt.endpoint,
            currentEndpoint: postConnectEndpoint)
        else {
            if Self.stalePostConnectRequiresDisconnect(
                capturedRouteAuthorityGeneration: attempt.routeAuthorityGeneration,
                currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
                completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
                isCancelled: Task.isCancelled,
                isPaused: AppStateStore.shared.isPaused,
                capturedEndpoint: attempt.endpoint,
                currentEndpoint: postConnectEndpoint)
            {
                await self.session.disconnect()
            }
            return false
        }
        return true
    }

    private func scheduleReconnectProbe() {
        self.reconnectProbeTask?.cancel()
        // GatewayChannel reconnects normally, but pauses after auth or pairing failures.
        // Probe only while disconnected so recovery does not restore steady idle polling.
        self.reconnectProbeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            self?.refresh()
        }
    }

    private func routeAuthorityAllowsInvoke(_ capturedGeneration: UInt64) -> Bool {
        Self.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: capturedGeneration,
            currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
            completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
            isPaused: AppStateStore.shared.isPaused)
    }

    #if DEBUG
    func waitForRouteInvalidationForTesting(
        onPendingSnapshot: (@Sendable () async -> Void)? = nil) async
    {
        await self.awaitStableRouteInvalidationDrain(onPendingSnapshot: onPendingSnapshot)
    }

    func refreshForTesting(
        isPaused: Bool,
        computerControlEnabled: Bool,
        computerControlProvider: ComputerControlProvider = .peekaboo)
    {
        self.refresh(
            isPaused: isPaused,
            computerControlEnabled: computerControlEnabled,
            computerControlProvider: computerControlProvider)
    }

    func enqueueRouteInvalidationForTesting() {
        self.enqueueRouteInvalidation(mode: .ordinaryDisconnect)
    }

    func generationsForTesting() -> (endpointAttempt: UInt64, routeAuthority: UInt64, completedRouteAuthority: UInt64) {
        (
            self.endpointAttemptGeneration,
            self.routeAuthorityGeneration,
            self.completedRouteAuthorityGeneration)
    }

    func routeAuthorityAllowsInvokeForTesting(_ capturedGeneration: UInt64, isPaused: Bool) -> Bool {
        Self.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: capturedGeneration,
            currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
            completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
            isPaused: isPaused)
    }

    func prepareNodeHostWorkerRetryForTesting(command: [String]) throws {
        guard self.nodeHostWorkerRetryTask == nil else {
            throw MacNodeHostWorkerRetryPolicy.RetryBackoffPending()
        }
        let input = MacNodeHostWorkerRetryPolicy.Input(
            launch: MacNodeHostWorkerLaunch(
                command: command,
                configurationGeneration: self.nodeHostWorkerConfigurationGeneration))
        try self.nodeHostWorkerRetryPolicy.prepareForStart(input)
        self.activeNodeHostWorkerInput = input
    }

    func handleNodeHostWorkerFailureForTesting(configurationGeneration: UInt64? = nil) {
        self.handleNodeHostWorkerFailure(
            configurationGeneration: configurationGeneration ?? self.nodeHostWorkerConfigurationGeneration)
    }

    func waitForNodeHostWorkerRetryForTesting() async {
        await self.nodeHostWorkerRetryTask?.value
    }

    func handleNodeHostConfigurationChangeForTesting() async {
        await self.handleNodeHostConfigurationChange().value
    }

    func resolveWorkerManifestForConnectionForTesting(
        provider: ComputerControlProvider = .peekaboo) async throws
        -> (manifest: MacNodeHostManifest?, unavailableReason: String?)
    {
        try await self.resolveWorkerManifestForConnection(provider: provider)
    }
    #endif

    private func cancelReconnectProbe() {
        self.reconnectProbeTask?.cancel()
        self.reconnectProbeTask = nil
    }

    @objc private nonisolated func refreshNodeConfiguration(_: Notification) {
        Task { @MainActor [weak self] in
            self?.refresh()
        }
    }

    @objc private nonisolated func nodeHostWorkerFailed(_ notification: Notification) {
        guard let generation = (notification.object as? NSNumber)?.uint64Value else { return }
        Task { @MainActor [weak self] in
            self?.handleNodeHostWorkerFailure(configurationGeneration: generation)
        }
    }

    @objc private nonisolated func nodeHostConfigurationChanged(_: Notification) {
        Task { @MainActor [weak self] in
            self?.handleNodeHostConfigurationChange()
        }
    }

    @discardableResult
    private func handleNodeHostConfigurationChange() -> Task<Void, Never> {
        // Worker code, plugin availability, and its manifest are startup-scoped.
        // Replace the process before reconnecting so updates cannot leave a stale route.
        self.enqueueRouteInvalidation(mode: .workerRestart)
    }
}

extension MacNodeModeCoordinator {
    private func currentCaps(
        browserControlEnabled: Bool,
        cameraEnabled: Bool,
        computerControlProvider: ComputerControlProvider,
        codexThreadCatalogEnabled: Bool,
        claudeSessionCatalogEnabled: Bool) -> [String]
    {
        let rawLocationMode = AppDefaults.standard.string(forKey: locationModeKey) ?? "off"
        let computerControlEnabled = isComputerControlEnabled()
        return Self.resolvedCaps(
            browserControlEnabled: browserControlEnabled,
            cameraEnabled: cameraEnabled,
            computerControlEnabled: computerControlEnabled,
            computerControlProvider: computerControlProvider,
            locationMode: OpenClawLocationMode(rawValue: rawLocationMode) ?? .off,
            connectionMode: AppStateStore.shared.connectionMode,
            codexThreadCatalogEnabled: codexThreadCatalogEnabled,
            claudeSessionCatalogEnabled: claudeSessionCatalogEnabled)
    }

    private func currentPermissions() async -> [String: Bool] {
        let statuses = await PermissionManager.authorizationStatus()
        return Self.advertisedPermissions(statuses)
    }

    private func currentCommands(
        caps: [String],
        computerControlProvider: ComputerControlProvider) -> [String]
    {
        Self.resolvedCommands(caps: caps, computerControlProvider: computerControlProvider)
    }

    /// The node-host worker is a capability superset, not a connect
    /// precondition. Backoff-pending is transient (its lifecycle-owned wake
    /// retries shortly); every other worker failure connects this Mac with
    /// native capabilities only and surfaces the reason to the operator.
    private func resolveWorkerManifestForConnection(
        provider: ComputerControlProvider) async throws
        -> (manifest: MacNodeHostManifest?, unavailableReason: String?)
    {
        do {
            let manifest = try await Self.workerManifest(
                self.startNodeHostWorkerIfConfigured(provider: provider),
                for: provider)
            return (manifest, nil)
        } catch let backoff as MacNodeHostWorkerRetryPolicy.RetryBackoffPending {
            throw backoff
        } catch {
            return (nil, self.recordNodeHostWorkerStartFailure(error))
        }
    }

    private func startNodeHostWorkerIfConfigured(
        provider: ComputerControlProvider) async throws -> MacNodeHostManifest?
    {
        guard let nodeHostWorker else { return nil }
        guard self.nodeHostWorkerRetryTask == nil else {
            throw MacNodeHostWorkerRetryPolicy.RetryBackoffPending()
        }
        if let activeInput = self.activeNodeHostWorkerInput {
            // Worker launch metadata is startup-scoped. Route retries reuse it instead of
            // repeating CLI and runtime discovery until an explicit restart resets state.
            try self.nodeHostWorkerRetryPolicy.prepareForStart(activeInput)
            return try await nodeHostWorker.start(launch: activeInput.launch)
        }
        let launch: MacNodeHostWorkerLaunch
        do {
            if let projectLaunch = try await CommandResolver.projectNodeHostWorkerLaunch() {
                launch = projectLaunch
            } else {
                switch await CLIInstaller.status() {
                case let .ready(location, _):
                    launch = MacNodeHostWorkerLaunch(command: CommandResolver.nodeHostWorkerCommand(
                        prefix: [location]))
                case let status:
                    throw MacNodeHostWorker.WorkerError.unavailable(status.message)
                }
            }
        } catch let error as RuntimeResolutionError {
            throw MacNodeHostWorker.WorkerError.unavailable(RuntimeLocator.describeFailure(error))
        }
        var workerEnvironment: [String: String] = [:]
        if provider == .cua, let endpoint = CuaDriverHostCoordinator.shared.workerEndpoint {
            workerEnvironment[CuaDriverWorkerEnvironment.endpoint] = try endpoint.environmentValue()
        }
        let effectiveLaunch = MacNodeHostWorkerLaunch(
            command: launch.command,
            currentDirectoryURL: launch.currentDirectoryURL,
            environment: workerEnvironment,
            configurationGeneration: self.nodeHostWorkerConfigurationGeneration)
        let input = MacNodeHostWorkerRetryPolicy.Input(launch: effectiveLaunch)
        try self.nodeHostWorkerRetryPolicy.prepareForStart(input)
        self.activeNodeHostWorkerInput = input
        return try await nodeHostWorker.start(launch: effectiveLaunch)
    }

    /// Retry exhaustion keeps the concrete worker error it exhausted on; the
    /// bare "stopped after N unexpected exits" text cannot guide the operator.
    private func recordNodeHostWorkerStartFailure(_ error: Error) -> String {
        if error is MacNodeHostWorkerRetryPolicy.RetryBudgetExhausted {
            let detail = self.lastNodeHostWorkerStartFailure.map { " — \($0)" } ?? ""
            return error.localizedDescription + detail
        }
        let reason = error.localizedDescription
        self.lastNodeHostWorkerStartFailure = reason
        return reason
    }

    private func handleNodeHostWorkerFailure(configurationGeneration: UInt64) {
        guard configurationGeneration == self.nodeHostWorkerConfigurationGeneration else { return }
        guard let input = self.activeNodeHostWorkerInput else {
            self.logger.error("node-host worker exited without an active startup input")
            self.enqueueRouteInvalidation(mode: .ordinaryDisconnect)
            return
        }

        self.cancelNodeHostWorkerRetryTask()
        let invalidation = self.enqueueRouteInvalidation(mode: .ordinaryDisconnect)
        switch self.nodeHostWorkerRetryPolicy.recordUnexpectedExit(for: input) {
        case let .retry(attempt, delayNanoseconds):
            self.nodeHostWorkerRetryTaskGeneration &+= 1
            let taskGeneration = self.nodeHostWorkerRetryTaskGeneration
            let delaySeconds = Double(delayNanoseconds) / 1_000_000_000
            self.logger.error(
                "node-host worker retry \(attempt, privacy: .public) in \(delaySeconds, privacy: .public)s")
            let retrySleep = self.nodeHostWorkerRetrySleep
            self.nodeHostWorkerRetryTask = Task { @MainActor [weak self] in
                await invalidation.value
                do {
                    try await retrySleep(delayNanoseconds)
                } catch {
                    return
                }
                guard let self,
                      self.nodeHostWorkerRetryTaskGeneration == taskGeneration,
                      self.activeNodeHostWorkerInput == input
                else { return }
                self.nodeHostWorkerRetryTask = nil
                self.refreshContinuation.yield()
            }
        case let .giveUp(unexpectedExitCount):
            self.logger.critical(
                "node-host worker gave up after \(unexpectedExitCount, privacy: .public) unexpected exits")
            self.notificationCenter.post(
                name: .openclawNodeHostWorkerRetryExhausted,
                object: self,
                userInfo: ["unexpectedExitCount": unexpectedExitCount])
            // The exhausted worker must not take the node channel with it. Wake
            // the connect loop after the disconnect drains so the next attempt
            // reconnects with native capabilities and a visible degraded reason.
            Task { @MainActor [weak self] in
                await invalidation.value
                self?.refreshContinuation.yield()
            }
        }
    }

    private func cancelNodeHostWorkerRetryTask() {
        self.nodeHostWorkerRetryTaskGeneration &+= 1
        self.nodeHostWorkerRetryTask?.cancel()
        self.nodeHostWorkerRetryTask = nil
    }

    private func resetNodeHostWorkerRetryState() {
        self.cancelNodeHostWorkerRetryTask()
        self.activeNodeHostWorkerInput = nil
        self.lastNodeHostWorkerStartFailure = nil
        self.nodeHostWorkerRetryPolicy.reset()
    }

    private func buildSessionBox(url: URL, tls: GatewayTLSRoute?) -> WebSocketSessionBox? {
        guard let tls else {
            self.tlsSessionCache.invalidate()
            return nil
        }
        return self.tlsSessionCache.sessionBox(url: url, params: tls.params)
    }
}

extension MacNodeModeCoordinator {
    static func endpointTransitionRequiresDisconnect(
        from previous: GatewayEndpointState,
        to next: GatewayEndpointState) -> Bool
    {
        self.effectiveEndpoint(from: previous) != self.effectiveEndpoint(from: next)
    }

    nonisolated static func endpointAttemptIsCurrent(
        capturedGeneration: UInt64,
        currentGeneration: UInt64) -> Bool
    {
        capturedGeneration == currentGeneration
    }

    nonisolated static func pausedStateRequiresDisconnect(_ isPaused: Bool) -> Bool {
        isPaused
    }

    nonisolated static func controlTransitionRequiresRouteInvalidation(
        previousPaused: Bool,
        nextPaused: Bool,
        previousComputerControlEnabled: Bool,
        nextComputerControlEnabled: Bool,
        previousComputerControlProvider: ComputerControlProvider = .peekaboo,
        nextComputerControlProvider: ComputerControlProvider = .peekaboo) -> Bool
    {
        (!previousPaused && nextPaused) ||
            (previousComputerControlEnabled && !nextComputerControlEnabled) ||
            previousComputerControlProvider != nextComputerControlProvider
    }

    nonisolated static func endpointState(
        _ state: GatewayEndpointState,
        matches endpoint: GatewayConnection.EndpointSnapshot) -> Bool
    {
        guard case let .ready(_, url, token, password, routeRevision) = state else { return false }
        return url == endpoint.config.url &&
            token == endpoint.config.token &&
            password == endpoint.config.password &&
            routeRevision == endpoint.revision
    }

    nonisolated static func endpointAttemptCanConnect(
        capturedGeneration: UInt64,
        currentGeneration: UInt64,
        isCancelled: Bool,
        isPaused: Bool,
        capturedEndpoint: GatewayConnection.EndpointSnapshot,
        currentEndpoint: GatewayConnection.EndpointSnapshot) -> Bool
    {
        capturedGeneration == currentGeneration &&
            !isCancelled &&
            !isPaused &&
            self.sameEndpoint(capturedEndpoint, currentEndpoint)
    }

    nonisolated static func routeAuthorityAllowsInvoke(
        capturedRouteAuthorityGeneration: UInt64,
        currentRouteAuthorityGeneration: UInt64,
        completedRouteAuthorityGeneration: UInt64,
        isPaused: Bool) -> Bool
    {
        capturedRouteAuthorityGeneration == currentRouteAuthorityGeneration &&
            currentRouteAuthorityGeneration == completedRouteAuthorityGeneration &&
            !isPaused
    }

    nonisolated static func routeSnapshotAllowsCodexCatalogInvoke(
        command: String,
        catalogAdvertised: Bool) -> Bool
    {
        !MacNodeCodexThreadCatalogContract.commands.contains(command) || catalogAdvertised
    }

    nonisolated static func routeSnapshotAllowsClaudeCatalogInvoke(
        command: String,
        catalogAdvertised: Bool) -> Bool
    {
        !MacNodeClaudeSessionCatalogContract.commands.contains(command) || catalogAdvertised
    }

    nonisolated static func stalePostConnectRequiresDisconnect(
        capturedRouteAuthorityGeneration: UInt64,
        currentRouteAuthorityGeneration: UInt64,
        completedRouteAuthorityGeneration: UInt64,
        isCancelled: Bool,
        isPaused: Bool,
        capturedEndpoint: GatewayConnection.EndpointSnapshot,
        currentEndpoint: GatewayConnection.EndpointSnapshot) -> Bool
    {
        capturedRouteAuthorityGeneration != currentRouteAuthorityGeneration ||
            currentRouteAuthorityGeneration != completedRouteAuthorityGeneration ||
            isCancelled ||
            isPaused ||
            !self.sameEndpoint(capturedEndpoint, currentEndpoint)
    }

    private nonisolated static func sameEndpoint(
        _ lhs: GatewayConnection.EndpointSnapshot,
        _ rhs: GatewayConnection.EndpointSnapshot) -> Bool
    {
        lhs.config.url == rhs.config.url &&
            lhs.config.token == rhs.config.token &&
            lhs.config.password == rhs.config.password &&
            GatewayTLSRoute.hasSameConnectionIdentity(lhs.tls, rhs.tls) &&
            lhs.routeAuthority == rhs.routeAuthority &&
            lhs.deviceAuthGatewayID == rhs.deviceAuthGatewayID &&
            lhs.revision == rhs.revision
    }

    private static func effectiveEndpoint(from state: GatewayEndpointState) -> EffectiveEndpoint? {
        guard case let .ready(mode, url, token, password, routeRevision) = state else { return nil }
        return EffectiveEndpoint(
            mode: mode,
            url: url,
            token: token,
            password: password,
            routeRevision: routeRevision)
    }

    nonisolated static func advertisedPermissions(
        _ statuses: [Capability: CapabilityAuthorizationStatus]) -> [String: Bool]
    {
        // Unknown TCC state is not denial. Omitting it keeps the node surface
        // narrow without turning a later confirmed grant into a false upgrade.
        Dictionary(uniqueKeysWithValues: statuses.compactMap { capability, status in
            guard status != .unknown else { return nil }
            return (capability.rawValue, status == .granted)
        })
    }

    nonisolated static func resolvedCaps(
        browserControlEnabled: Bool,
        cameraEnabled: Bool,
        computerControlEnabled: Bool,
        computerControlProvider: ComputerControlProvider = .peekaboo,
        locationMode: OpenClawLocationMode,
        connectionMode: AppState.ConnectionMode,
        codexThreadCatalogEnabled: Bool = false,
        claudeSessionCatalogEnabled: Bool = false) -> [String]
    {
        var caps: [String] = [
            OpenClawCapability.canvas.rawValue,
            OpenClawCapability.screen.rawValue,
        ]
        _ = browserControlEnabled
        if cameraEnabled { caps.append(OpenClawCapability.camera.rawValue) }
        // Advertised only when the operator has enabled Computer Control; the
        // command is dangerous and stays disarmed until allowlisted on the gateway.
        if computerControlEnabled, computerControlProvider == .peekaboo {
            caps.append(OpenClawCapability.computer.rawValue)
        }
        if locationMode != .off { caps.append(OpenClawCapability.location.rawValue) }
        // A local Gateway already catalogs this user's Codex home. Advertise the
        // node-owned catalog only when this Mac supplies it to a remote Gateway.
        if codexThreadCatalogEnabled, connectionMode == .remote {
            caps.append(MacNodeCodexThreadCatalogContract.capability)
        }
        if claudeSessionCatalogEnabled, connectionMode == .remote {
            caps.append(MacNodeClaudeSessionCatalogContract.capability)
        }
        return caps
    }

    nonisolated static func resolvedCommands(
        caps: [String],
        computerControlProvider: ComputerControlProvider = .peekaboo) -> [String]
    {
        var commands: [String] = [
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
        ]

        if computerControlProvider == .peekaboo {
            commands.append(MacNodeScreenCommand.snapshot.rawValue)
        }
        commands.append(MacNodeScreenCommand.record.rawValue)
        commands.append(OpenClawSystemCommand.notify.rawValue)

        let capsSet = Set(caps)
        if capsSet.contains(OpenClawCapability.camera.rawValue) {
            commands.append(OpenClawCameraCommand.list.rawValue)
            commands.append(OpenClawCameraCommand.snap.rawValue)
            commands.append(OpenClawCameraCommand.clip.rawValue)
            commands.append(OpenClawCameraCommand.ptzStatus.rawValue)
            commands.append(OpenClawCameraCommand.ptzControl.rawValue)
        }
        if capsSet.contains(OpenClawCapability.location.rawValue) {
            commands.append(OpenClawLocationCommand.get.rawValue)
        }
        if capsSet.contains(MacNodeCodexThreadCatalogContract.capability) {
            commands.append(contentsOf: MacNodeCodexThreadCatalogContract.commands)
        }
        if capsSet.contains(MacNodeClaudeSessionCatalogContract.capability) {
            commands.append(contentsOf: MacNodeClaudeSessionCatalogContract.commands)
        }
        if capsSet.contains(OpenClawCapability.computer.rawValue) {
            commands.append(OpenClawComputerCommand.act.rawValue)
        }

        return commands
    }

    nonisolated static func workerManifest(
        _ manifest: MacNodeHostManifest?,
        for provider: ComputerControlProvider) -> MacNodeHostManifest?
    {
        guard let manifest else { return nil }
        guard provider == .peekaboo else { return manifest }
        let providerCommands = Set([
            MacNodeScreenCommand.snapshot.rawValue,
            OpenClawComputerCommand.act.rawValue,
        ])
        return MacNodeHostManifest(
            version: manifest.version,
            caps: manifest.caps.filter { $0 != OpenClawCapability.computer.rawValue },
            commands: manifest.commands.filter { !providerCommands.contains($0) },
            computerUse: nil,
            pathEnv: manifest.pathEnv)
    }

    nonisolated static func computerUseDescriptor(
        provider: ComputerControlProvider,
        commands: [String],
        workerManifest: MacNodeHostManifest?) -> OpenClawProtocol.AnyCodable?
    {
        guard commands.contains(MacNodeScreenCommand.snapshot.rawValue),
              commands.contains(OpenClawComputerCommand.act.rawValue)
        else { return nil }
        return switch provider {
        case .peekaboo: ComputerControlProvider.peekabooComputerUseDescriptor
        case .cua: workerManifest?.computerUse
        }
    }

    nonisolated static func mergingUnique(_ primary: [String], _ additional: [String]) -> [String] {
        var seen = Set<String>()
        return (primary + additional).filter { seen.insert($0).inserted }
    }
}
