import Foundation
import Testing

struct RootTabsSourceGuardTests {
    @Test func `initial scene phase reaches the model before gateway admission`() throws {
        let startup = try Self.extract(
            Self.source("Sources/OpenClawApp.swift"),
            from: ".task {",
            to: ".onReceive(")
        let modelPhase = try #require(startup.range(of: "self.appModel.setScenePhase(self.scenePhase)"))
        let gatewayPhase = try #require(
            startup.range(of: "self.gatewayController.setScenePhase(self.scenePhase)"))

        #expect(modelPhase.lowerBound < gatewayPhase.lowerBound)
    }

    @Test func `local network permission has visible request paths`() throws {
        let root = try Self.source("Sources/RootTabs.swift")
        let onboarding = try Self.sources([
            "Sources/Onboarding/OnboardingWizardView.swift",
            "Sources/Onboarding/OnboardingWizardConnectionSections.swift",
        ])
        let settings = try Self.source("Sources/Design/SettingsProTabActions.swift")
        let controller = try Self.sources([
            "Sources/Gateway/GatewayConnectionController.swift",
            "Sources/Gateway/GatewayConnectionController+Capabilities.swift",
        ])

        #expect(controller.contains("requestLocalNetworkAccess(reason: \"connect_manual\""))
        #expect(controller.contains("requestLocalNetworkAccess(reason: \"connect_discovered_gateway\""))
        #expect(root.contains("maybeRequestLocalNetworkAccess(reason: \"root_appear\")"))
        #expect(root.contains("requestLocalNetworkAccess(reason: \"gateway_setup_deeplink\")"))
        #expect(onboarding.contains("requestLocalNetworkAccess(reason: \"onboarding_continue\")"))
        #expect(settings.contains("requestLocalNetworkAccess(reason: \"settings_preflight\")"))
    }

    @Test func `scanner starts only while its view is visible`() throws {
        let source = try Self.source("Sources/Onboarding/QRScannerView.swift")
        let make = try Self.extract(source, from: "func makeUIViewController", to: "func updateUIViewController")
        let lifecycle = try Self.extract(
            source,
            from: "final class QRScannerContainerViewController",
            to: "final class Coordinator")

        #expect(!make.contains("startScanning()"))
        #expect(lifecycle.contains("override func viewDidAppear"))
        #expect(lifecycle.contains("try self.scanner.startScanning()"))
        #expect(lifecycle.contains("override func viewWillDisappear"))
        #expect(lifecycle.contains("self.stopScannerCapture()"))
    }

    @Test func `credential fields stay scoped to exact gateway owners`() throws {
        let onboarding = try Self.sources([
            "Sources/Onboarding/OnboardingWizardView.swift",
            "Sources/Onboarding/OnboardingWizardConnectionSections.swift",
        ])
        let settings = try Self.source("Sources/Design/SettingsProTabActions.swift")

        for source in [onboarding, settings] {
            #expect(source.contains(
                "if !GatewayStableIdentifier.matches(self.gatewayCredentialFieldStableID, stableID)"))
            #expect(!source.contains("gatewayCredentialFieldStableID == stableID"))

            let tokenSetter = try Self.extract(
                source,
                from: "func persistGatewayToken(_ value: String)",
                to: "func persistGatewayPassword(_ value: String)")
            let assignment = try #require(tokenSetter.range(of: "self.gatewayToken = value"))
            let owner = try #require(tokenSetter.range(of: "self.gatewayCredentialTargetStableID"))
            #expect(assignment.lowerBound < owner.lowerBound)
        }
    }

    private static func source(_ path: String) throws -> String {
        try String(contentsOf: self.iOSRoot.appendingPathComponent(path), encoding: .utf8)
    }

    private static func sources(_ paths: [String]) throws -> String {
        try paths.map(self.source).joined(separator: "\n")
    }

    private static var iOSRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
