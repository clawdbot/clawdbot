import Foundation
import OpenClawKit

@MainActor
final class GatewayHealthMonitor {
    struct Config {
        var intervalSeconds: Double
        var timeoutSeconds: Double
        var maxFailures: Int
    }

    private let config: Config
    private let sleep: @Sendable (UInt64) async -> Void
    private var task: Task<Void, Never>?

    init(
        config: Config = Config(intervalSeconds: 15, timeoutSeconds: 5, maxFailures: 3),
        sleep: @escaping @Sendable (UInt64) async -> Void = { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        })
    {
        self.config = config
        self.sleep = sleep
    }

    func start(
        check: @escaping @Sendable () async throws -> Bool,
        onFailure: @escaping @Sendable (_ failureCount: Int) async -> Void)
    {
        self.stop()
        let config = self.config
        let sleep = self.sleep
        self.task = Task { @MainActor in
            var failures = 0
            while !Task.isCancelled {
                let ok = await Self.runCheck(check: check, timeoutSeconds: config.timeoutSeconds)
                if ok {
                    failures = 0
                } else {
                    failures += 1
                    if failures >= max(1, config.maxFailures) {
                        await onFailure(failures)
                        failures = 0
                    }
                }

                if Task.isCancelled { break }
                let interval = max(0.0, config.intervalSeconds)
                let nanos = UInt64(interval * 1_000_000_000)
                if nanos > 0 {
                    await sleep(nanos)
                } else {
                    await Task.yield()
                }
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    private static func runCheck(
        check: @escaping @Sendable () async throws -> Bool,
        timeoutSeconds: Double) async -> Bool
    {
        let timeout = max(0.0, timeoutSeconds)
        if timeout == 0 {
            return await (try? check()) ?? false
        }
        do {
            let timeoutError = NSError(
                domain: "GatewayHealthMonitor",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "health check timed out"])
            return try await AsyncTimeout.withTimeout(
                seconds: timeout,
                onTimeout: { timeoutError },
                operation: check)
        } catch {
            return false
        }
    }
}
