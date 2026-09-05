import Darwin
import Foundation
import Testing
@testable import OpenClawDiscovery

struct BoundedCommandTests {
    @Test func `force kills and reaps a command that ignores termination`() async throws {
        let pidFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-bounded-command-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }

        // BoundedCommand starts its deadline concurrently with the spawn, so the
        // timeout also bounds `/bin/sh` starting up and publishing its pid. A
        // deadline near spawn latency turns that into a coin flip: under load the
        // child is killed before it ever writes the file. Keep it well clear of
        // spawn cost; what this test asserts is the force-kill, not spawn speed.
        let runTask = Task {
            await BoundedCommand.run(
                path: "/bin/sh",
                arguments: ["-c", "echo $$ > \"$PID_FILE\"; trap '' TERM; exec /bin/sleep 30"],
                environment: ["PID_FILE": pidFile.path],
                timeout: 2.0)
        }
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            Issue.record("timed out waiting for TERM-resistant command cleanup")
            runTask.cancel()
        }
        defer {
            watchdog.cancel()
            runTask.cancel()
        }

        let pid = try await Self.waitForPID(in: pidFile)
        let output = await runTask.value
        watchdog.cancel()

        #expect(output == nil)
        #expect(Self.waitUntilGone(pid))
    }

    /// Non-recording parse for polling. `#require` records an issue even when the
    /// error it throws is swallowed by `try?`, so a retry loop must not use it or
    /// the first not-yet-written read fails the test outright.
    private static func pollPID(in file: URL) -> pid_t? {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The child creates the pid file and writes to it in two steps, so a single
    /// read can observe a missing *or* empty file. Poll until it parses.
    private static func waitForPID(in file: URL) async throws -> pid_t {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if let pid = self.pollPID(in: file) {
                return pid
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        let text = try String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return try #require(pid_t(text))
    }

    /// Reaping is asynchronous, so the process can still be visible for a moment
    /// after `run` returns.
    private static func waitUntilGone(_ pid: pid_t) -> Bool {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            errno = 0
            if kill(pid, 0) == -1, errno == ESRCH {
                return true
            }
            usleep(10000)
        }
        return false
    }
}
