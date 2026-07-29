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

    private static func runSubprocess(
        configuration: Configuration,
        output: OutputFiles) async throws -> TerminationStatus
    {
        let result = try await Subprocess.run(
            configuration,
            input: .standardInput,
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
            input: .standardInput,
            output: output.subprocessStandardOutput,
            error: output.subprocessStandardError)
        { execution in
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
        return result.closureOutput ? .timedOut : .completed(result.terminationStatus)
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
            .send(
                signal: .kill,
                toProcessGroup: true,
                allowedDurationToNextStep: .zero),
        ]
        let configuration = Configuration(
            .path(.init("/usr/bin/env")),
            arguments: Arguments(command),
            environment: self.environment(from: env),
            workingDirectory: cwd.map { .init($0) },
            platformOptions: platformOptions)

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
