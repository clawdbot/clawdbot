import Darwin
import Foundation
import Subprocess

final class ManagedProcess: @unchecked Sendable {
    private enum WakeReason: Sendable {
        case exited
        case terminate(gracefully: Bool)
    }

    private struct StartFailure: LocalizedError, Sendable {
        let message: String
        var errorDescription: String? {
            self.message
        }
    }

    private final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var childHandles: [FileHandle]
        private var startResult: Result<pid_t, StartFailure>?
        private var startWaiters: [UUID: CheckedContinuation<pid_t, any Error>] = [:]
        private var abortiveTerminationRequested = false
        private var finished = false

        init(childHandles: [FileHandle]) {
            self.childHandles = childHandles
        }

        var isRunning: Bool {
            self.lock.withLock { !self.finished }
        }

        var shouldAbortGracefulTermination: Bool {
            self.lock.withLock { self.abortiveTerminationRequested }
        }

        func requestAbortiveTermination() {
            self.lock.withLock { self.abortiveTerminationRequested = true }
        }

        func publishStart(_ result: Result<pid_t, StartFailure>) {
            let waiters = self.lock.withLock {
                guard self.startResult == nil else { return [CheckedContinuation<pid_t, any Error>]() }
                self.startResult = result
                defer { self.startWaiters.removeAll() }
                return Array(self.startWaiters.values)
            }
            for waiter in waiters {
                waiter.resume(with: result.mapError { $0 as any Error })
            }
        }

