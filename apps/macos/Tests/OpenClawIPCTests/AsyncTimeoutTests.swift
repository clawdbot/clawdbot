import Foundation
import OpenClawKit
import Testing

private struct ExpectedTimeout: Error {}
private struct ExpectedOperationFailure: Error {}

private final class CancellationProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var wasCancelled = false

    func markCancelled() {
        self.lock.lock()
        self.wasCancelled = true
        self.lock.unlock()
    }

    func cancelled() -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.wasCancelled
    }
}

private actor CancellationIgnoringOperation {
    private var didStart = false
    private var didFinish = false
    private var isReleased = false
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var finishWaiters: [CheckedContinuation<Void, Never>] = []

    func run() async -> String {
        self.didStart = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()

        if !self.isReleased {
            await withCheckedContinuation { continuation in
                self.releaseContinuation = continuation
            }
        }

        self.didFinish = true
        self.finishWaiters.forEach { $0.resume() }
        self.finishWaiters.removeAll()
        return "late"
    }

    func waitUntilStarted() async {
        if self.didStart {
            return
        }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func waitUntilFinished() async {
        if self.didFinish { return }
        await withCheckedContinuation { continuation in
            self.finishWaiters.append(continuation)
        }
    }

    func release() {
        self.isReleased = true
        self.releaseContinuation?.resume()
        self.releaseContinuation = nil
    }

    func started() -> Bool {
        self.didStart
    }

    func finished() -> Bool {
        self.didFinish
    }
}

private actor AsyncTimeoutTestGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if self.isOpen { return }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }

    func open() {
        self.isOpen = true
        self.waiters.forEach { $0.resume() }
        self.waiters.removeAll()
    }
}

private actor AsyncTimeoutStartState {
    private var didStart = false

    func markStarted() {
        self.didStart = true
    }

    func started() -> Bool {
        self.didStart
    }
}

struct AsyncTimeoutTests {
    @Test func `timeout returns when operation ignores cancellation`() async {
        let operation = CancellationIgnoringOperation()
        let cancellation = CancellationProbe()
        let watchdog = Task {
            do {
                try await Task.sleep(for: .seconds(1))
                await operation.release()
            } catch {}
        }

        await #expect(throws: ExpectedTimeout.self) {
            try await AsyncTimeout.withTimeout(
                seconds: 0.05,
                onTimeout: { ExpectedTimeout() },
                operation: {
                    await withTaskCancellationHandler {
                        await operation.run()
                    } onCancel: {
                        cancellation.markCancelled()
                    }
                })
        }

        #expect(cancellation.cancelled())
        #expect(await operation.started())
        #expect(await !operation.finished())
        await operation.release()
        await operation.waitUntilFinished()
        watchdog.cancel()
    }

    @Test func `successful operation wins`() async throws {
        let result = try await AsyncTimeout.withTimeout(
            seconds: 1,
            onTimeout: { ExpectedTimeout() },
            operation: { "ready" })

        #expect(result == "ready")
    }

    @Test func `zero timeout preserves unbounded operation semantics`() async throws {
        let result = try await AsyncTimeout.withTimeout(
            seconds: 0,
            onTimeout: { ExpectedTimeout() },
            operation: { "unbounded" })

        #expect(result == "unbounded")
    }

    @Test func `operation error propagates`() async {
        await #expect(throws: ExpectedOperationFailure.self) {
            try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { ExpectedTimeout() },
                operation: { throw ExpectedOperationFailure() })
        }
    }

    @Test(arguments: [0.0, 60.0])
    func `caller cancellation returns before operation finishes`(seconds: Double) async {
        let operation = CancellationIgnoringOperation()
        let cancellation = CancellationProbe()
        let task = Task {
            try await AsyncTimeout.withTimeout(
                seconds: seconds,
                onTimeout: { ExpectedTimeout() },
                operation: {
                    await withTaskCancellationHandler {
                        await operation.run()
                    } onCancel: {
                        cancellation.markCancelled()
                    }
                })
        }
        await operation.waitUntilStarted()
        let watchdog = Task {
            do {
                try await Task.sleep(for: .seconds(1))
                await operation.release()
            } catch {}
        }

        task.cancel()
        await #expect(throws: CancellationError.self) {
            try await task.value
        }
        #expect(cancellation.cancelled())
        #expect(await !operation.finished())

        await operation.release()
        await operation.waitUntilFinished()
        watchdog.cancel()
    }

    @Test func `pre cancelled task does not start operation`() async {
        let entryGate = AsyncTimeoutTestGate()
        let operationState = AsyncTimeoutStartState()
        let task = Task {
            await entryGate.wait()
            return try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { ExpectedTimeout() },
                operation: {
                    await operationState.markStarted()
                    return "unexpected"
                })
        }

        task.cancel()
        await entryGate.open()
        await #expect(throws: CancellationError.self) {
            try await task.value
        }
        for _ in 0..<20 {
            await Task.yield()
        }
        #expect(await !operationState.started())
    }
}
