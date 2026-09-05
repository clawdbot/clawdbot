import Foundation
import OpenClawKit
import Synchronization
import Testing
import UserNotifications
import XCTest
@testable import OpenClaw

private enum NotificationOperationProbeError: LocalizedError {
    case expected

    var errorDescription: String? {
        "expected notification failure"
    }
}

private actor NotificationOperationPause {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait(entered: XCTestExpectation) async {
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            entered.fulfill()
        }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

struct NotificationServingPreferenceTests {
    @Test func `defaults to enabled`() throws {
        let (suiteName, defaults) = try self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(NotificationServingPreference.isEnabled(defaults: defaults))
    }

    @Test func `persists explicit opt out and opt in`() throws {
        let (suiteName, defaults) = try self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(false, forKey: NotificationServingPreference.storageKey)
        #expect(!NotificationServingPreference.isEnabled(defaults: defaults))

        defaults.set(true, forKey: NotificationServingPreference.storageKey)
        #expect(NotificationServingPreference.isEnabled(defaults: defaults))
    }

    @Test @MainActor func `notification operation returns its completed value`() async {
        let result = await NotificationOperationRunner.run(timeoutSeconds: 1) { 42 }

        switch result {
        case let .success(value):
            #expect(value == 42)
        case let .failure(error):
            Issue.record("Unexpected notification failure: \(error.message)")
        }
    }

    @Test @MainActor func `notification operation preserves its failure`() async {
        let result: Result<Int, NotificationCallError> = await NotificationOperationRunner.run(
            timeoutSeconds: 1)
        {
            throw NotificationOperationProbeError.expected
        }

        switch result {
        case .success:
            Issue.record("The failed notification operation unexpectedly succeeded")
        case let .failure(error):
            #expect(error.message == "expected notification failure")
        }
    }

    @Test @MainActor func `notification operation times out suspended work`() async {
        let result = await NotificationOperationRunner.run(timeoutSeconds: 0.01) {
            try await Task.sleep(nanoseconds: 200_000_000)
            return 42
        }

        switch result {
        case .success:
            Issue.record("The suspended notification operation unexpectedly succeeded")
        case let .failure(error):
            #expect(error.message == "notification request timed out")
        }
    }

    @Test @MainActor func `caller cancellation retires a suspended notification operation`() async {
        let pause = NotificationOperationPause()
        let entered = XCTestExpectation(description: "notification operation suspended")
        let callerFinished = XCTestExpectation(description: "cancelled caller returned")
        let operationCancelled = Mutex(false)
        let (cancellation, recordCancellation) = AsyncStream<Bool>.makeStream()
        let caller = Task { @MainActor in
            let result = await NotificationOperationRunner.run(timeoutSeconds: 30) {
                await withTaskCancellationHandler {
                    await pause.wait(entered: entered)
                    recordCancellation.yield(Task.isCancelled)
                    recordCancellation.finish()
                    return 42
                } onCancel: {
                    operationCancelled.withLock { $0 = true }
                }
            }
            callerFinished.fulfill()
            return result
        }
        let ready = await XCTWaiter.fulfillment(of: [entered], timeout: 5)
        caller.cancel()
        let cancelledWhenCallReturned = operationCancelled.withLock { $0 }
        #expect(cancelledWhenCallReturned, "Cancellation must reach the operation before cancel() returns")
        let finished = await XCTWaiter.fulfillment(of: [callerFinished], timeout: 2)
        await pause.release()
        #expect(ready == .completed)
        #expect(finished == .completed, "Cancellation must return without waiting for the permission callback")
        for await cancelled in cancellation {
            #expect(cancelled, "The suspended operation must inherit cancellation before it resumes")
        }
        if case .success = await caller.value {
            Issue.record("The cancelled notification operation unexpectedly succeeded")
        }
    }

    @Test @MainActor func `already cancelled callers cannot start a notification operation`() async {
        let caller = Task { @MainActor in
            await NotificationOperationRunner.run(timeoutSeconds: 1) {
                Issue.record("The cancelled caller started a notification operation")
                return 42
            }
        }
        caller.cancel()
        if case .success = await caller.value {
            Issue.record("The cancelled notification operation unexpectedly succeeded")
        }
    }

    @Test @MainActor func `cancelled callers cannot add a native notification`() async {
        let center = UNUserNotificationCenter.current()
        let adapter = LiveNotificationCenter(center: center)
        let identifier = "notification-cancellation-test-\(UUID().uuidString)"
        defer { center.removePendingNotificationRequests(withIdentifiers: [identifier]) }
        let operation = Task { @MainActor in
            let content = UNMutableNotificationContent()
            content.title = "OpenClaw cancellation test"
            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3600, repeats: false))
            try await adapter.add(request)
        }
        operation.cancel()

        await #expect(throws: CancellationError.self) {
            try await operation.value
        }
    }

    private func makeDefaults() throws -> (String, UserDefaults) {
        let suiteName = "NotificationServingPreferenceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        return (suiteName, defaults)
    }
}
