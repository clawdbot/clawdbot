import CryptoKit
import Foundation
import OpenClawProtocol
import OSLog

private struct NodeInvokeRequestPayload: Codable {
    var id: String
    var nodeId: String
    var command: String
    var paramsJSON: String?
    var timeoutMs: Int?
    var idempotencyKey: String?
}

private struct NodeInvokeCancelPayload: Codable {
    var invokeId: String
}

func canonicalizeCanvasHostUrl(raw: String?, activeURL: URL?) -> String? {
    let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty else { return nil }
    guard var parsed = URLComponents(string: trimmed) else { return trimmed }

    let parsedHost = parsed.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let parsedIsLoopback = !parsedHost.isEmpty && LoopbackHost.isLoopback(parsedHost)

    if !parsedHost.isEmpty, !parsedIsLoopback {
        guard let activeURL else { return trimmed }
        let isTLS = activeURL.scheme?.lowercased() == "wss"
        guard isTLS else { return trimmed }
        parsed.scheme = "https"
        if parsed.port == nil {
            let tlsPort = activeURL.port ?? 443
            parsed.port = (tlsPort == 443) ? nil : tlsPort
        }
        return parsed.string ?? trimmed
    }

    guard let activeURL, let fallbackHost = activeURL.host, !LoopbackHost.isLoopback(fallbackHost) else {
        return trimmed
    }
    let isTLS = activeURL.scheme?.lowercased() == "wss"
    parsed.scheme = isTLS ? "https" : "http"
    parsed.host = fallbackHost
    let fallbackPort = activeURL.port ?? (isTLS ? 443 : 80)
    parsed.port = ((isTLS && fallbackPort == 443) || (!isTLS && fallbackPort == 80)) ? nil : fallbackPort
    return parsed.string ?? trimmed
}

/// Binds suspended work to one installed gateway channel generation.
/// Callers use this lease so an actor hop cannot retarget a payload to a replacement gateway.
public struct GatewayNodeSessionRoute: Sendable, Equatable {
    fileprivate let channelGeneration: UInt64
    fileprivate let admissionGeneration: UInt64
    fileprivate let socketGeneration: UInt64
}

/// A route lease became stale before its request touched the channel. Unlike
/// a socket cancellation, this proves the payload was never dispatched.
public enum GatewayNodeSessionRequestError: Error, Sendable {
    case routeChangedBeforeDispatch
}

/// Owns a server-event stream until its caller is finished or canceled.
public struct GatewayServerEventSubscription: Sendable {
    public let events: AsyncStream<EventFrame>
    private let continuation: AsyncStream<EventFrame>.Continuation

    fileprivate init(
        events: AsyncStream<EventFrame>,
        continuation: AsyncStream<EventFrame>.Continuation)
    {
        self.events = events
        self.continuation = continuation
    }

    /// Finishes the stream and unregisters its Gateway subscriber.
    public func cancel() {
        self.continuation.finish()
    }
}

public struct GatewayNodeSessionCredentials: Sendable, Equatable {
    public let token: String?
    public let bootstrapToken: String?
    public let password: String?

    public init(
        token: String? = nil,
        bootstrapToken: String? = nil,
        password: String? = nil)
    {
        self.token = token
        self.bootstrapToken = bootstrapToken
        self.password = password
    }
}

