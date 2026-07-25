import ConcurrencyExtras
import Foundation
import OSLog

enum GatewayEndpointState: Equatable {
    case ready(
        mode: AppState.ConnectionMode,
        url: URL,
        token: String?,
        password: String?,
        routeRevision: UInt64 = 0)
    case connecting(mode: AppState.ConnectionMode, detail: String)
    case unavailable(mode: AppState.ConnectionMode, reason: String)
}

/// Single place to resolve (and publish) the effective gateway control endpoint.
///
/// This is intentionally separate from `GatewayConnection`:
/// - `GatewayConnection` consumes the resolved endpoint (no tunnel side-effects).
/// - The endpoint store owns observation + explicit "ensure tunnel" actions.
actor GatewayEndpointStore {
    static let shared = GatewayEndpointStore()
    private static let supportedBindModes: Set<String> = [
        "loopback",
        "tailnet",
        "lan",
        "auto",
        "custom",
    ]
    private static let remoteConnectingDetail = "Connecting to remote gateway…"
    private static let staticLogger = Logger(subsystem: "ai.openclaw", category: "gateway-endpoint")
    private enum EnvOverrideWarningKind {
        case token
        case password
    }

    private static let envOverrideWarnings = LockIsolated((token: false, password: false))

    enum SourceMode: String, Sendable {
        case unconfigured
        case local
        case remote

        init(_ mode: AppState.ConnectionMode) {
            self = SourceMode(rawValue: mode.rawValue) ?? .unconfigured
        }
    }

    enum SourceTransport: String, Sendable {
        case ssh
        case direct

        init(_ transport: AppState.RemoteTransport) {
            self = transport == .direct ? .direct : .ssh
        }
    }

    struct SSHRouteIdentity: Equatable, Sendable {
        let target: String
        let identity: String
        let hostKeyPolicy: String
        let configuredRemotePort: Int?
        let configuredRemoteURL: String?
    }

    struct SourceSnapshot: Equatable, Sendable {
        /// MainActor selection generation captured before reading canonical config.
        let routingGeneration: UInt64?
        let mode: SourceMode
        let token: String?
        let password: String?
        /// Non-secret route owner for device-scoped credentials.
        let deviceAuthGatewayID: String?
        let localPort: Int
        let localHost: String
        let scheme: String
        let bindMode: String?
        let remoteTransport: SourceTransport
        let directRemoteURL: URL?
        let remoteTLSFingerprint: String?
        /// Invalidates a suspended SSH lookup when its desired route changes.
        let sshRouteIdentity: SSHRouteIdentity?
    }

    struct Deps {
        let token: @Sendable () -> String?
        let password: @Sendable () -> String?
        let localPort: @Sendable () -> Int
        let remoteRouteIfRunning: @Sendable () async -> RemoteTunnelManager.Route?
        let remoteRouteIsCurrent: @Sendable (RemoteTunnelManager.Route) async -> Bool
        let canStartRemoteTunnel: @Sendable () -> Bool
        let ensureRemoteTunnel: @Sendable () async throws -> RemoteTunnelManager.Route
        let routingGenerationIsCurrent: @Sendable (UInt64) async -> Bool
        let sourceSnapshot: @Sendable () async -> SourceSnapshot

        static let live = Deps(
            token: {
                let root = OpenClawConfigFile.loadDict()
                let isRemote = ConnectionModeResolver.resolve(root: root).mode == .remote
                return GatewayEndpointStore.resolveGatewayToken(
                    isRemote: isRemote,
                    root: root,
                    env: ProcessInfo.processInfo.environment,
                    launchdSnapshot: GatewayLaunchAgentManager.launchdConfigSnapshot())
            },
            password: {
                let root = OpenClawConfigFile.loadDict()
                let isRemote = ConnectionModeResolver.resolve(root: root).mode == .remote
                return GatewayEndpointStore.resolveGatewayPassword(
                    isRemote: isRemote,
                    root: root,
                    env: ProcessInfo.processInfo.environment,
                    launchdSnapshot: GatewayLaunchAgentManager.launchdConfigSnapshot())
            },
            localPort: { GatewayEnvironment.gatewayPort() },
            remoteRouteIfRunning: { await RemoteTunnelManager.shared.controlTunnelRouteIfRunning() },
            remoteRouteIsCurrent: { await RemoteTunnelManager.shared.isCurrentRoute($0) },
            canStartRemoteTunnel: { GatewayEndpointStore.primaryAppLaunchAdmitted.withValue { $0 } },
            ensureRemoteTunnel: { try await RemoteTunnelManager.shared.ensureControlTunnelRoute() },
            routingGenerationIsCurrent: { generation in
                await MainActor.run {
                    AppStateStore.shared.gatewayRoutingGeneration == generation
                }
            },
            sourceSnapshot: { await GatewayEndpointStore.liveSourceSnapshot() })
    }

    private static let primaryAppLaunchAdmitted = LockIsolated(false)

    static func admitPrimaryAppLaunch() {
        self.primaryAppLaunchAdmitted.withValue { $0 = true }
    }

    private static func resolveGatewayPassword(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot?) -> String?
    {
        let serviceEnv = launchdSnapshot?.environment ?? [:]
        let raw = env["OPENCLAW_GATEWAY_PASSWORD"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let configPassword = resolveConfigPassword(
                isRemote: isRemote,
                root: root,
                env: env,
                serviceEnv: serviceEnv),
                !configPassword.isEmpty
            {
                self.warnEnvOverrideOnce(
                    kind: .password,
                    envVar: "OPENCLAW_GATEWAY_PASSWORD",
                    configKey: isRemote ? "gateway.remote.password" : "gateway.auth.password")
            }
            return trimmed
        }
        if isRemote {
            if let gateway = root["gateway"] as? [String: Any],
               let remote = gateway["remote"] as? [String: Any],
               let password = remote["password"] as? String
            {
                let pw = password.trimmingCharacters(in: .whitespacesAndNewlines)
                if !pw.isEmpty {
                    return pw
                }
            }
            return nil
        }
        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           let password = auth["password"] as? String
        {
            if let pw = resolveLocalConfigAuthString(
                password,
                env: env,
                serviceEnv: serviceEnv)
            {
                return pw
            }
        }
        if let password = launchdSnapshot?.password?.trimmingCharacters(in: .whitespacesAndNewlines),
           !password.isEmpty
        {
            return password
        }
        return nil
    }

    private static func resolveConfigPassword(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String] = [:],
        serviceEnv: [String: String] = [:]) -> String?
    {
        if isRemote {
            if let gateway = root["gateway"] as? [String: Any],
               let remote = gateway["remote"] as? [String: Any],
               let password = remote["password"] as? String
            {
                return password.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return nil
        }

        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           let password = auth["password"] as? String
        {
            return self.resolveLocalConfigAuthString(password, env: env, serviceEnv: serviceEnv)
        }
        return nil
    }

    private static func resolveGatewayToken(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot?) -> String?
    {
        let serviceEnv = launchdSnapshot?.environment ?? [:]
        let raw = env["OPENCLAW_GATEWAY_TOKEN"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let configToken = resolveConfigToken(
                isRemote: isRemote,
                root: root,
                env: env,
                serviceEnv: serviceEnv),
                !configToken.isEmpty,
                configToken != trimmed
            {
                self.warnEnvOverrideOnce(
                    kind: .token,
                    envVar: "OPENCLAW_GATEWAY_TOKEN",
                    configKey: isRemote ? "gateway.remote.token" : "gateway.auth.token")
            }
            return trimmed
        }

        if let configToken = resolveConfigToken(
            isRemote: isRemote,
            root: root,
            env: env,
            serviceEnv: serviceEnv),
            !configToken.isEmpty
        {
            return configToken
        }

        if isRemote {
            return nil
        }

        if let token = launchdSnapshot?.token?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty
        {
            return token
        }

        return nil
    }

    private static func resolveConfigToken(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String] = [:],
        serviceEnv: [String: String] = [:]) -> String?
    {
        if isRemote {
            return GatewayRemoteConfig.resolveTokenString(root: root)
        }

        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           let token = auth["token"] as? String
        {
            return self.resolveLocalConfigAuthString(token, env: env, serviceEnv: serviceEnv)
        }
        return nil
    }

    private static func resolveLocalConfigAuthString(
        _ raw: String,
        env: [String: String],
        serviceEnv: [String: String]) -> String?
    {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let envName = envSecretRefName(trimmed) else {
            return trimmed
        }
        // Finder-launched apps cannot see gateway-service-only env values. Resolve
        // local refs from app env first, then the gateway LaunchAgent snapshot.
        for source in [env, serviceEnv] {
            let value = source[envName]?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let value, !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private static func envSecretRefName(_ value: String) -> String? {
        let name: Substring
        if value.hasPrefix("${"), value.hasSuffix("}") {
            let nameStart = value.index(value.startIndex, offsetBy: 2)
            let nameEnd = value.index(before: value.endIndex)
            name = value[nameStart..<nameEnd]
        } else if value.hasPrefix("$") {
            let nameStart = value.index(after: value.startIndex)
            name = value[nameStart..<value.endIndex]
        } else {
            return nil
        }
        let candidate = String(name)
        return self.isValidEnvSecretRefID(candidate) ? candidate : nil
    }

    private static func isValidEnvSecretRefID(_ value: String) -> Bool {
        value.range(of: #"^[A-Z][A-Z0-9_]{0,127}$"#, options: .regularExpression) != nil
    }

    private static func warnEnvOverrideOnce(
        kind: EnvOverrideWarningKind,
        envVar: String,
        configKey: String)
    {
        let shouldWarn = Self.envOverrideWarnings.withValue { state in
            switch kind {
            case .token:
                guard !state.token else { return false }
                state.token = true
                return true
            case .password:
                guard !state.password else { return false }
                state.password = true
                return true
            }
        }
        guard shouldWarn else { return }
        Self.staticLogger.warning(
            "\(envVar, privacy: .public) is set and overrides \(configKey, privacy: .public). " +
                "If this is unintentional, clear it with: launchctl unsetenv \(envVar, privacy: .public)")
    }

    private let deps: Deps
    private let logger = Logger(subsystem: "ai.openclaw", category: "gateway-endpoint")

    private var state: GatewayEndpointState
    private var subscribers: [UUID: AsyncStream<GatewayEndpointState>.Continuation] = [:]
    private var remoteEnsure: (token: UUID, task: Task<RemoteTunnelManager.Route, Error>)?
    private var resolvedEndpoint: GatewayConnection.EndpointSnapshot?
    private var endpointRevision: UInt64 = 0
    private var resolutionGeneration: UInt64 = 0
    private var activeSource: SourceSnapshot?

    init(deps: Deps = .live) {
        self.deps = deps
        let modeRaw = UserDefaults.standard.string(forKey: connectionModeKey)
        let initialMode: AppState.ConnectionMode
        if let modeRaw {
            initialMode = AppState.ConnectionMode(rawValue: modeRaw) ?? .local
        } else {
            let seen = UserDefaults.standard.bool(forKey: "openclaw.onboardingSeen")
            initialMode = seen ? .local : .unconfigured
        }

        let port = deps.localPort()
        let root = OpenClawConfigFile.loadDict()
        let bind = GatewayEndpointStore.resolveGatewayBindMode(
            root: root,
            env: ProcessInfo.processInfo.environment)
        let customBindHost = GatewayEndpointStore.resolveGatewayCustomBindHost(root: root)
        let scheme = GatewayEndpointStore.resolveGatewayScheme(
            root: root,
            env: ProcessInfo.processInfo.environment)
        let host = GatewayEndpointStore.resolveLocalGatewayHost(
            bindMode: bind,
            customBindHost: customBindHost,
            tailscaleIP: nil)
        let token = deps.token()
        let password = deps.password()
        let deviceAuthGatewayID = GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: initialMode,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "")
        switch initialMode {
        case .local:
            let url = URL(string: "\(scheme)://\(host):\(port)")!
            self.endpointRevision = 1
            self.state = .ready(
                mode: .local,
                url: url,
                token: token,
                password: password,
                routeRevision: self.endpointRevision)
            self.resolvedEndpoint = GatewayConnection.EndpointSnapshot(
                config: (url, token, password),
                tls: GatewayTLSRoute.resolve(
                    url: url,
                    connectionMode: .local,
                    configuredFingerprint: nil),
                routeAuthority: nil,
                deviceAuthGatewayID: deviceAuthGatewayID,
                revision: self.endpointRevision)
        case .remote:
            self.state = .connecting(mode: .remote, detail: Self.remoteConnectingDetail)
            Task { await self.refresh() }
        case .unconfigured:
            self.state = .unavailable(mode: .unconfigured, reason: "Gateway not configured")
        }
    }

    func subscribe(bufferingNewest: Int = 1) -> AsyncStream<GatewayEndpointState> {
        let id = UUID()
        let initial = self.state
        let store = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            continuation.yield(initial)
            self.subscribers[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await store.removeSubscriber(id) }
            }
        }
    }

    func refresh() async {
        _ = await self.refreshIfCurrent()
    }

    private func refreshIfCurrent() async -> (source: SourceSnapshot, generation: UInt64)? {
        do {
            let source = try await currentSourceSnapshot()
            let generation = self.adoptSource(source)
            await self.resolveSource(source, generation: generation)
            guard await self.sourceIsCurrent(source, generation: generation),
                  !Task.isCancelled,
                  generation == self.resolutionGeneration,
                  self.activeSource == source
            else { return nil }
            return (source, generation)
        } catch {
            return nil
        }
    }

    private func currentSourceSnapshot() async throws -> SourceSnapshot {
        try Task.checkCancellation()
        let source = await deps.sourceSnapshot()
        try Task.checkCancellation()
        return source
    }

    private func adoptSource(_ source: SourceSnapshot) -> UInt64 {
        if self.activeSource != source {
            self.cancelRemoteEnsure()
            self.activeSource = source
            self.resolutionGeneration &+= 1
        }
        return self.resolutionGeneration
    }

    private func sourceIsCurrent(_ source: SourceSnapshot, generation: UInt64) async -> Bool {
        guard !Task.isCancelled,
              generation == self.resolutionGeneration,
              self.activeSource == source
        else { return false }
        let current = await deps.sourceSnapshot()
        guard !Task.isCancelled,
              generation == self.resolutionGeneration,
              self.activeSource == source,
              current == source
        else { return false }
        guard let routingGeneration = source.routingGeneration else { return true }
        let routingGenerationIsCurrent = await deps.routingGenerationIsCurrent(routingGeneration)
        return routingGenerationIsCurrent &&
            !Task.isCancelled &&
            generation == self.resolutionGeneration &&
            self.activeSource == source
    }

    private func resolveSource(_ source: SourceSnapshot, generation: UInt64) async {
        guard !Task.isCancelled,
              generation == self.resolutionGeneration,
              self.activeSource == source
        else { return }
        switch source.mode {
        case .local:
            self.cancelRemoteEnsure()
            guard await self.sourceIsCurrent(source, generation: generation) else { return }
            let url = URL(string: "\(source.scheme)://\(source.localHost):\(source.localPort)")!
            self.setReady(
                mode: .local,
                url: url,
                token: source.token,
                password: source.password,
                tls: GatewayTLSRoute.resolve(
                    url: url,
                    connectionMode: .local,
                    configuredFingerprint: nil),
                deviceAuthGatewayID: source.deviceAuthGatewayID,
                routeAuthority: nil)
        case .remote:
            if source.remoteTransport == .direct {
                guard let url = source.directRemoteURL else {
                    self.cancelRemoteEnsure()
                    self.setState(.unavailable(
                        mode: .remote,
                        reason: "gateway.remote.url missing or invalid for direct transport"))
                    return
                }
                self.cancelRemoteEnsure()
                guard await self.sourceIsCurrent(source, generation: generation) else { return }
                self.setReady(
                    mode: .remote,
                    url: url,
                    token: source.token,
                    password: source.password,
                    tls: GatewayTLSRoute.resolve(
                        url: url,
                        connectionMode: .remote,
                        configuredFingerprint: source.remoteTLSFingerprint),
                    deviceAuthGatewayID: source.deviceAuthGatewayID,
                    routeAuthority: nil)
                return
            }
            let route = await deps.remoteRouteIfRunning()
            guard let route else {
                guard await self.sourceIsCurrent(source, generation: generation) else { return }
                self.setState(.connecting(mode: .remote, detail: Self.remoteConnectingDetail))
                self.kickRemoteEnsureIfNeeded(detail: Self.remoteConnectingDetail)
                return
            }
            guard await self.sourceIsCurrent(source, generation: generation) else { return }
            self.cancelRemoteEnsure()
            let url = URL(string: "\(source.scheme)://127.0.0.1:\(Int(route.localPort))")!
            self.setReady(
                mode: .remote,
                url: url,
                token: source.token,
                password: source.password,
                tls: GatewayTLSRoute.resolve(
                    url: url,
                    connectionMode: .remote,
                    configuredFingerprint: source.remoteTLSFingerprint),
                deviceAuthGatewayID: source.deviceAuthGatewayID,
                routeAuthority: route.generation)
        case .unconfigured:
            self.cancelRemoteEnsure()
            self.setState(.unavailable(mode: .unconfigured, reason: "Gateway not configured"))
        }
    }

    /// Explicit action: ensure the remote control tunnel is established and publish the resolved endpoint.
    func ensureRemoteControlTunnel() async throws -> UInt16 {
        guard let context = await refreshIfCurrent() else { throw CancellationError() }
        guard context.source.mode == .remote else {
            throw NSError(
                domain: "RemoteTunnel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not enabled"])
        }
        if context.source.remoteTransport == .direct {
            guard await self.sourceIsCurrent(context.source, generation: context.generation) else {
                throw CancellationError()
            }
            guard let url = context.source.directRemoteURL else {
                throw NSError(
                    domain: "GatewayEndpoint",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "gateway.remote.url missing or invalid"])
            }
            guard let port = GatewayRemoteConfig.defaultPort(for: url),
                  let portInt = UInt16(exactly: port)
            else {
                throw NSError(
                    domain: "GatewayEndpoint",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid gateway.remote.url port"])
            }
            self.logger.info("remote transport direct; skipping SSH tunnel")
            return portInt
        }
        let endpoint = try await ensureRemoteEndpoint(
            source: context.source,
            generation: context.generation,
            detail: Self.remoteConnectingDetail)
        guard let portInt = endpoint.config.url.port, let port = UInt16(exactly: portInt) else {
            throw NSError(
                domain: "GatewayEndpoint",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing tunnel port"])
        }
        return port
    }

    func requireConfig() async throws -> GatewayConnection.Config {
        try await self.requireEndpoint().config
    }

    /// Returns endpoint credentials and tunnel authority from the same actor
    /// snapshot. Callers must never stitch these values together across awaits.
    func requireEndpoint() async throws -> GatewayConnection.EndpointSnapshot {
        // A newer resolution owns the endpoint after it increments the generation.
        // Never let this request fall through to the previously-ready route.
        guard let context = await refreshIfCurrent(),
              !Task.isCancelled,
              context.generation == self.resolutionGeneration,
              context.source == self.activeSource
        else {
            throw CancellationError()
        }
        switch self.state {
        case .ready:
            guard await self.sourceIsCurrent(context.source, generation: context.generation) else {
                throw CancellationError()
            }
            guard let resolvedEndpoint else {
                throw NSError(
                    domain: "GatewayEndpoint",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Gateway endpoint changed while resolving"])
            }
            return resolvedEndpoint
        case let .connecting(mode, _):
            guard mode == .remote else {
                throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: "Connecting…"])
            }
            return try await self.ensureRemoteEndpoint(
                source: context.source,
                generation: context.generation,
                detail: Self.remoteConnectingDetail)
        case let .unavailable(mode, reason):
            guard mode == .remote else {
                throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
            }

            // Auto-recover for remote mode: if the SSH control tunnel died (or hasn't been created yet),
            // recreate it on demand so callers can recover without a manual reconnect.
            self.logger.info(
                "endpoint unavailable; ensuring remote control tunnel reason=\(reason, privacy: .public)")
            return try await self.ensureRemoteEndpoint(
                source: context.source,
                generation: context.generation,
                detail: Self.remoteConnectingDetail)
        }
    }

    private func cancelRemoteEnsure() {
        self.remoteEnsure?.task.cancel()
        self.remoteEnsure = nil
    }

    @discardableResult
    private func kickRemoteEnsureIfNeeded(detail: String) -> Bool {
        guard self.deps.canStartRemoteTunnel() else {
            self.setState(.connecting(mode: .remote, detail: detail))
            return false
        }
        if self.remoteEnsure != nil {
            self.setState(.connecting(mode: .remote, detail: detail))
            return true
        }

        let deps = deps
        let token = UUID()
        let task = Task.detached(priority: .utility) { try await deps.ensureRemoteTunnel() }
        self.remoteEnsure = (token: token, task: task)
        self.setState(.connecting(mode: .remote, detail: detail))
        return true
    }

    private func ensureRemoteEndpoint(
        source: SourceSnapshot,
        generation: UInt64,
        detail: String) async throws -> GatewayConnection.EndpointSnapshot
    {
        try Task.checkCancellation()
        guard source.mode == .remote,
              generation == self.resolutionGeneration,
              self.activeSource == source
        else { throw CancellationError() }

        if source.remoteTransport == .direct {
            guard await self.sourceIsCurrent(source, generation: generation) else {
                throw CancellationError()
            }
            guard let url = source.directRemoteURL else {
                throw NSError(
                    domain: "GatewayEndpoint",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "gateway.remote.url missing or invalid"])
            }
            self.cancelRemoteEnsure()
            return self.setReady(
                mode: .remote,
                url: url,
                token: source.token,
                password: source.password,
                tls: GatewayTLSRoute.resolve(
                    url: url,
                    connectionMode: .remote,
                    configuredFingerprint: source.remoteTLSFingerprint),
                deviceAuthGatewayID: source.deviceAuthGatewayID,
                routeAuthority: nil)
        }

        guard self.kickRemoteEnsureIfNeeded(detail: detail) else {
            throw CancellationError()
        }
        guard let ensure = remoteEnsure else {
            throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: "Connecting…"])
        }

        let route: RemoteTunnelManager.Route
        do {
            route = try await ensure.task.value
        } catch {
            if Task.isCancelled {
                throw CancellationError()
            }
            guard self.remoteEnsure?.token == ensure.token,
                  await self.sourceIsCurrent(source, generation: generation),
                  self.remoteEnsure?.token == ensure.token
            else { throw CancellationError() }
            self.remoteEnsure = nil
            if error is CancellationError {
                self.setState(.connecting(mode: .remote, detail: detail))
                throw error
            }
            let msg = "Remote control tunnel failed (\(error.localizedDescription))"
            self.setState(.unavailable(mode: .remote, reason: msg))
            self.logger.error("remote control tunnel ensure failed \(msg, privacy: .public)")
            throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
        }

        try Task.checkCancellation()
        let routeIsCurrent = await deps.remoteRouteIsCurrent(route)
        try Task.checkCancellation()
        guard await self.sourceIsCurrent(source, generation: generation) else {
            throw CancellationError()
        }
        guard routeIsCurrent else {
            if self.remoteEnsure?.token == ensure.token {
                self.remoteEnsure = nil
            }
            return try await self.ensureRemoteEndpoint(
                source: source,
                generation: generation,
                detail: detail)
        }
        guard self.remoteEnsure?.token == ensure.token else {
            if let endpoint = matchingReadyRemoteEndpoint(
                route: route,
                source: source,
                generation: generation)
            {
                return endpoint
            }
            throw CancellationError()
        }
        self.remoteEnsure = nil

        let url = URL(string: "\(source.scheme)://127.0.0.1:\(Int(route.localPort))")!
        return self.setReady(
            mode: .remote,
            url: url,
            token: source.token,
            password: source.password,
            tls: GatewayTLSRoute.resolve(
                url: url,
                connectionMode: .remote,
                configuredFingerprint: source.remoteTLSFingerprint),
            deviceAuthGatewayID: source.deviceAuthGatewayID,
            routeAuthority: route.generation)
    }

    private func matchingReadyRemoteEndpoint(
        route: RemoteTunnelManager.Route,
        source: SourceSnapshot,
        generation: UInt64) -> GatewayConnection.EndpointSnapshot?
    {
        let url = URL(string: "\(source.scheme)://127.0.0.1:\(Int(route.localPort))")!
        guard generation == self.resolutionGeneration,
              self.activeSource == source,
              let endpoint = resolvedEndpoint,
              endpoint.config.url == url,
              endpoint.config.token == source.token,
              endpoint.config.password == source.password,
              endpoint.deviceAuthGatewayID == source.deviceAuthGatewayID,
              endpoint.routeAuthority == route.generation,
              state == .ready(
                  mode: .remote,
                  url: url,
                  token: source.token,
                  password: source.password,
                  routeRevision: endpoint.revision ?? 0)
        else { return nil }
        return endpoint
    }

    private func removeSubscriber(_ id: UUID) {
        self.subscribers[id] = nil
    }

    private func setState(_ next: GatewayEndpointState) {
        if case .ready = next {
            // Ready state and its route authority are published by setReady.
        } else if self.resolvedEndpoint != nil {
            self.endpointRevision &+= 1
            self.resolvedEndpoint = nil
        }
        guard next != self.state else { return }
        self.state = next
        for (_, continuation) in self.subscribers {
            continuation.yield(next)
        }
        switch next {
        case let .ready(mode, url, _, _, _):
            let modeDesc = String(describing: mode)
            let urlDesc = url.absoluteString
            self.logger
                .debug(
                    "resolved endpoint mode=\(modeDesc, privacy: .public) url=\(urlDesc, privacy: .public)")
        case let .connecting(mode, detail):
            let modeDesc = String(describing: mode)
            self.logger
                .debug(
                    "endpoint connecting mode=\(modeDesc, privacy: .public) detail=\(detail, privacy: .public)")
        case let .unavailable(mode, reason):
            let modeDesc = String(describing: mode)
            self.logger
                .debug(
                    "endpoint unavailable mode=\(modeDesc, privacy: .public) reason=\(reason, privacy: .public)")
        }
    }

    @discardableResult
    private func setReady(
        mode: AppState.ConnectionMode,
        url: URL,
        token: String?,
        password: String?,
        tls: GatewayTLSRoute?,
        deviceAuthGatewayID: String?,
        routeAuthority: UInt64?) -> GatewayConnection.EndpointSnapshot
    {
        let changed = self.resolvedEndpoint.map { endpoint in
            endpoint.config.url != url ||
                endpoint.config.token != token ||
                endpoint.config.password != password ||
                !GatewayTLSRoute.hasSameConnectionIdentity(endpoint.tls, tls) ||
                endpoint.deviceAuthGatewayID != deviceAuthGatewayID ||
                endpoint.routeAuthority != routeAuthority
        } ?? true
        if changed {
            self.endpointRevision &+= 1
        }
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (url, token, password),
            tls: tls,
            routeAuthority: routeAuthority,
            deviceAuthGatewayID: deviceAuthGatewayID,
            revision: self.endpointRevision)
        self.resolvedEndpoint = endpoint
        self.setState(.ready(
            mode: mode,
            url: url,
            token: token,
            password: password,
            routeRevision: self.endpointRevision))
        return endpoint
    }
}

