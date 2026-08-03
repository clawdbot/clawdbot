import OpenClawKit

enum GatewayPushSubscription {
    @MainActor
    static func consume(
        bufferingNewest: Int? = nil,
        onPush: @escaping @MainActor (GatewayPush) -> Void) async
    {
        let stream: AsyncStream<GatewayPush> = if let bufferingNewest {
            await GatewayConnection.shared.subscribe(bufferingNewest: bufferingNewest)
        } else {
            await GatewayConnection.shared.subscribe()
        }

        for await push in stream {
            if Task.isCancelled { return }
            await MainActor.run {
                onPush(push)
            }
        }
    }

    @MainActor
    static func restartTask(
        task: inout Task<Void, Never>?,
        bufferingNewest: Int? = nil,
        onPush: @escaping @MainActor (GatewayPush) -> Void)
    {
        task?.cancel()
        task = Task {
            await self.consume(bufferingNewest: bufferingNewest, onPush: onPush)
        }
    }
}
