import Network
import Testing
@testable import OpenClawKit

struct GatewayDiscoveryStatusTextTests {
    @Test func `discovery states return localized presentation copy`() {
        #expect(GatewayDiscoveryStatusText.make(states: [], hasBrowsers: false) == "Idle")
        #expect(GatewayDiscoveryStatusText.make(states: [], hasBrowsers: true) == "Setup")
        #expect(GatewayDiscoveryStatusText.make(states: [.ready], hasBrowsers: true) == "Searching…")
        #expect(GatewayDiscoveryStatusText.stopped == "Stopped")
    }

    @Test func `discovery failures preserve network error detail`() {
        let failedError = NWError.posix(.ETIMEDOUT)
        let waitingError = NWError.posix(.ENETDOWN)
        let failed = GatewayDiscoveryStatusText.make(
            states: [.failed(failedError)],
            hasBrowsers: true)
        let waiting = GatewayDiscoveryStatusText.make(
            states: [.waiting(waitingError)],
            hasBrowsers: true)

        #expect(failed.hasPrefix("Failed: "))
        #expect(failed.hasSuffix(String(describing: failedError)))
        #expect(waiting.hasPrefix("Waiting: "))
        #expect(waiting.hasSuffix(String(describing: waitingError)))
    }
}
