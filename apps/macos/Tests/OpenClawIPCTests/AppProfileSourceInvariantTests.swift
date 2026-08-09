import Foundation
import Testing

struct AppProfileSourceInvariantTests {
    @Test func `profile persistence has one defaults and gateway-label owner`() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceRoot = macRoot.appendingPathComponent("Sources/OpenClaw", isDirectory: true)
        let files = try #require(FileManager.default.enumerator(
            at: sourceRoot,
            includingPropertiesForKeys: nil)?.allObjects as? [URL])
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.path < $1.path }

        var directStandardOwners: [String] = []
        var hardcodedGatewayLabelOwners: [String] = []
        var unscopedAppStorageOwners: [String] = []
        for file in files {
            let source = try String(contentsOf: file, encoding: .utf8)
            if source.contains("UserDefaults.standard") {
                directStandardOwners.append(file.lastPathComponent)
            }
            if source.contains("\"ai.openclaw.gateway\"") {
                hardcodedGatewayLabelOwners.append(file.lastPathComponent)
            }
            if source.split(separator: "\n").contains(where: {
                $0.contains("@AppStorage(") && !$0.contains("store: AppDefaults.standard")
            }) {
                unscopedAppStorageOwners.append(file.lastPathComponent)
            }
            #expect(!source.contains("UserDefaults = .standard"), "Unscoped defaults in \(file.path)")
        }

        #expect(directStandardOwners == ["AppProfile.swift"])
        #expect(hardcodedGatewayLabelOwners == ["AppProfile.swift"])
        #expect(unscopedAppStorageOwners.sorted() == ["DebugSettings.swift", "GeneralSettings.swift"])
        let settingsRoot = try String(
            contentsOf: sourceRoot.appendingPathComponent("SettingsRootView.swift"),
            encoding: .utf8)
        #expect(settingsRoot.contains(".defaultAppStorage(AppDefaults.standard)"))
    }
}
