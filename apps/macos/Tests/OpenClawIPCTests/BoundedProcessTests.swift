import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct BoundedProcessTests {
    /// The two fan-out tests below assert that no exit notification is *lost* when a
    /// child exits while its monitor is being registered. They are not latency
    /// assertions, so their timeout must not double as one.
    ///
    /// Spawning dozens of processes at once periodically stalls the whole fan-out:
    /// instrumenting the deadline showed every one of the 64 exits observed at
    /// ~3.1s, clustered within 100ms of each other, rather than a single slow
    /// straggler. A 1s per-process budget lost that coin flip roughly one run in
    /// five, failing 63 of 64 at once. A generous budget still fails hard if an
    /// exit is genuinely missed — the 50ms `pollUntilExit` fallback would never
    /// complete — while a merely-loaded machine passes.
    private static let concurrentSpawnTimeout: TimeInterval = 30

    @Test func `captures output without waiting for inherited handles`() async throws {
        let startedAt = ContinuousClock.now
        let result = try await BoundedProcess.run(
            path: "/bin/sh",
            arguments: ["-c", "sleep 5 & echo $!; echo ready"],
            timeout: 1)

        let output = try #require(String(data: result.output, encoding: .utf8))
        let lines = output.split(separator: "\n")
        let childPID = try #require(lines.first.flatMap { pid_t($0) })
        #expect(lines.contains("ready"))
        #expect(result.terminationStatus == 0)
        #expect(ContinuousClock.now - startedAt < .seconds(2))
        #expect(self.waitUntilGone(childPID))
    }

    @Test func `preserves combined standard output and error ordering`() async throws {
        let result = try await BoundedProcess.run(
            path: "/bin/sh",
            arguments: ["-c", "printf first; printf second >&2; printf third"],
            timeout: 1)

        #expect(String(data: result.output, encoding: .utf8) == "firstsecondthird")
    }

    @Test func `captures parallel instant exits`() async throws {
        let results = try await withThrowingTaskGroup(of: Int32.self) { group in
            for _ in 0..<32 {
                group.addTask {
                    try await BoundedProcess.run(
                        path: "/usr/bin/true",
                        arguments: [],
                        timeout: Self.concurrentSpawnTimeout).terminationStatus
                }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }

        #expect(results.count == 32)
        #expect(results.allSatisfy { $0 == 0 })
    }

    @Test func `captures parallel script exits during monitor registration`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-bounded-process-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let script = directory.appendingPathComponent("instant-exit")
        try "#!/bin/sh\nexit 0\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let results = try await withThrowingTaskGroup(of: Int32.self) { group in
            for _ in 0..<64 {
                group.addTask {
                    try await BoundedProcess.run(
                        path: script.path,
                        arguments: [],
                        timeout: Self.concurrentSpawnTimeout).terminationStatus
                }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }

        #expect(results.count == 64)
        #expect(results.allSatisfy { $0 == 0 })
    }

    @Test func `times out and reaps a TERM-resistant process group`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-bounded-process-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let parentPIDFile = directory.appendingPathComponent("parent.pid")
        let childPIDFile = directory.appendingPathComponent("child.pid")

        let startedAt = ContinuousClock.now
        do {
            _ = try await BoundedProcess.run(
                path: "/bin/sh",
                arguments: [
                    "-c",
                    """
                    trap '' TERM
                    /bin/sh -c 'trap "" TERM; echo $$ > "$CHILD_PID_FILE"; while :; do :; done' &
                    echo $$ > "$PARENT_PID_FILE"
                    while [ ! -s "$CHILD_PID_FILE" ]; do :; done
                    while :; do :; done
                    """,
                ],
                environment: [
                    "PARENT_PID_FILE": parentPIDFile.path,
                    "CHILD_PID_FILE": childPIDFile.path,
                ],
                timeout: 2)
            Issue.record("Expected process timeout")
        } catch {
            #expect(error is BoundedProcessError)
        }

        let parentPID = try await self.waitForPID(in: parentPIDFile)
        let childPID = try await self.waitForPID(in: childPIDFile)
        #expect(ContinuousClock.now - startedAt < .seconds(3))
        #expect(self.waitUntilGone(parentPID))
        #expect(self.waitUntilGone(childPID))
    }

    @Test func `cancellation reaps the process group`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-bounded-process-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let parentPIDFile = directory.appendingPathComponent("parent.pid")
        let childPIDFile = directory.appendingPathComponent("child.pid")

        let task = Task {
            try await BoundedProcess.run(
                path: "/bin/sh",
                arguments: [
                    "-c",
                    """
                    sleep 30 &
                    echo $$ > "$PARENT_PID_FILE"
                    echo $! > "$CHILD_PID_FILE"
                    wait
                    """,
                ],
                environment: [
                    "PARENT_PID_FILE": parentPIDFile.path,
                    "CHILD_PID_FILE": childPIDFile.path,
                ],
                timeout: 30)
        }
        let parentPID = try await self.waitForPID(in: parentPIDFile)
        let childPID = try await self.waitForPID(in: childPIDFile)

        task.cancel()
        do {
            _ = try await task.value
            Issue.record("Expected cancellation")
        } catch {
            #expect(error is CancellationError)
        }

        #expect(self.waitUntilGone(parentPID))
        #expect(self.waitUntilGone(childPID))
    }

    @Test func `rejects excessive output and reaps the producer`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-bounded-process-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let pidFile = directory.appendingPathComponent("producer.pid")

        let startedAt = ContinuousClock.now
        do {
            _ = try await BoundedProcess.run(
                path: "/bin/sh",
                arguments: [
                    "-c",
                    """
                    echo $$ > "$PID_FILE"
                    while :; do
                        printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
                    done
                    """,
                ],
                environment: ["PID_FILE": pidFile.path],
                timeout: 5)
            Issue.record("Expected output limit failure")
        } catch {
            #expect(!(error is BoundedProcessError))
        }

        let producerPID = try await self.waitForPID(in: pidFile)
        #expect(ContinuousClock.now - startedAt < .seconds(2))
        #expect(self.waitUntilGone(producerPID))
    }

    /// Non-recording parse for polling. `#require` records an issue even when the
    /// error it throws is swallowed by `try?`, so `waitForPID` cannot retry through
    /// `readPID`: the first read of a created-but-not-yet-written pid file would
    /// fail the test despite the retry succeeding a moment later.
    private func pollPID(from file: URL) -> pid_t? {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// `echo $$ > file` creates the file and writes to it in two steps, so a single
    /// read can observe a missing *or* empty file. Poll until it parses, and only
    /// then fall back to the recording read so a genuine absence still fails.
    private func waitForPID(in file: URL) async throws -> pid_t {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if let value = self.pollPID(from: file) {
                return value
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        let text = try String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return try #require(pid_t(text))
    }

    private func waitUntilGone(_ pid: pid_t) -> Bool {
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
