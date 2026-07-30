import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct BoundedProcessTests {
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
                        timeout: 1).terminationStatus
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
                        timeout: 1).terminationStatus
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

        let parentPID = try self.readPID(from: parentPIDFile)
        let childPID = try self.readPID(from: childPIDFile)
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

        let producerPID = try self.readPID(from: pidFile)
        #expect(ContinuousClock.now - startedAt < .seconds(2))
        #expect(self.waitUntilGone(producerPID))
    }

    private func readPID(from file: URL) throws -> pid_t {
        let value = try String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return try #require(pid_t(value))
    }

    private func waitForPID(in file: URL) async throws -> pid_t {
        let deadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < deadline {
            if let value = try? self.readPID(from: file) {
                return value
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        return try self.readPID(from: file)
    }

    private func waitUntilGone(_ pid: pid_t) -> Bool {
        let deadline = Date().addingTimeInterval(1)
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
