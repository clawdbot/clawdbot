import Foundation

enum WatchMessageAcknowledgmentError: LocalizedError {
    case rejected(String)

    var errorDescription: String? {
        switch self {
        case let .rejected(reason):
            "WATCH_DELIVERY_REJECTED: \(reason)"
        }
    }
}

func requireAcceptedWatchMessageReply(_ reply: [String: Any]) throws {
    guard let accepted = reply["ok"] as? Bool else {
        throw WatchMessageAcknowledgmentError.rejected("malformed acknowledgment")
    }
    guard accepted else {
        let reason = (reply["error"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        throw WatchMessageAcknowledgmentError.rejected(
            reason.flatMap { $0.isEmpty ? nil : $0 } ?? "payload was rejected")
    }
}

enum WatchSessionActivationError: LocalizedError {
    case failed(String)
    case timedOut

    var errorDescription: String? {
        switch self {
        case let .failed(reason):
            "WATCH_UNAVAILABLE: Apple Watch session activation failed (\(reason))"
        case .timedOut:
            "WATCH_UNAVAILABLE: Apple Watch session activation timed out"
        }
    }
}

/// Joins concurrent sends to one WCSession activation and bounds the wait for its delegate callback.
/// A failed or timed-out generation remains retryable so a later foreground launch can recover.
final class WatchSessionActivationGate: @unchecked Sendable {
    private typealias Waiter = CheckedContinuation<Void, any Error>

    private enum State {
        case idle
        case activating(UInt64)
        case completed(Result<Void, WatchSessionActivationError>)
    }

    private let lock = NSLock()
    private let timeoutNanoseconds: UInt64
    private var generation: UInt64 = 0
    private var state = State.idle
    private var waiters: [Waiter] = []

    init(timeoutNanoseconds: UInt64 = 15_000_000_000) {
        self.timeoutNanoseconds = timeoutNanoseconds
    }

    @discardableResult
    func beginActivation() -> Bool {
        let generationToStart: UInt64? = self.lock.withLock {
            switch self.state {
            case .idle:
                break
            case .activating:
                return nil
            case let .completed(result):
                if case .success = result {
                    return nil
                }
            }

            self.generation &+= 1
            self.state = .activating(self.generation)
            return self.generation
        }

        guard let generationToStart else { return false }
        Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: self?.timeoutNanoseconds ?? 0)
            } catch {
                return
            }
            self?.finish(.failure(.timedOut), generation: generationToStart)
        }
        return true
    }

    func waitUntilActivated() async throws {
        try await withCheckedThrowingContinuation { (continuation: Waiter) in
            let completedResult: Result<Void, WatchSessionActivationError>? = self.lock.withLock {
                switch self.state {
                case .idle:
                    return .failure(.failed("activation was not started"))
                case .activating:
                    self.waiters.append(continuation)
                    return nil
                case let .completed(result):
                    return result
                }
            }
            if let completedResult {
                Self.resume(continuation, with: completedResult)
            }
        }
    }

    func complete(activated: Bool, errorDescription: String?) {
        let result: Result<Void, WatchSessionActivationError>
        if activated {
            result = .success(())
        } else {
            let reason = errorDescription?.trimmingCharacters(in: .whitespacesAndNewlines)
            let failureReason = reason.flatMap { $0.isEmpty ? nil : $0 } ?? "session stayed inactive"
            result = .failure(.failed(failureReason))
        }
        self.finish(result, generation: nil)
    }

    func reset() {
        let waiters: [Waiter] = self.lock.withLock {
            self.state = .idle
            let waiters = self.waiters
            self.waiters.removeAll()
            return waiters
        }
        let result = Result<Void, WatchSessionActivationError>.failure(
            .failed("active Apple Watch changed"))
        for waiter in waiters {
            Self.resume(waiter, with: result)
        }
    }

    private func finish(
        _ result: Result<Void, WatchSessionActivationError>,
        generation expectedGeneration: UInt64?)
    {
        let waiters: [Waiter]? = self.lock.withLock {
            if let expectedGeneration {
                guard case let .activating(activeGeneration) = self.state,
                      activeGeneration == expectedGeneration
                else {
                    return nil
                }
            }
            self.state = .completed(result)
            let waiters = self.waiters
            self.waiters.removeAll()
            return waiters
        }
        guard let waiters else { return }
        for waiter in waiters {
            Self.resume(waiter, with: result)
        }
    }

    private static func resume(
        _ continuation: Waiter,
        with result: Result<Void, WatchSessionActivationError>)
    {
        switch result {
        case .success:
            continuation.resume(returning: ())
        case let .failure(error):
            continuation.resume(throwing: error)
        }
    }
}
