import Foundation

public enum AsyncTimeout {
    public static func withTimeout<T: Sendable>(
        seconds: Double,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        let clamped = max(0, seconds)
        if clamped == 0 {
            return try await operation()
        }

        return try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
                throw onTimeout()
            }
            let result = try await group.next()
            group.cancelAll()
            if let result { return result }
            throw onTimeout()
        }
    }

    public static func withTimeoutMs<T: Sendable>(
        timeoutMs: Int,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        let clamped = max(0, timeoutMs)
        let seconds = Double(clamped) / 1000.0
        return try await self.withTimeout(seconds: seconds, onTimeout: onTimeout, operation: operation)
    }
}
