import Foundation

enum LogLocator {
    private static var logDir: URL {
        if let override = ProcessInfo.processInfo.environment["OPENCLAW_LOG_DIR"],
           !override.isEmpty
        {
            return URL(fileURLWithPath: override)
        }
        return URL(fileURLWithPath: "/tmp/openclaw")
    }

    private static var stdoutLog: URL {
        logDir.appendingPathComponent("openclaw-stdout.log")
    }

    private static var gatewayLog: URL {
        logDir.appendingPathComponent("openclaw-gateway.log")
    }

    private static func ensureLogDirExists() {
        try? FileManager().createDirectory(at: self.logDir, withIntermediateDirectories: true)
    }

    private static func modificationDate(for url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    /// Returns the newest log file under /tmp/openclaw/ (rolling or stdout), or nil if none exist.
    static func bestLogFile() -> URL? {
        self.ensureLogDirExists()
        let fm = FileManager()
        let files = (try? fm.contentsOfDirectory(
            at: self.logDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles])) ?? []

        let prefixes = ["openclaw"]
        return files
            .filter { file in
                prefixes.contains { file.lastPathComponent.hasPrefix($0) } && file.pathExtension == "log"
            }
            .max { lhs, rhs in
                self.modificationDate(for: lhs) < self.modificationDate(for: rhs)
            }
    }

    /// Path to use for launchd stdout/err.
    static var launchdLogPath: String {
        self.ensureLogDirExists()
        return stdoutLog.path
    }

    /// Path to use for the Gateway launchd job stdout/err.
    static var launchdGatewayLogPath: String {
        self.ensureLogDirExists()
        return gatewayLog.path
    }
}
