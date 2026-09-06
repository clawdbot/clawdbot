import Darwin
import Foundation
import Testing
@testable import OpenClaw

private actor ShellLineRecorder {
    private var lines: [String] = []

    func append(_ line: String) {
        self.lines.append(line)
    }

    func snapshot() -> [String] {
        self.lines
    }
}

struct ShellExecutorTimeoutTests {
    /// The executor's deadline starts at spawn, so allow ample process startup time.
    /// This is a fixture budget, not the timeout behavior under test.
    private static let fixtureTimeout: TimeInterval = 1.0

    @Test func `streaming captures both streams while delivering stdout lines`() async {
        let recorder = ShellLineRecorder()
        let result = await ShellExecutor.runStreamingDetailed(
            command: [
                "/bin/sh",
                "-c",
                "printf 'one\\ntwo\\n'; printf 'problem\\n' >&2",
            ],
            cwd: nil,
            env: nil,
            timeout: 5)
        { line in
            await recorder.append(line)
        }

        #expect(result.success)
        #expect(await recorder.snapshot() == ["one", "two"])
        #expect(result.stdout == "one\ntwo\n")
        #expect(result.stderr == "problem\n")
    }

    @Test func `timeout kills and reaps a TERM-ignoring command`() async throws {
        try await self.assertTimeoutKillsAndReaps(streaming: false)
    }

    @Test func `streaming timeout kills and reaps a TERM-ignoring command`() async throws {
        try await self.assertTimeoutKillsAndReaps(streaming: true)
    }

    @Test func `timeout terminates TERM-ignoring descendants`() async throws {
        try await self.assertTimeoutTerminatesDescendants(streaming: false)
    }

    @Test func `streaming timeout terminates TERM-ignoring descendants`() async throws {
        try await self.assertTimeoutTerminatesDescendants(streaming: true)
    }

    private func assertTimeoutKillsAndReaps(streaming: Bool) async throws {
        let pidFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-shell-timeout-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }

        let command = [
            "/bin/sh",
            "-c",
            "echo $$ > \"$PID_FILE\"; trap '' TERM; exec /bin/sleep 30",
        ]
        let environment = ["PID_FILE": pidFile.path]
        let result = if streaming {
            await ShellExecutor.runStreamingDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout,
                onStandardOutputLine: { _ in })
        } else {
            await ShellExecutor.runDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout)
        }

        #expect(result.timedOut)
        let pid = try self.readPID(from: pidFile)
        defer {
            if kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
        }
        #expect(await self.waitUntilGone(pid))
    }

    private func assertTimeoutTerminatesDescendants(streaming: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-shell-timeout-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let parentPIDFile = directory.appendingPathComponent("parent.pid")
        let childPIDFile = directory.appendingPathComponent("child.pid")

        let command = [
            "/bin/sh",
            "-c",
            """
            /bin/sh -c 'trap "" TERM; echo $$ > "$CHILD_PID_FILE"; while :; do sleep 10; done' &
            echo $$ > "$PARENT_PID_FILE"
            while [ ! -s "$CHILD_PID_FILE" ]; do sleep 0.01; done
            while :; do sleep 10; done
            """,
        ]
        let environment = [
            "PARENT_PID_FILE": parentPIDFile.path,
            "CHILD_PID_FILE": childPIDFile.path,
        ]
        let result = if streaming {
            await ShellExecutor.runStreamingDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout,
                onStandardOutputLine: { _ in })
        } else {
            await ShellExecutor.runDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout)
        }

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
        try #require(
            FileManager.default.fileExists(atPath: file.path),
            "Timeout fixture did not publish its PID file: \(file.path)")
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
