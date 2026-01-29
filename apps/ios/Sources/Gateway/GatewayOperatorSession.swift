import MoltbotKit
import MoltbotProtocol
import Foundation

/// Operator-role gateway session for iOS.
///
/// Wraps `GatewayChannelActor` to provide a similar interface to `GatewayNodeSession`
/// but without invoke handling (operator role does not receive node.invoke requests).
public actor GatewayOperatorSession {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var channel: GatewayChannelActor?
    private var activeURL: URL?
    private var activeToken: String?
    private var activePassword: String?
    private var serverEventSubscribers: [UUID: AsyncStream<EventFrame>.Continuation] = [:]

    public init() {}

    public func connect(
        url: URL,
        token: String?,
        password: String?,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void
    ) async throws {
        let shouldReconnect = self.activeURL != url ||
            self.activeToken != token ||
            self.activePassword != password ||
            self.channel == nil

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
                    await self?.handlePush(push, onConnected: onConnected)
                },
                connectOptions: connectOptions,
                disconnectHandler: { [weak self] reason in
                    guard self != nil else { return }
                    await onDisconnected(reason)
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
            // onConnected is called via pushHandler when snapshot arrives
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

    public func currentRemoteAddress() -> String? {
        guard let url = self.activeURL else { return nil }
        guard let host = url.host else { return url.absoluteString }
        let port = url.port ?? (url.scheme == "wss" ? 443 : 80)
        if host.contains(":") {
            return "[\(host)]:\(port)"
        }
        return "\(host):\(port)"
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

    private func handlePush(
        _ push: GatewayPush,
        onConnected: @escaping @Sendable () async -> Void
    ) async {
        switch push {
        case .snapshot:
            await onConnected()
        case let .event(evt):
            self.broadcastServerEvent(evt)
        case let .seqGap(expected, received):
            // Broadcast a synthetic event so subscribers can handle gaps
            let gapEvent = EventFrame(
                type: "evt",
                event: "seqGap",
                payload: MoltbotProtocol.AnyCodable(["expected": expected, "received": received]),
                seq: received,
                stateversion: nil)
            self.broadcastServerEvent(gapEvent)
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

    private func decodeParamsJSON(_ paramsJSON: String?) throws -> [String: MoltbotKit.AnyCodable]? {
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
            acc[entry.key] = MoltbotKit.AnyCodable(entry.value)
        }
    }
}
