import Testing
@testable import OpenClaw

@MainActor
struct MacNodePresenceReporterTests {
    @Test func `first activity sample sends immediately`() {
        #expect(MacNodePresenceReporter._testShouldSend(
            idleSeconds: 0,
            nowMs: 100_000,
            lastSentAtMs: nil,
            lastSentActiveAtMs: nil))
    }

    @Test func `continuous activity is throttled and then refreshed`() {
        #expect(!MacNodePresenceReporter._testShouldSend(
            idleSeconds: 0,
            nowMs: 110_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
        #expect(MacNodePresenceReporter._testShouldSend(
            idleSeconds: 0,
            nowMs: 115_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
    }

    @Test func `idle presence gets a sparse keepalive`() {
        #expect(!MacNodePresenceReporter._testShouldSend(
            idleSeconds: 100,
            nowMs: 200_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
        #expect(!MacNodePresenceReporter._testShouldSend(
            idleSeconds: 2_592_000,
            nowMs: 115_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000,
            saturated: true))
        #expect(MacNodePresenceReporter._testShouldSend(
            idleSeconds: 180,
            nowMs: 280_000,
            lastSentAtMs: 100_000,
            lastSentActiveAtMs: 100_000))
    }
}
