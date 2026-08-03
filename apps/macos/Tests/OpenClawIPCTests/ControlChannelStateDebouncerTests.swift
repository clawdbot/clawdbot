import Foundation
import Testing
@testable import OpenClaw

struct ControlChannelStateDebouncerTests {
    @Test func `terminal states apply immediately`() {
        let start = Date(timeIntervalSince1970: 1_000)
        var debouncer = ControlChannelStateDebouncer(interval: 0.5, lastAppliedAt: start)

        let degradedDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .degraded("gateway unavailable"),
            now: start.addingTimeInterval(0.1))
        #expect(degradedDelay != nil)

        let connectedDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .connected,
            now: start.addingTimeInterval(0.2))
        #expect(connectedDelay == nil)

        let afterTerminalDelay = debouncer.delayBeforeApplying(
            currentState: .connected,
            newState: .connecting,
            now: start.addingTimeInterval(0.3))
        #expect(afterTerminalDelay == nil)
    }

    @Test func `nonterminal states are debounced within interval`() {
        let start = Date(timeIntervalSince1970: 1_000)
        var debouncer = ControlChannelStateDebouncer(interval: 0.5, lastAppliedAt: start)

        let soonDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .degraded("gateway unavailable"),
            now: start.addingTimeInterval(0.1))
        #expect(soonDelay != nil)
        #expect(abs((soonDelay ?? 0) - 0.4) < 0.001)

        let afterWindowDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .degraded("gateway unavailable"),
            now: start.addingTimeInterval(0.6))
        #expect(afterWindowDelay == nil)
    }

    @Test func `deferred apply resets debounce window`() {
        let start = Date(timeIntervalSince1970: 1_000)
        var debouncer = ControlChannelStateDebouncer(interval: 0.5, lastAppliedAt: start)

        debouncer.recordDeferredApply(at: start.addingTimeInterval(0.5))

        let delayAfterDeferredUpdate = debouncer.delayBeforeApplying(
            currentState: .degraded("gateway unavailable"),
            newState: .connecting,
            now: start.addingTimeInterval(0.7))
        #expect(delayAfterDeferredUpdate != nil)
        #expect(abs((delayAfterDeferredUpdate ?? 0) - 0.3) < 0.001)
    }
}
