import Foundation

struct AsyncWaitTimeoutError: Error, CustomStringConvertible {
    let label: String
    var description: String { "Timeout waiting for: \(self.label)" }
}

func waitUntil(
    _ label: String,
    timeoutSeconds: Double = 3.0,
    pollMs: UInt64 = 10,
    _ condition: @escaping @Sendable () async -> Bool) async throws
{
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
        if await condition() { return }
        try await Task.sleep(nanoseconds: pollMs * 1_000_000)
    }
    throw AsyncWaitTimeoutError(label: label)
}
