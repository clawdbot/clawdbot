import Foundation

/// Owns one delayed MainActor action and invalidates it by generation.
///
/// Cancellation alone is not an action-time guarantee: a delay can finish
/// before a replacement cancels the task. The generation check therefore runs
/// on the MainActor immediately before the action is delivered.
@MainActor
final class DelayedActionGate {
    typealias Sleeper = @Sendable (Duration) async throws -> Void
    typealias DeliveryBarrier = @Sendable () async -> Void

    private let sleeper: Sleeper
    private let deliveryBarrier: DeliveryBarrier
    private var generation: UInt64 = 0
    private var task: Task<Void, Never>?

    init(
        sleeper: @escaping Sleeper = { try await Task.sleep(for: $0) },
        deliveryBarrier: @escaping DeliveryBarrier = {})
    {
        self.sleeper = sleeper
        self.deliveryBarrier = deliveryBarrier
    }

    @discardableResult
    func schedule(
        after duration: Duration,
        action: @escaping @MainActor () async -> Void) -> Task<Void, Never>
    {
        self.task?.cancel()
        self.generation &+= 1
        let generation = self.generation
        let sleeper = self.sleeper
        let deliveryBarrier = self.deliveryBarrier
        let task = Task { @MainActor [weak self] in
            do {
                try await sleeper(duration)
            } catch {
                return
            }
            await deliveryBarrier()
            guard let self,
                  !Task.isCancelled,
                  self.generation == generation
            else { return }
            await action()
            if self.generation == generation {
                self.task = nil
            }
        }
        self.task = task
        return task
    }

    func cancel() {
        self.generation &+= 1
        self.task?.cancel()
        self.task = nil
    }
}