public actor GatewayNodeSession {
    @TaskLocal private static var executingLifecycleCallbackID: UUID?

    private static let staleRouteInvokeMessage = "UNAVAILABLE: node route changed before dispatch"
    private enum ComputerInvokeReceiptState {
        case inFlight(Task<BridgeInvokeResponse, Never>)
        case completed(BridgeInvokeResponse)

        var isCompleted: Bool {
            if case .completed = self {
                return true
            }
            return false
        }
    }

    private struct ComputerInvokeReceipt {
        let id: UUID
        let fingerprint: String
        var state: ComputerInvokeReceiptState
        var operationSettled: Bool
    }

    private struct ConnectOptionsKey: Equatable {
        let normalizedInputs: String
        let deviceAuthGatewayIDBytes: [UInt8]?
    }

    private struct ComputerInvokeReceiptKey: Hashable {
        let receiptScopeBytes: [UInt8]
        let idempotencyKeyBytes: [UInt8]

        init(receiptScope: String, idempotencyKey: String) {
            self.receiptScopeBytes = Array(receiptScope.utf8)
            self.idempotencyKeyBytes = Array(idempotencyKey.utf8)
        }
    }

    private struct ActiveInvoke {
        let admissionGeneration: UInt64
        let task: Task<BridgeInvokeResponse, Never>
    }

    private struct LifecycleCallbackBarrier {
        let id: UUID
        let task: Task<Void, Never>
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "node.gateway")
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private static let defaultInvokeTimeoutMs = 30000
    private static let maxInvokeTimeoutMs = Int(Int32.max)
    private static let computerInvokeReceiptLimit = 256
    private var channel: GatewayChannelActor?
    private var activeURL: URL?
    private var activeCredentials: GatewayNodeSessionCredentials?
    private var activeConnectOptionsKey: ConnectOptionsKey?
    private var activeSessionIdentity: ObjectIdentifier?
    private var channelGeneration: UInt64 = 0
    private var admissionGeneration: UInt64 = 0
    // A delayed push keeps its physical socket epoch. Once disconnect cleanup
    // retires that epoch, it cannot adopt the replacement route's admission.
    private var activeSocketGeneration: UInt64?
    private var lastRetiredSocketGeneration: UInt64?
    private var routeTeardownBarrier: Task<Void, Never>?
    private var lifecycleCallbackBarrier: LifecycleCallbackBarrier?
    private var executingLifecycleCallbackIDs: Set<UUID> = []
    private var activeInvokes: [UUID: ActiveInvoke] = [:]
    private var connectOptions: GatewayConnectOptions?
    private var onConnected: (@Sendable () async -> Void)?
    private var onDisconnected: (@Sendable (String) async -> Void)?
    private var onInvoke: (@Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse)?
    private var onInvokeInput: (@Sendable (NodeInvokeInputEvent) async -> Void)?
    private var onInvokeCancel: (@Sendable (String) async -> Void)?
    private var onRouteInvalidated: (@Sendable () async -> Void)?
    private var hasEverConnected = false
    private var hasNotifiedConnected = false
    private var snapshotReceived = false
    private var serverMethods: Set<String>?
    private var serverCapabilities: Set<GatewayServerCapability>?
    private var mainSessionKey: String?
    private var snapshotWaiters: [CheckedContinuation<Bool, Never>] = []
    private var snapshotReadyWaiters: [CheckedContinuation<Bool, Never>] = []
    // `computer.act` is not safe to repeat after a response is lost. Keep recent
    // in-flight/results on the long-lived node session so a channel reconnect can
    // replay the receipt without posting input twice. App restart intentionally
    // remains a wider durable-storage boundary.
    private var computerInvokeReceipts: [ComputerInvokeReceiptKey: ComputerInvokeReceipt] = [:]
    private var computerInvokeReceiptOrder: [ComputerInvokeReceiptKey] = []
    #if DEBUG
    private var computerInvokeReceiptJoinCounts: [UUID: Int] = [:]
    #endif

    static func invokeWithTimeout(
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onOperationSettled: (@Sendable () async -> Void)? = nil) async -> BridgeInvokeResponse
    {
        let timeoutLogger = Logger(subsystem: "ai.openclaw", category: "node.gateway")
        let timeout: Int = {
            if let timeoutMs {
                return min(max(0, timeoutMs), Self.maxInvokeTimeoutMs)
            }
            return Self.defaultInvokeTimeoutMs
        }()
        guard timeout > 0 else {
            let response = await onInvoke(request)
            await onOperationSettled?()
            return response
        }

        // Use an explicit latch so timeouts win even if onInvoke blocks (e.g., permission prompts).
        final class InvokeLatch: @unchecked Sendable {
            private let lock = NSLock()
            private var continuation: CheckedContinuation<BridgeInvokeResponse, Never>?
            private var resumed = false

            func setContinuation(_ continuation: CheckedContinuation<BridgeInvokeResponse, Never>) {
                self.lock.lock()
                defer { self.lock.unlock() }
                self.continuation = continuation
            }

            func resume(_ response: BridgeInvokeResponse) {
                let cont: CheckedContinuation<BridgeInvokeResponse, Never>?
                self.lock.lock()
                if self.resumed {
                    self.lock.unlock()
                    return
                }
                self.resumed = true
                cont = self.continuation
                self.continuation = nil
                self.lock.unlock()
                cont?.resume(returning: response)
            }
        }

        let latch = InvokeLatch()
        var onInvokeTask: Task<Void, Never>?
        var timeoutTask: Task<Void, Never>?
        defer {
            onInvokeTask?.cancel()
            timeoutTask?.cancel()
        }
        let response = await withCheckedContinuation { (cont: CheckedContinuation<BridgeInvokeResponse, Never>) in
            latch.setContinuation(cont)
            onInvokeTask = Task.detached {
                let result = await onInvoke(request)
                await onOperationSettled?()
                latch.resume(result)
            }
            timeoutTask = Task.detached {
                do {
                    try await Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000)
                } catch {
                    // Expected when invoke finishes first and cancels the timeout task.
                    return
                }
                guard !Task.isCancelled else { return }
                timeoutLogger.info("node invoke timeout fired id=\(request.id, privacy: .public)")
                latch.resume(BridgeInvokeResponse(
                    id: request.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "node invoke timed out")))
            }
        }
        timeoutLogger
            .info("node invoke race resolved id=\(request.id, privacy: .public) ok=\(response.ok, privacy: .public)")
        return response
    }

    private struct ServerEventSubscriber {
        let continuation: AsyncStream<EventFrame>.Continuation
        /// Filters before buffering so unrelated traffic cannot evict awaited events.
        let matches: @Sendable (EventFrame) -> Bool
    }

    private var serverEventSubscribers: [UUID: ServerEventSubscriber] = [:]
    private var pluginSurfaceUrls: [String: String] = [:]

    private struct PluginSurfaceRefreshResponse: Decodable {
        let pluginSurfaceUrls: [String: AnyCodable]?
    }

    public init() {}

    private func connectOptionsKey(_ options: GatewayConnectOptions) -> ConnectOptionsKey {
        func sorted(_ values: [String]) -> String {
            values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .sorted()
                .joined(separator: ",")
        }
        let role = options.role.trimmingCharacters(in: .whitespacesAndNewlines)
        let scopes = sorted(options.scopes)
        let caps = sorted(options.caps)
        let commands = sorted(options.commands)
        let pathEnv = options.pathEnv?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let clientId = options.clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientMode = options.clientMode.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientDisplayName = (options.clientDisplayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let deviceIdentityProfile = options.deviceIdentityProfile.rawValue
        let includeDeviceIdentity = options.includeDeviceIdentity ? "1" : "0"
        let allowStoredDeviceAuth = options.allowStoredDeviceAuth ? "1" : "0"
        let permissions = options.permissions
            .map { key, value in
                let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
                return "\(trimmed)=\(value ? "1" : "0")"
            }
            .sorted()
            .joined(separator: ",")

        let normalizedInputs = [
            role,
            scopes,
            caps,
            commands,
            pathEnv,
            clientId,
            clientMode,
            clientDisplayName,
            deviceIdentityProfile,
            includeDeviceIdentity,
            allowStoredDeviceAuth,
            permissions,
        ].joined(separator: "|")
        return ConnectOptionsKey(
            normalizedInputs: normalizedInputs,
            deviceAuthGatewayIDBytes: options.deviceAuthGatewayID.map { Array($0.utf8) })
    }

    public func connect(
        url: URL,
        credentials: GatewayNodeSessionCredentials,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        extraHeadersProvider: (@Sendable () -> [String: String])? = nil,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onInvokeInput: (@Sendable (NodeInvokeInputEvent) async -> Void)? = nil,
        onInvokeCancel: (@Sendable (String) async -> Void)? = nil,
        onRouteInvalidated: (@Sendable () async -> Void)? = nil) async throws
    {
        let nextOptionsKey = self.connectOptionsKey(connectOptions)
        let nextSessionIdentity = sessionBox.map { ObjectIdentifier($0.session) }
        let shouldReconnect = self.activeURL != url ||
            self.activeCredentials != credentials ||
            self.activeConnectOptionsKey != nextOptionsKey ||
            self.activeSessionIdentity != nextSessionIdentity ||
            self.channel == nil

        // Replacing a route from its own lifecycle callback would either await
        // itself or install ahead of its post-callback cleanup. Fail closed; the
        // owner can retry after the callback returns.
        guard !shouldReconnect || !self.isExecutingLifecycleCallback()
        else { throw CancellationError() }

        let channelGeneration: UInt64
        if shouldReconnect {
            let invalidatedAdmissionGeneration = self.admissionGeneration
            self.channelGeneration &+= 1
            self.admissionGeneration &+= 1
            channelGeneration = self.channelGeneration
            self.resetConnectionState()
            let existing = self.channel
            let previousOnRouteInvalidated = existing == nil ? nil : self.onRouteInvalidated
            // Invalidate and detach synchronously. Every later connect/disconnect then waits
            // on the same serialized teardown before it can install another route.
            self.channel = nil
            self.clearActiveRoute()
            let teardown = if let existing {
                self.enqueueRouteTeardown(
                    channel: existing,
                    admissionGeneration: invalidatedAdmissionGeneration,
                    onRouteInvalidated: previousOnRouteInvalidated)
            } else {
                self.routeTeardownBarrier
            }
            await teardown?.value
            // A newer connect or disconnect can run while teardown suspends. Never let the
            // superseded call install its endpoint or credentials afterward.
            guard self.channelGeneration == channelGeneration else { throw CancellationError() }
            let channel = GatewayChannelActor(
                url: url,
                token: credentials.token,
                bootstrapToken: credentials.bootstrapToken,
                password: credentials.password,
                session: sessionBox,
                pushHandler: { [weak self] push, socketGeneration in
                    await self?.handlePush(
                        push,
                        channelGeneration: channelGeneration,
                        socketGeneration: socketGeneration)
                },
                connectOptions: connectOptions,
                disconnectHandler: { [weak self] reason, socketGeneration in
                    await self?.handleChannelDisconnected(
                        reason,
                        channelGeneration: channelGeneration,
                        socketGeneration: socketGeneration)
                },
                // Intentionally outside the shouldReconnect identity key: the channel re-reads
                // the provider on every upgrade, so header edits ride the next reconnect
                // without forcing a new channel.
                extraHeadersProvider: extraHeadersProvider)
            self.channel = channel
            self.connectOptions = connectOptions
            self.onConnected = onConnected
            self.onDisconnected = onDisconnected
            self.onInvoke = onInvoke
            self.onInvokeInput = onInvokeInput
            self.onInvokeCancel = onInvokeCancel
            self.onRouteInvalidated = onRouteInvalidated
            self.activeURL = url
            self.activeCredentials = credentials
            self.activeConnectOptionsKey = nextOptionsKey
            self.activeSessionIdentity = nextSessionIdentity
        } else {
            channelGeneration = self.channelGeneration
            self.connectOptions = connectOptions
            self.onConnected = onConnected
            self.onDisconnected = onDisconnected
            self.onInvoke = onInvoke
            self.onInvokeInput = onInvokeInput
            self.onInvokeCancel = onInvokeCancel
            self.onRouteInvalidated = onRouteInvalidated
        }

        guard let channel else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "gateway channel unavailable",
            ])
        }

        do {
            // Bind this connect attempt to the admission epoch that owns the socket.
            // An in-place disconnect keeps the channel object/generation but advances
            // admission, so a drained snapshot waiter must not report a stale connect.
            let expectedAdmissionGeneration = self.admissionGeneration
            try await channel.connect()
            guard self.channelGeneration == channelGeneration,
                  self.admissionGeneration == expectedAdmissionGeneration,
                  self.channel === channel
            else { throw CancellationError() }
            _ = await self.waitForSnapshot(timeoutMs: 500)
            guard self.channelGeneration == channelGeneration,
                  self.admissionGeneration == expectedAdmissionGeneration,
                  self.channel === channel
            else { throw CancellationError() }
            await self.notifyConnectedIfNeeded(
                admissionGeneration: expectedAdmissionGeneration)
        } catch {
            throw error
        }
    }

    /// Keeps the flat overload source-compatible while credentials remain one reconnect identity.
    public func connect(
        url: URL,
        token: String? = nil,
        bootstrapToken: String? = nil,
        password: String? = nil,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        extraHeadersProvider: (@Sendable () -> [String: String])? = nil,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onInvokeInput: (@Sendable (NodeInvokeInputEvent) async -> Void)? = nil,
        onInvokeCancel: (@Sendable (String) async -> Void)? = nil,
        onRouteInvalidated: (@Sendable () async -> Void)? = nil) async throws
    {
        try await self.connect(
            url: url,
            credentials: GatewayNodeSessionCredentials(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password),
            connectOptions: connectOptions,
            sessionBox: sessionBox,
            extraHeadersProvider: extraHeadersProvider,
            onConnected: onConnected,
            onDisconnected: onDisconnected,
            onInvoke: onInvoke,
            onInvokeInput: onInvokeInput,
            onInvokeCancel: onInvokeCancel,
            onRouteInvalidated: onRouteInvalidated)
    }

    public func disconnect() async {
        let invalidatedAdmissionGeneration = self.admissionGeneration
        self.channelGeneration &+= 1
        self.admissionGeneration &+= 1
        let channel = self.channel
        let onRouteInvalidated = channel == nil ? nil : self.onRouteInvalidated
        self.channel = nil
        self.clearActiveRoute()
        self.hasEverConnected = false
        self.resetConnectionState()
        let teardown = if let channel {
            self.enqueueRouteTeardown(
                channel: channel,
                admissionGeneration: invalidatedAdmissionGeneration,
                onRouteInvalidated: onRouteInvalidated)
        } else {
            self.routeTeardownBarrier
        }
        if channel != nil || !self.isExecutingLifecycleCallback() {
            await teardown?.value
        }
    }

    private func clearActiveRoute() {
        self.activeURL = nil
        self.activeCredentials = nil
        self.activeConnectOptionsKey = nil
        self.activeSessionIdentity = nil
        self.connectOptions = nil
        self.onConnected = nil
        self.onDisconnected = nil
        self.onInvoke = nil
        self.onInvokeInput = nil
        self.onInvokeCancel = nil
        self.onRouteInvalidated = nil
        self.activeSocketGeneration = nil
        self.lastRetiredSocketGeneration = nil
    }

    private func enqueueRouteTeardown(
        channel: GatewayChannelActor,
        admissionGeneration: UInt64,
        onRouteInvalidated: (@Sendable () async -> Void)?) -> Task<Void, Never>
    {
        let isLifecycleReentry = self.isExecutingLifecycleCallback()
        let previous = self.routeTeardownBarrier
        let lifecycleCallback = self.lifecycleCallbackBarrier
        let activeInvokes = self.cancelActiveInvokes(admissionGeneration: admissionGeneration)
        let invalidationCallbackID = UUID()
        self.executingLifecycleCallbackIDs.insert(invalidationCallbackID)
        // Stop the detached transport concurrently with owner cleanup. Input release
        // must not wait on socket cancellation, but the old endpoint must not retain
        // automatic reconnect ownership while lifecycle callbacks are suspended.
        let channelShutdown = Task { await channel.shutdown() }
        let immediateTeardown = Task {
            await Self.$executingLifecycleCallbackID.withValue(invalidationCallbackID) {
                await onRouteInvalidated?()
            }
            await channelShutdown.value
        }
        let fullTeardown = Task {
            await immediateTeardown.value
            await previous?.value
            await lifecycleCallback?.task.value
            if lifecycleCallback != nil {
                await Self.$executingLifecycleCallbackID.withValue(invalidationCallbackID) {
                    await onRouteInvalidated?()
                }
            }
            await self.awaitActiveInvokes(activeInvokes)
            self.executingLifecycleCallbackIDs.remove(invalidationCallbackID)
        }
        // Successor routes always wait for the full callback cleanup. Only the
        // callback that initiated teardown receives the short, non-cyclic wait.
        self.routeTeardownBarrier = fullTeardown
        return isLifecycleReentry ? immediateTeardown : fullTeardown
    }

    private func enqueueLifecycleCallback(
        immediate: (@Sendable () async -> Void)? = nil,
        final: @escaping @Sendable () async -> Void) -> LifecycleCallbackBarrier
    {
        let previous = self.lifecycleCallbackBarrier?.task
        let id = UUID()
        self.executingLifecycleCallbackIDs.insert(id)
        let task = Task { [weak self] in
            await Self.$executingLifecycleCallbackID.withValue(id) {
                await immediate?()
                await previous?.value
                await final()
            }
            await self?.finishLifecycleCallback(id)
        }
        let barrier = LifecycleCallbackBarrier(id: id, task: task)
        self.lifecycleCallbackBarrier = barrier
        return barrier
    }

    private func clearLifecycleCallbackBarrier(_ id: UUID) {
        guard self.lifecycleCallbackBarrier?.id == id else { return }
        self.lifecycleCallbackBarrier = nil
    }

    private func finishLifecycleCallback(_ id: UUID) {
        self.executingLifecycleCallbackIDs.remove(id)
        self.clearLifecycleCallbackBarrier(id)
    }

    private func isExecutingLifecycleCallback() -> Bool {
        guard let id = Self.executingLifecycleCallbackID else { return false }
        return self.executingLifecycleCallbackIDs.contains(id)
    }

    public func currentIssuedDeviceAuthRoles() async -> Set<String> {
        guard let channel else { return [] }
        return await channel.currentIssuedDeviceAuthRoles()
    }

    public func currentCanvasHostUrl() -> String? {
        self.pluginSurfaceUrls["canvas"]
    }

    @discardableResult
    public func refreshPluginSurfaceUrl(surface: String, timeoutSeconds: Int = 8) async -> String? {
        guard let channel else { return nil }
        let trimmedSurface = surface.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSurface.isEmpty else { return nil }

        return await self.requestPluginSurfaceRefresh(
            channel: channel,
            method: "node.pluginSurface.refresh",
            params: ["surface": AnyCodable(trimmedSurface)],
            surface: trimmedSurface,
            timeoutSeconds: timeoutSeconds)
    }

    @discardableResult
    public func refreshCanvasHostUrl(timeoutSeconds: Int = 8) async -> String? {
        await self.refreshPluginSurfaceUrl(surface: "canvas", timeoutSeconds: timeoutSeconds)
    }

    public func currentRemoteAddress() -> String? {
        guard let url = activeURL else { return nil }
        guard let host = url.host else { return url.absoluteString }
        let port = url.port ?? (url.scheme == "wss" ? 443 : 80)
        if host.contains(":") {
            return "[\(host)]:\(port)"
        }
        return "\(host):\(port)"
    }

    public func currentRoute(ifGatewayID expectedGatewayID: String? = nil) async -> GatewayNodeSessionRoute? {
        guard let channel = self.channel else { return nil }
        if let expectedGatewayID {
            guard !expectedGatewayID.isEmpty,
                  let currentGatewayID = self.connectOptions?.deviceAuthGatewayID,
                  currentGatewayID.utf8.elementsEqual(expectedGatewayID.utf8)
            else { return nil }
        }
        let channelGeneration = self.channelGeneration
        let admissionGeneration = self.admissionGeneration
        guard let socketGeneration = await channel.currentConnectionGeneration(),
              self.channel === channel,
              self.channelGeneration == channelGeneration,
              self.admissionGeneration == admissionGeneration
        else { return nil }
        return GatewayNodeSessionRoute(
            channelGeneration: channelGeneration,
            admissionGeneration: admissionGeneration,
            socketGeneration: socketGeneration)
    }

    public func supportsServerCapability(
        _ capability: GatewayServerCapability,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute) -> Bool?
    {
        guard self.isCurrentRoute(expectedRoute),
              self.channel != nil,
              let serverCapabilities
        else { return nil }
        return serverCapabilities.contains(capability)
    }

    public func supportsServerMethod(
        _ method: String,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute) -> Bool?
    {
        guard self.isCurrentRoute(expectedRoute),
              self.channel != nil,
              let serverMethods
        else { return nil }
        return serverMethods.contains(method)
    }

    public func waitForCurrentMainSessionKey(
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute) async -> String?
    {
        guard self.isCurrentRoute(expectedRoute), self.channel != nil else { return nil }
        if !self.snapshotReceived {
            guard await self.waitForSnapshot() else { return nil }
        }
        guard self.isCurrentRoute(expectedRoute), self.channel != nil else { return nil }
        return self.mainSessionKey
    }

    @discardableResult
    public func sendEvent(
        event: String,
        payloadJSON: String?,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute? = nil) async -> Bool
    {
        guard !Task.isCancelled else { return false }
        if let expectedRoute, !self.isCurrentRoute(expectedRoute) {
            return false
        }
        guard let channel else { return false }
        let params: [String: AnyCodable] = [
            "event": AnyCodable(event),
            "payloadJSON": AnyCodable(payloadJSON ?? NSNull()),
        ]
        do {
            try Task.checkCancellation()
            try await channel.send(method: "node.event", params: params)
            return true
        } catch {
            self.logger.error("node event failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    public func request(
        method: String,
        paramsJSON: String?,
        timeoutSeconds: Int = 15,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute? = nil,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> Data
    {
        let params = try decodeParamsJSON(paramsJSON)
        return try await self.request(
            method: method,
            params: params,
            timeoutMs: Double(timeoutSeconds * 1000),
            ifCurrentRoute: expectedRoute,
            distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
    }

    public func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double = 15000,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute? = nil,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> Data
    {
        if let expectedRoute, !self.isCurrentRoute(expectedRoute) {
            if distinguishPreDispatchRouteChange {
                throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch
            }
            throw CancellationError()
        }
        guard let channel else {
            throw NSError(domain: "Gateway", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "not connected",
            ])
        }

        if let expectedRoute {
            return try await channel.request(
                method: method,
                params: params,
                timeoutMs: timeoutMs,
                ifCurrentConnectionGeneration: expectedRoute.socketGeneration)
        }
        return try await channel.request(
            method: method,
            params: params,
            timeoutMs: timeoutMs)
    }

    public func subscribeServerEvents(bufferingNewest: Int = 200) -> AsyncStream<EventFrame> {
        self.makeServerEventSubscription(bufferingNewest: bufferingNewest).events
    }

    public func makeServerEventSubscription(
        bufferingNewest: Int = 200,
        matching: @escaping @Sendable (EventFrame) -> Bool = { _ in true }) -> GatewayServerEventSubscription
    {
        let id = UUID()
        let session = self
        let (events, continuation) = AsyncStream<EventFrame>.makeStream(
            bufferingPolicy: .bufferingNewest(bufferingNewest))
        self.serverEventSubscribers[id] = ServerEventSubscriber(
            continuation: continuation,
            matches: matching)
        continuation.onTermination = { @Sendable _ in
            Task { await session.removeServerEventSubscriber(id) }
        }
        return GatewayServerEventSubscription(
            events: events,
            continuation: continuation)
    }
}

// MARK: - Inbound events and invokes

extension GatewayNodeSession {
    private func handlePush(
        _ push: GatewayPush,
        channelGeneration: UInt64,
        socketGeneration: UInt64) async
    {
        guard self.channelGeneration == channelGeneration,
              self.admitSocketGeneration(socketGeneration)
        else { return }
        switch push {
        case let .snapshot(ok):
            let admissionGeneration = self.admissionGeneration
            self.pluginSurfaceUrls = self.normalizePluginSurfaceUrls(ok.pluginsurfaceurls)
            self.serverMethods = ok.advertisedServerMethods()
            self.serverCapabilities = Set(
                GatewayServerCapability.allCases.filter { ok.supportsServerCapability($0) })
            let snapshotMainSessionKey = ok.snapshot.sessiondefaults?["mainSessionKey"]?.value as? String
            let trimmedMainSessionKey = snapshotMainSessionKey?
                .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines) ?? ""
            self.mainSessionKey = trimmedMainSessionKey.isEmpty ? nil : trimmedMainSessionKey
            if self.hasEverConnected {
                self.broadcastServerEvent(
                    EventFrame(type: "event", event: "seqGap", payload: nil, seq: nil, stateversion: nil))
            }
            self.hasEverConnected = true
            self.markSnapshotReceived()
            await self.notifyConnectedIfNeeded(
                admissionGeneration: admissionGeneration)
        case let .event(evt):
            guard let channel else { return }
            await self.handleEvent(
                evt,
                channel: channel,
                channelGeneration: channelGeneration,
                admissionGeneration: self.admissionGeneration,
                socketGeneration: socketGeneration)
        default:
            break
        }
    }

    private func resetConnectionState() {
        self.hasNotifiedConnected = false
        self.snapshotReceived = false
        self.serverMethods = nil
        self.serverCapabilities = nil
        self.mainSessionKey = nil
        self.drainSnapshotWaiters(returning: false)
        self.drainSnapshotReadyWaiters(returning: false)
    }

    private func handleChannelDisconnected(
        _ reason: String,
        channelGeneration: UInt64,
        socketGeneration: UInt64) async
    {
        guard self.channelGeneration == channelGeneration,
              self.retireSocketGeneration(socketGeneration)
        else { return }
        // The channel actor reconnects in place, so channelGeneration alone cannot
        // distinguish delayed work decoded before this socket loss. Revoke those
        // invoke leases before runtime cleanup; new events receive the fresh epoch.
        let invalidatedAdmissionGeneration = self.admissionGeneration
        self.admissionGeneration &+= 1
        let activeInvokes = self.cancelActiveInvokes(
            admissionGeneration: invalidatedAdmissionGeneration)
        let onRouteInvalidated = self.onRouteInvalidated
        let onDisconnected = self.onDisconnected
        // The underlying channel can auto-reconnect; resetting state here ensures we surface a fresh
        // onConnected callback once a new snapshot arrives after reconnect.
        self.resetConnectionState()
        // Transport reconnect must not wait on owner callbacks that can suspend
        // indefinitely. The lifecycle barrier still gates readiness and invokes.
        _ = self.enqueueLifecycleCallback(
            immediate: {
                // Release held input before waiting for a connected callback that
                // may already be suspended in owner code.
                await onRouteInvalidated?()
            },
            final: {
                // This cleanup runs after all older lifecycle callbacks, so they
                // cannot resume later and restore a disconnected route.
                await onDisconnected?(reason)
                await self.awaitActiveInvokes(activeInvokes)
            })
    }

    private func markSnapshotReceived() {
        self.snapshotReceived = true
        self.drainSnapshotWaiters(returning: true)
        self.drainSnapshotReadyWaiters(returning: true)
    }

    private func waitForSnapshot(timeoutMs: Int) async -> Bool {
        if self.snapshotReceived {
            return true
        }
        let clamped = max(0, timeoutMs)
        return await withCheckedContinuation { cont in
            self.snapshotWaiters.append(cont)
            Task { [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: UInt64(clamped) * 1_000_000)
                await self.timeoutSnapshotWaiters()
            }
        }
    }

    private func waitForSnapshot() async -> Bool {
        if self.snapshotReceived {
            return true
        }
        return await withCheckedContinuation { cont in
            self.snapshotReadyWaiters.append(cont)
        }
    }

    private func timeoutSnapshotWaiters() {
        guard !self.snapshotReceived else { return }
        self.drainSnapshotWaiters(returning: false)
    }

    private func drainSnapshotWaiters(returning value: Bool) {
        if !self.snapshotWaiters.isEmpty {
            let waiters = self.snapshotWaiters
            self.snapshotWaiters.removeAll()
            for waiter in waiters {
                waiter.resume(returning: value)
            }
        }
    }

    private func drainSnapshotReadyWaiters(returning value: Bool) {
        if !self.snapshotReadyWaiters.isEmpty {
            let waiters = self.snapshotReadyWaiters
            self.snapshotReadyWaiters.removeAll()
            for waiter in waiters {
                waiter.resume(returning: value)
            }
        }
    }

    private func notifyConnectedIfNeeded(admissionGeneration: UInt64) async {
        guard admissionGeneration == self.admissionGeneration else { return }
        if self.hasNotifiedConnected {
            // The snapshot delivery task can enqueue the callback before connect()
            // reaches this method. Join that callback so connect never returns early.
            let lifecycleCallback = self.lifecycleCallbackBarrier
            if !self.isExecutingLifecycleCallback() {
                await lifecycleCallback?.task.value
            }
            return
        }
        self.hasNotifiedConnected = true
        guard let onConnected = self.onConnected else { return }
        let lifecycleCallback = self.enqueueLifecycleCallback(final: onConnected)
        // A lifecycle callback may deliberately disconnect or replace its route.
        // Queue the successor callback behind it, but never make it await itself.
        if !self.isExecutingLifecycleCallback() {
            await lifecycleCallback.task.value
        }
    }

    private func normalizeCanvasHostUrl(_ raw: String?) -> String? {
        canonicalizeCanvasHostUrl(raw: raw, activeURL: self.activeURL)
    }

    private func normalizePluginSurfaceUrls(_ raw: [String: AnyCodable]?) -> [String: String] {
        var normalized: [String: String] = [:]
        if let raw {
            normalized = raw.compactMapValues { value in
                self.normalizeCanvasHostUrl(value.value as? String)
            }
        }
        return normalized
    }

    private func requestPluginSurfaceRefresh(
        channel: GatewayChannelActor,
        method: String,
        params: [String: AnyCodable]?,
        surface: String,
        timeoutSeconds: Int) async -> String?
    {
        do {
            let data = try await channel.request(
                method: method,
                params: params,
                timeoutMs: Double(timeoutSeconds * 1000))
            let decoded = try decoder.decode(PluginSurfaceRefreshResponse.self, from: data)
            let urls = self.normalizePluginSurfaceUrls(decoded.pluginSurfaceUrls)
            guard let refreshed = urls[surface] else { return nil }
            self.pluginSurfaceUrls[surface] = refreshed
            return refreshed
        } catch {
            self.logger.debug("\(method, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func handleEvent(
        _ evt: EventFrame,
        channel: GatewayChannelActor,
        channelGeneration: UInt64,
        admissionGeneration: UInt64,
        socketGeneration: UInt64) async
    {
        self.broadcastServerEvent(evt)
        if evt.event == "node.invoke.input" {
            guard let payload = evt.payload, let onInvokeInput else { return }
            do {
                let input: NodeInvokeInputEvent = try self.decodeEventPayload(from: payload)
                await onInvokeInput(input)
            } catch {
                self.logger.error("node invoke input decode failed: \(error.localizedDescription, privacy: .public)")
            }
            return
        }
        if evt.event == "node.invoke.cancel" {
            guard let payload = evt.payload, let onInvokeCancel else { return }
            do {
                let cancel: NodeInvokeCancelPayload = try self.decodeEventPayload(from: payload)
                await onInvokeCancel(cancel.invokeId)
            } catch {
                self.logger.error("node invoke cancel decode failed: \(error.localizedDescription, privacy: .public)")
            }
            return
        }
        guard evt.event == "node.invoke.request" else { return }
        self.logger.info("node invoke request received")
        guard let payload = evt.payload else { return }
        do {
            let request = try decodeInvokeRequest(from: payload)
            let timeoutLabel = request.timeoutMs.map(String.init) ?? "none"
            self.logger.info(
                """
                node invoke request decoded id=\(request.id, privacy: .public) \
                command=\(request.command, privacy: .public) \
                timeoutMs=\(timeoutLabel, privacy: .public)
                """)
            guard let onInvoke else { return }
            let route = GatewayNodeSessionRoute(
                channelGeneration: channelGeneration,
                admissionGeneration: admissionGeneration,
                socketGeneration: socketGeneration)
            let receiptScope = self.computerInvokeReceiptScope()
            // GatewayChannel waits for push handling before it rearms receive. Run device work
            // separately so a long invoke cannot starve heartbeats or later node requests.
            Task.detached { [weak self] in
                await self?.handleInvokeRequest(
                    request: request,
                    onInvoke: onInvoke,
                    route: route,
                    receiptScope: receiptScope,
                    channel: channel,
                    socketGeneration: socketGeneration)
            }
        } catch {
            self.logger.error("node invoke decode failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func handleInvokeRequest(
        request: NodeInvokeRequestPayload,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        route: GatewayNodeSessionRoute,
        receiptScope: String,
        channel: GatewayChannelActor,
        socketGeneration: UInt64) async
    {
        guard self.isCurrentRoute(route),
              self.channel === channel
        else { return }
        // Lifecycle cleanup gates owner readiness. Reject while it is suspended instead of
        // holding the Gateway request until timeout; the replacement route stays fail-closed.
        if self.lifecycleCallbackBarrier != nil {
            self.logger.info("node invoke rejected during lifecycle transition id=\(request.id, privacy: .public)")
            await self.sendInvokeResult(
                request: request,
                response: BridgeInvokeResponse(
                    id: request.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "UNAVAILABLE: node lifecycle transition in progress")),
                channel: channel,
                socketGeneration: socketGeneration)
            return
        }
        self.logger.info("node invoke executing id=\(request.id, privacy: .public)")
        let bridgeRequest = BridgeInvokeRequest(
            id: request.id,
            command: request.command,
            paramsJSON: request.paramsJSON,
            nodeId: request.nodeId)
        let routeBoundInvoke: @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse = { [weak self] req in
            guard let self else {
                return Self.staleRouteInvokeResponse(requestId: req.id)
            }
            return await self.invokeIfCurrentRoute(
                req,
                expectedRoute: route,
                onInvoke: onInvoke)
        }
        let response = await invokeWithComputerReceipt(
            requestPayload: request,
            request: bridgeRequest,
            timeoutMs: request.timeoutMs,
            receiptScope: receiptScope,
            onInvoke: routeBoundInvoke)
        // Invoke output belongs to the requesting channel. A target switch while the device
        // command is running must discard it instead of disclosing it to the replacement.
        guard self.isCurrentRoute(route),
              self.channel === channel
        else { return }
        self.logger.info(
            "node invoke completed id=\(request.id, privacy: .public) ok=\(response.ok, privacy: .public)")
        await self.sendInvokeResult(
            request: request,
            response: response,
            channel: channel,
            socketGeneration: socketGeneration)
    }

    func invokeIfCurrentRoute(
        _ request: BridgeInvokeRequest,
        expectedRoute: GatewayNodeSessionRoute,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse) async
        -> BridgeInvokeResponse
    {
        guard self.isCurrentRoute(expectedRoute),
              self.channel != nil
        else { return Self.staleRouteInvokeResponse(requestId: request.id) }
        let requiresRouteScopedCancellation = request.command == "computer.act" ||
            OpenClawTalkCommand(rawValue: request.command) != nil
        guard requiresRouteScopedCancellation else {
            return await onInvoke(request)
        }
        // These side-effecting commands own explicit cancellation cleanup. Route
        // teardown waits for it so a replacement cannot inherit input ownership.
        let invokeID = UUID()
        let task = Task { await onInvoke(request) }
        self.activeInvokes[invokeID] = ActiveInvoke(
            admissionGeneration: expectedRoute.admissionGeneration,
            task: task)
        let response = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        self.activeInvokes.removeValue(forKey: invokeID)
        return response
    }

    private func isCurrentRoute(_ route: GatewayNodeSessionRoute) -> Bool {
        route.channelGeneration == self.channelGeneration &&
            route.admissionGeneration == self.admissionGeneration
    }

    private func admitSocketGeneration(_ socketGeneration: UInt64) -> Bool {
        if let lastRetiredSocketGeneration,
           socketGeneration <= lastRetiredSocketGeneration
        {
            return false
        }
        if let activeSocketGeneration {
            return socketGeneration == activeSocketGeneration
        }
        self.activeSocketGeneration = socketGeneration
        return true
    }

    private func retireSocketGeneration(_ socketGeneration: UInt64) -> Bool {
        if let lastRetiredSocketGeneration,
           socketGeneration <= lastRetiredSocketGeneration
        {
            return false
        }
        if let activeSocketGeneration,
           socketGeneration != activeSocketGeneration
        {
            return false
        }
        self.activeSocketGeneration = nil
        self.lastRetiredSocketGeneration = socketGeneration
        return true
    }

    #if DEBUG
    // periphery:ignore - package tests observe admission rollover without exposing mutable state.
    func _test_admissionGeneration() -> UInt64 {
        self.admissionGeneration
    }

    // periphery:ignore - package tests drive the private connection callback deterministically.
    func _test_notifyConnectedIfNeeded(admissionGeneration: UInt64) async {
        await self.notifyConnectedIfNeeded(admissionGeneration: admissionGeneration)
    }

    // periphery:ignore - package tests inject gateway pushes without a live socket.
    func _test_handlePush(_ push: GatewayPush, socketGeneration: UInt64) async {
        await self.handlePush(
            push,
            channelGeneration: self.channelGeneration,
            socketGeneration: socketGeneration)
    }

    // periphery:ignore - package tests inject socket retirement without a live channel.
    func _test_handleChannelDisconnected(_ reason: String, socketGeneration: UInt64) async {
        await self.handleChannelDisconnected(
            reason,
            channelGeneration: self.channelGeneration,
            socketGeneration: socketGeneration)
    }

    // periphery:ignore - package tests verify event stream filtering without a live gateway.
    func _test_broadcastServerEvent(_ event: EventFrame) {
        self.broadcastServerEvent(event)
    }
    #endif

    private func cancelActiveInvokes(
        admissionGeneration: UInt64) -> [(id: UUID, task: Task<BridgeInvokeResponse, Never>)]
    {
        let matches = self.activeInvokes.compactMap { id, invoke in
            invoke.admissionGeneration == admissionGeneration
                ? (id: id, task: invoke.task)
                : nil
        }
        for match in matches {
            match.task.cancel()
        }
        return matches
    }

    private func awaitActiveInvokes(
        _ invokes: [(id: UUID, task: Task<BridgeInvokeResponse, Never>)]) async
    {
        for invoke in invokes {
            _ = await invoke.task.value
            self.activeInvokes.removeValue(forKey: invoke.id)
        }
    }

    private static func staleRouteInvokeResponse(requestId: String) -> BridgeInvokeResponse {
        BridgeInvokeResponse(
            id: requestId,
            ok: false,
            error: OpenClawNodeError(
                code: .unavailable,
                message: self.staleRouteInvokeMessage))
    }

    private func invokeWithComputerReceipt(
        requestPayload: NodeInvokeRequestPayload,
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        receiptScope: String,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        retryStaleJoinedReceipt: Bool = true) async
        -> BridgeInvokeResponse
    {
        let idempotencyKey = requestPayload.idempotencyKey?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard requestPayload.command == "computer.act", !idempotencyKey.isEmpty else {
            return await Self.invokeWithTimeout(
                request: request,
                timeoutMs: timeoutMs,
                onInvoke: onInvoke)
        }

        let receiptKey = ComputerInvokeReceiptKey(
            receiptScope: receiptScope,
            idempotencyKey: idempotencyKey)
        let fingerprint = Self.computerInvokeFingerprint(requestPayload)
        if let receipt = computerInvokeReceipts[receiptKey] {
            guard receipt.fingerprint == fingerprint else {
                return BridgeInvokeResponse(
                    id: request.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .invalidRequest,
                        message: "INVALID_REQUEST: computer.act idempotency key reused with different parameters"))
            }
            #if DEBUG
            self.computerInvokeReceiptJoinCounts[receipt.id, default: 0] += 1
            #endif
            let response = switch receipt.state {
            case let .inFlight(task): await task.value
            case let .completed(response): response
            }
            self.discardRetryableComputerInvokeReceipt(
                key: receiptKey,
                receiptID: receipt.id,
                fingerprint: fingerprint,
                response: response)
            if retryStaleJoinedReceipt, Self.isStaleRouteInvokeResponse(response) {
                // A reconnect retry can join the old route's in-flight receipt.
                // Once that receipt proves it never dispatched, retry exactly once
                // with this request's route-bound invoke closure.
                return await self.invokeWithComputerReceipt(
                    requestPayload: requestPayload,
                    request: request,
                    timeoutMs: timeoutMs,
                    receiptScope: receiptScope,
                    onInvoke: onInvoke,
                    retryStaleJoinedReceipt: false)
            }
            return Self.rebindInvokeResponse(response, requestId: request.id)
        }

        guard self.makeComputerInvokeReceiptCapacity() else {
            return BridgeInvokeResponse(
                id: request.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "UNAVAILABLE: computer.act receipt capacity exhausted"))
        }

        let receiptID = UUID()
        let task = Task { [self] in
            await Self.invokeWithTimeout(
                request: request,
                timeoutMs: timeoutMs,
                onInvoke: onInvoke,
                onOperationSettled: { [weak self] in
                    await self?.markComputerInvokeOperationSettled(
                        key: receiptKey,
                        receiptID: receiptID,
                        fingerprint: fingerprint)
                })
        }
        self.computerInvokeReceipts[receiptKey] = ComputerInvokeReceipt(
            id: receiptID,
            fingerprint: fingerprint,
            state: .inFlight(task),
            operationSettled: false)
        self.computerInvokeReceiptOrder.append(receiptKey)
        let response = await task.value
        if Self.isStaleRouteInvokeResponse(response) {
            self.discardRetryableComputerInvokeReceipt(
                key: receiptKey,
                receiptID: receiptID,
                fingerprint: fingerprint,
                response: response)
        } else if self.computerInvokeReceipts[receiptKey]?.id == receiptID,
                  self.computerInvokeReceipts[receiptKey]?.fingerprint == fingerprint
        {
            self.computerInvokeReceipts[receiptKey]?.state = .completed(response)
        }
        return Self.rebindInvokeResponse(response, requestId: request.id)
    }

    #if DEBUG
    // periphery:ignore - package tests exercise receipt dedupe around the private invoke path.
    func invokeComputerWithReceiptForTesting(
        requestId: String,
        paramsJSON: String,
        idempotencyKey: String,
        receiptScope: String,
        timeoutMs: Int = 0,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse) async
        -> BridgeInvokeResponse
    {
        let payload = NodeInvokeRequestPayload(
            id: requestId,
            nodeId: "test-node",
            command: "computer.act",
            paramsJSON: paramsJSON,
            timeoutMs: timeoutMs,
            idempotencyKey: idempotencyKey)
        return await self.invokeWithComputerReceipt(
            requestPayload: payload,
            request: BridgeInvokeRequest(
                id: requestId,
                command: "computer.act",
                paramsJSON: paramsJSON,
                nodeId: "test-node"),
            timeoutMs: timeoutMs,
            receiptScope: receiptScope,
            onInvoke: onInvoke)
    }

    // periphery:ignore - package tests assert receipt joining without exposing the receipt store.
    func computerReceiptJoinCountForTesting(
        idempotencyKey: String,
        receiptScope: String) -> Int
    {
        let receiptKey = ComputerInvokeReceiptKey(
            receiptScope: receiptScope,
            idempotencyKey: idempotencyKey)
        guard let receiptID = self.computerInvokeReceipts[receiptKey]?.id else { return 0 }
        return self.computerInvokeReceiptJoinCounts[receiptID] ?? 0
    }
    #endif

    private func computerInvokeReceiptScope() -> String {
        if let gatewayID = self.connectOptions?.deviceAuthGatewayID,
           !gatewayID.isEmpty
        {
            return "gateway:\(gatewayID)"
        }
        return "url:\(self.activeURL?.absoluteString ?? "unknown")"
    }

    private static func computerInvokeFingerprint(_ request: NodeInvokeRequestPayload) -> String {
        let value = [request.nodeId, request.command, request.paramsJSON ?? ""].joined(separator: "\u{0}")
        return SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func rebindInvokeResponse(
        _ response: BridgeInvokeResponse,
        requestId: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            type: response.type,
            id: requestId,
            ok: response.ok,
            payload: response.payload,
            payloadJSON: response.payloadJSON,
            error: response.error)
    }

    private static func isStaleRouteInvokeResponse(_ response: BridgeInvokeResponse) -> Bool {
        response.ok == false &&
            response.error?.code == .unavailable &&
            response.error?.message == self.staleRouteInvokeMessage
    }

    private func discardRetryableComputerInvokeReceipt(
        key: ComputerInvokeReceiptKey,
        receiptID: UUID,
        fingerprint: String,
        response: BridgeInvokeResponse)
    {
        guard Self.isStaleRouteInvokeResponse(response),
              self.computerInvokeReceipts[key]?.id == receiptID,
              self.computerInvokeReceipts[key]?.fingerprint == fingerprint
        else { return }
        self.computerInvokeReceipts.removeValue(forKey: key)
        self.computerInvokeReceiptOrder.removeAll { $0 == key }
        #if DEBUG
        self.computerInvokeReceiptJoinCounts.removeValue(forKey: receiptID)
        #endif
    }

    private func markComputerInvokeOperationSettled(
        key: ComputerInvokeReceiptKey,
        receiptID: UUID,
        fingerprint: String)
    {
        guard self.computerInvokeReceipts[key]?.id == receiptID,
              self.computerInvokeReceipts[key]?.fingerprint == fingerprint
        else { return }
        self.computerInvokeReceipts[key]?.operationSettled = true
    }

    private func makeComputerInvokeReceiptCapacity() -> Bool {
        while self.computerInvokeReceipts.count >= Self.computerInvokeReceiptLimit {
            guard let completedIndex = computerInvokeReceiptOrder.firstIndex(where: { key in
                guard let receipt = self.computerInvokeReceipts[key] else { return false }
                return receipt.state.isCompleted && receipt.operationSettled
            }) else { return false }
            let evictedKey = self.computerInvokeReceiptOrder.remove(at: completedIndex)
            let evictedReceipt = self.computerInvokeReceipts.removeValue(forKey: evictedKey)
            #if DEBUG
            if let receiptID = evictedReceipt?.id {
                self.computerInvokeReceiptJoinCounts.removeValue(forKey: receiptID)
            }
            #endif
        }
        return true
    }

    private func decodeInvokeRequest(from payload: OpenClawProtocol.AnyCodable) throws -> NodeInvokeRequestPayload {
        try self.decodeEventPayload(from: payload)
    }

    private func decodeEventPayload<T: Decodable>(from payload: OpenClawProtocol.AnyCodable) throws -> T {
        do {
            let data = try encoder.encode(payload)
            return try self.decoder.decode(T.self, from: data)
        } catch {
            if let raw = payload.value as? String, let data = raw.data(using: .utf8) {
                return try self.decoder.decode(T.self, from: data)
            }
            throw error
        }
    }

    private func sendInvokeResult(
        request: NodeInvokeRequestPayload,
        response: BridgeInvokeResponse,
        channel: GatewayChannelActor,
        socketGeneration: UInt64) async
    {
        self.logger.info(
            "node invoke result sending id=\(request.id, privacy: .public) ok=\(response.ok, privacy: .public)")
        var params: [String: AnyCodable] = [
            "id": AnyCodable(request.id),
            "nodeId": AnyCodable(request.nodeId),
            "ok": AnyCodable(response.ok),
        ]
        if let payloadJSON = response.payloadJSON {
            params["payloadJSON"] = AnyCodable(payloadJSON)
        }
        if let payload = response.payload {
            params["payload"] = payload
        }
        if let error = response.error {
            params["error"] = AnyCodable([
                "code": error.code.rawValue,
                "message": error.message,
            ])
        }
        do {
            try await channel.send(
                method: "node.invoke.result",
                params: params,
                ifCurrentConnectionGeneration: socketGeneration)
        } catch {
            self.logger.error(
                """
                node invoke result failed id=\(request.id, privacy: .public) \
                error=\(error.localizedDescription, privacy: .public)
                """)
        }
    }

    private func decodeParamsJSON(
        _ paramsJSON: String?) throws -> [String: AnyCodable]?
    {
        guard let paramsJSON, !paramsJSON.isEmpty else { return nil }
        guard let data = paramsJSON.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 12, userInfo: [
                NSLocalizedDescriptionKey: "paramsJSON not UTF-8",
            ])
        }
        return try JSONDecoder().decode([String: AnyCodable].self, from: data)
    }

    private func broadcastServerEvent(_ evt: EventFrame) {
        for (id, subscriber) in self.serverEventSubscribers where subscriber.matches(evt) {
            if case .terminated = subscriber.continuation.yield(evt) {
                self.serverEventSubscribers.removeValue(forKey: id)
            }
        }
    }

    private func removeServerEventSubscriber(_ id: UUID) {
        self.serverEventSubscribers.removeValue(forKey: id)
    }
}
