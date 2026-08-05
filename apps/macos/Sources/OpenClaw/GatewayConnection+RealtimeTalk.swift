import Foundation
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    /// Creates a realtime Talk transport bound to one physical Gateway socket.
    ///
    /// Gateway relay sessions are owned by the connection that created them. A
    /// route-only transport could silently move follow-up audio or close calls to
    /// a replacement socket after reconnecting, where that session does not exist.
    func acquireRealtimeTalkTransport() async throws -> RealtimeTalkRelayTransport {
        let lease = try await self.acquireServerLease()

        return RealtimeTalkRelayTransport(
            subscribeServerEvents: { bufferingNewest in
                let pushes = await self.subscribe(bufferingNewest: bufferingNewest)
                let invalidations = await self.subscribeServerLeaseInvalidation(lease)
                return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
                    let task = Task {
                        await withTaskGroup(of: Void.self) { group in
                            group.addTask {
                                for await push in pushes {
                                    guard case let .event(event) = push else { continue }
                                    continuation.yield(event)
                                }
                            }
                            group.addTask {
                                for await _ in invalidations {}
                            }
                            await group.next()
                            group.cancelAll()
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