extension GatewayEndpointStore {
    func maybeFallbackToTailnet(from currentURL: URL) async -> GatewayConnection.EndpointSnapshot? {
        guard let expectedEndpoint = resolvedEndpoint,
              expectedEndpoint.config.url == currentURL
        else { return nil }
        let currentHost = currentURL.host?.lowercased() ?? ""
        guard currentHost == "127.0.0.1" || currentHost == "localhost" else { return nil }

        let source: SourceSnapshot
        do {
            source = try await self.currentSourceSnapshot()
        } catch {
            return nil
        }
        let fallbackHost = source.localHost.lowercased()
        guard source.mode == .local,
              source.bindMode == "tailnet",
              fallbackHost != "127.0.0.1",
              fallbackHost != "localhost"
        else { return nil }
        let generation = self.adoptSource(source)
        guard !Task.isCancelled,
              generation == self.resolutionGeneration,
              self.activeSource == source,
              self.resolvedEndpoint?.revision == expectedEndpoint.revision,
              self.resolvedEndpoint?.config.url == currentURL
        else { return nil }
        let url = URL(string: "\(source.scheme)://\(source.localHost):\(source.localPort)")!

        guard await self.sourceIsCurrent(source, generation: generation) else { return nil }
        self.logger.info("auto bind fallback to tailnet host=\(source.localHost, privacy: .public)")
        self.setReady(
            mode: .local,
            url: url,
            token: source.token,
            password: source.password,
            tls: GatewayTLSRoute.resolve(
                url: url,
                connectionMode: .local,
                configuredFingerprint: nil),
            deviceAuthGatewayID: source.deviceAuthGatewayID,
            routeAuthority: nil)
        return self.resolvedEndpoint
    }
}

