import Darwin
import Foundation
import Testing

enum TestProcessSupport {
    static func pollPID(in file: URL) -> pid_t? {
        guard let value = try? String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        else { return nil }
        return pid_t(value)
    }

    static func waitForPID(in file: URL, timeout: Duration = .seconds(2)) async throws -> pid_t {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if let pid = self.pollPID(in: file) { return pid }
            try await Task.sleep(for: .milliseconds(10))
        }
        return try #require(self.pollPID(in: file))
    }

    static func processIsGone(_ pid: pid_t) -> Bool {
        errno = 0
        return kill(pid, 0) == -1 && errno == ESRCH
    }

    static func waitUntilGone(_ pid: pid_t, timeout: Duration = .seconds(2)) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if self.processIsGone(pid) { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return self.processIsGone(pid)
    }

    static func killLeakedProcesses(in files: [URL]) {
        let pids = files.compactMap { self.pollPID(in: $0) }
        for pid in pids where !self.processIsGone(pid) {
            _ = kill(pid, SIGKILL)
        }
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline, pids.contains(where: { !self.processIsGone($0) }) {
            usleep(10000)
        }
    }
}
