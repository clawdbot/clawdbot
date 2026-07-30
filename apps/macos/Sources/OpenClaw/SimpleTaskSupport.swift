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
        operation: @escaping @Sendable () async -> Void
    ) {
        guard task == nil else { return }
        task = Task.detached {
            await operation()
            while !Task.isCancelled {
                // Cancellation wakes the sleep. Exit before the next operation so stopped stores
                // cannot issue one final gateway refresh after their lifecycle has ended.
                do {
                    try await sleep(UInt64(interval * 1_000_000_000))
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                await operation()
            }
        }
    }
}
