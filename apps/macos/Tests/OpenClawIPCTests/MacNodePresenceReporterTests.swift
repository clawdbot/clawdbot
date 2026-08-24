import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct MacNodePresenceReporterTests {
    @Test func `active computer presence defaults off and honors explicit opt in`() throws {
        let suiteName = "MacNodePresenceReporterTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(!AppState.resolveActiveComputerPresenceEnabled(defaults: defaults))
        defaults.set(true, forKey: activeComputerPresenceEnabledKey)
        #expect(AppState.resolveActiveComputerPresenceEnabled(defaults: defaults))
    }

    @Test func `only the latest active computer presence update applies`() {
        #expect(AppState.activeComputerPresenceUpdateIsCurrent(
            capturedGeneration: 4,
            currentGeneration: 4,
            capturedEnabled: false,
            currentEnabled: false,
            isCancelled: false))
        #expect(!AppState.activeComputerPresenceUpdateIsCurrent(
            capturedGeneration: 3,
            currentGeneration: 4,
            capturedEnabled: true,
            currentEnabled: false,
            isCancelled: false))
        #expect(!AppState.activeComputerPresenceUpdateIsCurrent(
            capturedGeneration: 4,
            currentGeneration: 4,
            capturedEnabled: false,
            currentEnabled: false,
            isCancelled: true))
    }

    @Test func `disabled reporter does not sample idle time`() async {
        let idleProbe = PresenceIdleProbe(seconds: 3)
        let sender = PresenceSenderRecorder()
        let clear = PresenceClearRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: idleProbe.read)
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)
        for _ in 0..<20 { await Task.yield() }
        reporter.stop()

        #expect(idleProbe.calls == 0)
        #expect(sender.payloads.isEmpty)
        #expect(clear.calls == 0)
        #expect(clear.unsupportedCalls == 0)
    }

    @Test func `enabling sends an immediate activity sample`() async throws {
        let idleProbe = PresenceIdleProbe(seconds: 7)
        let sender = PresenceSenderRecorder()
        let clear = PresenceClearRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: idleProbe.read)
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)
        await reporter.setReportingEnabled(true)
        reporter.stop()

        let payload = try #require(sender.payloadObjects.last)
        #expect(payload["idleSeconds"] as? Int == 7)
        #expect(payload["action"] == nil)
        #expect(idleProbe.calls == 1)
    }

    @Test func `disabling sends a same connection clear`() async throws {
        let sender = PresenceSenderRecorder()
        let clear = PresenceClearRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: { 0 })
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)
        await reporter.setReportingEnabled(true)
        await reporter.setReportingEnabled(false)
        reporter.stop()

        let payload = try #require(sender.payloadObjects.last)
        #expect(payload["idleSeconds"] as? Int == 0)
        #expect(clear.calls == 1)
        #expect(clear.unsupportedCalls == 0)
    }

    @Test func `failed clear retries while disabled`() async {
        let sender = PresenceSenderRecorder()
        let clear = PresenceClearRecorder(outcomes: [.retry, .cleared])
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: { 0 })
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)
        await reporter.setReportingEnabled(true)
        await reporter.setReportingEnabled(false)
        await reporter.setReportingEnabled(false)
        reporter.stop()

        #expect(clear.calls == 2)
        #expect(clear.unsupportedCalls == 0)
    }

    @Test func `activity crossing opt out is followed by a clear`() async {
        let sender = SuspendingPresenceSender()
        let clear = PresenceClearRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: true,
            idleSecondsProvider: { 0 })
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)
        await sender.waitForActivitySend()

        await reporter.setReportingEnabled(false)
        sender.finishActivitySend()
        await clear.waitForCallCount(1)
        reporter.stop()

        #expect(clear.calls == 1)
        #expect(clear.unsupportedCalls == 0)
    }

    @Test func `activity crossing disable and re-enable refreshes the enabled sample`() async {
        let sender = SuspendingPresenceSender()
        let clear = PresenceClearRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: true,
            idleSecondsProvider: { 0 })
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)
        await sender.waitForActivitySend()

        await reporter.setReportingEnabled(false)
        await reporter.setReportingEnabled(true)
        sender.finishActivitySend()
        await sender.waitForActivityCount(3)
        reporter.stop()

        #expect(sender.payloadObjects.last?["idleSeconds"] as? Int == 0)
        #expect(clear.calls == 0)
    }

    @Test func `unsupported clear requests one reconnect and fresh disabled start stays silent`() async {
        let sender = PresenceSenderRecorder()
        let clear = PresenceClearRecorder(outcomes: [.unsupported])
        let reporter = MacNodePresenceReporter(
            reportingEnabled: false,
            idleSecondsProvider: { 0 })
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)

        await reporter.setReportingEnabled(true)
        await reporter.setReportingEnabled(false)
        await reporter.setReportingEnabled(false)
        reporter.stop()
        reporter.start(
            sender: sender.send,
            clearer: clear.clear,
            onUnsupportedClear: clear.handleUnsupported)
        for _ in 0..<20 { await Task.yield() }
        reporter.stop()

        #expect(sender.payloadObjects.filter { $0["idleSeconds"] != nil }.count == 1)
        #expect(clear.calls == 1)
        #expect(clear.unsupportedCalls == 1)
    }

    @Test func `stale activity completion cannot attach to a restarted disabled route`() async {
        let staleSender = SuspendingPresenceSender()
        let staleClear = PresenceClearRecorder()
        let reporter = MacNodePresenceReporter(
            reportingEnabled: true,
            idleSecondsProvider: { 0 })
        reporter.start(
            sender: staleSender.send,
            clearer: staleClear.clear,
            onUnsupportedClear: staleClear.handleUnsupported)
        await staleSender.waitForActivitySend()

        reporter.stop()
        await reporter.setReportingEnabled(false)
        let freshSender = PresenceSenderRecorder()
        let freshClear = PresenceClearRecorder(outcomes: [.unsupported])
        reporter.start(
            sender: freshSender.send,
            clearer: freshClear.clear,
            onUnsupportedClear: freshClear.handleUnsupported)
        staleSender.finishActivitySend()
        for _ in 0..<20 { await Task.yield() }
        reporter.stop()

        #expect(freshSender.payloads.isEmpty)
        #expect(freshClear.calls == 0)
        #expect(freshClear.unsupportedCalls == 0)
    }

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

