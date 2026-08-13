import Foundation
import Testing
@testable import OpenClaw

struct ComputerControlSettingsTests {
    @Test func `computer control defaults on while preserving explicit choices`() throws {
        let suiteName = "ComputerControlSettingsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(isComputerControlEnabled(defaults: defaults))

        defaults.set(false, forKey: computerControlEnabledKey)
        #expect(!isComputerControlEnabled(defaults: defaults))

        defaults.set(true, forKey: computerControlEnabledKey)
        #expect(isComputerControlEnabled(defaults: defaults))
    }
}
