import MoltbotProtocol
import Foundation
import OSLog

private struct NodeInvokeRequestPayload: Codable, Sendable {
    var id: String
    var nodeId: String
    var command: String
    var paramsJSON: String?
    var timeoutMs: Int?
    var idempotencyKey: String?
}

public actor GatewayNodeSession {
    private let logger = Logger(subsystem: "com.clawdbot", category: "node.gateway")
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var channel: GatewayChannelActor?
    private var activeURL: URL?
    private var activeToken: String?
    private var activePassword: String?
    private var connectOptions: GatewayConnectOptions?
    private var onConnected: (@Sendable () async -> Void)?
    private var onDisconnected: (@Sendable (String) async -> Void)?
    private var onInvoke: (@Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse)?

    static func invokeWithTimeout(
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse
    ) async -> BridgeInvokeResponse {
        let timeout = max(0, timeoutMs ?? 0)
        guard timeout > 0 else {
            return await onInvoke(request)
        }

        return await withTaskGroup(of: BridgeInvokeResponse.self) { group in
            group.addTask { await onInvoke(request) }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000)
                return BridgeInvokeResponse(
                    id: request.id,
                    ok: false,
                    error: MoltbotNodeError(
                        code: .unavailable,
                        message: "node invoke timed out")
                )
            }

            let first = await group.next()!
            group.cancelAll()
            return first
        }
    }
    private var serverEventSubscribers: [UUID: AsyncStream<EventFrame>.Continuation] = [:]
    private var canvasHostUrl: String?

    public init() {}

    public func connect(
        url: URL,
        token: String?,
        password: String?,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse
    ) async throws {
        let shouldReconnect = self.activeURL != url ||
            self.activeToken != token ||
            self.activePassword != password ||
            self.channel == nil

        self.connectOptions = connectOptions
        self.onConnected = onConnected
        self.onDisconnected = onDisconnected
        self.onInvoke = onInvoke

        if shouldReconnect {
            if let existing = self.channel {
                await existing.shutdown()
            }
            let channel = GatewayChannelActor(
                url: url,
                token: token,
                password: password,
                session: sessionBox,
                pushHandler: { [weak self] push in
                    await self?.handlePush(push)
                },
                connectOptions: connectOptions,
                disconnectHandler: { [weak self] reason in
                    await self?.onDisconnected?(reason)
                })
            self.channel = channel
            self.activeURL = url
            self.activeToken = token
            self.activePassword = password
        }

        guard let channel = self.channel else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "gateway channel unavailable",
            ])
        }

        do {
            try await channel.connect()
            await onConnected()
        } catch {
            await onDisconnected(error.localizedDescription)
            throw error
        }
    }

    public func disconnect() async {
        await self.channel?.shutdown()
        self.channel = nil
        self.activeURL = nil
        self.activeToken = nil
        self.activePassword = nil
    }

    public func currentCanvasHostUrl() -> String? {
        self.canvasHostUrl
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
            let raw = ok.canvashosturl?.trimmingCharacters(in: .whitespacesAndNewlines)
            self.canvasHostUrl = (raw?.isEmpty == false) ? raw : nil
            await self.onConnected?()
        case let .event(evt):
            await self.handleEvent(evt)
        default:
            break
        }
    }

    private func handleEvent(_ evt: EventFrame) async {
        self.broadcastServerEvent(evt)
        guard evt.event == "node.invoke.request" else { return }
        guard let payload = evt.payload else { return }
        do {
            let data = try self.encoder.encode(payload)
            let request = try self.decoder.decode(NodeInvokeRequestPayload.self, from: data)
            guard let onInvoke else { return }
            let req = BridgeInvokeRequest(id: request.id, command: request.command, paramsJSON: request.paramsJSON)
            let response = await Self.invokeWithTimeout(
                request: req,
                timeoutMs: request.timeoutMs,
                onInvoke: onInvoke
            )
            await self.sendInvokeResult(request: request, response: response)
        } catch {
            self.logger.error("node invoke decode failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func sendInvokeResult(request: NodeInvokeRequestPayload, response: BridgeInvokeResponse) async {
        guard let channel = self.channel else { return }
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
            self.logger.error("node invoke result failed: \(error.localizedDescription, privacy: .public)")
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
