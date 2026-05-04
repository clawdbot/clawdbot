import Foundation

public struct HookJob: Sendable {
    public let text: String
    public let timestamp: Date

    public init(text: String, timestamp: Date) {
        self.text = text
        self.timestamp = timestamp
    }
}

public actor HookExecutor {
    private let config: SwabbleConfig
    private var lastRun: Date?
    private let hostname: String

    public init(config: SwabbleConfig) {
        self.config = config
        hostname = Host.current().localizedName ?? "host"
    }

    public func shouldRun() -> Bool {
        guard config.hook.cooldownSeconds > 0 else { return true }
        if let lastRun, Date().timeIntervalSince(lastRun) < config.hook.cooldownSeconds {
            return false
        }
        return true
    }

    public func run(job: HookJob) async throws {
        guard shouldRun() else { return }
        guard !config.hook.command.isEmpty else { throw NSError(
            domain: "Hook",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "hook command not set"]) }

        let prefix = config.hook.prefix.replacingOccurrences(of: "${hostname}", with: hostname)
        let payload = prefix + job.text

        let process = Process()
        process.executableURL = URL(fileURLWithPath: config.hook.command)
        process.arguments = config.hook.args + [payload]

        var env = ProcessInfo.processInfo.environment
        env["SWABBLE_TEXT"] = job.text
        env["SWABBLE_PREFIX"] = prefix
        for (k, v) in config.hook.env {
            env[k] = v
        }
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()

        let timeoutNanos = UInt64(max(config.hook.timeoutSeconds, 0.1) * 1_000_000_000)
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                process.waitUntilExit()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanos)
                if process.isRunning {
                    process.terminate()
                }
            }
            try await group.next()
            group.cancelAll()
        }
        lastRun = Date()
    }
}
