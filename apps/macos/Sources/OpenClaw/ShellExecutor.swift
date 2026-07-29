import Foundation
import OpenClawIPC
import Subprocess

enum ShellExecutor {
    struct ShellResult: Sendable {
        var stdout: String
        var stderr: String
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var errorMessage: String?
    }

    /// A background descendant may inherit stdout after its parent exits.
    /// Seekable files let the parent result finish without waiting for that unrelated process.
    private final class OutputFiles: @unchecked Sendable {
        let stdout: FileHandle
        let stderr: FileHandle
        private let stdoutURL: URL
        private let stderrURL: URL

        init() throws {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-shell-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            self.stdoutURL = directory.appendingPathComponent("stdout")
            self.stderrURL = directory.appendingPathComponent("stderr")
            FileManager.default.createFile(atPath: self.stdoutURL.path, contents: nil)
            FileManager.default.createFile(atPath: self.stderrURL.path, contents: nil)
            self.stdout = try FileHandle(forWritingTo: self.stdoutURL)
            self.stderr = try FileHandle(forWritingTo: self.stderrURL)
        }

        func readAndRemove() -> (stdout: String, stderr: String) {
            try? self.stdout.close()
            try? self.stderr.close()
            let stdoutData = (try? Data(contentsOf: self.stdoutURL)) ?? Data()
            let stderrData = (try? Data(contentsOf: self.stderrURL)) ?? Data()
            try? FileManager.default.removeItem(at: self.stdoutURL.deletingLastPathComponent())
            return (
                String(bytes: stdoutData, encoding: .utf8) ?? "",
                String(bytes: stderrData, encoding: .utf8) ?? "")
        }

        var subprocessStandardOutput: FileDescriptorOutput {
            .fileDescriptor(
                .init(rawValue: self.stdout.fileDescriptor),
                closeAfterSpawningProcess: false)
        }

        var subprocessStandardError: FileDescriptorOutput {
            .fileDescriptor(
                .init(rawValue: self.stderr.fileDescriptor),
                closeAfterSpawningProcess: false)
        }
    }

    private enum RunOutcome: Sendable {
        case completed(TerminationStatus)
        case timedOut
    }

    private static func environment(from values: [String: String]?) -> Environment {
        guard let values else { return .inherit }
        var converted: [Environment.Key: String] = [:]
        converted.reserveCapacity(values.count)
        for (key, value) in values {
            guard let environmentKey = Environment.Key(rawValue: key) else { continue }
            converted[environmentKey] = value
        }
        return .custom(converted)
    }

    private static func runSubprocess(
        configuration: Configuration,
        output: OutputFiles) async throws -> TerminationStatus
    {
        let result = try await Subprocess.run(
            configuration,
            output: output.subprocessStandardOutput,
            error: output.subprocessStandardError)
        return result.terminationStatus
    }

    private static func execute(
        configuration: Configuration,
        output: OutputFiles,
        timeout: Double?) async throws -> RunOutcome
    {
        guard let timeout, timeout > 0 else {
            return try await .completed(self.runSubprocess(configuration: configuration, output: output))
        }

        return try await withThrowingTaskGroup(of: RunOutcome.self) { group in
            group.addTask {
                try await .completed(self.runSubprocess(configuration: configuration, output: output))
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                return .timedOut
            }

            // Group scope waits for swift-subprocess cancellation teardown, including
            // SIGKILL escalation and reaping, before a timeout result reaches callers.
            defer { group.cancelAll() }
            return try await group.next() ?? .timedOut
        }
    }

    static func runDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?) async -> ShellResult
    {
        guard !command.isEmpty else {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "empty command")
        }

        let output: OutputFiles
        do {
            output = try OutputFiles()
        } catch {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "failed to capture output: \(error.localizedDescription)")
        }

        var platformOptions = PlatformOptions()
        platformOptions.qualityOfService = .userInitiated
        platformOptions.createSession = true
        platformOptions.teardownSequence = [
            .gracefulShutDown(
                toProcessGroup: true,
                allowedDurationToNextStep: .milliseconds(100)),
        ]
        let configuration = Configuration(
            .path(.init("/usr/bin/env")),
            arguments: Arguments(command),
            environment: self.environment(from: env),
            workingDirectory: cwd.map { .init($0) },
            platformOptions: platformOptions)

        do {
            let outcome = try await self.execute(
                configuration: configuration,
                output: output,
                timeout: timeout)
            let captured = output.readAndRemove()
            switch outcome {
            case .timedOut:
                return ShellResult(
                    stdout: captured.stdout,
                    stderr: captured.stderr,
                    exitCode: nil,
                    timedOut: true,
                    success: false,
                    errorMessage: "timeout")
            case let .completed(terminationStatus):
                let status = switch terminationStatus {
                case let .exited(code), let .signaled(code):
                    Int(code)
                }
                return ShellResult(
                    stdout: captured.stdout,
                    stderr: captured.stderr,
                    exitCode: status,
                    timedOut: false,
                    success: terminationStatus.isSuccess,
                    errorMessage: terminationStatus.isSuccess ? nil : "exit \(status)")
            }
        } catch {
            let captured = output.readAndRemove()
            return ShellResult(
                stdout: captured.stdout,
                stderr: captured.stderr,
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "failed to start: \(error.localizedDescription)")
        }
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}
