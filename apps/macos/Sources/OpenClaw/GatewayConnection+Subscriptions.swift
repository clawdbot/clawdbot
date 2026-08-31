import Foundation
import OpenClawKit

extension GatewayConnection {
    func subscribe(
        bufferingNewest: Int,
        ifCurrentServerLease lease: ServerLease) -> AsyncStream<GatewayPush>
    {
        let id = UUID()
        let connection = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            guard self.serverLeaseMatchesCurrentState(lease) else {
                continuation.finish()
                return
            }
            if let snapshot = self.lastSnapshot {
                switch continuation.yield(.snapshot(snapshot)) {
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
            self.serverSubscribers[lease.socketGeneration, default: [:]][id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task {
                    await connection.removeServerSubscriber(
                        id,
                        socketGeneration: lease.socketGeneration)
                }
            }
        }
    }

    func removeServerSubscriber(_ id: UUID, socketGeneration: UInt64) {
        self.serverSubscribers[socketGeneration]?[id] = nil
        if self.serverSubscribers[socketGeneration]?.isEmpty == true {
            self.serverSubscribers[socketGeneration] = nil
        }
    }

    func finishServerSubscribers(socketGeneration: UInt64? = nil) {
        let subscribers: [AsyncStream<GatewayPush>.Continuation]
        if let socketGeneration {
            if let removed = self.serverSubscribers.removeValue(forKey: socketGeneration) {
                subscribers = Array(removed.values)
            } else {
                subscribers = []
            }
        } else {
            subscribers = self.serverSubscribers.values.flatMap(\.values)
            self.serverSubscribers.removeAll()
        }
        subscribers.forEach { $0.finish() }
    }

    #if DEBUG
    func _test_activeSocketGeneration() -> UInt64? {
        self.activeSocketGeneration
    }
    #endif
}
