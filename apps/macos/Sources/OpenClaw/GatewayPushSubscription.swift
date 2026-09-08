import OpenClawKit

enum GatewayPushSubscription {
    @MainActor
    static func consume(
        connection: GatewayConnection = .shared,
        bufferingNewest: Int? = nil,
        onPush: @escaping @MainActor (GatewayConnection.PushDelivery) -> Void) async
    {
        let stream: AsyncStream<GatewayConnection.PushDelivery> = if let bufferingNewest {
            await connection.subscribe(bufferingNewest: bufferingNewest)
        } else {
            await connection.subscribe()
        }

        for await delivery in stream {
            if Task.isCancelled { return }
            // Validate payloads on the consumer executor. Retirement receipts
            // also reach exact-source cleanup; status/action users must recheck.
            if delivery.push != nil, !delivery.isCurrent { continue }
            onPush(delivery)
        }
    }

    @MainActor
    static func restartTask(
        task: inout Task<Void, Never>?,
        connection: GatewayConnection = .shared,
        bufferingNewest: Int? = nil,
        onPush: @escaping @MainActor (GatewayConnection.PushDelivery) -> Void)
    {
        task?.cancel()
        task = Task {
            await self.consume(connection: connection, bufferingNewest: bufferingNewest, onPush: onPush)
        }
    }
}