extension GatewayEndpointStore {
    private struct LiveAppSnapshot: Sendable {
        let mode: AppState.ConnectionMode
        let configIsCurrent: Bool
        let generation: UInt64
        let tailscaleIP: String?
    }

    private static func liveSourceSnapshot() async -> SourceSnapshot {
        await self.liveSourceSnapshot(
            appSnapshot: {
                LiveAppSnapshot(
                    mode: AppStateStore.shared.connectionMode,
                    configIsCurrent: AppStateStore.shared.gatewayConfigIsCurrentForRouting,
                    generation: AppStateStore.shared.gatewayRoutingGeneration,
                    tailscaleIP: TailscaleService.shared.tailscaleIP)
            },
            generationIsCurrent: { generation in
                AppStateStore.shared.gatewayRoutingGeneration == generation
            },
            beforeConfigRead: {})
    }

    private static func liveSourceSnapshot(
        appSnapshot: @escaping @MainActor @Sendable () -> LiveAppSnapshot,
        generationIsCurrent: @escaping @MainActor @Sendable (UInt64) -> Bool,
        beforeConfigRead: @escaping @Sendable () async -> Void) async -> SourceSnapshot
    {
        // Capture MainActor-owned selection facts before reading config. The
        // post-build generation check rejects any interleaving route edit.
        let app = await appSnapshot()
        await beforeConfigRead()
        let root = OpenClawConfigFile.loadDict()
        let env = ProcessInfo.processInfo.environment
        let configMode = ConnectionModeResolver.resolve(root: root).mode
        // App selection is persisted asynchronously. Refuse to resolve either
        // side while the MainActor selection and canonical config disagree.
        let mode = self.effectiveSourceMode(
            appMode: app.mode,
            configMode: configMode,
            configIsCurrent: app.configIsCurrent)
        let isRemote = mode == .remote
        let launchdSnapshot = mode == .local ? GatewayLaunchAgentManager.launchdConfigSnapshot() : nil
        let bindMode = self.resolveGatewayBindMode(root: root, env: env)
        let customBindHost = self.resolveGatewayCustomBindHost(root: root)
        let tailscaleIP = bindMode == "tailnet"
            ? app.tailscaleIP ?? TailscaleService.fallbackTailnetIPv4()
            : nil
        let remoteResolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        let sshRouteIdentity: SSHRouteIdentity?
        if mode == .remote, remoteResolution.transport == .ssh {
            let sshSettings = CommandResolver.connectionSettings(configRoot: root)
            sshRouteIdentity = SSHRouteIdentity(
                target: sshSettings.target,
                identity: sshSettings.identity.trimmingCharacters(in: .whitespacesAndNewlines),
                hostKeyPolicy: sshSettings.sshHostKeyPolicy.rawValue,
                configuredRemotePort: GatewayRemoteConfig.resolveRemotePort(root: root),
                configuredRemoteURL: GatewayRemoteConfig.resolveUrlString(root: root))
        } else {
            sshRouteIdentity = nil
        }
        let deviceAuthGatewayID = GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: mode,
            remoteTransport: remoteResolution.transport,
            remoteURL: remoteResolution.directURL?.absoluteString
                ?? GatewayRemoteConfig.resolveUrlString(root: root)
                ?? "",
            remoteTarget: sshRouteIdentity?.target ?? "")

