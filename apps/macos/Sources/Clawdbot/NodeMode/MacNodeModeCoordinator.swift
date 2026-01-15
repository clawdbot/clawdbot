import ClawdbotDiscovery
import ClawdbotKit
import Foundation
import Network
import OSLog

@MainActor
final class MacNodeModeCoordinator {
    static let shared = MacNodeModeCoordinator()

    private let logger = Logger(subsystem: "com.clawdbot", category: "mac-node")
    private var task: Task<Void, Never>?
    private let runtime = MacNodeRuntime()
    private let session = MacNodeBridgeSession()
    private var tunnel: RemotePortTunnel?

    func start() {
        guard self.task == nil else { return }
        self.task = Task { [weak self] in
            await self?.run()
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
        Task { await self.session.disconnect() }
        self.tunnel?.terminate()
        self.tunnel = nil
    }

    func setPreferredBridgeStableID(_ stableID: String?) {
        BridgeDiscoveryPreferences.setPreferredStableID(stableID)
        Task { await self.session.disconnect() }
    }

    private func run() async {
        var retryDelay: UInt64 = 1_000_000_000
        var lastCameraEnabled: Bool?
        let defaults = UserDefaults.standard
        while !Task.isCancelled {
            if await MainActor.run(body: { AppStateStore.shared.isPaused }) {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                continue
            }

            let cameraEnabled = defaults.object(forKey: cameraEnabledKey) as? Bool ?? false
            if lastCameraEnabled == nil {
                lastCameraEnabled = cameraEnabled
            } else if lastCameraEnabled != cameraEnabled {
                lastCameraEnabled = cameraEnabled
                await self.session.disconnect()
                try? await Task.sleep(nanoseconds: 200_000_000)
            }

            guard let endpoint = await self.resolveBridgeEndpoint(timeoutSeconds: 5) else {
                try? await Task.sleep(nanoseconds: min(retryDelay, 5_000_000_000))
                retryDelay = min(retryDelay * 2, 10_000_000_000)
                continue
            }

            retryDelay = 1_000_000_000
            do {
                let hello = await self.makeHello()
                self.logger.info(
                    "mac node bridge connecting endpoint=\(endpoint, privacy: .public)")
                try await self.session.connect(
                    endpoint: endpoint,
                    hello: hello,
                    onConnected: { [weak self] serverName, mainSessionKey in
                        self?.logger.info("mac node connected to \(serverName, privacy: .public)")
                        if let mainSessionKey {
                            await self?.runtime.updateMainSessionKey(mainSessionKey)
                        }
                    },
                    onDisconnected: { reason in
                        await MacNodeModeCoordinator.handleBridgeDisconnect(reason: reason)
                    },
                    onInvoke: { [weak self] req in
                        guard let self else {
                            return BridgeInvokeResponse(
                                id: req.id,
                                ok: false,
                                error: ClawdbotNodeError(code: .unavailable, message: "UNAVAILABLE: node not ready"))
                        }
                        return await self.runtime.handleInvoke(req)
                    })
            } catch {
                if await self.tryPair(endpoint: endpoint, error: error) {
                    continue
                }
                self.logger.error(
                    "mac node bridge connect failed: \(error.localizedDescription, privacy: .public)")
                try? await Task.sleep(nanoseconds: min(retryDelay, 5_000_000_000))
                retryDelay = min(retryDelay * 2, 10_000_000_000)
            }
        }
    }

    private func makeHello() async -> BridgeHello {
        let token = MacNodeTokenStore.loadToken()
        let caps = self.currentCaps()
        let commands = self.currentCommands(caps: caps)
        let permissions = await self.currentPermissions()
        return BridgeHello(
            nodeId: Self.nodeId(),
            displayName: InstanceIdentity.displayName,
            token: token,
            platform: "macos",
            version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            deviceFamily: "Mac",
            modelIdentifier: InstanceIdentity.modelIdentifier,
            caps: caps,
            commands: commands,
            permissions: permissions)
    }

    private func currentCaps() -> [String] {
        var caps: [String] = [ClawdbotCapability.canvas.rawValue, ClawdbotCapability.screen.rawValue]
        if UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false {
            caps.append(ClawdbotCapability.camera.rawValue)
        }
        let rawLocationMode = UserDefaults.standard.string(forKey: locationModeKey) ?? "off"
        if ClawdbotLocationMode(rawValue: rawLocationMode) != .off {
            caps.append(ClawdbotCapability.location.rawValue)
        }
        return caps
    }

    private func currentPermissions() async -> [String: Bool] {
        let statuses = await PermissionManager.status()
        return Dictionary(uniqueKeysWithValues: statuses.map { ($0.key.rawValue, $0.value) })
    }

    private func currentCommands(caps: [String]) -> [String] {
        var commands: [String] = [
            ClawdbotCanvasCommand.present.rawValue,
            ClawdbotCanvasCommand.hide.rawValue,
            ClawdbotCanvasCommand.navigate.rawValue,
            ClawdbotCanvasCommand.evalJS.rawValue,
            ClawdbotCanvasCommand.snapshot.rawValue,
            ClawdbotCanvasA2UICommand.push.rawValue,
            ClawdbotCanvasA2UICommand.pushJSONL.rawValue,
            ClawdbotCanvasA2UICommand.reset.rawValue,
            MacNodeScreenCommand.record.rawValue,
            ClawdbotSystemCommand.run.rawValue,
            ClawdbotSystemCommand.notify.rawValue,
        ]

        let capsSet = Set(caps)
        if capsSet.contains(ClawdbotCapability.camera.rawValue) {
            commands.append(ClawdbotCameraCommand.list.rawValue)
            commands.append(ClawdbotCameraCommand.snap.rawValue)
            commands.append(ClawdbotCameraCommand.clip.rawValue)
        }
        if capsSet.contains(ClawdbotCapability.location.rawValue) {
            commands.append(ClawdbotLocationCommand.get.rawValue)
        }

        return commands
    }

    private func tryPair(endpoint: NWEndpoint, error: Error) async -> Bool {
        let text = error.localizedDescription.uppercased()
        guard text.contains("NOT_PAIRED") || text.contains("UNAUTHORIZED") else { return false }

        do {
            let shouldSilent = await MainActor.run {
                AppStateStore.shared.connectionMode == .remote
            }
            let hello = await self.makeHello()
            let token = try await MacNodeBridgePairingClient().pairAndHello(
                endpoint: endpoint,
                hello: hello,
                silent: shouldSilent,
                onStatus: { [weak self] status in
                    self?.logger.info("mac node pairing: \(status, privacy: .public)")
                })
            if !token.isEmpty {
                MacNodeTokenStore.saveToken(token)
            }
            return true
        } catch {
            self.logger.error("mac node pairing failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private static func nodeId() -> String {
        "mac-\(InstanceIdentity.instanceId)"
    }

    private func resolveLoopbackBridgeEndpoint(timeoutSeconds: Double) async -> NWEndpoint? {
        guard let port = Self.loopbackBridgePort(),
              let endpointPort = NWEndpoint.Port(rawValue: port)
        else {
            return nil
        }
        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: endpointPort)
        let reachable = await Self.probeEndpoint(endpoint, timeoutSeconds: timeoutSeconds)
        return reachable ? endpoint : nil
    }

    static func loopbackBridgePort() -> UInt16? {
        if let raw = ProcessInfo.processInfo.environment["CLAWDBOT_BRIDGE_PORT"],
           let parsed = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           parsed > 0,
           parsed <= Int(UInt16.max)
        {
            return UInt16(parsed)
        }
        return 18790
    }

    static func remoteBridgePort() -> Int {
        let fallback = Int(Self.loopbackBridgePort() ?? 18790)
        let settings = CommandResolver.connectionSettings()
        let sshHost = CommandResolver.parseSSHTarget(settings.target)?.host ?? ""
        let base =
            ClawdbotConfigFile.remoteGatewayPort(matchingHost: sshHost) ??
            GatewayEnvironment.gatewayPort()
        guard base > 0 else { return fallback }
        return Self.derivePort(base: base, offset: 1, fallback: fallback)
    }

    private static func derivePort(base: Int, offset: Int, fallback: Int) -> Int {
        let derived = base + offset
        guard derived > 0, derived <= Int(UInt16.max) else { return fallback }
        return derived
    }

    static func probeEndpoint(_ endpoint: NWEndpoint, timeoutSeconds: Double) async -> Bool {
        let connection = NWConnection(to: endpoint, using: .tcp)
        let stream = Self.makeStateStream(for: connection)
        connection.start(queue: DispatchQueue(label: "com.clawdbot.macos.bridge-loopback-probe"))
        do {
            try await Self.waitForReady(stream, timeoutSeconds: timeoutSeconds)
            connection.cancel()
            return true
        } catch {
            connection.cancel()
            return false
        }
    }

    private static func makeStateStream(
        for connection: NWConnection) -> AsyncStream<NWConnection.State>
    {
        AsyncStream { continuation in
            connection.stateUpdateHandler = { state in
                continuation.yield(state)
                switch state {
                case .ready, .failed, .cancelled:
                    continuation.finish()
                default:
                    break
                }
            }
        }
    }

    private static func waitForReady(
        _ stream: AsyncStream<NWConnection.State>,
        timeoutSeconds: Double) async throws
    {
        try await AsyncTimeout.withTimeout(
            seconds: timeoutSeconds,
            onTimeout: {
                NSError(domain: "Bridge", code: 22, userInfo: [
                    NSLocalizedDescriptionKey: "operation timed out",
                ])
            },
            operation: {
                for await state in stream {
                    switch state {
                    case .ready:
                        return
                    case let .failed(err):
                        throw err
                    case .cancelled:
                        throw NSError(domain: "Bridge", code: 20, userInfo: [
                            NSLocalizedDescriptionKey: "Connection cancelled",
                        ])
                    default:
                        continue
                    }
                }
                throw NSError(domain: "Bridge", code: 21, userInfo: [
                    NSLocalizedDescriptionKey: "Connection closed",
                ])
            })
    }

    private func resolveBridgeEndpoint(timeoutSeconds: Double) async -> NWEndpoint? {
        let mode = await MainActor.run(body: { AppStateStore.shared.connectionMode })
        if mode == .remote {
            do {
                if let tunnel = self.tunnel,
                   tunnel.process.isRunning,
                   let localPort = tunnel.localPort
                {
                    let healthy = await self.bridgeTunnelHealthy(localPort: localPort, timeoutSeconds: 1.0)
                    if healthy, let port = NWEndpoint.Port(rawValue: localPort) {
                        self.logger.info(
                            "reusing mac node bridge tunnel localPort=\(localPort, privacy: .public)")
                        return .hostPort(host: "127.0.0.1", port: port)
                    }
                    self.logger.error(
                        "mac node bridge tunnel unhealthy localPort=\(localPort, privacy: .public); restarting")
                    tunnel.terminate()
                    self.tunnel = nil
                }

                let remotePort = Self.remoteBridgePort()
                self.tunnel = try await RemotePortTunnel.create(
                    remotePort: remotePort,
                    allowRemoteUrlOverride: false)
                if let localPort = self.tunnel?.localPort,
                   let port = NWEndpoint.Port(rawValue: localPort)
                {
                    self.logger.info(
                        "mac node bridge tunnel ready " +
                            "localPort=\(localPort, privacy: .public) " +
                            "remotePort=\(remotePort, privacy: .public)")
                    return .hostPort(host: "127.0.0.1", port: port)
                }
            } catch {
                self.logger.error("mac node bridge tunnel failed: \(error.localizedDescription, privacy: .public)")
                self.tunnel?.terminate()
                self.tunnel = nil
            }
        } else if let tunnel = self.tunnel {
            tunnel.terminate()
            self.tunnel = nil
        }
        if mode == .local, let endpoint = await self.resolveLoopbackBridgeEndpoint(timeoutSeconds: 0.4) {
            return endpoint
        }
        return await Self.discoverBridgeEndpoint(timeoutSeconds: timeoutSeconds)
    }

    @MainActor
    private static func handleBridgeDisconnect(reason: String) async {
        guard reason.localizedCaseInsensitiveContains("ping") else { return }
        let coordinator = MacNodeModeCoordinator.shared
        coordinator.logger.error(
            "mac node bridge disconnected (\(reason, privacy: .public)); resetting tunnel")
        coordinator.tunnel?.terminate()
        coordinator.tunnel = nil
    }

    private func bridgeTunnelHealthy(localPort: UInt16, timeoutSeconds: Double) async -> Bool {
        guard let port = NWEndpoint.Port(rawValue: localPort) else { return false }
        return await Self.probeEndpoint(.hostPort(host: "127.0.0.1", port: port), timeoutSeconds: timeoutSeconds)
    }

    private static func discoverBridgeEndpoint(timeoutSeconds: Double) async -> NWEndpoint? {
        final class DiscoveryState: @unchecked Sendable {
            let lock = NSLock()
            var resolved = false
            var browsers: [NWBrowser] = []
            var continuation: CheckedContinuation<NWEndpoint?, Never>?

            func finish(_ endpoint: NWEndpoint?) {
                self.lock.lock()
                defer { lock.unlock() }
                if self.resolved { return }
                self.resolved = true
                for browser in self.browsers {
                    browser.cancel()
                }
                self.continuation?.resume(returning: endpoint)
                self.continuation = nil
            }
        }

        return await withCheckedContinuation { cont in
            let state = DiscoveryState()
            state.continuation = cont

            let params = NWParameters.tcp
            params.includePeerToPeer = true

            for domain in ClawdbotBonjour.bridgeServiceDomains {
                let browser = NWBrowser(
                    for: .bonjour(type: ClawdbotBonjour.bridgeServiceType, domain: domain),
                    using: params)
                browser.browseResultsChangedHandler = { results, _ in
                    let preferred = BridgeDiscoveryPreferences.preferredStableID()
                    if let preferred,
                       let match = results.first(where: {
                        if case .service = $0.endpoint {
                            return BridgeEndpointID.stableID($0.endpoint) == preferred
                        }
                        return false
                       })
                    {
                        state.finish(match.endpoint)
                        return
                    }

                    if let result = results.first(where: { if case .service = $0.endpoint { true } else { false } }) {
                        state.finish(result.endpoint)
                    }
                }
                browser.stateUpdateHandler = { browserState in
                    if case .failed = browserState {
                        state.finish(nil)
                    }
                }
                state.browsers.append(browser)
                browser.start(queue: DispatchQueue(label: "com.clawdbot.macos.bridge-discovery.\(domain)"))
            }

            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                state.finish(nil)
            }
        }
    }
}

enum MacNodeTokenStore {
    private static let suiteName = "com.clawdbot.shared"
    private static let tokenKey = "mac.node.bridge.token"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    static func loadToken() -> String? {
        let raw = self.defaults.string(forKey: self.tokenKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw?.isEmpty == false ? raw : nil
    }

    static func saveToken(_ token: String) {
        self.defaults.set(token, forKey: self.tokenKey)
    }
}
