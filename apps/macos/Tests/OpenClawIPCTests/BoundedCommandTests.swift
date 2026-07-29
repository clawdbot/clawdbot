import Darwin
import Foundation
import Testing
@testable import OpenClawDiscovery

struct BoundedCommandTests {
    @Test func `drains output larger than a process pipe`() async throws {
        let byteCount = 256 * 1024
        let output = await BoundedCommand.run(
            path: "/usr/bin/head",
            arguments: ["-c", "\(byteCount)", "/dev/zero"],
            timeout: 1.0)

        let value = try #require(output)
        #expect(value.utf8.count == byteCount)
    }

    @Test func `force kills and reaps a command that ignores termination`() async throws {
        let pidFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-bounded-command-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }

        let clock = ContinuousClock()
        let startedAt = clock.now
        let output = await BoundedCommand.run(
            path: "/bin/sh",
            arguments: ["-c", "echo $$ > \"$PID_FILE\"; trap '' TERM; exec /bin/sleep 30"],
            environment: ["PID_FILE": pidFile.path],
            timeout: 0.1)

        #expect(output == nil)
        #expect(startedAt.duration(to: clock.now) < .seconds(1))
        let pidString = try String(contentsOf: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidString))
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
    }
}
