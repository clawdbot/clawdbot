import AppKit
import Foundation
import OpenClawKit
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

@MainActor
final class MacNodeModeCoordinator: NSObject {
    static let shared = MacNodeModeCoordinator()
    static var nodeIdentityProfile: GatewayDeviceIdentityProfile {
        self.resolveNodeIdentityProfile(
            defaults: .standard,
            isExistingInstallation: AppStateStore.shared.onboardingSeen)
    }

    static func prepareNodeIdentityProfile(isExistingInstallation: Bool) {
        _ = self.resolveNodeIdentityProfile(
            defaults: .standard,
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
    private let runtime: MacNodeRuntime
    private let session: GatewayNodeSession
    private let refreshEvents: AsyncStream<Void>
    private let refreshContinuation: AsyncStream<Void>.Continuation
    private var autoRepairedTLSFingerprintsByStoreKey: [String: String] = [:]
    private var tlsSessionCache = MacNodeGatewayTLSSessionCache()

    override private init() {
        let session = GatewayNodeSession()
        let refreshEvents = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        self.session = session
        self.runtime = MacNodeRuntime(
            canvasSurfaceUrl: { await session.currentCanvasHostUrl() },
            refreshCanvasSurfaceUrl: { await session.refreshCanvasHostUrl() })
        self.refreshEvents = refreshEvents.stream
        self.refreshContinuation = refreshEvents.continuation
        super.init()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.refreshNodeConfiguration),
            name: UserDefaults.didChangeNotification,
            object: UserDefaults.standard)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.refreshNodeConfiguration),
            name: NSApplication.didBecomeActiveNotification,
            object: nil)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.refreshNodeConfiguration),
            name: .openclawPermissionsChanged,
            object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
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
                if let previousState, state != previousState {
                    self?.refresh()
                }
                previousState = state
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
        self.endpointRefreshTask?.cancel()
        self.endpointRefreshTask = nil
        self.reconnectProbeTask?.cancel()
        self.reconnectProbeTask = nil
        Task {
            await self.runtime.releaseHeldComputerInput()
            await self.session.disconnect()
        }
    }

    func setPreferredGatewayStableID(_ stableID: String?) {
        GatewayDiscoveryPreferences.setPreferredStableID(stableID)
        Task {
            await self.session.disconnect()
            self.refresh()
        }
    }

    func refresh() {
        self.refreshContinuation.yield()
    }

    private func run() async {
        var retryDelay: UInt64 = 1_000_000_000
        var refreshIterator = self.refreshEvents.makeAsyncIterator()
        let defaults = UserDefaults.standard

        while !Task.isCancelled {
            if await MainActor.run(body: { AppStateStore.shared.isPaused }) {
                guard await refreshIterator.next() != nil else { return }
                continue
            }

            let cameraEnabled = defaults.object(forKey: cameraEnabledKey) as? Bool ?? false
            let browserControlEnabled = OpenClawConfigFile.browserControlEnabled()
            let codexThreadCatalogEnabled = OpenClawConfigFile.explicitlyEnabledPlugin(
                MacNodeCodexThreadCatalogContract.pluginId)

            var attemptedURL: URL?
            do {
                let config = try await GatewayEndpointStore.shared.requireConfig()
                attemptedURL = config.url
                let caps = self.currentCaps(
                    browserControlEnabled: browserControlEnabled,
                    cameraEnabled: cameraEnabled,
                    codexThreadCatalogEnabled: codexThreadCatalogEnabled)
                // If Computer Control was turned off, release any button the
                // computer.act service is still holding rather than waiting for
                // the idle watchdog. This refresh loop re-runs on the settings
                // change that drops the cap.
                if !caps.contains(OpenClawCapability.computer.rawValue) {
                    await self.runtime.releaseHeldComputerInput()
                }
                let commands = self.currentCommands(caps: caps)
                let permissions = await self.currentPermissions()
                let connectOptions = GatewayConnectOptions(
                    role: "node",
                    scopes: [],
                    caps: caps,
                    commands: commands,
                    permissions: permissions,
                    clientId: "openclaw-macos",
                    clientMode: "node",
                    clientDisplayName: InstanceIdentity.displayName,
                    deviceIdentityProfile: Self.nodeIdentityProfile)
                let sessionBox = self.buildSessionBox(
                    url: config.url,
                    connectionMode: AppStateStore.shared.connectionMode)

                try await self.session.connect(
                    url: config.url,
                    token: config.token,
                    bootstrapToken: nil,
                    password: config.password,
                    connectOptions: connectOptions,
                    sessionBox: sessionBox,
                    onConnected: { [weak self] in
                        guard let self else { return }
                        await self.cancelReconnectProbe()
                        self.logger.info("mac node connected to gateway")
                        let mainSessionKey = await GatewayConnection.shared.mainSessionKey()
                        await self.runtime.updateMainSessionKey(mainSessionKey)
                        await self.runtime.setEventSender { [weak self] event, payload in
                            guard let self else { return }
                            await self.session.sendEvent(event: event, payloadJSON: payload)
                        }
                    },
                    onDisconnected: { [weak self] reason in
                        guard let self else { return }
                        await self.runtime.setEventSender(nil)
                        await self.runtime.releaseHeldComputerInput()
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
                        return await self.runtime.handleInvoke(req)
                    })

                retryDelay = 1_000_000_000
                // GatewayNodeSession owns transport reconnects. Wait until inputs can
                // actually change instead of rereading config and TCC state every second.
                guard await refreshIterator.next() != nil else { return }
            } catch {
                if await self.autoRepairStaleTLSPinIfNeeded(error: error, url: attemptedURL) {
                    retryDelay = 1_000_000_000
                    continue
                }
                self.logger.error("mac node gateway connect failed: \(error.localizedDescription, privacy: .public)")
                try? await Task.sleep(nanoseconds: min(retryDelay, 10_000_000_000))
                retryDelay = min(retryDelay * 2, 10_000_000_000)
            }
        }
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

    private func cancelReconnectProbe() {
        self.reconnectProbeTask?.cancel()
        self.reconnectProbeTask = nil
    }

    @objc private nonisolated func refreshNodeConfiguration(_: Notification) {
        Task { @MainActor [weak self] in
            self?.refresh()
        }
    }

    nonisolated static func resolvedCaps(
        browserControlEnabled: Bool,
        cameraEnabled: Bool,
        computerControlEnabled: Bool,
        locationMode: OpenClawLocationMode,
        connectionMode: AppState.ConnectionMode,
        codexThreadCatalogEnabled: Bool = false) -> [String]
    {
        var caps: [String] = [
            OpenClawCapability.canvas.rawValue,
            OpenClawCapability.screen.rawValue,
        ]
        if browserControlEnabled, connectionMode == .local {
            caps.append(OpenClawCapability.browser.rawValue)
        }
        if cameraEnabled {
            caps.append(OpenClawCapability.camera.rawValue)
        }
        // Advertised only when the operator has enabled Computer Control; the
        // command is dangerous and stays disarmed until allowlisted on the gateway.
        if computerControlEnabled {
            caps.append(OpenClawCapability.computer.rawValue)
        }
        if locationMode != .off {
            caps.append(OpenClawCapability.location.rawValue)
        }
        if codexThreadCatalogEnabled {
            caps.append(MacNodeCodexThreadCatalogContract.capability)
        }
        return caps
    }

    private func currentCaps(
        browserControlEnabled: Bool,
        cameraEnabled: Bool,
        codexThreadCatalogEnabled: Bool) -> [String]
    {
        let rawLocationMode = UserDefaults.standard.string(forKey: locationModeKey) ?? "off"
        let computerControlEnabled =
            UserDefaults.standard.object(forKey: computerControlEnabledKey) as? Bool ?? false
        return Self.resolvedCaps(
            browserControlEnabled: browserControlEnabled,
            cameraEnabled: cameraEnabled,
            computerControlEnabled: computerControlEnabled,
            locationMode: OpenClawLocationMode(rawValue: rawLocationMode) ?? .off,
            connectionMode: AppStateStore.shared.connectionMode,
            codexThreadCatalogEnabled: codexThreadCatalogEnabled)
    }

    private func currentPermissions() async -> [String: Bool] {
        let statuses = await PermissionManager.status()
        return Dictionary(uniqueKeysWithValues: statuses.map { ($0.key.rawValue, $0.value) })
    }

    nonisolated static func resolvedCommands(caps: [String]) -> [String] {
        var commands: [String] = [
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
            OpenClawCanvasCommand.evalJS.rawValue,
            OpenClawCanvasCommand.snapshot.rawValue,
            OpenClawCanvasA2UICommand.push.rawValue,
            OpenClawCanvasA2UICommand.pushJSONL.rawValue,
            OpenClawCanvasA2UICommand.reset.rawValue,
            MacNodeScreenCommand.snapshot.rawValue,
            MacNodeScreenCommand.record.rawValue,
            OpenClawSystemCommand.notify.rawValue,
            OpenClawSystemCommand.which.rawValue,
            OpenClawSystemCommand.run.rawValue,
            OpenClawSystemCommand.execApprovalsGet.rawValue,
            OpenClawSystemCommand.execApprovalsSet.rawValue,
        ]

        let capsSet = Set(caps)
        if capsSet.contains(OpenClawCapability.browser.rawValue) {
            commands.append(OpenClawBrowserCommand.proxy.rawValue)
        }
        if capsSet.contains(OpenClawCapability.camera.rawValue) {
            commands.append(OpenClawCameraCommand.list.rawValue)
            commands.append(OpenClawCameraCommand.snap.rawValue)
            commands.append(OpenClawCameraCommand.clip.rawValue)
        }
        if capsSet.contains(OpenClawCapability.location.rawValue) {
            commands.append(OpenClawLocationCommand.get.rawValue)
        }
        if capsSet.contains(MacNodeCodexThreadCatalogContract.capability) {
            commands.append(MacNodeCodexThreadCatalogContract.listCommand)
        }
        if capsSet.contains(OpenClawCapability.computer.rawValue) {
            commands.append(OpenClawComputerCommand.act.rawValue)
        }

        return commands
    }

    private func currentCommands(caps: [String]) -> [String] {
        Self.resolvedCommands(caps: caps)
    }

    nonisolated static func tlsPinStoreKey(for url: URL) -> String {
        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "gateway"
        let port = url.port ?? 443
        return "\(host):\(port)"
    }

    nonisolated static func shouldAutoRepairStaleTLSPin(url: URL, failure: GatewayTLSValidationFailure) -> Bool {
        guard failure.kind == .pinMismatch else { return false }
        guard url.scheme?.lowercased() == "wss" else { return false }
        guard failure.storeKey == nil || failure.storeKey == self.tlsPinStoreKey(for: url) else { return false }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !host.isEmpty
        else { return false }

        if LoopbackHost.isLoopback(host) {
            return failure.systemTrustOk
        }

        // Tailscale Serve uses publicly trusted, rotating certificates for *.ts.net names.
        // A stale legacy leaf pin should not leave the companion app half-connected forever.
        if host == "ts.net" || host.hasSuffix(".ts.net") {
            return failure.systemTrustOk
        }

        return false
    }

    private func autoRepairStaleTLSPinIfNeeded(error: Error, url: URL?) async -> Bool {
        guard let tlsError = error as? GatewayTLSValidationError, let url else { return false }
        guard Self.shouldAutoRepairStaleTLSPin(url: url, failure: tlsError.failure) else { return false }
        let storeKey = tlsError.failure.storeKey ?? Self.tlsPinStoreKey(for: url)
        guard let observedFingerprint = tlsError.failure.observedFingerprint else { return false }
        guard self.autoRepairedTLSFingerprintsByStoreKey[storeKey] != observedFingerprint else { return false }

        guard GatewayTLSStore.replaceFingerprint(observedFingerprint, stableID: storeKey) else { return false }
        self.autoRepairedTLSFingerprintsByStoreKey[storeKey] = observedFingerprint
        self.logger.info("replaced stale gateway TLS pin storeKey=\(storeKey, privacy: .public)")
        await self.session.disconnect()
        return true
    }

    nonisolated static func tlsParams(
        for url: URL,
        connectionMode: AppState.ConnectionMode,
        root: [String: Any],
        storedFingerprint: String?) -> GatewayTLSParams?
    {
        guard url.scheme?.lowercased() == "wss" else { return nil }
        let stableID = Self.tlsPinStoreKey(for: url)
        let configuredFingerprint = connectionMode == .remote
            ? GatewayRemoteConfig.resolveTLSFingerprint(root: root)
            : nil
        let expectedFingerprint = configuredFingerprint ?? storedFingerprint
        return GatewayTLSParams(
            required: true,
            expectedFingerprint: expectedFingerprint,
            allowTOFU: expectedFingerprint == nil,
            storeKey: stableID)
    }

    private func buildSessionBox(url: URL, connectionMode: AppState.ConnectionMode) -> WebSocketSessionBox? {
        guard url.scheme?.lowercased() == "wss" else {
            self.tlsSessionCache.invalidate()
            return nil
        }
        let stableID = Self.tlsPinStoreKey(for: url)
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        guard let params = Self.tlsParams(
            for: url,
            connectionMode: connectionMode,
            root: OpenClawConfigFile.loadDict(),
            storedFingerprint: stored)
        else {
            self.tlsSessionCache.invalidate()
            return nil
        }
        return self.tlsSessionCache.sessionBox(url: url, params: params)
    }
}
