import Foundation

struct GatewayConnectFailureBackoff {
    private var milliseconds: Double = 500
    private var retryNotBefore: ContinuousClock.Instant?

    var deadline: ContinuousClock.Instant? {
        self.retryNotBefore
    }

    mutating func clear(deadline: ContinuousClock.Instant) {
        if self.retryNotBefore == deadline {
            self.retryNotBefore = nil
        }
    }

    mutating func record(error: Error, pendingDeviceTokenRetry: Bool) {
        guard !Self.isCancellation(error) else { return }
        let delayMs = pendingDeviceTokenRetry ? min(self.milliseconds, 250) : self.milliseconds
        let clock = ContinuousClock()
        self.retryNotBefore = clock.now.advanced(by: .milliseconds(Int64(delayMs.rounded(.up))))
        self.milliseconds = min(self.milliseconds * 2, 30000)
    }

    mutating func reset() {
        self.milliseconds = 500
        self.retryNotBefore = nil
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain &&
            nsError.code == URLError.Code.cancelled.rawValue
    }
}

extension GatewayChannelActor {
    func waitForConnectFailureBackoff() async throws {
        guard let deadline = self.connectFailureBackoff.deadline else { return }
        // Delay inside the shared connect attempt so callers coalesce before a
        // socket is created instead of starting independent retry bursts.
        #if DEBUG
        if let testConnectFailureBackoffWaitHandler {
            try await testConnectFailureBackoffWaitHandler()
            self.connectFailureBackoff.clear(deadline: deadline)
            return
        }
        #endif
        let clock = ContinuousClock()
        if clock.now < deadline {
            try await clock.sleep(until: deadline)
        }
        self.connectFailureBackoff.clear(deadline: deadline)
    }
}
