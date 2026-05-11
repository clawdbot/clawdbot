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

public actor GatewayNodeSession {
    private let logger = Logger(subsystem: "ai.openclaw", category: "node.gateway")
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private static let defaultInvokeTimeoutMs = 30000
    private var channel: GatewayChannelActor?
    private var activeURL: URL?
    private var activeToken: String?
    private var activeBootstrapToken: String?
    private var activePassword: String?
    private var activeConnectOptionsKey: String?
    private var activeSessionIdentity: ObjectIdentifier?
    private var connectOptions: GatewayConnectOptions?
    private var onConnected: (@Sendable () async -> Void)?
    private var onDisconnected: (@Sendable (String) async -> Void)?
    private var onInvoke: (@Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse)?
    private var hasEverConnected = false
    private var hasNotifiedConnected = false
    private var snapshotReceived = false
    private var snapshotWaiters: [CheckedContinuation<Bool, Never>] = []

    static func invokeWithTimeout(
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse) async -> BridgeInvokeResponse
    {
        let timeoutLogger = Logger(subsystem: "ai.openclaw", category: "node.gateway")
        let timeout: Int = {
            if let timeoutMs { return max(0, timeoutMs) }
            return Self.defaultInvokeTimeoutMs
        }()
        guard timeout > 0 else {
            return await onInvoke(request)
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

    private var serverEventSubscribers: [UUID: AsyncStream<EventFrame>.Continuation] = [:]
    private var pluginSurfaceUrls: [String: String] = [:]

    private struct PluginSurfaceRefreshResponse: Decodable {
        let pluginSurfaceUrls: [String: AnyCodable]?
    }

    public init() {}

    private func connectOptionsKey(_ options: GatewayConnectOptions) -> String {
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
        let clientId = options.clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientMode = options.clientMode.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientDisplayName = (options.clientDisplayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let includeDeviceIdentity = options.includeDeviceIdentity ? "1" : "0"
        let permissions = options.permissions
            .map { key, value in
                let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
                return "\(trimmed)=\(value ? "1" : "0")"
            }
            .sorted()
            .joined(separator: ",")

        return [
            role,
            scopes,
            caps,
            commands,
            clientId,
            clientMode,
            clientDisplayName,
            includeDeviceIdentity,
            permissions,
        ].joined(separator: "|")
    }

    public func connect(
        url: URL,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse) async throws
    {
        let nextOptionsKey = self.connectOptionsKey(connectOptions)
        let nextSessionIdentity = sessionBox.map { ObjectIdentifier($0.session) }
        let shouldReconnect = self.activeURL != url ||
            self.activeToken != token ||
            self.activeBootstrapToken != bootstrapToken ||
            self.activePassword != password ||
            self.activeConnectOptionsKey != nextOptionsKey ||
            self.activeSessionIdentity != nextSessionIdentity ||
            self.channel == nil

        self.connectOptions = connectOptions
        self.onConnected = onConnected
        self.onDisconnected = onDisconnected
        self.onInvoke = onInvoke

        if shouldReconnect {
            self.resetConnectionState()
            if let existing = self.channel {
                await existing.shutdown()
            }
            let channel = GatewayChannelActor(
                url: url,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                session: sessionBox,
                pushHandler: { [weak self] push in
                    await self?.handlePush(push)
                },
                connectOptions: connectOptions,
                disconnectHandler: { [weak self] reason in
                    await self?.handleChannelDisconnected(reason)
                })
            self.channel = channel
            self.activeURL = url
            self.activeToken = token
            self.activeBootstrapToken = bootstrapToken
            self.activePassword = password
            self.activeConnectOptionsKey = nextOptionsKey
            self.activeSessionIdentity = nextSessionIdentity
        }

        guard let channel = self.channel else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "gateway channel unavailable",
            ])
        }

        do {
            try await channel.connect()
            _ = await self.waitForSnapshot(timeoutMs: 500)
            await self.notifyConnectedIfNeeded()
        } catch {
            throw error
        }
    }

    public func disconnect() async {
        await self.channel?.shutdown()
        self.channel = nil
        self.activeURL = nil
        self.activeToken = nil
        self.activeBootstrapToken = nil
        self.activePassword = nil
        self.activeConnectOptionsKey = nil
        self.activeSessionIdentity = nil
        self.hasEverConnected = false
        self.resetConnectionState()
    }

    public func currentCanvasHostUrl() -> String? {
        self.pluginSurfaceUrls["canvas"]
    }

    @discardableResult
    public func refreshPluginSurfaceUrl(surface: String, timeoutSeconds: Int = 8) async -> String? {
        guard let channel = self.channel else { return nil }
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
        guard let url = self.activeURL else { return nil }
        guard let host = url.host else { return url.absoluteString }
        let port = url.port ?? (url.scheme == "wss" ? 443 : 80)
        if host.contains(":") {
            return "[\(host)]:\(port)"
        }
        return "\(host):\(port)"
    }

    public func sendEvent(event: String, payloadJSON: String?) async {
        guard let channel = self.channel else { return }
        let params: [String: AnyCodable] = [
            "event": AnyCodable(event),
            "payloadJSON": AnyCodable(payloadJSON ?? NSNull()),
        ]
        do {
            try await channel.send(method: "node.event", params: params)
        } catch {
            self.logger.error("node event failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func request(method: String, paramsJSON: String?, timeoutSeconds: Int = 15) async throws -> Data {
        guard let channel = self.channel else {
            throw NSError(domain: "Gateway", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "not connected",
            ])
        }

        let params = try self.decodeParamsJSON(paramsJSON)
        return try await channel.request(
            method: method,
            params: params,
            timeoutMs: Double(timeoutSeconds * 1000))
    }

    public func subscribeServerEvents(bufferingNewest: Int = 200) -> AsyncStream<EventFrame> {
        let id = UUID()
        let session = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            self.serverEventSubscribers[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await session.removeServerEventSubscriber(id) }
            }
        }
    }

    private func handlePush(_ push: GatewayPush) async {
        switch push {
        case let .snapshot(ok):
            self.pluginSurfaceUrls = self.normalizePluginSurfaceUrls(ok.pluginsurfaceurls)
            if self.hasEverConnected {
                self.broadcastServerEvent(
                    EventFrame(type: "event", event: "seqGap", payload: nil, seq: nil, stateversion: nil))
            }
            self.hasEverConnected = true
            self.markSnapshotReceived()
            await self.notifyConnectedIfNeeded()
        case let .event(evt):
            await self.handleEvent(evt)
        default:
            break
        }
    }

    private func resetConnectionState() {
        self.hasNotifiedConnected = false
        self.snapshotReceived = false
        self.drainSnapshotWaiters(returning: false)
    }

    private func handleChannelDisconnected(_ reason: String) async {
        // The underlying channel can auto-reconnect; resetting state here ensures we surface a fresh
        // onConnected callback once a new snapshot arrives after reconnect.
        self.resetConnectionState()
        await self.onDisconnected?(reason)
    }

    private func markSnapshotReceived() {
        self.snapshotReceived = true
        self.drainSnapshotWaiters(returning: true)
    }

    private func waitForSnapshot(timeoutMs: Int) async -> Bool {
        if self.snapshotReceived { return true }
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

    private func notifyConnectedIfNeeded() async {
        guard !self.hasNotifiedConnected else { return }
        self.hasNotifiedConnected = true
        await self.onConnected?()
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
            let decoded = try self.decoder.decode(PluginSurfaceRefreshResponse.self, from: data)
            let urls = self.normalizePluginSurfaceUrls(decoded.pluginSurfaceUrls)
            guard let refreshed = urls[surface] else { return nil }
            self.pluginSurfaceUrls[surface] = refreshed
            return refreshed
        } catch {
            self.logger.debug("\(method, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func handleEvent(_ evt: EventFrame) async {
        self.broadcastServerEvent(evt)
        guard evt.event == "node.invoke.request" else { return }
        self.logger.info("node invoke request received")
        guard let payload = evt.payload else { return }
        do {
            let request = try self.decodeInvokeRequest(from: payload)
            let timeoutLabel = request.timeoutMs.map(String.init) ?? "none"
            self.logger.info(
                "node invoke request decoded id=\(request.id, privacy: .public) command=\(request.command, privacy: .public) timeoutMs=\(timeoutLabel, privacy: .public)")
            guard let onInvoke else { return }
            let req = BridgeInvokeRequest(
                id: request.id,
                command: request.command,
                paramsJSON: request.paramsJSON)
            self.logger.info("node invoke executing id=\(request.id, privacy: .public)")
            let response = await Self.invokeWithTimeout(
                request: req,
                timeoutMs: request.timeoutMs,
                onInvoke: onInvoke)
            self.logger.info(
                "node invoke completed id=\(request.id, privacy: .public) ok=\(response.ok, privacy: .public)")
            await self.sendInvokeResult(request: request, response: response)
        } catch {
            self.logger.error("node invoke decode failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func decodeInvokeRequest(from payload: OpenClawProtocol.AnyCodable) throws -> NodeInvokeRequestPayload {
        do {
            let data = try self.encoder.encode(payload)
            return try self.decoder.decode(NodeInvokeRequestPayload.self, from: data)
        } catch {
            if let raw = payload.value as? String, let data = raw.data(using: .utf8) {
                return try self.decoder.decode(NodeInvokeRequestPayload.self, from: data)
            }
            throw error
        }
    }

    private func sendInvokeResult(request: NodeInvokeRequestPayload, response: BridgeInvokeResponse) async {
        guard let channel = self.channel else { return }
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
        if let error = response.error {
            params["error"] = AnyCodable([
                "code": error.code.rawValue,
                "message": error.message,
            ])
        }
        do {
            try await channel.send(method: "node.invoke.result", params: params)
        } catch {
            self.logger.error(
                "node invoke result failed id=\(request.id, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
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
        let raw = try JSONSerialization.jsonObject(with: data)
        guard let dict = raw as? [String: Any] else {
            return nil
        }
        return dict.reduce(into: [:]) { acc, entry in
            acc[entry.key] = AnyCodable(entry.value)
        }
    }

    private func broadcastServerEvent(_ evt: EventFrame) {
        for (id, continuation) in self.serverEventSubscribers {
            if case .terminated = continuation.yield(evt) {
                self.serverEventSubscribers.removeValue(forKey: id)
            }
        }
    }

    private func removeServerEventSubscriber(_ id: UUID) {
        self.serverEventSubscribers.removeValue(forKey: id)
    }
}
