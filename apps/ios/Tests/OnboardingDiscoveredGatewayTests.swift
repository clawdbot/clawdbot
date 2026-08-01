import Foundation
import Testing

struct OnboardingDiscoveredGatewayTests {
    @Test func `discovered gateway surfaces diagnostic connection failures`() throws {
        let source = try String(contentsOf: Self.sourceURL(), encoding: .utf8)
        let start = try #require(source.range(of: "private func connectDiscoveredGateway("))
        let end = try #require(
            source.range(of: "private func selectMode(", range: start.upperBound..<source.endIndex))
        let connectDiscoveredGateway = String(source[start.lowerBound..<end.lowerBound])

        #expect(connectDiscoveredGateway.contains(
            "await self.gatewayController.connectWithDiagnostics(gateway)"))
        #expect(connectDiscoveredGateway.contains("self.setConnectionFailure(message)"))
        #expect(!connectDiscoveredGateway.contains("await self.gatewayController.connect(gateway)"))
    }

    private static func sourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Onboarding/OnboardingWizardView.swift")
    }
}
