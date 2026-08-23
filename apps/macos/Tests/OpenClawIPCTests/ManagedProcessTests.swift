import Foundation
import Subprocess
import Testing
@testable import OpenClaw

#if canImport(Darwin)
struct ManagedProcessTests {
    @Test func `launch failures preserve the executable description`() async {
        let executable = "/tmp/openclaw-missing-process-\(UUID().uuidString)"

        do {
            _ = try await self.start(executable: executable)
            Issue.record("expected the missing executable to fail")
        } catch {
            #expect(error.localizedDescription.contains(executable))
        }
    }

    @Test func `abortive termination interrupts the stdin grace period`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-managed-process-abort-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let eofFile = directory.appendingPathComponent("eof")
        let termFile = directory.appendingPathComponent("term")
        let stdinPipe = Pipe()
        let configuration = Subprocess.Configuration(
            .path(.init("/bin/sh")),
            arguments: Arguments([
                "-c",
                #"trap 'touch "$2"; exit 0' TERM; while IFS= read -r _; do :; done; touch "$1"; while :; do sleep 1; done"#,
                "managed-process",
                eofFile.path,
                termFile.path,
            ]))
        let process = ManagedProcess.launch(
            configuration: configuration,
            input: .fileDescriptor(
                .init(rawValue: stdinPipe.fileHandleForReading.fileDescriptor),
                closeAfterSpawningProcess: false),
            output: .discarded,
            error: .discarded,
            closeAfterSpawn: [stdinPipe.fileHandleForReading],
            closeStdinForGracefulShutdown: stdinPipe.fileHandleForWriting,
            gracefulShutdownTimeout: .seconds(2))
        _ = try await process.waitUntilStarted()

        let startedAt = ContinuousClock.now
        let termination = Task { await process.terminate() }
        let eofDeadline = ContinuousClock.now + .seconds(1)
        while !FileManager.default.fileExists(atPath: eofFile.path), ContinuousClock.now < eofDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        process.requestTermination(gracefully: false)
        await termination.value

        #expect(FileManager.default.fileExists(atPath: eofFile.path))
        #expect(FileManager.default.fileExists(atPath: termFile.path))
        #expect(ContinuousClock.now - startedAt < .seconds(1))
    }

    @Test func `instant exits cannot outrun process monitoring`() async throws {
        for _ in 0..<32 {
            let process = try await self.start(executable: "/usr/bin/true")
            defer { process.requestTermination() }

            let deadline = ContinuousClock.now + .seconds(1)
            while process.isRunning, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(1))
            }
            #expect(!process.isRunning)
            await process.terminate()
        }
    }

    @Test func `termination escalates for a TERM-resistant descendant`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-managed-process-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let childPIDFile = directory.appendingPathComponent("child.pid")
        let process = try await self.start(
            executable: "/bin/sh",
            arguments: [
                "-c",
                """
                /bin/sh -c 'trap "" TERM; echo $$ > "$CHILD_PID_FILE"; while :; do sleep 1; done' &
                while :; do sleep 1; done
                """,
            ],
            environment: ["CHILD_PID_FILE": childPIDFile.path])
        defer { process.requestTermination() }
        let childPID = try await TestProcessSupport.waitForPID(
            in: childPIDFile,
            timeout: .seconds(1))

        let startedAt = ContinuousClock.now
        await process.terminate()

        #expect(ContinuousClock.now - startedAt < .seconds(2))
        #expect(!process.isRunning)
        #expect(TestProcessSupport.processIsGone(childPID))
    }

    private func start(
        executable: String,
        arguments: [String] = [],
        environment: [String: String] = [:]) async throws -> ManagedProcess
    {
        let configuration = Subprocess.Configuration(
            .path(.init(executable)),
            arguments: Arguments(arguments),
            environment: ManagedProcess.environment(from: environment))
        let process = ManagedProcess.launch(
            configuration: configuration,
            input: .none,
            output: .discarded,
            error: .discarded)
        _ = try await process.waitUntilStarted()
        return process
    }
}
#endif