        func waitUntilStarted() async throws -> pid_t {
            let id = UUID()
            let pid = try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    let result: Result<pid_t, any Error>? = self.lock.withLock {
                        if Task.isCancelled { return .failure(CancellationError()) }
                        if let result = self.startResult { return result.mapError { $0 as any Error } }
                        self.startWaiters[id] = continuation
                        return nil
                    }
                    if let result { continuation.resume(with: result) }
                }
            } onCancel: {
                let waiter = self.lock.withLock { self.startWaiters.removeValue(forKey: id) }
                waiter?.resume(throwing: CancellationError())
            }
            try Task.checkCancellation()
            return pid
        }

        func closeChildHandles() {
            let handles = self.lock.withLock {
                defer { self.childHandles.removeAll() }
                return self.childHandles
            }
            handles.forEach { try? $0.close() }
        }

        func finish() {
            self.lock.withLock { self.finished = true }
        }

        static func hasExited(_ processIdentifier: pid_t) -> Bool {
            var info = siginfo_t()
            return waitid(P_PID, id_t(processIdentifier), &info, WEXITED | WNOHANG | WNOWAIT) == 0 &&
                info.si_pid != 0
        }
    }

    private let state: State
    private let wakeContinuation: AsyncStream<WakeReason>.Continuation
    let completionTask: Task<TerminationStatus?, Never>

    var isRunning: Bool {
        self.state.isRunning
    }

    private init(
        state: State,
        wakeContinuation: AsyncStream<WakeReason>.Continuation,
        completionTask: Task<TerminationStatus?, Never>)
    {
        self.state = state
        self.wakeContinuation = wakeContinuation
        self.completionTask = completionTask
    }

    static func launch(
        configuration: Subprocess.Configuration,
        input: some InputProtocol,
        output: some OutputProtocol,
        error: some ErrorOutputProtocol,
        closeAfterSpawn childHandles: [FileHandle] = [],
        closeStdinForGracefulShutdown stdinHandle: FileHandle? = nil,
        gracefulShutdownTimeout: Duration = .zero) -> ManagedProcess
    {
        var configuration = configuration
        configuration.platformOptions.createSession = true
        configuration.platformOptions.teardownSequence = [
            .send(signal: .terminate, toProcessGroup: true, allowedDurationToNextStep: .milliseconds(250)),
        ]
        let state = State(childHandles: childHandles)
        let (wakeEvents, wakeContinuation) = AsyncStream.makeStream(
            of: WakeReason.self,
            bufferingPolicy: .bufferingNewest(1))
        let task = Task.detached(priority: .userInitiated) { () -> TerminationStatus? in
            do {
                let result = try await Subprocess.run(
                    configuration,
                    input: input,
                    output: output,
                    error: error)
                { execution in
                    let pid = pid_t(execution.processIdentifier.value)
                    state.closeChildHandles()
                    // Startup is a replayable lifecycle fact; cancelling one waiter
                    // must not consume it or cancel the independently owned child.
                    state.publishStart(.success(pid))

                    let exitSource = DispatchSource.makeProcessSource(
                        identifier: pid,
                        eventMask: .exit,
                        queue: .global(qos: .userInitiated))
                    let didExit: @Sendable () -> Void = {
                        // Stop reuse at leader exit; completion still joins descendant cleanup.
                        state.finish()
                        wakeContinuation.yield(.exited)
                    }
                    exitSource.setEventHandler(handler: didExit)
                    exitSource.resume()
                    if State.hasExited(pid) { didExit() }
                    var wakeIterator = wakeEvents.makeAsyncIterator()
                    let wakeReason = await wakeIterator.next() ?? .terminate(gracefully: true)
                    exitSource.cancel()

                    func killGroup() async {
                        try? execution.send(signal: .kill, toProcessGroup: true)
                        try? await Task.sleep(for: .milliseconds(50))
                    }

                    guard !State.hasExited(pid),
                          case let .terminate(gracefully: graceful) = wakeReason
                    else {
                        // The unreaped leader pins the group identity while descendants are killed.
                        await killGroup()
                        return
                    }
                    if graceful, let stdinHandle {
                        try? stdinHandle.close()
                        if await self.waitForExit(
                            pid,
                            timeout: gracefulShutdownTimeout,
                            interruptWhenAbortive: state)
                        {
                            await killGroup()
                            return
                        }
                    }
                    try? await Task.sleep(for: .milliseconds(10))
                    try? execution.send(signal: .terminate, toProcessGroup: true)
                    _ = await self.waitForExit(pid, timeout: .milliseconds(250))
                    await killGroup()
                }
                state.finish()
                return result.terminationStatus
            } catch {
                state.closeChildHandles()
                let message = (error as? SubprocessError)?.description ?? error.localizedDescription
                state.publishStart(.failure(StartFailure(message: message)))
                state.finish()
                return nil
            }
        }
        return ManagedProcess(
            state: state,
            wakeContinuation: wakeContinuation,
            completionTask: task)
    }

    static func launch(
        configuration: Subprocess.Configuration,
        stdin: FileHandle,
        stdout: FileHandle,
        stderr: FileHandle,
        closeStdinForGracefulShutdown stdinWriter: FileHandle? = nil,
        gracefulShutdownTimeout: Duration = .zero) -> ManagedProcess
    {
        self.launch(
            configuration: configuration,
            input: .fileDescriptor(.init(rawValue: stdin.fileDescriptor), closeAfterSpawningProcess: false),
            output: .fileDescriptor(.init(rawValue: stdout.fileDescriptor), closeAfterSpawningProcess: false),
            error: .fileDescriptor(.init(rawValue: stderr.fileDescriptor), closeAfterSpawningProcess: false),
            closeAfterSpawn: [stdin, stdout, stderr],
            closeStdinForGracefulShutdown: stdinWriter,
            gracefulShutdownTimeout: gracefulShutdownTimeout)
    }

    static func environment(from values: [String: String]) -> Environment {
        .custom(values.reduce(into: [:]) { result, element in
            if let key = Environment.Key(rawValue: element.key) { result[key] = element.value }
        })
    }

    func waitUntilStarted() async throws -> pid_t {
        try await self.state.waitUntilStarted()
    }

    func requestTermination(gracefully: Bool = true) {
        if !gracefully {
            self.state.requestAbortiveTermination()
        }
        self.wakeContinuation.yield(.terminate(gracefully: gracefully))
    }

    func wait() async {
        _ = await self.completionTask.value
    }

    func terminate(gracefully: Bool = true) async {
        self.requestTermination(gracefully: gracefully)
        await self.wait()
    }

    deinit {
        self.requestTermination()
    }

    private static func waitForExit(
        _ processIdentifier: pid_t,
        timeout: Duration,
        interruptWhenAbortive state: State? = nil) async -> Bool
    {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if State.hasExited(processIdentifier) { return true }
            if state?.shouldAbortGracefulTermination == true { return false }
            do {
                try await Task.sleep(for: .milliseconds(10))
            } catch {
                return false
            }
        }
        return State.hasExited(processIdentifier)
    }
}
