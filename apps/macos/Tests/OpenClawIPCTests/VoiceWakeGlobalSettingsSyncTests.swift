import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

private actor VoiceWakeSyncDelaySequence {
    private var calls = 0
    private var firstStartedWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstReleaseWaiter: CheckedContinuation<Void, Never>?

    func wait() async {
        self.calls += 1
        guard self.calls == 1 else { return }
        for waiter in self.firstStartedWaiters {
            waiter.resume()
        }
        self.firstStartedWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.firstReleaseWaiter = continuation
        }
    }

    func waitUntilFirstStarted() async {
        guard self.calls == 0 else { return }
        await withCheckedContinuation { continuation in
            self.firstStartedWaiters.append(continuation)
        }
    }

    func releaseFirst() {
        self.firstReleaseWaiter?.resume()
        self.firstReleaseWaiter = nil
    }
}

private actor VoiceWakeSyncRecorder {
    private let blockFirst: Bool
    private(set) var payloads: [[String]] = []
    private var firstStartedWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstReleaseWaiter: CheckedContinuation<Void, Never>?

    init(blockFirst: Bool = false) {
        self.blockFirst = blockFirst
    }

    func record(_ triggers: [String]) async {
        self.payloads.append(triggers)
        guard self.blockFirst, self.payloads.count == 1 else { return }
        for waiter in self.firstStartedWaiters {
            waiter.resume()
        }
        self.firstStartedWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.firstReleaseWaiter = continuation
        }
    }

    func waitUntilFirstStarted() async {
        guard self.payloads.isEmpty else { return }
        await withCheckedContinuation { continuation in
            self.firstStartedWaiters.append(continuation)
        }
    }

    func releaseFirst() {
        self.firstReleaseWaiter?.resume()
        self.firstReleaseWaiter = nil
    }

    func waitForPayloadCount(_ expected: Int) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while self.payloads.count < expected, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        if self.payloads.count < expected {
            Issue.record("timed out waiting for \(expected) voice wake payloads")
        }
    }
}

@Suite(.serialized)
@MainActor
struct VoiceWakeGlobalSettingsSyncTests {
    private func voiceWakeChangedEvent(payload: OpenClawProtocol.AnyCodable) -> EventFrame {
        EventFrame(
            type: "event",
            event: "voicewake.changed",
            payload: payload,
            seq: nil,
            stateversion: nil)
    }

    private func applyTriggersAndCapturePrevious(_ triggers: [String]) async -> [String] {
        let previous = await MainActor.run { AppStateStore.shared.swabbleTriggerWords }
        await MainActor.run {
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(triggers)
        }
        return previous
    }

    @Test func `applies voice wake changed event to app state`() async {
        let previous = await applyTriggersAndCapturePrevious(["before"])
        let evt = self.voiceWakeChangedEvent(payload: OpenClawProtocol.AnyCodable(["triggers": [
            "openclaw",
            "computer",
        ]]))

        VoiceWakeGlobalSettingsSync.shared.handle(push: .event(evt))

        let updated = await MainActor.run { AppStateStore.shared.swabbleTriggerWords }
        #expect(updated == ["openclaw", "computer"])

        await MainActor.run {
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(previous)
        }
    }

    @Test func `ignores voice wake changed event with invalid payload`() async {
        let previous = await applyTriggersAndCapturePrevious(["before"])
        let evt = self.voiceWakeChangedEvent(payload: OpenClawProtocol.AnyCodable(["unexpected": 123]))

        VoiceWakeGlobalSettingsSync.shared.handle(push: .event(evt))

        let updated = await MainActor.run { AppStateStore.shared.swabbleTriggerWords }
        #expect(updated == ["before"])

        await MainActor.run {
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(previous)
        }
    }

    @Test func `cancelled trigger sync does not send stale payload`() async {
        let delay = VoiceWakeSyncDelaySequence()
        let recorder = VoiceWakeSyncRecorder()
        let scheduler = VoiceWakeGlobalSyncScheduler(
            delay: { await delay.wait() },
            deliver: { await recorder.record($0) })

        let stale = scheduler.schedule(["stale"])
        await delay.waitUntilFirstStarted()
        let current = scheduler.schedule(["current"])
        await current.value
        await recorder.waitForPayloadCount(1)
        await delay.releaseFirst()
        await stale.value

        #expect(await recorder.payloads == [["current"]])
    }

    @Test func `newest trigger sync is delivered after an in flight stale write`() async {
        let recorder = VoiceWakeSyncRecorder(blockFirst: true)
        let scheduler = VoiceWakeGlobalSyncScheduler(
            delay: {},
            deliver: { await recorder.record($0) })

        scheduler.schedule(["stale"])
        await recorder.waitUntilFirstStarted()
        let current = scheduler.schedule(["current"])
        await current.value

        #expect(await recorder.payloads == [["stale"]])

        await recorder.releaseFirst()
        await recorder.waitForPayloadCount(2)
        #expect(await recorder.payloads == [["stale"], ["current"]])
    }
}
