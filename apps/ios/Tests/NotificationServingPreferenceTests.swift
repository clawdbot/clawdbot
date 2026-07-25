import Foundation
import Testing
@testable import OpenClaw

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

    private func makeDefaults() throws -> (String, UserDefaults) {
        let suiteName = "NotificationServingPreferenceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        return (suiteName, defaults)
    }
}
