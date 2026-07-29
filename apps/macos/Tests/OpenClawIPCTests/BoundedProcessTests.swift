import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct BoundedProcessTests {
    @Test func `captures output without waiting for inherited handles`() throws {
        let startedAt = ContinuousClock.now
        let result = try BoundedProcess.run(
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

    @Test func `times out and reaps a TERM-resistant process group`() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-bounded-process-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let parentPIDFile = directory.appendingPathComponent("parent.pid")
        let childPIDFile = directory.appendingPathComponent("child.pid")

        let startedAt = ContinuousClock.now
        do {
            _ = try BoundedProcess.run(
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

    private func readPID(from file: URL) throws -> pid_t {
        let value = try String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return try #require(pid_t(value))
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
