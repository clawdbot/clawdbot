import Foundation
import Testing

private actor CompletingAsyncCondition {
    private(set) var completed = false

    func snapshot() async -> Bool {
        let snapshot = self.completed
        if snapshot { return snapshot }

        // Predicate entry follows the helper's deadline construction, so this
        // stale observation returns after that unchanged 15-second deadline.
        let deadline = Date().addingTimeInterval(15)
        do {
            while Date() < deadline {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        } catch {
            return snapshot
        }
        self.completed = true
        return snapshot
    }
}

struct TestAsyncHelpersTests {
    @Test func `rechecks completion after an async predicate outlasts the deadline`() async throws {
        let condition = CompletingAsyncCondition()

        try await waitUntil("completed async snapshot") { await condition.snapshot() }

        #expect(await condition.completed)
    }

    @Test func `an incomplete condition retains its timeout label`() async throws {
        let label = "incomplete condition"
        do {
            try await waitUntil(label, timeoutSeconds: 0) { false }
            Issue.record("Expected a timeout for an incomplete condition")
        } catch let error as AsyncWaitTimeoutError {
            #expect(error.label == label)
        }
    }

    @Test func `cancellation from an incomplete predicate reaches its caller`() async {
        let task = Task {
            try await waitUntil("cancelled condition") {
                withUnsafeCurrentTask { $0?.cancel() }
                return false
            }
        }

        await #expect(throws: CancellationError.self) {
            try await task.value
        }
    }
}
