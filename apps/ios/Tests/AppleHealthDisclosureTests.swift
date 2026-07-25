import Foundation
import Testing

struct AppleHealthDisclosureTests {
    @Test func `Apple Health disclosure is visible before privacy access expands`() throws {
        let settings = try Self.source("Design/SettingsProTabSections.swift")
        let permissionsStart = try #require(settings.range(of: "var permissionsDestination: some View"))
        let permissionsEnd = try #require(
            settings.range(
                of: "var voiceDestination: some View",
                range: permissionsStart.upperBound..<settings.endIndex))
        let permissions = String(settings[permissionsStart.lowerBound..<permissionsEnd.lowerBound])
        let appleHealth = try #require(permissions.range(of: "self.appleHealthAccessCard"))
        let privacyAccess = try #require(permissions.range(of: "self.privacyAccessCard"))

        #expect(appleHealth.lowerBound < privacyAccess.lowerBound)
    }

    @Test func `Apple Health disclosure names its source data and destination`() throws {
        let source = try Self.source("Health/AppleHealthAccessSectionView.swift")

        #expect(source.contains("Apple Health Summaries"))
        #expect(source.contains("Creates read-only summaries from the Apple Health app"))
        #expect(source.contains("steps, sleep, resting heart rate, and workouts"))
        #expect(source.contains("from Apple Health only when a summary is"))
        #expect(source.contains("your Gateway to your configured AI provider"))
        #expect(source.contains("raw samples stay on this device"))
        #expect(source.contains("Enable Apple Health Summaries"))
    }

    private static func source(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources")
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }
}
