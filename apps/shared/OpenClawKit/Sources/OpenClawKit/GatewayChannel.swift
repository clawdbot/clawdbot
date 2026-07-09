import Foundation
import OpenClawProtocol
import OSLog

public protocol WebSocketTasking: AnyObject {
    var state: URLSessionTask.State { get }
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void)
    func receive() async throws -> URLSessionWebSocketTask.Message
    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
}

extension URLSessionWebSocketTask: WebSocketTasking {}

private final class WebSocketPingContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false

    func resumeOnce(_ resume: () -> Void) {
        self.lock.lock()
        if self.didResume {
            self.lock.unlock()
            return
        }
        self.didResume = true
        self.lock.unlock()
        resume()
    }
}

public struct WebSocketTaskBox: @unchecked Sendable {
    public let task: any WebSocketTasking
    public init(task: any WebSocketTasking) {
        self.task = task
    }

    public var state: URLSessionTask.State {
        self.task.state
    }

    public func resume() {
        self.task.resume()
    }

    public func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.task.cancel(with: closeCode, reason: reason)
    }

    public func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.task.send(message)
    }

    public func receive() async throws -> URLSessionWebSocketTask.Message {
        try await self.task.receive()
    }

    public func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.task.receive(completionHandler: completionHandler)
    }

    public func sendPing() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = WebSocketPingContinuationGate()
            self.task.sendPing { error in
                // URLSession can race ping callbacks with cancellation; only the first
                // pong result owns this checked continuation or Swift traps the app.
                gate.resumeOnce {
                    ThrowingContinuationSupport.resumeVoid(continuation, error: error)
                }
            }
        }
    }
}

public protocol WebSocketSessioning: AnyObject {
    func makeWebSocketTask(url: URL) -> WebSocketTaskBox
    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox
}

extension WebSocketSessioning {
    /// Compatibility path for existing session conformers. URLSession and pinning sessions
    /// override this requirement so operator headers remain attached to the upgrade request.
    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        guard let url = request.url else { preconditionFailure("WebSocket request URL is required") }
        return self.makeWebSocketTask(url: url)
    }
}

extension URLSession: WebSocketSessioning {
    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        let task = self.webSocketTask(with: request)
        // Avoid "Message too long" receive errors for large snapshots / history payloads.
        task.maximumMessageSize = 16 * 1024 * 1024 // 16 MB
        return WebSocketTaskBox(task: task)
    }
}

public struct WebSocketSessionBox: @unchecked Sendable {
    public let session: any WebSocketSessioning

    public init(session: any WebSocketSessioning) {
        self.session = session
    }
}

public struct GatewayConnectOptions: Sendable {
    public var role: String
    public var scopes: [String]
    public var scopesAreExplicit: Bool
    public var caps: [String]
    public var commands: [String]
    public var permissions: [String: Bool]
    public var clientId: String
    public var clientMode: String
    public var clientDisplayName: String?
    public var deviceIdentityProfile: GatewayDeviceIdentityProfile
    /// When false, the connection omits the signed device identity payload and cannot use
    /// device-scoped auth (role/scope upgrades will require pairing). Keep this true for
    /// role/scoped sessions such as operator UI clients.
    public var includeDeviceIdentity: Bool
    /// Set false for an endpoint handoff whose explicit credentials (including none) must be
    /// tried without reusing a device token issued by a different gateway.
    public var allowStoredDeviceAuth: Bool
    /// Stable gateway owner for device tokens. Nil preserves legacy unscoped storage for clients
    /// that have not adopted endpoint ownership yet.
    public var deviceAuthGatewayID: String?

    public init(
        role: String,
        scopes: [String],
        scopesAreExplicit: Bool = false,
        caps: [String],
        commands: [String],
        permissions: [String: Bool],
        clientId: String,
        clientMode: String,
        clientDisplayName: String?,
        deviceIdentityProfile: GatewayDeviceIdentityProfile = .primary,
        includeDeviceIdentity: Bool = true,
        allowStoredDeviceAuth: Bool = true,
        deviceAuthGatewayID: String? = nil)
    {
        self.role = role
        self.scopes = scopes
        self.scopesAreExplicit = scopesAreExplicit
        self.caps = caps
        self.commands = commands
        self.permissions = permissions
        self.clientId = clientId
        self.clientMode = clientMode
        self.clientDisplayName = clientDisplayName
        self.deviceIdentityProfile = deviceIdentityProfile
        self.includeDeviceIdentity = includeDeviceIdentity
        self.allowStoredDeviceAuth = allowStoredDeviceAuth
        self.deviceAuthGatewayID = deviceAuthGatewayID
    }
}

public enum GatewayAuthSource: String, Sendable {
    case deviceToken = "device-token"
    case sharedToken = "shared-token"
    case bootstrapToken = "bootstrap-token"
    case password
    case none
}

/// Avoid ambiguity with the app's own AnyCodable type.
private typealias ProtoAnyCodable = OpenClawProtocol.AnyCodable

private func gatewayErrorDetails(_ error: ErrorShape?) -> [String: ProtoAnyCodable] {
    var details: [String: ProtoAnyCodable] = [:]
    if let nested = error?.details?.value as? [String: ProtoAnyCodable] {
        details.merge(nested) { _, nestedValue in nestedValue }
    }
    if let error {
        if details["code"] == nil {
            details["code"] = ProtoAnyCodable(error.code)
        } else {
            details["errorCode"] = ProtoAnyCodable(error.code)
        }
        details["message"] = ProtoAnyCodable(error.message)
        if let retryable = error.retryable {
            details["retryable"] = ProtoAnyCodable(retryable)
        }
        if let retryAfterMs = error.retryafterms {
            details["retryAfterMs"] = ProtoAnyCodable(retryAfterMs)
        }
    }
    return details
}

private func gatewayIntValue(_ value: Any?) -> Int? {
    if let value = value as? Int {
        return value
    }
    if let value = value as? Int64 {
        return Int(exactly: value)
    }
    if let value = value as? Double, value.rounded() == value {
        return Int(exactly: value)
    }
    if let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() {
        let doubleValue = value.doubleValue
        guard doubleValue.rounded() == doubleValue else {
            return nil
        }
        return Int(exactly: doubleValue)
    }
    if let value = value as? String {
        return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return nil
}

private enum ConnectChallengeError: Error {
    case timeout
}

private let defaultOperatorConnectScopes: [String] = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
]

