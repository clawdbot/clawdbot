import Foundation

private actor AsyncTimeoutRace<T: Sendable> {
    private enum Outcome {
        case success(T)
        case failure(any Error)
    }

    private var outcome: Outcome?
    private var continuation: CheckedContinuation<T, any Error>?
    private var tasks: [Task<Void, Never>] = []

    func wait(for tasks: [Task<Void, Never>]) async throws -> T {
        if let outcome {
            tasks.forEach { $0.cancel() }
            return try self.value(from: outcome)
        }
        self.tasks = tasks
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    private func resolve(_ outcome: Outcome) {
        guard self.outcome == nil else { return }
        self.outcome = outcome
        self.tasks.forEach { $0.cancel() }
        self.tasks.removeAll()
        if let continuation {
            self.continuation = nil
            self.resume(continuation, with: outcome)
        }
    }

    func resolveSuccess(_ value: T) {
        self.resolve(.success(value))
    }

    func resolveFailure(_ error: any Error) {
        self.resolve(.failure(error))
    }

    private func resume(_ continuation: CheckedContinuation<T, any Error>, with outcome: Outcome) {
        switch outcome {
        case let .success(value):
            continuation.resume(returning: value)
        case let .failure(error):
            continuation.resume(throwing: error)
        }
    }

    private func value(from outcome: Outcome) throws -> T {
        switch outcome {
        case let .success(value):
            return value
        case let .failure(error):
            throw error
        }
    }
}

public enum AsyncTimeout {
    public static func withTimeout<T: Sendable>(
        seconds: Double,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        let clamped = max(0, seconds)
        // Unstructured racers let the caller return without awaiting a cancellation-ignoring loser.
        // The actor resumes once and cancels every racer; noncooperative work may still finish later,
        // so callers must own resource cleanup and stale-result safety.
        let race = AsyncTimeoutRace<T>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()

            let operationTask = Task {
                do {
                    let value = try await operation()
                    await race.resolveSuccess(value)
                } catch {
                    await race.resolveFailure(error)
                }
            }
            var tasks = [operationTask]
            if clamped > 0 {
                let timeoutTask = Task {
                    do {
                        try await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
                        await race.resolveFailure(onTimeout())
                    } catch is CancellationError {
                        // The operation or caller resolved the race first.
                    } catch {
                        await race.resolveFailure(error)
                    }
                }
                tasks.append(timeoutTask)
            }
            if Task.isCancelled {
                tasks.forEach { $0.cancel() }
                throw CancellationError()
            }
            return try await race.wait(for: tasks)
        } onCancel: {
            Task { await race.resolveFailure(CancellationError()) }
        }
    }

    public static func withTimeoutMs<T: Sendable>(
        timeoutMs: Int,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        let clamped = max(0, timeoutMs)
        let seconds = Double(clamped) / 1000.0
        return try await self.withTimeout(seconds: seconds, onTimeout: onTimeout, operation: operation)
    }
}
