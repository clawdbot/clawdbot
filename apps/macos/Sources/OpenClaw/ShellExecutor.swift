import Darwin
import Dispatch
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
        var preflightError: String?
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

    private enum DeadlineOutcome: Sendable, Equatable {
        case exited
        case timedOut
    }

    private enum StreamingTaskResult: Sendable {
        case drained
        case deadline(timedOut: Bool)
    }

    private final class StreamingOutputCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var stdoutLines: [String] = []
        private var stderrLines: [String] = []

        func appendStdout(line: String) {
            self.lock.withLock {
                self.stdoutLines.append(line)
            }
        }

        func appendStderr(line: String) {
            self.lock.withLock {
                self.stderrLines.append(line)
            }
        }

        func snapshot() -> (stdout: String, stderr: String) {
            self.lock.withLock {
                (Self.output(from: self.stdoutLines), Self.output(from: self.stderrLines))
            }
        }

        private static func output(from lines: [String]) -> String {
            guard !lines.isEmpty else { return "" }
            return lines.joined(separator: "\n") + "\n"
        }
    }

    private final class ProcessExitSignal: @unchecked Sendable {
        private let lock = NSLock()
        private let source: DispatchSourceProcess
        private var continuation: CheckedContinuation<Void, Never>?
        private var finished = false

        init(processIdentifier: pid_t) {
            self.source = DispatchSource.makeProcessSource(
                identifier: processIdentifier,
                eventMask: .exit,
                queue: .global(qos: .userInitiated))
            self.source.setEventHandler { [weak self] in
                self?.finish()
            }
            self.source.resume()
        }

        func wait() async {
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    self.lock.lock()
                    guard !self.finished else {
                        self.lock.unlock()
                        continuation.resume()
                        return
                    }
                    self.continuation = continuation
                    self.lock.unlock()
                }
            } onCancel: {
                self.finish()
            }
        }

        private func finish() {
            self.lock.lock()
            guard !self.finished else {
                self.lock.unlock()
                return
            }
            self.finished = true
            let continuation = self.continuation
            self.continuation = nil
            self.lock.unlock()
            self.source.cancel()
            continuation?.resume()
        }
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

    private static func configuration(command: [String], cwd: String?, env: [String: String]?) -> Configuration {
        var platformOptions = PlatformOptions()
        platformOptions.qualityOfService = .userInitiated
        platformOptions.createSession = true
        platformOptions.teardownSequence = [
            .send(
                signal: .kill,
                toProcessGroup: true,
                allowedDurationToNextStep: .zero),
        ]
        return Configuration(
            executable: .path(.init("/usr/bin/env")),
            arguments: Arguments(command),
            environment: self.environment(from: env),
            workingDirectory: cwd.map { .init($0) },
            platformOptions: platformOptions)
    }

    private static func completedResult(
        _ terminationStatus: TerminationStatus,
        captured: (stdout: String, stderr: String)) -> ShellResult
    {
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
            errorMessage: terminationStatus.isSuccess ? nil : "exit \(status)",
            preflightError: nil)
    }

    private static func timedOutResult(captured: (stdout: String, stderr: String)) -> ShellResult {
        ShellResult(
            stdout: captured.stdout,
            stderr: captured.stderr,
            exitCode: nil,
            timedOut: true,
            success: false,
            errorMessage: "timeout",
            preflightError: nil)
    }

    private static func failedResult(
        captured: (stdout: String, stderr: String) = ("", ""),
        message: String,
        preflightError: String? = nil) -> ShellResult
    {
        ShellResult(
            stdout: captured.stdout,
            stderr: captured.stderr,
            exitCode: nil,
            timedOut: false,
            success: false,
            errorMessage: message,
            preflightError: preflightError)
    }

    private static func runSubprocess(
        configuration: Configuration,
        output: OutputFiles) async throws -> TerminationStatus
    {
        let result = try await Subprocess.run(
            configuration,
            input: .currentStandardInput,
            output: output.subprocessStandardOutput,
            error: output.subprocessStandardError)
        return result.terminationStatus
    }

    private static func runTimedSubprocess(
        configuration: Configuration,
        output: OutputFiles,
        timeout: Double) async throws -> RunOutcome
    {
        let result = try await Subprocess.run(
            configuration,
            input: .currentStandardInput,
            output: output.subprocessStandardOutput,
            error: output.subprocessStandardError)
        { execution in
            await self.waitForExitOrTimeout(execution: execution, timeout: timeout)
        }
        return result.closureResult ? .timedOut : .completed(result.terminationStatus)
    }

    private static func waitForExitOrTimeout(
        execution: Execution<some InputProtocol, some OutputProtocol, some OutputProtocol>,
        timeout: Double) async -> Bool
    {
        let processIdentifier = pid_t(execution.processIdentifier.value)
        return await withTaskCancellationHandler {
            let deadline = await withTaskGroup(of: DeadlineOutcome.self) { group in
                let exitSignal = ProcessExitSignal(processIdentifier: processIdentifier)
                group.addTask {
                    await exitSignal.wait()
                    return .exited
                }
                group.addTask {
                    do {
                        try await Task.sleep(for: .seconds(timeout))
                        return .timedOut
                    } catch {
                        return .exited
                    }
                }
                defer { group.cancelAll() }
                return await group.next() ?? .exited
            }

            guard deadline == .timedOut else { return false }
            try? execution.send(signal: .terminate, toProcessGroup: true)
            try? await Task.sleep(for: .milliseconds(100))
            // The group leader may have exited on TERM. Keep the body alive until
            // the final group kill so TERM-ignoring descendants cannot escape.
            try? execution.send(signal: .kill, toProcessGroup: true)
            return true
        } onCancel: {
            // Cancellation can arrive before the timeout race finishes.
            _ = Darwin.kill(-processIdentifier, SIGKILL)
        }
    }

    private static func runStreamingSubprocess(
        configuration: Configuration,
        timeout: Double?,
        capture: StreamingOutputCapture,
        onStandardOutputLine: @escaping @Sendable (String) async -> Void) async throws
        -> (terminationStatus: TerminationStatus, timedOut: Bool)
    {
        let result = try await Subprocess.run(
            configuration,
            input: .currentStandardInput,
            output: .sequence,
            error: .sequence)
        { execution in
            let processIdentifier = pid_t(execution.processIdentifier.value)
            return try await withTaskCancellationHandler {
                try await withThrowingTaskGroup(of: StreamingTaskResult.self) { group in
                    group.addTask {
                        for try await line in execution.standardOutput.strings(bufferingPolicy: .unbounded) {
                            capture.appendStdout(line: line)
                            await onStandardOutputLine(line)
                        }
                        return .drained
                    }
                    group.addTask {
                        for try await line in execution.standardError.strings(bufferingPolicy: .unbounded) {
                            capture.appendStderr(line: line)
                        }
                        return .drained
                    }
                    if let timeout, timeout > 0 {
                        group.addTask {
                            await .deadline(
                                timedOut: self.waitForExitOrTimeout(
                                    execution: execution,
                                    timeout: timeout))
                        }
                    }

                    var timedOut = false
                    for try await taskResult in group {
                        if case let .deadline(didTimeOut) = taskResult {
                            timedOut = didTimeOut
                        }
                    }
                    return timedOut
                }
            } onCancel: {
                _ = Darwin.kill(-processIdentifier, SIGKILL)
            }
        }
        return (result.terminationStatus, result.closureResult)
    }

    static func runDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?,
        beforeSpawn: (@Sendable () -> String?)? = nil) async -> ShellResult
    {
        guard !command.isEmpty else {
            return self.failedResult(message: "empty command")
        }

        let output: OutputFiles
        do {
            output = try OutputFiles()
        } catch {
            return self.failedResult(message: "failed to capture output: \(error.localizedDescription)")
        }

        let configuration = self.configuration(command: command, cwd: cwd, env: env)

        if let message = beforeSpawn?() {
            _ = output.readAndRemove()
            return self.failedResult(message: message, preflightError: message)
        }

        do {
            let outcome = if let timeout, timeout > 0 {
                try await self.runTimedSubprocess(
                    configuration: configuration,
                    output: output,
                    timeout: timeout)
            } else {
                try await RunOutcome.completed(
                    self.runSubprocess(configuration: configuration, output: output))
            }
            let captured = output.readAndRemove()
            switch outcome {
            case .timedOut:
                return self.timedOutResult(captured: captured)
            case let .completed(terminationStatus):
                return self.completedResult(terminationStatus, captured: captured)
            }
        } catch {
            let captured = output.readAndRemove()
            return self.failedResult(
                captured: captured,
                message: "failed to start: \(error.localizedDescription)")
        }
    }

    /// The installer owns its process tree and does not daemonize descendants, so
    /// it can safely use pipe-backed streaming. Broad callers keep the file-backed
    /// path above because an unrelated descendant may inherit their stdout.
    static func runStreamingDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?,
        onStandardOutputLine: @escaping @Sendable (String) async -> Void) async -> ShellResult
    {
        guard !command.isEmpty else {
            return self.failedResult(message: "empty command")
        }

        let configuration = self.configuration(command: command, cwd: cwd, env: env)
        let capture = StreamingOutputCapture()

        do {
            let outcome = try await self.runStreamingSubprocess(
                configuration: configuration,
                timeout: timeout,
                capture: capture,
                onStandardOutputLine: onStandardOutputLine)
            let captured = capture.snapshot()
            if outcome.timedOut {
                return self.timedOutResult(captured: captured)
            }
            return self.completedResult(outcome.terminationStatus, captured: captured)
        } catch {
            let captured = capture.snapshot()
            return self.failedResult(
                captured: captured,
                message: "failed to start: \(error.localizedDescription)")
        }
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}
