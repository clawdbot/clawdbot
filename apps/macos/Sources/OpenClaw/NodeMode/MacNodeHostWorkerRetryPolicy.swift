import Foundation

struct MacNodeHostWorkerRetryPolicy: Sendable {
    struct Input: Equatable, Sendable {
        let launch: MacNodeHostWorkerLaunch
        let configurationGeneration: UInt64
    }

    enum UnexpectedExitDisposition: Equatable, Sendable {
        case retry(attempt: Int, delayNanoseconds: UInt64)
        case giveUp(unexpectedExitCount: Int)
    }

    struct RetryBudgetExhausted: LocalizedError, Equatable, Sendable {
        let unexpectedExitCount: Int

        var errorDescription: String? {
            "node-host worker stopped after \(self.unexpectedExitCount) unexpected exits"
        }
    }

    struct RetryBackoffPending: LocalizedError, Equatable, Sendable {
        var errorDescription: String? {
            "node-host worker retry backoff is still pending"
        }
    }

    static let defaultMaximumRetryCount = 5
    static let defaultInitialDelayNanoseconds: UInt64 = 1_000_000_000
    static let defaultMaximumDelayNanoseconds: UInt64 = 10_000_000_000

    private let maximumRetryCount: Int
    private let initialDelayNanoseconds: UInt64
    private let maximumDelayNanoseconds: UInt64
    private var input: Input?
    private var unexpectedExitCount = 0
    private var exhausted = false

    init(
        maximumRetryCount: Int = Self.defaultMaximumRetryCount,
        initialDelayNanoseconds: UInt64 = Self.defaultInitialDelayNanoseconds,
        maximumDelayNanoseconds: UInt64 = Self.defaultMaximumDelayNanoseconds)
    {
        precondition(maximumRetryCount >= 0)
        precondition(initialDelayNanoseconds > 0)
        precondition(maximumDelayNanoseconds >= initialDelayNanoseconds)
        self.maximumRetryCount = maximumRetryCount
        self.initialDelayNanoseconds = initialDelayNanoseconds
        self.maximumDelayNanoseconds = maximumDelayNanoseconds
    }

    mutating func prepareForStart(_ input: Input) throws {
        self.adopt(input)
        if self.exhausted {
            throw RetryBudgetExhausted(unexpectedExitCount: self.unexpectedExitCount)
        }
    }

    mutating func recordUnexpectedExit(for input: Input) -> UnexpectedExitDisposition {
        self.adopt(input)
        guard !self.exhausted else {
            return .giveUp(unexpectedExitCount: self.unexpectedExitCount)
        }

        self.unexpectedExitCount += 1
        guard self.unexpectedExitCount <= self.maximumRetryCount else {
            self.exhausted = true
            return .giveUp(unexpectedExitCount: self.unexpectedExitCount)
        }
        return .retry(
            attempt: self.unexpectedExitCount,
            delayNanoseconds: self.retryDelay(for: self.unexpectedExitCount))
    }

    mutating func reset() {
        self.input = nil
        self.unexpectedExitCount = 0
        self.exhausted = false
    }

    private mutating func adopt(_ input: Input) {
        guard self.input != input else { return }
        self.input = input
        self.unexpectedExitCount = 0
        self.exhausted = false
    }

    private func retryDelay(for attempt: Int) -> UInt64 {
        var delay = self.initialDelayNanoseconds
        for _ in 1..<attempt {
            if delay >= self.maximumDelayNanoseconds / 2 {
                return self.maximumDelayNanoseconds
            }
            delay = min(delay * 2, self.maximumDelayNanoseconds)
        }
        return delay
    }
}
