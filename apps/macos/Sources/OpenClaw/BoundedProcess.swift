import Darwin
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
    private static let outputLimit = 64 * 1024

    private enum DeadlineOutcome: Sendable {
        case exited
        case timedOut
    }

    private final class ProcessExitSignal: @unchecked Sendable {
        private let lock = NSLock()
        private let processIdentifier: pid_t
        private let source: DispatchSourceProcess?
        private var continuation: CheckedContinuation<Void, Never>?
        private var finished = false

        init(processIdentifier: pid_t) {
            self.processIdentifier = processIdentifier
            if Self.hasExited(processIdentifier) {
                self.source = nil
                self.finished = true
                return
            }
            let source = DispatchSource.makeProcessSource(
                identifier: processIdentifier,
                eventMask: .exit,
                queue: .global(qos: .utility))
            self.source = source
            source.setEventHandler { [weak self] in
                self?.finish()
            }
            source.resume()
            // The child can exit between the initial waitid probe and kqueue
            // registration. Recheck after resume so that race cannot consume
            // the full timeout when no NOTE_EXIT event is delivered.
            if Self.hasExited(processIdentifier) {
                self.finish()
            }
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

        func pollUntilExit() async {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .milliseconds(50))
                } catch {
                    return
                }
                if Self.hasExited(self.processIdentifier) {
                    self.finish()
                    return
                }
            }
        }

        func hasExited() -> Bool {
            Self.hasExited(self.processIdentifier)
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
            self.source?.cancel()
            continuation?.resume()
        }

        private static func hasExited(_ processIdentifier: pid_t) -> Bool {
            while true {
                var info = siginfo_t()
                if waitid(P_PID, id_t(processIdentifier), &info, WEXITED | WNOHANG | WNOWAIT) == 0 {
                    return info.si_pid != 0 || info.si_signo != 0
                }
                guard errno == EINTR else { return false }
            }
        }
    }

    static func run(
        path: String,
        arguments: [String],
        environment: [String: String]? = nil,
        workingDirectory: String? = nil,
        timeout: TimeInterval) async throws -> BoundedProcessResult
    {
        precondition(timeout > 0)
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
        let executionResult = try await Subprocess.run(
            configuration,
            input: .none,
            output: .bytes(limit: self.outputLimit),
            error: .combinedWithOutput)
        { execution in
            let exitSignal = ProcessExitSignal(
                processIdentifier: pid_t(execution.processIdentifier.value))
            let deadline = await withTaskGroup(of: DeadlineOutcome.self) { group in
                group.addTask {
                    await exitSignal.wait()
                    return .exited
                }
                // Keep normal exits event-driven, but recover promptly if
                // kqueue misses NOTE_EXIT under heavy concurrent spawning.
                group.addTask {
                    await exitSignal.pollUntilExit()
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
            try Task.checkCancellation()

            switch deadline {
            case .exited:
                // The body runs before swift-subprocess reaps the group leader.
                // Kill inherited descendants while the pid cannot be recycled.
                try? execution.send(signal: .kill, toProcessGroup: true)
                return false
            case .timedOut:
                if exitSignal.hasExited() {
                    try? execution.send(signal: .kill, toProcessGroup: true)
                    return false
                }
                try? execution.send(signal: .terminate, toProcessGroup: true)
                try? await Task.sleep(for: .milliseconds(100))
                try? execution.send(signal: .kill, toProcessGroup: true)
                return true
            }
        }

        if executionResult.closureOutput {
            throw BoundedProcessError.timedOut
        }
        let data = Data(executionResult.standardOutput)
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
