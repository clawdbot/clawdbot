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
                        for await push in pushes {
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
}
