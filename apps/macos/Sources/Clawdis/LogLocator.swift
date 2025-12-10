import Foundation

enum LogLocator {
    private static let logDir = URL(fileURLWithPath: "/tmp/clawdis")
    private static let stdoutLog = logDir.appendingPathComponent("clawdis-stdout.log")

    /// Returns the newest log file under /tmp/clawdis/ (rolling or stdout), or nil if none exist.
    static func bestLogFile() -> URL? {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(
            at: logDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles])) ?? []

        return files
            .filter { $0.lastPathComponent.hasPrefix("clawdis") && $0.pathExtension == "log" }
            .sorted { lhs, rhs in
                let lDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let rDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return lDate > rDate
            }
            .first
    }

    /// Path to use for launchd stdout/err.
    static var launchdLogPath: String {
        stdoutLog.path
    }
}