extension String {
    fileprivate var nilIfEmpty: String? {
        self.isEmpty ? nil : self
    }
}

private struct SelectedConnectAuth {
    let authToken: String?
    let authBootstrapToken: String?
    let authDeviceToken: String?
    let authPassword: String?
    let signatureToken: String?
    let storedToken: String?
    let storedScopes: [String]?
    let authSource: GatewayAuthSource
    let suppressedDeviceTokenRetry: Bool
}

public actor GatewayChannelActor {
    nonisolated static func resolveRequestTimeoutMs(_ timeoutMs: Double?, defaultMs: Double) -> Double? {
        timeoutMs == 0 ? nil : (timeoutMs ?? defaultMs)
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "gateway")
    private var task: WebSocketTaskBox?
    private var activeConnectAttemptID: UUID?
    private var pending: [String: CheckedContinuation<GatewayFrame, Error>] = [:]
    private var connected = false
    private var isConnecting = false
    private var connectWaiters: [CheckedContinuation<Void, Error>] = []
    private var url: URL
    private var token: String?
    private var bootstrapToken: String?
    private var password: String?
    private let session: WebSocketSessioning
    private var backoffMs: Double = 500
    private var shouldReconnect = true
    private var lastSeq: Int?
    private var lastTick: Date?
    private var tickIntervalMs: Double = 30000
    private var lastAuthSource: GatewayAuthSource = .none
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    // Remote gateways (tailscale/wan) can take longer to deliver connect.challenge.
    // Connect now requires this nonce before we send device-auth.
    private var connectTimeoutSeconds: Double = 30
    private var testConnectAttemptFinishedHandler: (@Sendable (UUID) -> Void)?
    private let connectChallengeTimeoutSeconds: Double = 6.0
    // Some networks will silently drop idle TCP/TLS flows around ~30s. The gateway tick is server->client,
    // but NATs/proxies often require outbound traffic to keep the connection alive.
    private let keepaliveIntervalSeconds: Double = 15.0
    private var watchdogTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?
    private var pendingDeviceTokenRetry = false
    private var deviceTokenRetryBudgetUsed = false
    private var issuedDeviceAuthRoles = Set<String>()
    private var reconnectPausedForAuthFailure = false
    private let defaultRequestTimeoutMs: Double = 15000
    private let extraHeadersProvider: (@Sendable () -> [String: String])?
    private let pushHandler: (@Sendable (GatewayPush) async -> Void)?
    private var connectOptions: GatewayConnectOptions?
    private let disconnectHandler: (@Sendable (String) async -> Void)?

    public init(
        url: URL,
        token: String?,
        bootstrapToken: String? = nil,
        password: String? = nil,
        session: WebSocketSessionBox? = nil,
        pushHandler: (@Sendable (GatewayPush) async -> Void)? = nil,
        connectOptions: GatewayConnectOptions? = nil,
        disconnectHandler: (@Sendable (String) async -> Void)? = nil,
        extraHeadersProvider: (@Sendable () -> [String: String])? = nil)
    {
        self.url = url
        self.token = token
        self.bootstrapToken = bootstrapToken
        self.password = password
        self.extraHeadersProvider = extraHeadersProvider
        self.session = session?.session ?? URLSession(configuration: .default)
        self.pushHandler = pushHandler
        self.connectOptions = connectOptions
        self.disconnectHandler = disconnectHandler
        Task { [weak self] in
            await self?.startWatchdog()
        }
    }

    public func authSource() -> GatewayAuthSource {
        self.lastAuthSource
    }

    func _test_setConnectTimeoutSeconds(_ seconds: Double) {
        self.connectTimeoutSeconds = seconds
    }

    func _test_setConnectAttemptFinishedHandler(_ handler: (@Sendable (UUID) -> Void)?) {
        self.testConnectAttemptFinishedHandler = handler
    }

    public func shutdown() async {
        self.shouldReconnect = false
        self.connected = false
        self.activeConnectAttemptID = nil

        self.watchdogTask?.cancel()
        self.watchdogTask = nil

        self.tickTask?.cancel()
        self.tickTask = nil

        self.keepaliveTask?.cancel()
        self.keepaliveTask = nil

        self.task?.cancel(with: .goingAway, reason: nil)
        self.task = nil

        await self.failPending(NSError(
            domain: "Gateway",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "gateway channel shutdown"]))

        let waiters = self.connectWaiters
        self.connectWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(throwing: NSError(
                domain: "Gateway",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "gateway channel shutdown"]))
        }
    }

    private func startWatchdog() {
        self.watchdogTask?.cancel()
        self.watchdogTask = Task { [weak self] in
            guard let self else { return }
            await self.watchdogLoop()
        }
    }

    private func watchdogLoop() async {
        // Keep nudging reconnect in case exponential backoff stalls.
        while self.shouldReconnect {
            guard await self.sleepUnlessCancelled(nanoseconds: 30 * 1_000_000_000) else { return } // 30s cadence
            guard self.shouldReconnect else { return }
            if self.reconnectPausedForAuthFailure { continue }
            if self.connected { continue }
            do {
                try await self.connect()
            } catch {
                if self.shouldPauseReconnectAfterAuthFailure(error) {
                    self.reconnectPausedForAuthFailure = true
                    self.logger.error(
                        "gateway watchdog reconnect paused for non-recoverable auth failure \(error.localizedDescription, privacy: .public)")
                    continue
                }
                let wrapped = self.wrap(error, context: "gateway watchdog reconnect")
                self.logger.error("gateway watchdog reconnect failed \(wrapped.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Operator-supplied proxy credentials (Cloudflare Access-style) ride on the upgrade
    /// request. Read from the provider at connect time so edits apply on the next reconnect
    /// without re-pairing. Values are credentials: never log them.
    private func makeUpgradeRequest() -> URLRequest {
        var request = URLRequest(url: self.url)
        // Custom headers can contain service tokens or Authorization values. Do not even read
        // the provider for cleartext routes, where credentials would be exposed in transit.
        guard self.url.scheme?.lowercased() == "wss" else { return request }
        guard let headers = self.extraHeadersProvider?(), !headers.isEmpty else { return request }
        for (name, value) in GatewayCustomHeaders.sanitized(headers) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    public func connect() async throws {
        if self.connected, self.task?.state == .running { return }
        if self.isConnecting {
            try await withCheckedThrowingContinuation { cont in
                self.connectWaiters.append(cont)
            }
            return
        }
        self.isConnecting = true
        defer { self.isConnecting = false }

        self.task?.cancel(with: .goingAway, reason: nil)
        let attemptID = UUID()
        let connectTask = self.session.makeWebSocketTask(request: self.makeUpgradeRequest())
        self.activeConnectAttemptID = attemptID
        self.task = connectTask
        connectTask.resume()
        do {
            try await AsyncTimeout.withTimeout(
                seconds: self.connectTimeoutSeconds,
                onTimeout: {
                    NSError(
                        domain: "Gateway",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "connect timed out"])
                },
                operation: { try await self.sendConnect(task: connectTask, attemptID: attemptID) })
            try self.ensureCurrentConnectAttempt(attemptID, task: connectTask)
        } catch {
            let wrapped: Error = if let authError = error as? GatewayConnectAuthError {
                authError
            } else {
                self.wrap(error, context: "connect to gateway @ \(self.url.absoluteString)")
            }
            if self.isCurrentConnectAttempt(attemptID, task: connectTask) {
                self.activeConnectAttemptID = nil
                self.connected = false
                self.task = nil
                connectTask.cancel(with: .goingAway, reason: nil)
                await self.disconnectHandler?("connect failed: \(wrapped.localizedDescription)")
            }
            let waiters = self.connectWaiters
            self.connectWaiters.removeAll()
            for waiter in waiters {
                waiter.resume(throwing: wrapped)
            }
            self.logger.error("gateway ws connect failed \(wrapped.localizedDescription, privacy: .public)")
            throw wrapped
        }
        self.activeConnectAttemptID = nil
        self.listen()
        self.connected = true
        self.reconnectPausedForAuthFailure = false
        self.backoffMs = 500
        self.lastSeq = nil
        self.startKeepalive()

        let waiters = self.connectWaiters
        self.connectWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(returning: ())
        }
    }

    private func startKeepalive() {
        self.keepaliveTask?.cancel()
        self.keepaliveTask = Task { [weak self] in
            guard let self else { return }
            await self.keepaliveLoop()
        }
    }

    private func keepaliveLoop() async {
        while self.shouldReconnect {
            guard await self.sleepUnlessCancelled(
                nanoseconds: UInt64(self.keepaliveIntervalSeconds * 1_000_000_000))
            else { return }
            guard self.shouldReconnect else { return }
            guard self.connected else { continue }
            guard let task = self.task else { continue }
            // Best-effort ping keeps NAT/proxy state alive without generating RPC load.
            do {
                try await task.sendPing()
            } catch {
                // Avoid spamming logs; the reconnect paths will surface meaningful errors.
            }
        }
    }

    private func sendConnect(task: WebSocketTaskBox, attemptID: UUID) async throws {
        defer { self.testConnectAttemptFinishedHandler?(attemptID) }
        try self.ensureCurrentConnectAttempt(attemptID, task: task)
        let platform = InstanceIdentity.platformString
        let primaryLocale = Locale.preferredLanguages.first ?? Locale.current.identifier
        let options = self.connectOptions ?? GatewayConnectOptions(
            role: "operator",
            scopes: defaultOperatorConnectScopes,
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "ui",
            clientDisplayName: InstanceIdentity.displayName)
        let clientDisplayName = options.clientDisplayName ?? InstanceIdentity.displayName
        let clientId = options.clientId
        let clientMode = options.clientMode
        let role = options.role
        let deviceIdentityProfile = options.deviceIdentityProfile
        let requestedScopes = options.scopes
        let scopesAreExplicit = options.scopesAreExplicit
        let includeDeviceIdentity = options.includeDeviceIdentity
        let allowStoredDeviceAuth = options.allowStoredDeviceAuth
        let deviceAuthGatewayID = options.deviceAuthGatewayID
        let identity = includeDeviceIdentity ? DeviceIdentityStore.loadOrCreate(profile: deviceIdentityProfile) : nil
        let selectedAuth = self.selectConnectAuth(
            role: role,
            includeDeviceIdentity: includeDeviceIdentity,
            allowStoredDeviceAuth: allowStoredDeviceAuth,
            deviceAuthGatewayID: deviceAuthGatewayID,
            deviceIdentityProfile: deviceIdentityProfile,
            deviceId: identity?.deviceId,
            requestedScopes: requestedScopes)
        let scopes = self.resolveConnectScopes(
            role: role,
            requestedScopes: requestedScopes,
            scopesAreExplicit: scopesAreExplicit,
            selectedAuth: selectedAuth)

        let reqId = UUID().uuidString
        var client: [String: ProtoAnyCodable] = [
            "id": ProtoAnyCodable(clientId),
            "displayName": ProtoAnyCodable(clientDisplayName),
            "version": ProtoAnyCodable(
                Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"),
            "platform": ProtoAnyCodable(platform),
            "mode": ProtoAnyCodable(clientMode),
            "instanceId": ProtoAnyCodable(InstanceIdentity.instanceId),
        ]
        client["deviceFamily"] = ProtoAnyCodable(InstanceIdentity.deviceFamily)
        if let model = InstanceIdentity.modelIdentifier {
            client["modelIdentifier"] = ProtoAnyCodable(model)
        }
        var params: [String: ProtoAnyCodable] = [
            "minProtocol": ProtoAnyCodable(GATEWAY_MIN_PROTOCOL_VERSION),
            "maxProtocol": ProtoAnyCodable(GATEWAY_PROTOCOL_VERSION),
            "client": ProtoAnyCodable(client),
            "caps": ProtoAnyCodable(options.caps),
            "locale": ProtoAnyCodable(primaryLocale),
            "userAgent": ProtoAnyCodable(ProcessInfo.processInfo.operatingSystemVersionString),
            "role": ProtoAnyCodable(role),
            "scopes": ProtoAnyCodable(scopes),
        ]
        if !options.commands.isEmpty {
            params["commands"] = ProtoAnyCodable(options.commands)
        }
        if !options.permissions.isEmpty {
            params["permissions"] = ProtoAnyCodable(options.permissions)
        }
        if self.pendingDeviceTokenRetry,
           selectedAuth.authDeviceToken != nil || selectedAuth.suppressedDeviceTokenRetry
        {
            self.pendingDeviceTokenRetry = false
        }
        self.lastAuthSource = selectedAuth.authSource
        self.logger.info("gateway connect auth=\(selectedAuth.authSource.rawValue, privacy: .public)")
        if let authToken = selectedAuth.authToken {
            var auth: [String: ProtoAnyCodable] = ["token": ProtoAnyCodable(authToken)]
            if let authDeviceToken = selectedAuth.authDeviceToken {
                auth["deviceToken"] = ProtoAnyCodable(authDeviceToken)
            }
            params["auth"] = ProtoAnyCodable(auth)
        } else if let authBootstrapToken = selectedAuth.authBootstrapToken {
            params["auth"] = ProtoAnyCodable(["bootstrapToken": ProtoAnyCodable(authBootstrapToken)])
        } else if let password = selectedAuth.authPassword {
            params["auth"] = ProtoAnyCodable(["password": ProtoAnyCodable(password)])
        }
        let signedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        let connectNonce = try await self.waitForConnectChallenge(task: task, attemptID: attemptID)
        try self.ensureCurrentConnectAttempt(attemptID, task: task)
        if includeDeviceIdentity, let identity {
            let payload = GatewayDeviceAuthPayload.buildConnectCompatibilityPayload(
                deviceId: identity.deviceId,
                clientId: clientId,
                clientMode: clientMode,
                role: role,
                scopes: scopes,
                signedAtMs: signedAtMs,
                token: selectedAuth.signatureToken,
                nonce: connectNonce)
            if let device = GatewayDeviceAuthPayload.signedDeviceDictionary(
                payload: payload,
                identity: identity,
                signedAtMs: signedAtMs,
                nonce: connectNonce)
            {
                params["device"] = ProtoAnyCodable(device)
            }
        }

        let frame = RequestFrame(
            type: "req",
            id: reqId,
            method: "connect",
            params: ProtoAnyCodable(params))
        let data = try self.encoder.encode(frame)
        try await task.send(.data(data))
        try self.ensureCurrentConnectAttempt(attemptID, task: task)
        do {
            let response = try await self.waitForConnectResponse(
                reqId: reqId,
                task: task,
                attemptID: attemptID)
            try self.ensureCurrentConnectAttempt(attemptID, task: task)
            let issuedRoles = try self.handleConnectResponse(
                response,
                identity: identity,
                role: role,
                deviceAuthGatewayID: deviceAuthGatewayID,
                deviceIdentityProfile: deviceIdentityProfile)
            self.issuedDeviceAuthRoles.formUnion(issuedRoles)
            if issuedRoles.contains(role) {
                // Only a token persisted from this endpoint may unlock stored auth for its role.
                self.connectOptions?.allowStoredDeviceAuth = true
            }
            self.pendingDeviceTokenRetry = false
            self.deviceTokenRetryBudgetUsed = false
        } catch {
            try self.ensureCurrentConnectAttempt(attemptID, task: task)
            let shouldRetryWithDeviceToken = self.shouldRetryWithStoredDeviceToken(
                error: error,
                explicitGatewayToken: self.token?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                storedToken: selectedAuth.storedToken,
                attemptedDeviceTokenRetry: selectedAuth.authDeviceToken != nil)
            if shouldRetryWithDeviceToken {
                self.pendingDeviceTokenRetry = true
                self.deviceTokenRetryBudgetUsed = true
                self.backoffMs = min(self.backoffMs, 250)
            } else if selectedAuth.authDeviceToken != nil,
                      let identity,
                      self.shouldClearStoredDeviceTokenAfterRetry(error)
            {
                // Retry failed with an explicit device-token mismatch; clear stale local token.
                DeviceAuthStore.clearToken(
                    deviceId: identity.deviceId,
                    role: role,
                    gatewayID: deviceAuthGatewayID,
                    profile: deviceIdentityProfile)
            }
            throw error
        }
    }

    private func selectConnectAuth(
        role: String,
        includeDeviceIdentity: Bool,
        allowStoredDeviceAuth: Bool,
        deviceAuthGatewayID: String?,
        deviceIdentityProfile: GatewayDeviceIdentityProfile,
        deviceId: String?,
        requestedScopes: [String]) -> SelectedConnectAuth
    {
        let explicitToken = self.token?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let explicitBootstrapToken =
            self.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let explicitPassword = self.password?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let storedEntry =
            (includeDeviceIdentity && allowStoredDeviceAuth && deviceId != nil)
            ? DeviceAuthStore.loadToken(
                deviceId: deviceId!,
                role: role,
                gatewayID: deviceAuthGatewayID,
                profile: deviceIdentityProfile)
            : nil
        let storedToken = storedEntry?.token
        let storedScopes = storedEntry?.scopes ?? []
        let requestedScopesExceedStoredToken = Self.requestedScopesExceedStoredToken(
            role: role,
            requestedScopes: requestedScopes,
            storedToken: storedToken,
            storedScopes: storedScopes)
        let suppressedDeviceTokenRetry =
            includeDeviceIdentity && self.pendingDeviceTokenRetry &&
            requestedScopesExceedStoredToken && storedToken != nil && explicitToken != nil
        // Scope upgrades must be judged from the requested scopes. A stale
        // device-token retry carries the old grant and is rejected before pairing repair.
        let shouldUseDeviceRetryToken =
            includeDeviceIdentity && self.pendingDeviceTokenRetry &&
            !requestedScopesExceedStoredToken && storedToken != nil && explicitToken != nil &&
            self.isTrustedDeviceRetryEndpoint()
        let authToken =
            explicitToken ??
            // A freshly scanned setup code should force the bootstrap pairing path instead of
            // silently reusing an older stored device token.
            (includeDeviceIdentity && explicitPassword == nil && explicitBootstrapToken == nil
                ? storedToken
                : nil)
        let authBootstrapToken =
            authToken == nil && explicitPassword == nil ? explicitBootstrapToken : nil
        let authDeviceToken = shouldUseDeviceRetryToken ? storedToken : nil
        let authSource: GatewayAuthSource = if authDeviceToken != nil || (explicitToken == nil && authToken != nil) {
            .deviceToken
        } else if authToken != nil {
            .sharedToken
        } else if authBootstrapToken != nil {
            .bootstrapToken
        } else if explicitPassword != nil {
            .password
        } else {
            .none
        }
        return SelectedConnectAuth(
            authToken: authToken,
            authBootstrapToken: authBootstrapToken,
            authDeviceToken: authDeviceToken,
            authPassword: explicitPassword,
            signatureToken: authToken ?? authBootstrapToken,
            storedToken: storedToken,
            storedScopes: storedEntry?.scopes,
            authSource: authSource,
            suppressedDeviceTokenRetry: suppressedDeviceTokenRetry)
    }

    nonisolated static func _test_requestedScopesExceedStoredToken(
        role: String,
        requestedScopes: [String],
        storedToken: String?,
        storedScopes: [String]) -> Bool
    {
        self.requestedScopesExceedStoredToken(
            role: role,
            requestedScopes: requestedScopes,
            storedToken: storedToken,
            storedScopes: storedScopes)
    }

    private nonisolated static func requestedScopesExceedStoredToken(
        role: String,
        requestedScopes: [String],
        storedToken: String?,
        storedScopes: [String]) -> Bool
    {
        storedToken != nil && !storedScopes.isEmpty &&
            !self.storedDeviceTokenScopesAllow(
                role: role,
                requestedScopes: requestedScopes,
                storedScopes: storedScopes)
    }

    private nonisolated static func storedDeviceTokenScopesAllow(
        role: String,
        requestedScopes: [String],
        storedScopes: [String]) -> Bool
    {
        let requested = self.normalizedScopeList(requestedScopes)
        if requested.isEmpty {
            return true
        }
        let allowed = self.normalizedScopeList(storedScopes)
        if allowed.isEmpty {
            return false
        }
        let allowedSet = Set(allowed)
        let normalizedRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedRole != "operator" {
            let prefix = "\(normalizedRole)."
            return requested.allSatisfy { scope in
                scope.hasPrefix(prefix) && allowedSet.contains(scope)
            }
        }
        return requested.allSatisfy { scope in
            self.operatorScopeSatisfied(scope, granted: allowedSet)
        }
    }

    private nonisolated static func normalizedScopeList(_ scopes: [String]) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        for scope in scopes {
            let trimmed = scope.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || seen.contains(trimmed) {
                continue
            }
            seen.insert(trimmed)
            out.append(trimmed)
        }
        return out
    }

    private nonisolated static func operatorScopeSatisfied(_ scope: String, granted: Set<String>) -> Bool {
        if !scope.hasPrefix("operator.") {
            return false
        }
        if granted.contains("operator.admin") {
            return true
        }
        if scope == "operator.read" {
            return granted.contains("operator.read") || granted.contains("operator.write")
        }
        if scope == "operator.write" {
            return granted.contains("operator.write")
        }
        return granted.contains(scope)
    }

    private func shouldPersistBootstrapHandoffTokens() -> Bool {
        guard self.lastAuthSource == .bootstrapToken else { return false }
        let scheme = self.url.scheme?.lowercased()
        if scheme == "wss" {
            return true
        }
        guard scheme == "ws", let host = self.url.host else { return false }
        // Setup codes intentionally allow plaintext WebSocket bootstrap on local networks
        // for QR pairing. Persist the resulting bounded device token so reconnects do not
        // fall back to auth=none after the single-use bootstrap token is cleared.
        return LoopbackHost.isLocalNetworkHost(host)
    }

    private func filteredBootstrapHandoffScopes(role: String, scopes: [String]) -> [String]? {
        let normalizedRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
        switch normalizedRole {
        case "node":
            return []
        case "operator":
            let allowedOperatorScopes: Set = [
                "operator.approvals",
                "operator.read",
                "operator.talk.secrets",
                "operator.write",
            ]
            return Array(Set(scopes.filter { allowedOperatorScopes.contains($0) })).sorted()
        default:
            return nil
        }
    }

    private func resolveConnectScopes(
        role: String,
        requestedScopes: [String],
        scopesAreExplicit: Bool,
        selectedAuth: SelectedConnectAuth) -> [String]
    {
        if selectedAuth.authSource == .bootstrapToken,
           let filteredScopes = self.filteredBootstrapHandoffScopes(role: role, scopes: requestedScopes)
        {
            return filteredScopes
        }
        if selectedAuth.authSource == .deviceToken,
           !scopesAreExplicit,
           let storedScopes = selectedAuth.storedScopes,
           !storedScopes.isEmpty
        {
            return storedScopes
        }
        return requestedScopes
    }

    @discardableResult
    private func persistBootstrapHandoffToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String],
        deviceAuthGatewayID: String?,
        deviceIdentityProfile: GatewayDeviceIdentityProfile) -> Bool
    {
        guard let filteredScopes = self.filteredBootstrapHandoffScopes(role: role, scopes: scopes) else {
            return false
        }
        return DeviceAuthStore.storeTokenResult(
            deviceId: deviceId,
            role: role,
            token: token,
            scopes: filteredScopes,
            gatewayID: deviceAuthGatewayID,
            profile: deviceIdentityProfile).persisted
    }

    private func persistIssuedDeviceToken(
        authSource: GatewayAuthSource,
        deviceId: String,
        role: String,
        token: String,
        scopes: [String],
        deviceAuthGatewayID: String?,
        deviceIdentityProfile: GatewayDeviceIdentityProfile) -> Bool
    {
        if authSource == .bootstrapToken {
            guard self.shouldPersistBootstrapHandoffTokens() else {
                return false
            }
            return self.persistBootstrapHandoffToken(
                deviceId: deviceId,
                role: role,
                token: token,
                scopes: scopes,
                deviceAuthGatewayID: deviceAuthGatewayID,
                deviceIdentityProfile: deviceIdentityProfile)
        }
        return DeviceAuthStore.storeTokenResult(
            deviceId: deviceId,
            role: role,
            token: token,
            scopes: scopes,
            gatewayID: deviceAuthGatewayID,
            profile: deviceIdentityProfile).persisted
    }

    private func handleConnectResponse(
        _ res: ResponseFrame,
        identity: DeviceIdentity?,
        role: String,
        deviceAuthGatewayID: String?,
        deviceIdentityProfile: GatewayDeviceIdentityProfile) throws -> Set<String>
    {
        if res.ok == false {
            let error = res.error
            let msg = error?.message ?? "gateway connect failed"
            let details = gatewayErrorDetails(error)
            let detailCode = details["code"]?.value as? String
            let canRetryWithDeviceToken = details["canRetryWithDeviceToken"]?.value as? Bool ?? false
            let recommendedNextStep = details["recommendedNextStep"]?.value as? String
            let requestId = details["requestId"]?.value as? String
            let reason = details["reason"]?.value as? String
            let owner = details["owner"]?.value as? String
            let title = details["title"]?.value as? String
            let userMessage = details["userMessage"]?.value as? String
            let actionLabel = details["actionLabel"]?.value as? String
            let actionCommand = details["actionCommand"]?.value as? String
            let docsURLString = details["docsUrl"]?.value as? String
            let retryableOverride = details["retryable"]?.value as? Bool
            let pauseReconnectOverride = details["pauseReconnect"]?.value as? Bool
            let clientMinProtocol = gatewayIntValue(details["clientMinProtocol"]?.value)
            let clientMaxProtocol = gatewayIntValue(details["clientMaxProtocol"]?.value)
            let expectedProtocol = gatewayIntValue(details["expectedProtocol"]?.value)
            let minimumProbeProtocol = gatewayIntValue(details["minimumProbeProtocol"]?.value)
            throw GatewayConnectAuthError(
                message: msg,
                detailCodeRaw: detailCode,
                canRetryWithDeviceToken: canRetryWithDeviceToken,
                recommendedNextStepRaw: recommendedNextStep,
                requestId: requestId,
                detailsReason: reason,
                ownerRaw: owner,
                titleOverride: title,
                userMessageOverride: userMessage,
                actionLabel: actionLabel,
                actionCommand: actionCommand,
                docsURLString: docsURLString,
                retryableOverride: retryableOverride,
                pauseReconnectOverride: pauseReconnectOverride,
                clientMinProtocol: clientMinProtocol,
                clientMaxProtocol: clientMaxProtocol,
                expectedProtocol: expectedProtocol,
                minimumProbeProtocol: minimumProbeProtocol)
        }
        guard let payload = res.payload else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "connect failed (missing payload)"])
        }
        let payloadData = try self.encoder.encode(payload)
        let ok = try decoder.decode(HelloOk.self, from: payloadData)
        if let tick = ok.policy["tickIntervalMs"]?.value as? Double {
            self.tickIntervalMs = tick
        } else if let tick = ok.policy["tickIntervalMs"]?.value as? Int {
            self.tickIntervalMs = Double(tick)
        }
        let auth = ok.auth
        var issuedRoles = Set<String>()
        if let identity {
            if let deviceToken = auth["deviceToken"]?.value as? String {
                let authRole = auth["role"]?.value as? String ?? role
                let scopes = (auth["scopes"]?.value as? [ProtoAnyCodable])?
                    .compactMap { $0.value as? String } ?? []
                if self.persistIssuedDeviceToken(
                    authSource: self.lastAuthSource,
                    deviceId: identity.deviceId,
                    role: authRole,
                    token: deviceToken,
                    scopes: scopes,
                    deviceAuthGatewayID: deviceAuthGatewayID,
                    deviceIdentityProfile: deviceIdentityProfile)
                {
                    issuedRoles.insert(authRole)
                }
            }
            if self.shouldPersistBootstrapHandoffTokens(),
               let tokenEntries = auth["deviceTokens"]?.value as? [ProtoAnyCodable]
            {
                for entry in tokenEntries {
                    guard let rawEntry = entry.value as? [String: ProtoAnyCodable],
                          let deviceToken = rawEntry["deviceToken"]?.value as? String,
                          let authRole = rawEntry["role"]?.value as? String
                    else {
                        continue
                    }
                    let scopes = (rawEntry["scopes"]?.value as? [ProtoAnyCodable])?
                        .compactMap { $0.value as? String } ?? []
                    if self.persistBootstrapHandoffToken(
                        deviceId: identity.deviceId,
                        role: authRole,
                        token: deviceToken,
                        scopes: scopes,
                        deviceAuthGatewayID: deviceAuthGatewayID,
                        deviceIdentityProfile: deviceIdentityProfile)
                    {
                        issuedRoles.insert(authRole)
                    }
                }
            }
        }
        self.lastTick = Date()
        self.tickTask?.cancel()
        self.tickTask = Task { [weak self] in
            guard let self else { return }
            await self.watchTicks()
        }
        if let pushHandler = self.pushHandler {
            Task { await pushHandler(.snapshot(ok)) }
        }
        return issuedRoles
    }

    public func currentIssuedDeviceAuthRoles() -> Set<String> {
        self.issuedDeviceAuthRoles
    }

    private func listen() {
        self.task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .failure(err):
                Task { await self.handleReceiveFailure(err) }
            case let .success(msg):
                Task {
                    await self.handle(msg)
                    await self.listen()
                }
            }
        }
    }

    private func handleReceiveFailure(_ err: Error) async {
        let wrapped = self.wrap(err, context: "gateway receive")
        self.logger.error("gateway ws receive failed \(wrapped.localizedDescription, privacy: .public)")
        self.connected = false
        self.keepaliveTask?.cancel()
        self.keepaliveTask = nil
        await self.disconnectHandler?("receive failed: \(wrapped.localizedDescription)")
        await self.failPending(wrapped)
        await self.scheduleReconnect()
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) async {
        let data: Data? = switch msg {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return }
        guard let frame = try? self.decoder.decode(GatewayFrame.self, from: data) else {
            self.logger.error("gateway decode failed")
            return
        }
        switch frame {
        case let .res(res):
            let id = res.id
            if let waiter = pending.removeValue(forKey: id) {
                waiter.resume(returning: .res(res))
            }
        case let .event(evt):
            if evt.event == "connect.challenge" { return }
            if let seq = evt.seq {
                if let last = lastSeq, seq > last + 1 {
                    await self.pushHandler?(.seqGap(expected: last + 1, received: seq))
                }
                self.lastSeq = seq
            }
            if evt.event == "tick" { self.lastTick = Date() }
            await self.pushHandler?(.event(evt))
        default:
            break
        }
    }

    private func waitForConnectChallenge(task: WebSocketTaskBox, attemptID: UUID) async throws -> String {
        return try await AsyncTimeout.withTimeout(
            seconds: self.connectChallengeTimeoutSeconds,
            onTimeout: { ConnectChallengeError.timeout },
            operation: { [weak self] in
                guard let self else { throw ConnectChallengeError.timeout }
                while true {
                    let msg = try await task.receive()
                    try await self.ensureCurrentConnectAttempt(attemptID, task: task)
                    guard let data = self.decodeMessageData(msg) else { continue }
                    guard let frame = try? self.decoder.decode(GatewayFrame.self, from: data) else { continue }
                    if case let .event(evt) = frame, evt.event == "connect.challenge",
                       let payload = evt.payload?.value as? [String: ProtoAnyCodable],
                       let nonce = GatewayConnectChallengeSupport.nonce(from: payload)
                    {
                        return nonce
                    }
                }
            })
    }

    private func waitForConnectResponse(
        reqId: String,
        task: WebSocketTaskBox,
        attemptID: UUID) async throws -> ResponseFrame
    {
        while true {
            let msg = try await task.receive()
            try self.ensureCurrentConnectAttempt(attemptID, task: task)
            guard let data = self.decodeMessageData(msg) else { continue }
            guard let frame = try? self.decoder.decode(GatewayFrame.self, from: data) else {
                throw NSError(
                    domain: "Gateway",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "connect failed (invalid response)"])
            }
            if case let .res(res) = frame, res.id == reqId {
                return res
            }
        }
    }

    private func isCurrentConnectAttempt(_ attemptID: UUID, task candidate: WebSocketTaskBox) -> Bool {
        guard self.activeConnectAttemptID == attemptID, let task = self.task else { return false }
        return task.task === candidate.task
    }

    private func ensureCurrentConnectAttempt(_ attemptID: UUID, task candidate: WebSocketTaskBox) throws {
        // A timed-out handshake can finish after a retry installs another socket.
        // Every post-await step must still own its logical attempt and physical socket.
        try Task.checkCancellation()
        guard self.isCurrentConnectAttempt(attemptID, task: candidate) else { throw CancellationError() }
    }

    private nonisolated func decodeMessageData(_ msg: URLSessionWebSocketTask.Message) -> Data? {
        return switch msg {
        case let .data(data): data
        case let .string(text): text.data(using: .utf8)
        @unknown default: nil
        }
    }

    private func watchTicks() async {
        let tolerance = self.tickIntervalMs * 2
        while self.connected {
            guard await self.sleepUnlessCancelled(nanoseconds: UInt64(tolerance * 1_000_000)) else { return }
            guard self.connected else { return }
            if let last = self.lastTick {
                let delta = Date().timeIntervalSince(last) * 1000
                if delta > tolerance {
                    self.logger.error("gateway tick missed; reconnecting")
                    self.connected = false
                    await self.failPending(
                        NSError(
                            domain: "Gateway",
                            code: 4,
                            userInfo: [NSLocalizedDescriptionKey: "gateway tick missed; reconnecting"]))
                    await self.scheduleReconnect()
                    return
                }
            }
        }
    }

    private func scheduleReconnect() async {
        guard self.shouldReconnect else { return }
        guard !self.reconnectPausedForAuthFailure else { return }
        let delay = self.backoffMs / 1000
        self.backoffMs = min(self.backoffMs * 2, 30000)
        guard await self.sleepUnlessCancelled(nanoseconds: UInt64(delay * 1_000_000_000)) else { return }
        guard self.shouldReconnect else { return }
        guard !self.reconnectPausedForAuthFailure else { return }
        do {
            try await self.connect()
        } catch {
            if self.shouldPauseReconnectAfterAuthFailure(error) {
                self.reconnectPausedForAuthFailure = true
                self.logger.error(
                    "gateway reconnect paused for non-recoverable auth failure \(error.localizedDescription, privacy: .public)")
                return
            }
            let wrapped = self.wrap(error, context: "gateway reconnect")
            self.logger.error("gateway reconnect failed \(wrapped.localizedDescription, privacy: .public)")
            await self.scheduleReconnect()
        }
    }

    private func shouldRetryWithStoredDeviceToken(
        error: Error,
        explicitGatewayToken: String?,
        storedToken: String?,
        attemptedDeviceTokenRetry: Bool) -> Bool
    {
        if self.deviceTokenRetryBudgetUsed {
            return false
        }
        if attemptedDeviceTokenRetry {
            return false
        }
        guard explicitGatewayToken != nil, storedToken != nil else {
            return false
        }
        guard self.isTrustedDeviceRetryEndpoint() else {
            return false
        }
        guard let authError = error as? GatewayConnectAuthError else {
            return false
        }
        return authError.canRetryWithDeviceToken ||
            authError.detail == .authTokenMismatch
    }

    private func shouldPauseReconnectAfterAuthFailure(_ error: Error) -> Bool {
        guard let authError = error as? GatewayConnectAuthError else {
            return false
        }
        if authError.isNonRecoverable {
            return true
        }
        if authError.detail == .authTokenMismatch,
           self.deviceTokenRetryBudgetUsed, !self.pendingDeviceTokenRetry
        {
            return true
        }
        return false
    }

    private func shouldClearStoredDeviceTokenAfterRetry(_ error: Error) -> Bool {
        guard let authError = error as? GatewayConnectAuthError else {
            return false
        }
        return authError.detail == .authDeviceTokenMismatch
    }

    private func isTrustedDeviceRetryEndpoint() -> Bool {
        guard let host = self.url.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !host.isEmpty
        else {
            return false
        }
        if Self.isTrustedDeviceRetryLoopbackHost(host) {
            return true
        }
        if self.url.scheme?.lowercased() == "wss",
           let trust = self.session as? GatewayDeviceTokenRetryTrustProviding
        {
            return trust.allowsDeviceTokenRetryAuth
        }
        return false
    }

    private static func isTrustedDeviceRetryLoopbackHost(_ host: String) -> Bool {
        let normalized = LoopbackHost.normalizedHost(host)
        if normalized == "0.0.0.0" || normalized == "::" {
            return false
        }
        return LoopbackHost.isLoopbackHost(normalized)
    }

    private nonisolated func sleepUnlessCancelled(nanoseconds: UInt64) async -> Bool {
        do {
            try await Task.sleep(nanoseconds: nanoseconds)
        } catch {
            return false
        }
        return !Task.isCancelled
    }

    public func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil) async throws -> Data
    {
        try await self.connectOrThrow(context: "gateway connect")
        // Zero leaves terminal-operation deadlines to the Gateway owner.
        let effectiveTimeout = Self.resolveRequestTimeoutMs(timeoutMs, defaultMs: self.defaultRequestTimeoutMs)
        let payload = try self.encodeRequest(method: method, params: params, kind: "request")
        let response = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<GatewayFrame, Error>) in
            self.pending[payload.id] = cont
            if let effectiveTimeout {
                Task { [weak self] in
                    guard let self else { return }
                    try? await Task.sleep(nanoseconds: UInt64(effectiveTimeout * 1_000_000))
                    await self.timeoutRequest(id: payload.id, timeoutMs: effectiveTimeout)
                }
            }
            Task {
                do {
                    try await self.task?.send(.data(payload.data))
                } catch {
                    let wrapped = self.wrap(error, context: "gateway send \(method)")
                    let waiter = self.pending.removeValue(forKey: payload.id)
                    // Treat send failures as a broken socket: mark disconnected and trigger reconnect.
                    self.connected = false
                    self.task?.cancel(with: .goingAway, reason: nil)
                    Task { [weak self] in
                        guard let self else { return }
                        await self.scheduleReconnect()
                    }
                    if let waiter { waiter.resume(throwing: wrapped) }
                }
            }
        }
        guard case let .res(res) = response else {
            throw NSError(domain: "Gateway", code: 2, userInfo: [NSLocalizedDescriptionKey: "unexpected frame"])
        }
        if res.ok == false {
            let code = res.error?.code
            let msg = res.error?.message
            let details = gatewayErrorDetails(res.error)
            throw GatewayResponseError(method: method, code: code, message: msg, details: details)
        }
        if let payload = res.payload {
            // Encode back to JSON with Swift's encoder to preserve types and avoid ObjC bridging exceptions.
            return try self.encoder.encode(payload)
        }
        return Data() // Should not happen, but tolerate empty payloads.
    }

    public func send(method: String, params: [String: AnyCodable]?) async throws {
        try await self.connectOrThrow(context: "gateway connect")
        let payload = try self.encodeRequest(method: method, params: params, kind: "send")
        guard let task = self.task else {
            throw NSError(
                domain: "Gateway",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "gateway socket unavailable"])
        }
        do {
            try await task.send(.data(payload.data))
        } catch {
            let wrapped = self.wrap(error, context: "gateway send \(method)")
            self.connected = false
            self.task?.cancel(with: .goingAway, reason: nil)
            Task { [weak self] in
                guard let self else { return }
                await self.scheduleReconnect()
            }
            throw wrapped
        }
    }

    /// Wrap low-level URLSession/WebSocket errors with context so UI can surface them.
    private func wrap(_ error: Error, context: String) -> Error {
        if error is GatewayConnectAuthError ||
            error is GatewayResponseError ||
            error is GatewayDecodingError ||
            error is GatewayTLSValidationError
        {
            return error
        }
        if let urlError = error as? URLError {
            if let failure = (self.session as? GatewayTLSFailureProviding)?.consumeLastTLSFailure() {
                return GatewayTLSValidationError(failure: failure, context: context)
            }
            let desc = urlError.localizedDescription.isEmpty ? "cancelled" : urlError.localizedDescription
            return NSError(
                domain: URLError.errorDomain,
                code: urlError.errorCode,
                userInfo: [NSLocalizedDescriptionKey: "\(context): \(desc)"])
        }
        let ns = error as NSError
        let desc = ns.localizedDescription.isEmpty ? "unknown" : ns.localizedDescription
        return NSError(domain: ns.domain, code: ns.code, userInfo: [NSLocalizedDescriptionKey: "\(context): \(desc)"])
    }

    private func connectOrThrow(context: String) async throws {
        do {
            try await self.connect()
        } catch {
            throw self.wrap(error, context: context)
        }
    }

    private func encodeRequest(
        method: String,
        params: [String: AnyCodable]?,
        kind: String) throws -> (id: String, data: Data)
    {
        let id = UUID().uuidString
        // Encode request using the generated models to avoid JSONSerialization/ObjC bridging pitfalls.
        let paramsObject: ProtoAnyCodable? = params.map { entries in
            let dict = entries.reduce(into: [String: ProtoAnyCodable]()) { dict, entry in
                dict[entry.key] = ProtoAnyCodable(entry.value.value)
            }
            return ProtoAnyCodable(dict)
        }
        let frame = RequestFrame(
            type: "req",
            id: id,
            method: method,
            params: paramsObject)
        do {
            let data = try self.encoder.encode(frame)
            return (id: id, data: data)
        } catch {
            self.logger.error(
                "gateway \(kind) encode failed \(method, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    private func failPending(_ error: Error) async {
        let waiters = self.pending
        self.pending.removeAll()
        for (_, waiter) in waiters {
            waiter.resume(throwing: error)
        }
    }

    private func timeoutRequest(id: String, timeoutMs: Double) async {
        guard let waiter = self.pending.removeValue(forKey: id) else { return }
        let err = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out after \(Int(timeoutMs))ms"])
        waiter.resume(throwing: err)
    }
}

// Intentionally no `GatewayChannel` wrapper: the app should use the single shared `GatewayConnection`.
