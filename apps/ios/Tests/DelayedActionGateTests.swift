import Foundation
import Testing
@testable import OpenClaw

private actor DelayDeliveryBarrier {
    private var deliveryCount = 0
    private var firstDeliveryPaused = false
    private var pauseWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func pauseFirstDelivery() async {
        self.deliveryCount += 1
        guard self.deliveryCount == 1 else { return }
        self.firstDeliveryPaused = true
        let pauseWaiters = self.pauseWaiters
        self.pauseWaiters.removeAll()
        for waiter in pauseWaiters {
            waiter.resume()
        }
        await withCheckedContinuation { continuation in
            self.releaseWaiters.append(continuation)
        }
    }

    func waitUntilFirstDeliveryIsPaused() async {
        if self.firstDeliveryPaused { return }
        await withCheckedContinuation { continuation in
            self.pauseWaiters.append(continuation)
        }
    }

    func releaseFirstDelivery() {
        let releaseWaiters = self.releaseWaiters
        self.releaseWaiters.removeAll()
        for waiter in releaseWaiters {
            waiter.resume()
        }
    }
}

struct DelayedActionGateTests {
    @Test @MainActor func `completed delay delivers its action`() async {
        var actions: [String] = []
        let gate = DelayedActionGate(sleeper: { _ in })

        let task = gate.schedule(after: .zero) {
            actions.append("current")
        }
        await task.value

        #expect(actions == ["current"])
    }

    @Test @MainActor func `cancellation after delay return suppresses delivery`() async {
        var actions: [String] = []
        let barrier = DelayDeliveryBarrier()
        let gate = DelayedActionGate(
            sleeper: { _ in },
            deliveryBarrier: { await barrier.pauseFirstDelivery() })

        let task = gate.schedule(after: .zero) {
            actions.append("stale")
        }
        await barrier.waitUntilFirstDeliveryIsPaused()
        gate.cancel()
        await barrier.releaseFirstDelivery()
        await task.value

        #expect(actions.isEmpty)
    }

    @Test @MainActor func `replacement action wins after stale delay returns`() async {
        var actions: [String] = []
        let barrier = DelayDeliveryBarrier()
        let gate = DelayedActionGate(
            sleeper: { _ in },
            deliveryBarrier: { await barrier.pauseFirstDelivery() })

        let staleTask = gate.schedule(after: .zero) {
            actions.append("stale")
        }
        await barrier.waitUntilFirstDeliveryIsPaused()
        let currentTask = gate.schedule(after: .zero) {
            actions.append("current")
        }
        await currentTask.value
        await barrier.releaseFirstDelivery()
        await staleTask.value

        #expect(actions == ["current"])
    }
}
