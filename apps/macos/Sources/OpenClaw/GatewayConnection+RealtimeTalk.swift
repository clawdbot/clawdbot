import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    struct RealtimeTalkBootstrap: @unchecked Sendable {
        let transport: RealtimeTalkRelayTransport
        let configSnapshot: ConfigSnapshot
        let sessionKey: String
    }

    /// Freezes config and relay traffic to one physical Gateway socket.
    ///
    /// A route replacement between config resolution and session creation must
    /// fail this attempt instead of silently moving the relay to a new owner.
    func acquireRealtimeTalkBootstrap() async throws -> RealtimeTalkBootstrap {
        let lease = try await self.acquireServerLease()
        let data = try await self.request(
            method: Method.talkConfig.rawValue,
            params: [:],
            timeoutMs: 8000,
            ifCurrentServerLease: lease)
        let snapshot = try JSONDecoder().decode(ConfigSnapshot.self, from: data)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let configuredSessionKey = snapshot.config?["session"]?.dictionaryValue?["mainKey"]?
            .stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        return RealtimeTalkBootstrap(
            transport: self.realtimeTalkTransport(ifCurrentServerLease: lease),
            configSnapshot: snapshot,
            sessionKey: configuredSessionKey?.isEmpty == false ? configuredSessionKey! : "main")
    }

    /// Creates a realtime Talk transport bound to one physical Gateway socket.
    ///
    /// Gateway relay sessions are owned by the connection that created them. A
    /// route-only transport could silently move follow-up audio or close calls to
    /// a replacement socket after reconnecting, where that session does not exist.
    func acquireRealtimeTalkTransport() async throws -> RealtimeTalkRelayTransport {
        let lease = try await self.acquireServerLease()
        return self.realtimeTalkTransport(ifCurrentServerLease: lease)
    }

    private func realtimeTalkTransport(
        ifCurrentServerLease lease: ServerLease) -> RealtimeTalkRelayTransport
    {
        RealtimeTalkRelayTransport(
            subscribeServerEvents: { bufferingNewest in
                let pushes = await self.subscribe(
                    bufferingNewest: bufferingNewest,
                    ifCurrentServerLease: lease)
                return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
                    let task = Task {
                        for await delivery in pushes {
                            guard delivery.isCurrent, let push = delivery.push else { continue }
                            guard case let .event(event) = push else { continue }
                            switch continuation.yield(event) {
                            case .enqueued:
                                continue
                            case .dropped, .terminated:
                                continuation.finish()
                                return
                            @unknown default:
                                continuation.finish()
                                return
                            }
                        }
                        continuation.finish()
                    }
                    continuation.onTermination = { @Sendable _ in
                        task.cancel()
                    }
                }
            },
            request: { method, params, timeoutMs in
                try await self.request(
                    method: method,
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentServerLease: lease)
            },
            isCurrent: {
                await self.isCurrentServerLease(lease)
            })
    }

    func subscribe(
        bufferingNewest: Int,
        ifCurrentServerLease lease: ServerLease) -> AsyncStream<PushDelivery>
    {
        let id = UUID()
        let connection = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            guard self.serverLeaseMatchesCurrentState(lease) else {
                continuation.finish()
                return
            }
            if let snapshot = self.lastSnapshot, let delivery = self.makePushDelivery(.snapshot(snapshot)) {
                switch continuation.yield(delivery) {
                case .enqueued:
                    break
                case .dropped, .terminated:
                    continuation.finish()
                    return
                @unknown default:
                    continuation.finish()
                    return
                }
            }
            self.realtimeTalkSubscribers[lease.socketGeneration, default: [:]][id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task {
                    await connection.removeRealtimeTalkSubscriber(
                        id,
                        socketGeneration: lease.socketGeneration)
                }
            }
        }
    }

    func removeRealtimeTalkSubscriber(_ id: UUID, socketGeneration: UInt64) {
        self.realtimeTalkSubscribers[socketGeneration]?[id] = nil
        if self.realtimeTalkSubscribers[socketGeneration]?.isEmpty == true {
            self.realtimeTalkSubscribers[socketGeneration] = nil
        }
    }

    func finishRealtimeTalkSubscribers(socketGeneration: UInt64? = nil) {
        let subscribers: [AsyncStream<PushDelivery>.Continuation]
        if let socketGeneration {
            if let removed = self.realtimeTalkSubscribers.removeValue(forKey: socketGeneration) {
                subscribers = Array(removed.values)
            } else {
                subscribers = []
            }
        } else {
            subscribers = self.realtimeTalkSubscribers.values.flatMap(\.values)
            self.realtimeTalkSubscribers.removeAll()
        }
        subscribers.forEach { $0.finish() }
    }

    #if DEBUG
    func _test_activeSocketGeneration() -> UInt64? {
        self.activeSocketGeneration
    }
    #endif
}