        let source = SourceSnapshot(
            routingGeneration: app.generation,
            mode: SourceMode(mode),
            token: mode == .unconfigured
                ? nil
                : self.resolveGatewayToken(
                    isRemote: isRemote,
                    root: root,
                    env: env,
                    launchdSnapshot: launchdSnapshot),
            password: mode == .unconfigured
                ? nil
                : self.resolveGatewayPassword(
                    isRemote: isRemote,
                    root: root,
                    env: env,
                    launchdSnapshot: launchdSnapshot),
            deviceAuthGatewayID: deviceAuthGatewayID,
            localPort: self.resolveGatewayPort(root: root, env: env),
            localHost: self.resolveLocalGatewayHost(
                bindMode: bindMode,
                customBindHost: customBindHost,
                tailscaleIP: tailscaleIP),
            scheme: self.resolveGatewayScheme(root: root, env: env),
            bindMode: bindMode,
            remoteTransport: SourceTransport(remoteResolution.transport),
            directRemoteURL: remoteResolution.directURL,
            remoteTLSFingerprint: isRemote ? GatewayRemoteConfig.resolveTLSFingerprint(root: root) : nil,
            sshRouteIdentity: sshRouteIdentity)
        let selectionIsCurrent = await generationIsCurrent(app.generation)
        guard selectionIsCurrent, !Task.isCancelled else {
            // A route edit may persist while config is read off the MainActor.
            // Never publish credentials or an endpoint assembled across generations.
            return SourceSnapshot(
                routingGeneration: app.generation,
                mode: .unconfigured,
                token: nil,
                password: nil,
                deviceAuthGatewayID: nil,
                localPort: source.localPort,
                localHost: source.localHost,
                scheme: source.scheme,
                bindMode: source.bindMode,
                remoteTransport: .ssh,
                directRemoteURL: nil,
                remoteTLSFingerprint: nil,
                sshRouteIdentity: nil)
        }
        return source
    }

    private static func effectiveSourceMode(
        appMode: AppState.ConnectionMode,
        configMode: AppState.ConnectionMode,
        configIsCurrent: Bool) -> AppState.ConnectionMode
    {
        guard configIsCurrent, configMode == appMode else { return .unconfigured }
        return appMode
    }

    private static func resolveGatewayPort(
        root: [String: Any],
        env: [String: String],
        defaults: UserDefaults = .standard) -> Int
    {
        if let raw = env["OPENCLAW_GATEWAY_PORT"],
           let port = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           port > 0
        {
            return port
        }
        if let gateway = root["gateway"] as? [String: Any] {
            let port: Int? = switch gateway["port"] {
            case let value as Int:
                value
            case let value as NSNumber:
                value.intValue
            case let value as String:
                Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
            default:
                nil
            }
            if let port, port > 0 {
                return port
            }
        }
        let stored = defaults.integer(forKey: "gatewayPort")
        return stored > 0 ? stored : 18789
    }

    private static func resolveGatewayBindMode(
        root: [String: Any],
        env: [String: String]) -> String?
    {
        if let envBind = env["OPENCLAW_GATEWAY_BIND"] {
            let trimmed = envBind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if self.supportedBindModes.contains(trimmed) {
                return trimmed
            }
        }
        if let gateway = root["gateway"] as? [String: Any],
           let bind = gateway["bind"] as? String
        {
            let trimmed = bind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if self.supportedBindModes.contains(trimmed) {
                return trimmed
            }
        }
        return nil
    }

    private static func resolveGatewayCustomBindHost(root: [String: Any]) -> String? {
        if let gateway = root["gateway"] as? [String: Any],
           let customBindHost = gateway["customBindHost"] as? String
        {
            let trimmed = customBindHost.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return nil
    }

    private static func resolveGatewayScheme(
        root: [String: Any],
        env: [String: String]) -> String
    {
        if let envValue = env["OPENCLAW_GATEWAY_TLS"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envValue.isEmpty
        {
            return (envValue == "1" || envValue.lowercased() == "true") ? "wss" : "ws"
        }
        if let gateway = root["gateway"] as? [String: Any],
           let tls = gateway["tls"] as? [String: Any],
           let enabled = tls["enabled"] as? Bool
        {
            return enabled ? "wss" : "ws"
        }
        return "ws"
    }

    private static func resolveLocalGatewayHost(
        bindMode: String?,
        customBindHost: String?,
        tailscaleIP: String?) -> String
    {
        switch bindMode {
        case "tailnet":
            tailscaleIP ?? "127.0.0.1"
        case "auto":
            "127.0.0.1"
        case "custom":
            customBindHost ?? "127.0.0.1"
        default:
            "127.0.0.1"
        }
    }
}

extension GatewayEndpointStore {
    static func localConfig() -> GatewayConnection.Config {
        self.localConfig(
            root: OpenClawConfigFile.loadDict(),
            env: ProcessInfo.processInfo.environment,
            launchdSnapshot: GatewayLaunchAgentManager.launchdConfigSnapshot(),
            tailscaleIP: TailscaleService.fallbackTailnetIPv4())
    }

    static func localConfig(
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot?,
        tailscaleIP: String?) -> GatewayConnection.Config
    {
        let port = GatewayEnvironment.gatewayPort()
        let bind = self.resolveGatewayBindMode(root: root, env: env)
        let customBindHost = self.resolveGatewayCustomBindHost(root: root)
        let scheme = self.resolveGatewayScheme(root: root, env: env)
        let host = self.resolveLocalGatewayHost(
            bindMode: bind,
            customBindHost: customBindHost,
            tailscaleIP: tailscaleIP)
        let token = self.resolveGatewayToken(
            isRemote: false,
            root: root,
            env: env,
            launchdSnapshot: launchdSnapshot)
        let password = self.resolveGatewayPassword(
            isRemote: false,
            root: root,
            env: env,
            launchdSnapshot: launchdSnapshot)
        return (
            url: URL(string: "\(scheme)://\(host):\(port)")!,
            token: token,
            password: password)
    }

    private static func normalizeDashboardPath(_ rawPath: String?) -> String {
        let trimmed = (rawPath ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "/" }
        let withLeadingSlash = trimmed.hasPrefix("/") ? trimmed : "/" + trimmed
        guard withLeadingSlash != "/" else { return "/" }
        return withLeadingSlash.hasSuffix("/") ? withLeadingSlash : withLeadingSlash + "/"
    }

    private static func localControlUiBasePath() -> String {
        let root = OpenClawConfigFile.loadDict()
        guard let gateway = root["gateway"] as? [String: Any],
              let controlUi = gateway["controlUi"] as? [String: Any]
        else {
            return "/"
        }
        return self.normalizeDashboardPath(controlUi["basePath"] as? String)
    }

    static func dashboardURL(
        for config: GatewayConnection.Config,
        mode: AppState.ConnectionMode,
        localBasePath: String? = nil,
        authToken: String? = nil) throws -> URL
    {
        guard var components = URLComponents(url: config.url, resolvingAgainstBaseURL: false) else {
            throw NSError(domain: "Dashboard", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Invalid gateway URL",
            ])
        }
        switch components.scheme?.lowercased() {
        case "ws":
            components.scheme = "http"
        case "wss":
            components.scheme = "https"
        default:
            components.scheme = "http"
        }

        let urlPath = self.normalizeDashboardPath(components.path)
        if urlPath != "/" {
            components.path = urlPath
        } else if mode == .local {
            let fallbackPath = localBasePath ?? self.localControlUiBasePath()
            components.path = self.normalizeDashboardPath(fallbackPath)
        } else {
            components.path = "/"
        }

        var fragmentItems: [URLQueryItem] = []
        let tokenCandidate = authToken ?? config.token
        if let token = tokenCandidate?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty
        {
            fragmentItems.append(URLQueryItem(name: "token", value: token))
        }
        components.queryItems = nil
        if fragmentItems.isEmpty {
            components.fragment = nil
        } else {
            var fragment = URLComponents()
            fragment.queryItems = fragmentItems
            components.fragment = fragment.percentEncodedQuery
        }
        guard let url = components.url else {
            throw NSError(domain: "Dashboard", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to build dashboard URL",
            ])
        }
        return url
    }
}

