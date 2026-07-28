import Foundation
import OpenClawIPC

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
    }

    private final class CompletionBox: @unchecked Sendable {
        private let lock = NSLock()
        private var finished = false
        private let continuation: CheckedContinuation<ShellResult, Never>
        private let output: OutputFiles

        init(continuation: CheckedContinuation<ShellResult, Never>, output: OutputFiles) {
            self.continuation = continuation
            self.output = output
        }

        func finish(
            status: Int?,
            timedOut: Bool,
            errorMessage: String?,
            beforeCapture: (@Sendable () -> Void)? = nil)
        {
            self.lock.lock()
            guard !self.finished else {
                self.lock.unlock()
                return
            }
            self.finished = true
            self.lock.unlock()
            beforeCapture?()
            let captured = self.output.readAndRemove()
            self.continuation.resume(returning: ShellResult(
                stdout: captured.stdout,
                stderr: captured.stderr,
                exitCode: status,
                timedOut: timedOut,
                success: status == 0 && !timedOut && errorMessage == nil,
                errorMessage: errorMessage ?? status.flatMap { $0 == 0 ? nil : "exit \($0)" }))
        }
    }

    private static func completedResult(status: Int, output: OutputFiles) -> ShellResult {
        let captured = output.readAndRemove()
        return ShellResult(
            stdout: captured.stdout,
            stderr: captured.stderr,
            exitCode: status,
            timedOut: false,
            success: status == 0,
            errorMessage: status == 0 ? nil : "exit \(status)")
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

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = command
        if let cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }
        if let env {
            process.environment = env
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
        process.standardOutput = output.stdout
        process.standardError = output.stderr

        if let timeout, timeout > 0 {
            return await withCheckedContinuation { continuation in
                let completion = CompletionBox(continuation: continuation, output: output)

                process.terminationHandler = { terminatedProcess in
                    let status = Int(terminatedProcess.terminationStatus)
                    completion.finish(status: status, timedOut: false, errorMessage: nil)
                }

                do {
                    try process.run()
                } catch {
                    completion.finish(
                        status: nil,
                        timedOut: false,
                        errorMessage: "failed to start: \(error.localizedDescription)")
                    return
                }

                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
                    guard process.isRunning else { return }
                    // Claim timeout classification before SIGTERM can trigger the termination handler.
                    completion.finish(
                        status: nil,
                        timedOut: true,
                        errorMessage: "timeout",
                        beforeCapture: { process.terminate() })
                }
            }
        }

        do {
            try process.run()
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

        process.waitUntilExit()
        return self.completedResult(status: Int(process.terminationStatus), output: output)
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}
