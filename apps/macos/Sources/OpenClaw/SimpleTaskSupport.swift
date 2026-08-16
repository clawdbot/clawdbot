import Foundation

@MainActor
enum SimpleTaskSupport {
    static func start(task: inout Task<Void, Never>?, operation: @escaping @Sendable () async -> Void) {
        guard task == nil else { return }
        task = Task {
            await operation()
        }
    }

    static func stop(task: inout Task<Void, Never>?) {
        task?.cancel()
        task = nil
    }

    static func startDetachedLoop(
        task: inout Task<Void, Never>?,
        interval: TimeInterval,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
        operation: @escaping @Sendable () async -> Void)
    {
        guard task == nil else { return }
        task = Task.detached {
            await operation()
            while await self.waitForNextOperation(interval: interval, sleep: sleep) {
                guard !Task.isCancelled else { break }
                await operation()
            }
        }
    }

    static func schedule(
        task: inout Task<Void, Never>?,
        delay: TimeInterval,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
        beforeOperationCheck: @escaping @Sendable () -> Void = {},
        operation: @escaping @MainActor @Sendable () async -> Void)
    {
        task?.cancel()
        task = Task {
            guard await self.waitForNextOperation(interval: delay, sleep: sleep) else { return }
            beforeOperationCheck()
            guard !Task.isCancelled else { return }
            await operation()
        }
    }

    nonisolated static func waitForNextOperation(
        interval: TimeInterval,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) async
        -> Bool
    {
        guard !Task.isCancelled else { return false }
        // Cancellation wakes the sleep. Report it before the next operation so stopped stores
        // and superseded debounce tasks cannot issue stale gateway refreshes.
        do {
            try await sleep(UInt64(interval * 1_000_000_000))
        } catch {
            return false
        }
        return !Task.isCancelled
    }
}