#if DEBUG
extension GatewayEndpointStore {
    @MainActor
    static func _testLiveSourceSnapshot(
        state: AppState,
        beforeConfigRead: @escaping @Sendable () async -> Void) async -> SourceSnapshot
    {
        await self.liveSourceSnapshot(
            appSnapshot: {
                LiveAppSnapshot(
                    mode: state.connectionMode,
                    configIsCurrent: state.gatewayConfigIsCurrentForRouting,
                    generation: state.gatewayRoutingGeneration,
                    tailscaleIP: nil)
            },
            generationIsCurrent: { generation in
                state.gatewayRoutingGeneration == generation
            },
            beforeConfigRead: beforeConfigRead)
    }

    static func _testEffectiveSourceMode(
        appMode: AppState.ConnectionMode,
        configMode: AppState.ConnectionMode,
        configIsCurrent: Bool) -> AppState.ConnectionMode
    {
        self.effectiveSourceMode(
            appMode: appMode,
            configMode: configMode,
            configIsCurrent: configIsCurrent)
    }

    static func _testResolveGatewayPassword(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot? = nil) -> String?
    {
        self.resolveGatewayPassword(isRemote: isRemote, root: root, env: env, launchdSnapshot: launchdSnapshot)
    }

    static func _testResolveGatewayToken(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot? = nil) -> String?
    {
        self.resolveGatewayToken(isRemote: isRemote, root: root, env: env, launchdSnapshot: launchdSnapshot)
    }

    static func _testResolveLocalGatewayHost(
        bindMode: String?,
        tailscaleIP: String?,
        customBindHost: String? = nil) -> String
    {
        self.resolveLocalGatewayHost(
            bindMode: bindMode,
            customBindHost: customBindHost,
            tailscaleIP: tailscaleIP)
    }

    static func _testLocalConfig(
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot? = nil,
        tailscaleIP: String? = nil) -> GatewayConnection.Config
    {
        self.localConfig(
            root: root,
            env: env,
            launchdSnapshot: launchdSnapshot,
            tailscaleIP: tailscaleIP)
    }
}
#endif
