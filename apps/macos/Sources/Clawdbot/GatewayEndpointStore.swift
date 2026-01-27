import ConcurrencyExtras
import Foundation
import OSLog

enum GatewayEndpointState: Sendable, Equatable {
    case ready(mode: AppState.ConnectionMode, url: URL, token: String?, password: String?)
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
    private static let staticLogger = Logger(subsystem: "com.clawdbot", category: "gateway-endpoint")
    private enum EnvOverrideWarningKind: Sendable {
        case token
        case password
    }

    private static let envOverrideWarnings = LockIsolated((token: false, password: false))

    struct Deps: Sendable {
        let mode: @Sendable () async -> AppState.ConnectionMode
        let token: @Sendable () -> String?
        let password: @Sendable () -> String?
        let localPort: @Sendable () -> Int
        let localHost: @Sendable () async -> String
        let remotePortIfRunning: @Sendable () async -> UInt16?
        let ensureRemoteTunnel: @Sendable () async throws -> UInt16

        static let live = Deps(
            mode: { await MainActor.run { AppStateStore.shared.connectionMode } },
            token: {
                let root = MoltbotConfigFile.loadDict()
                let isRemote = ConnectionModeResolver.resolve(root: root).mode == .remote
                return GatewayEndpointStore.resolveGatewayToken(
                    isRemote: isRemote,
                    root: root,
                    env: ProcessInfo.processInfo.environment,
                    launchdSnapshot: GatewayLaunchAgentManager.launchdConfigSnapshot())
            },
            password: {
                let root = MoltbotConfigFile.loadDict()
                let isRemote = ConnectionModeResolver.resolve(root: root).mode == .remote
                return GatewayEndpointStore.resolveGatewayPassword(
                    isRemote: isRemote,
                    root: root,
                    env: ProcessInfo.processInfo.environment,
                    launchdSnapshot: GatewayLaunchAgentManager.launchdConfigSnapshot())
            },
            localPort: { GatewayEnvironment.gatewayPort() },
            localHost: {
                let root = MoltbotConfigFile.loadDict()
                let bind = GatewayEndpointStore.resolveGatewayBindMode(
                    root: root,
                    env: ProcessInfo.processInfo.environment)
                let customBindHost = GatewayEndpointStore.resolveGatewayCustomBindHost(root: root)
                let tailscaleIP = await MainActor.run { TailscaleService.shared.tailscaleIP }
                    ?? TailscaleService.fallbackTailnetIPv4()
                return GatewayEndpointStore.resolveLocalGatewayHost(
                    bindMode: bind,
                    customBindHost: customBindHost,
                    tailscaleIP: tailscaleIP)
            },
            remotePortIfRunning: { await RemoteTunnelManager.shared.controlTunnelPortIfRunning() },
            ensureRemoteTunnel: { try await RemoteTunnelManager.shared.ensureControlTunnel() })
    }

