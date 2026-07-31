import Foundation
import Testing
@testable import OpenClaw

private enum NotificationOperationProbeError: LocalizedError {
    case expected

    var errorDescription: String? {
        "expected notification failure"
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

    private func makeDefaults() throws -> (String, UserDefaults) {
        let suiteName = "NotificationServingPreferenceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        return (suiteName, defaults)
    }
}
