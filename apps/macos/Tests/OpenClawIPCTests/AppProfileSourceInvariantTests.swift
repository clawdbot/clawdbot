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

        let menuBar = try String(
            contentsOf: sourceRoot.appendingPathComponent("MenuBar.swift"),
            encoding: .utf8)
        let delegateInit = try #require(menuBar.range(of: "override init()"))
        let ownershipGate = try #require(menuBar.range(
            of: "AppInstanceLock.acquire",
            range: delegateInit.lowerBound..<menuBar.endIndex))
        let updaterConstruction = try #require(menuBar.range(
            of: "? makeUpdaterController()",
            range: ownershipGate.lowerBound..<menuBar.endIndex))
        #expect(ownershipGate.lowerBound < updaterConstruction.lowerBound)
        #expect(menuBar.contains("if let exitCode = Self.processExitCode(for: ownership)"))
        #expect(menuBar.contains("Darwin.exit(exitCode)"))
        #expect(!menuBar.contains("@State private var tailscaleService = TailscaleService.shared"))

        let gatewayManager = try String(
            contentsOf: sourceRoot.appendingPathComponent("GatewayProcessManager.swift"),
            encoding: .utf8)
        let publisherStart = try #require(gatewayManager.range(
            of: "private func publishGatewayReadinessTerminal"))
        let ownershipGuardStart = try #require(gatewayManager.range(
            of: "private func canPublishGatewayReadiness",
            range: publisherStart.lowerBound..<gatewayManager.endIndex))
        let probeStart = try #require(gatewayManager.range(
            of: "private func probeGatewayHealth",
            range: ownershipGuardStart.lowerBound..<gatewayManager.endIndex))
        let publisher = gatewayManager[publisherStart.lowerBound..<ownershipGuardStart.lowerBound]
        #expect(publisher.components(separatedBy: "canPublishGatewayReadiness(").count - 1 == 2)
        let ownershipGuard = gatewayManager[ownershipGuardStart.lowerBound..<probeStart.lowerBound]
        let initialCurrent = try #require(ownershipGuard.range(of: "guard self.isCurrentGatewayReadiness"))
        let profileOwnership = try #require(ownershipGuard.range(
            of: "profileOwnsGateway(",
            range: initialCurrent.upperBound..<ownershipGuard.endIndex))
        let finalCurrent = try #require(ownershipGuard.range(
            of: "return self.isCurrentGatewayReadiness",
            range: profileOwnership.upperBound..<ownershipGuard.endIndex))
        #expect(initialCurrent.lowerBound < profileOwnership.lowerBound)
        #expect(profileOwnership.lowerBound < finalCurrent.lowerBound)

        let portGuardian = try String(
            contentsOf: sourceRoot.appendingPathComponent("PortGuardian.swift"),
            encoding: .utf8)
        let profilePreserve = try #require(portGuardian.range(of: "if AppProfile.current.isActive"))
        let firstTerminate = try #require(portGuardian.range(
            of: "terminateProcess",
            range: profilePreserve.lowerBound..<portGuardian.endIndex))
        #expect(profilePreserve.lowerBound < firstTerminate.lowerBound)
    }
}
