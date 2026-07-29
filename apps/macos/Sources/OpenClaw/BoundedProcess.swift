import Dispatch
import Foundation
import Subprocess

enum BoundedProcessError: Error {
    case timedOut
}

struct BoundedProcessResult: Sendable {
    var output: Data
    var terminationStatus: Int32
}

enum BoundedProcess {
    private enum DeadlineOutcome: Sendable {
        case exited
        case timedOut
    }

    private final class BlockingResult: @unchecked Sendable {
        private let lock = NSLock()
        private var result: Result<BoundedProcessResult, any Error>?

        func store(_ result: Result<BoundedProcessResult, any Error>) {
            self.lock.lock()
            self.result = result
            self.lock.unlock()
        }

        func take() -> Result<BoundedProcessResult, any Error> {
            self.lock.lock()
            defer { self.lock.unlock() }
            guard let result else {
                fatalError("bounded process completed without a result")
            }
            return result
        }
    }

    private final class OutputFile: @unchecked Sendable {
        private let handle: FileHandle
        private let url: URL

        init() throws {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-process-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            self.url = directory.appendingPathComponent("output")
            FileManager.default.createFile(atPath: self.url.path, contents: nil)
            self.handle = try FileHandle(forWritingTo: self.url)
        }

        var subprocessOutput: FileDescriptorOutput {
            .fileDescriptor(
                .init(rawValue: self.handle.fileDescriptor),
                closeAfterSpawningProcess: false)
        }

        func readAndRemove() -> Data {
            try? self.handle.close()
            let data = (try? Data(contentsOf: self.url)) ?? Data()
            try? FileManager.default.removeItem(at: self.url.deletingLastPathComponent())
            return data
        }

        func remove() {
            try? self.handle.close()
            try? FileManager.default.removeItem(at: self.url.deletingLastPathComponent())
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
                queue: .global(qos: .utility))
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

    static func run(
        path: String,
        arguments: [String],
        environment: [String: String]? = nil,
        workingDirectory: String? = nil,
        timeout: TimeInterval) throws -> BoundedProcessResult
    {
        precondition(timeout > 0)
        let result = BlockingResult()
        let completed = DispatchSemaphore(value: 0)
        Task.detached(priority: .utility) {
            do {
                try await result.store(.success(self.runAsync(
                    path: path,
                    arguments: arguments,
                    environment: environment,
                    workingDirectory: workingDirectory,
                    timeout: timeout)))
            } catch {
                result.store(.failure(error))
            }
            completed.signal()
        }
        completed.wait()
        return try result.take().get()
    }

    private static func runAsync(
        path: String,
        arguments: [String],
        environment: [String: String]?,
        workingDirectory: String?,
        timeout: TimeInterval) async throws -> BoundedProcessResult
    {
        let output = try OutputFile()
        var shouldRemoveOutput = true
        defer {
            if shouldRemoveOutput {
                output.remove()
            }
        }

        var platformOptions = PlatformOptions()
        platformOptions.qualityOfService = .utility
        platformOptions.createSession = true
        platformOptions.teardownSequence = [
            .send(
                signal: .kill,
                toProcessGroup: true,
                allowedDurationToNextStep: .zero),
        ]
        let configuration = Configuration(
            .path(.init(path)),
            arguments: Arguments(arguments),
            environment: environment.map(self.environment(from:)) ?? .inherit,
            workingDirectory: workingDirectory.map { .init($0) },
            platformOptions: platformOptions)
        let descriptor = output.subprocessOutput
        let executionResult = try await Subprocess.run(
            configuration,
            input: .none,
            output: descriptor,
            error: descriptor)
        { execution in
            let exitSignal = ProcessExitSignal(
                processIdentifier: pid_t(execution.processIdentifier.value))
            let deadline = await withTaskGroup(of: DeadlineOutcome.self) { group in
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

            switch deadline {
            case .exited:
                // The body runs before swift-subprocess reaps the group leader.
                // Kill inherited descendants while the pid cannot be recycled.
                try? execution.send(signal: .kill, toProcessGroup: true)
                return false
            case .timedOut:
                try? execution.send(signal: .terminate, toProcessGroup: true)
                try? await Task.sleep(for: .milliseconds(100))
                try? execution.send(signal: .kill, toProcessGroup: true)
                return true
            }
        }

        let data = output.readAndRemove()
        shouldRemoveOutput = false
        if executionResult.closureOutput {
            throw BoundedProcessError.timedOut
        }
        let terminationStatus = switch executionResult.terminationStatus {
        case let .exited(code), let .signaled(code):
            Int32(code)
        }
        return BoundedProcessResult(output: data, terminationStatus: terminationStatus)
    }

    private static func environment(from values: [String: String]) -> Environment {
        var converted: [Environment.Key: String] = [:]
        converted.reserveCapacity(values.count)
        for (key, value) in values {
            guard let environmentKey = Environment.Key(rawValue: key) else { continue }
            converted[environmentKey] = value
        }
        return .custom(converted)
    }
}
