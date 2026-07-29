import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct ShellExecutorTimeoutTests {
    @Test func `timeout kills and reaps a TERM-ignoring command`() async throws {
        let pidFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-shell-timeout-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }

        let result = await ShellExecutor.runDetailed(
            command: [
                "/bin/sh",
                "-c",
                "echo $$ > \"$PID_FILE\"; trap '' TERM; while :; do :; done",
            ],
            cwd: nil,
            env: ["PID_FILE": pidFile.path],
            timeout: 0.1)

        #expect(result.timedOut)
        let pidString = try String(contentsOf: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidString))
        defer {
            if kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
        }
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    @Test func `timeout terminates TERM-ignoring descendants`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-shell-timeout-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let parentPIDFile = directory.appendingPathComponent("parent.pid")
        let childPIDFile = directory.appendingPathComponent("child.pid")

        let result = await ShellExecutor.runDetailed(
            command: [
                "/bin/sh",
                "-c",
                """
                /bin/sh -c 'trap "" TERM; echo $$ > "$CHILD_PID_FILE"; while :; do sleep 10; done' &
                echo $$ > "$PARENT_PID_FILE"
                while [ ! -s "$CHILD_PID_FILE" ]; do sleep 0.01; done
                while :; do sleep 10; done
                """,
            ],
            cwd: nil,
            env: [
                "PARENT_PID_FILE": parentPIDFile.path,
                "CHILD_PID_FILE": childPIDFile.path,
            ],
            timeout: 0.2)

        #expect(result.timedOut)
        let parentPID = try self.readPID(from: parentPIDFile)
        let childPID = try self.readPID(from: childPIDFile)
        defer {
            for pid in [parentPID, childPID] where kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
        }
        #expect(await self.waitUntilGone(parentPID))
        #expect(await self.waitUntilGone(childPID))
    }

    private func readPID(from file: URL) throws -> pid_t {
        let value = try String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return try #require(pid_t(value))
    }

    private func waitUntilGone(_ pid: pid_t) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < deadline {
            errno = 0
            if kill(pid, 0) == -1, errno == ESRCH {
                return true
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
}