    private static func resolveGatewayPassword(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot?) -> String?
    {
        let raw = env["CLAWDBOT_GATEWAY_PASSWORD"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let configPassword = self.resolveConfigPassword(isRemote: isRemote, root: root),
               !configPassword.isEmpty
            {
                self.warnEnvOverrideOnce(
                    kind: .password,
                    envVar: "CLAWDBOT_GATEWAY_PASSWORD",
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
            let pw = password.trimmingCharacters(in: .whitespacesAndNewlines)
            if !pw.isEmpty {
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

    private static func resolveConfigPassword(isRemote: Bool, root: [String: Any]) -> String? {
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
            return password.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private static func resolveGatewayToken(
        isRemote: Bool,
        root: [String: Any],
        env: [String: String],
        launchdSnapshot: LaunchAgentPlistSnapshot?) -> String?
    {
        let raw = env["CLAWDBOT_GATEWAY_TOKEN"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let configToken = self.resolveConfigToken(isRemote: isRemote, root: root),
               !configToken.isEmpty,
               configToken != trimmed
            {
                self.warnEnvOverrideOnce(
                    kind: .token,
                    envVar: "CLAWDBOT_GATEWAY_TOKEN",
                    configKey: isRemote ? "gateway.remote.token" : "gateway.auth.token")
            }
            return trimmed
        }

        if let configToken = self.resolveConfigToken(isRemote: isRemote, root: root),
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

    private static func resolveConfigToken(isRemote: Bool, root: [String: Any]) -> String? {
        if isRemote {
            if let gateway = root["gateway"] as? [String: Any],
               let remote = gateway["remote"] as? [String: Any],
               let token = remote["token"] as? String
            {
                return token.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return nil
        }

        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           let token = auth["token"] as? String
        {
            return token.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
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
    private let logger = Logger(subsystem: "com.clawdbot", category: "gateway-endpoint")

    private var state: GatewayEndpointState
    private var subscribers: [UUID: AsyncStream<GatewayEndpointState>.Continuation] = [:]
    private var remoteEnsure: (token: UUID, task: Task<UInt16, Error>)?

    init(deps: Deps = .live) {
        self.deps = deps
        let modeRaw = UserDefaults.standard.string(forKey: connectionModeKey)
        let initialMode: AppState.ConnectionMode
        if let modeRaw {
            initialMode = AppState.ConnectionMode(rawValue: modeRaw) ?? .local
        } else {
            let seen = UserDefaults.standard.bool(forKey: "moltbot.onboardingSeen")
            initialMode = seen ? .local : .unconfigured
        }

        let port = deps.localPort()
        let bind = GatewayEndpointStore.resolveGatewayBindMode(
            root: MoltbotConfigFile.loadDict(),
            env: ProcessInfo.processInfo.environment)
        let customBindHost = GatewayEndpointStore.resolveGatewayCustomBindHost(root: MoltbotConfigFile.loadDict())
        let scheme = GatewayEndpointStore.resolveGatewayScheme(
            root: MoltbotConfigFile.loadDict(),
            env: ProcessInfo.processInfo.environment)
        let host = GatewayEndpointStore.resolveLocalGatewayHost(
            bindMode: bind,
            customBindHost: customBindHost,
            tailscaleIP: nil)
        let token = deps.token()
        let password = deps.password()
        switch initialMode {
        case .local:
            self.state = .ready(
                mode: .local,
                url: URL(string: "\(scheme)://\(host):\(port)")!,
                token: token,
                password: password)
        case .remote:
            self.state = .connecting(mode: .remote, detail: Self.remoteConnectingDetail)
            Task { await self.setMode(.remote) }
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
        let mode = await self.deps.mode()
        await self.setMode(mode)
    }

    func setMode(_ mode: AppState.ConnectionMode) async {
        let token = self.deps.token()
        let password = self.deps.password()
        switch mode {
        case .local:
            self.cancelRemoteEnsure()
            let port = self.deps.localPort()
            let host = await self.deps.localHost()
            let scheme = GatewayEndpointStore.resolveGatewayScheme(
                root: MoltbotConfigFile.loadDict(),
                env: ProcessInfo.processInfo.environment)
            self.setState(.ready(
                mode: .local,
                url: URL(string: "\(scheme)://\(host):\(port)")!,
                token: token,
                password: password))
        case .remote:
            let root = MoltbotConfigFile.loadDict()
            if GatewayRemoteConfig.resolveTransport(root: root) == .direct {
                guard let url = GatewayRemoteConfig.resolveGatewayUrl(root: root) else {
                    self.cancelRemoteEnsure()
                    self.setState(.unavailable(
                        mode: .remote,
                        reason: "gateway.remote.url missing or invalid for direct transport"))
                    return
                }
                self.cancelRemoteEnsure()
                self.setState(.ready(mode: .remote, url: url, token: token, password: password))
                return
            }
            let port = await self.deps.remotePortIfRunning()
            guard let port else {
                self.setState(.connecting(mode: .remote, detail: Self.remoteConnectingDetail))
                self.kickRemoteEnsureIfNeeded(detail: Self.remoteConnectingDetail)
                return
            }
            self.cancelRemoteEnsure()
            let scheme = GatewayEndpointStore.resolveGatewayScheme(
                root: MoltbotConfigFile.loadDict(),
                env: ProcessInfo.processInfo.environment)
            self.setState(.ready(
                mode: .remote,
                url: URL(string: "\(scheme)://127.0.0.1:\(Int(port))")!,
                token: token,
                password: password))
        case .unconfigured:
            self.cancelRemoteEnsure()
            self.setState(.unavailable(mode: .unconfigured, reason: "Gateway not configured"))
        }
    }

    /// Explicit action: ensure the remote control tunnel is established and publish the resolved endpoint.
    func ensureRemoteControlTunnel() async throws -> UInt16 {
        let mode = await self.deps.mode()
        guard mode == .remote else {
            throw NSError(
                domain: "RemoteTunnel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not enabled"])
        }
        let root = MoltbotConfigFile.loadDict()
        if GatewayRemoteConfig.resolveTransport(root: root) == .direct {
            guard let url = GatewayRemoteConfig.resolveGatewayUrl(root: root) else {
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
        let config = try await self.ensureRemoteConfig(detail: Self.remoteConnectingDetail)
        guard let portInt = config.0.port, let port = UInt16(exactly: portInt) else {
            throw NSError(
                domain: "GatewayEndpoint",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing tunnel port"])
        }
        return port
    }

    func requireConfig() async throws -> GatewayConnection.Config {
        await self.refresh()
        switch self.state {
        case let .ready(_, url, token, password):
            return (url, token, password)
        case let .connecting(mode, _):
            guard mode == .remote else {
                throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: "Connecting…"])
            }
            return try await self.ensureRemoteConfig(detail: Self.remoteConnectingDetail)
        case let .unavailable(mode, reason):
            guard mode == .remote else {
                throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
            }

            // Auto-recover for remote mode: if the SSH control tunnel died (or hasn't been created yet),
            // recreate it on demand so callers can recover without a manual reconnect.
            self.logger.info(
                "endpoint unavailable; ensuring remote control tunnel reason=\(reason, privacy: .public)")
            return try await self.ensureRemoteConfig(detail: Self.remoteConnectingDetail)
        }
    }

    private func cancelRemoteEnsure() {
        self.remoteEnsure?.task.cancel()
        self.remoteEnsure = nil
    }

    private func kickRemoteEnsureIfNeeded(detail: String) {
        if self.remoteEnsure != nil {
            self.setState(.connecting(mode: .remote, detail: detail))
            return
        }

        let deps = self.deps
        let token = UUID()
        let task = Task.detached(priority: .utility) { try await deps.ensureRemoteTunnel() }
        self.remoteEnsure = (token: token, task: task)
        self.setState(.connecting(mode: .remote, detail: detail))
    }

    private func ensureRemoteConfig(detail: String) async throws -> GatewayConnection.Config {
        let mode = await self.deps.mode()
        guard mode == .remote else {
            throw NSError(
                domain: "RemoteTunnel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not enabled"])
        }

        let root = MoltbotConfigFile.loadDict()
        if GatewayRemoteConfig.resolveTransport(root: root) == .direct {
            guard let url = GatewayRemoteConfig.resolveGatewayUrl(root: root) else {
                throw NSError(
                    domain: "GatewayEndpoint",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "gateway.remote.url missing or invalid"])
            }
            let token = self.deps.token()
            let password = self.deps.password()
            self.cancelRemoteEnsure()
            self.setState(.ready(mode: .remote, url: url, token: token, password: password))
            return (url, token, password)
        }

        self.kickRemoteEnsureIfNeeded(detail: detail)
        guard let ensure = self.remoteEnsure else {
            throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: "Connecting…"])
        }

        do {
            let forwarded = try await ensure.task.value
            let stillRemote = await self.deps.mode() == .remote
            guard stillRemote else {
                throw NSError(
                    domain: "RemoteTunnel",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Remote mode is not enabled"])
            }

            if self.remoteEnsure?.token == ensure.token {
                self.remoteEnsure = nil
            }

            let token = self.deps.token()
            let password = self.deps.password()
            let scheme = GatewayEndpointStore.resolveGatewayScheme(
                root: MoltbotConfigFile.loadDict(),
                env: ProcessInfo.processInfo.environment)
            let url = URL(string: "\(scheme)://127.0.0.1:\(Int(forwarded))")!
            self.setState(.ready(mode: .remote, url: url, token: token, password: password))
            return (url, token, password)
        } catch let err as CancellationError {
            if self.remoteEnsure?.token == ensure.token {
                self.remoteEnsure = nil
            }
            throw err
        } catch {
            if self.remoteEnsure?.token == ensure.token {
                self.remoteEnsure = nil
            }
            let msg = "Remote control tunnel failed (\(error.localizedDescription))"
            self.setState(.unavailable(mode: .remote, reason: msg))
            self.logger.error("remote control tunnel ensure failed \(msg, privacy: .public)")
            throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
        }
    }

    private func removeSubscriber(_ id: UUID) {
        self.subscribers[id] = nil
    }

    private func setState(_ next: GatewayEndpointState) {
        guard next != self.state else { return }
        self.state = next
        for (_, continuation) in self.subscribers {
            continuation.yield(next)
        }
        switch next {
        case let .ready(mode, url, _, _):
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

    func maybeFallbackToTailnet(from currentURL: URL) async -> GatewayConnection.Config? {
        let mode = await self.deps.mode()
        guard mode == .local else { return nil }

        let root = MoltbotConfigFile.loadDict()
        let bind = GatewayEndpointStore.resolveGatewayBindMode(
            root: root,
            env: ProcessInfo.processInfo.environment)
        guard bind == "tailnet" else { return nil }

        let currentHost = currentURL.host?.lowercased() ?? ""
        guard currentHost == "127.0.0.1" || currentHost == "localhost" else { return nil }

        let tailscaleIP = await MainActor.run { TailscaleService.shared.tailscaleIP }
            ?? TailscaleService.fallbackTailnetIPv4()
        guard let tailscaleIP, !tailscaleIP.isEmpty else { return nil }

        let scheme = GatewayEndpointStore.resolveGatewayScheme(
            root: root,
            env: ProcessInfo.processInfo.environment)
        let port = self.deps.localPort()
        let token = self.deps.token()
        let password = self.deps.password()
        let url = URL(string: "\(scheme)://\(tailscaleIP):\(port)")!

        self.logger.info("auto bind fallback to tailnet host=\(tailscaleIP, privacy: .public)")
        self.setState(.ready(mode: .local, url: url, token: token, password: password))
        return (url, token, password)
    }

    private static func resolveGatewayBindMode(
        root: [String: Any],
        env: [String: String]) -> String?
    {
        if let envBind = env["CLAWDBOT_GATEWAY_BIND"] {
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
        if let envValue = env["CLAWDBOT_GATEWAY_TLS"]?.trimmingCharacters(in: .whitespacesAndNewlines),
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
    static func dashboardURL(for config: GatewayConnection.Config) throws -> URL {
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
        components.path = "/"
        var queryItems: [URLQueryItem] = []
        if let token = config.token?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty
        {
            queryItems.append(URLQueryItem(name: "token", value: token))
        }
        if let password = config.password?.trimmingCharacters(in: .whitespacesAndNewlines),
           !password.isEmpty
        {
            queryItems.append(URLQueryItem(name: "password", value: password))
        }
        components.queryItems = queryItems.isEmpty ? nil : queryItems
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

    static func _testResolveGatewayBindMode(
        root: [String: Any],
        env: [String: String]) -> String?
    {
        self.resolveGatewayBindMode(root: root, env: env)
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
}
#endif