@MainActor
private final class PresenceIdleProbe {
    let seconds: Int
    private(set) var calls = 0

    init(seconds: Int) {
        self.seconds = seconds
    }

    func read() -> Int? {
        self.calls += 1
        return self.seconds
    }
}

@MainActor
private final class PresenceSenderRecorder {
    private(set) var payloads: [String] = []

    var payloadObjects: [[String: Any]] {
        self.payloads.compactMap { payload in
            guard let data = payload.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }

    func send(_: String, _ payload: String) async -> Bool {
        self.payloads.append(payload)
        return true
    }
}

@MainActor
private final class PresenceClearRecorder {
    private var outcomes: [MacNodePresenceReporter.ClearDeliveryResult]
    private(set) var calls = 0
    private(set) var unsupportedCalls = 0

    init(outcomes: [MacNodePresenceReporter.ClearDeliveryResult] = []) {
        self.outcomes = outcomes
    }

    func clear() async -> MacNodePresenceReporter.ClearDeliveryResult {
        self.calls += 1
        return self.outcomes.isEmpty ? .cleared : self.outcomes.removeFirst()
    }

    func handleUnsupported() {
        self.unsupportedCalls += 1
    }

    func waitForCallCount(_ expected: Int) async {
        for _ in 0..<1000 {
            if self.calls >= expected { return }
            await Task.yield()
        }
        Issue.record("timed out waiting for \(expected) presence clear calls")
    }
}

@MainActor
private final class SuspendingPresenceSender {
    private var activityContinuation: CheckedContinuation<Bool, Never>?
    private var hasSuspendedActivity = false
    private(set) var payloads: [String] = []

    var payloadObjects: [[String: Any]] {
        self.payloads.compactMap { payload in
            guard let data = payload.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }

    func send(_: String, _ payload: String) async -> Bool {
        self.payloads.append(payload)
        guard self.payloadObjects.last?["idleSeconds"] != nil, !self.hasSuspendedActivity else {
            return true
        }
        self.hasSuspendedActivity = true
        return await withCheckedContinuation { continuation in
            self.activityContinuation = continuation
        }
    }

    func waitForActivitySend() async {
        for _ in 0..<1000 {
            if self.activityContinuation != nil { return }
            await Task.yield()
        }
        Issue.record("timed out waiting for suspended activity send")
    }

    func finishActivitySend() {
        self.activityContinuation?.resume(returning: true)
        self.activityContinuation = nil
    }

    func waitForActivityCount(_ expected: Int) async {
        for _ in 0..<1000 {
            if self.payloadObjects.filter({ $0["idleSeconds"] != nil }).count >= expected { return }
            await Task.yield()
        }
        Issue.record("timed out waiting for \(expected) activity samples")
    }
}
