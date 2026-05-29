import Testing
@testable import OpenClaw

@MainActor
@Suite struct RootTabsPresentationTests {
    @Test func quickSetupDoesNotPresentWhenGatewayAlreadyConfigured() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: true,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func quickSetupPresentsForFreshInstallWithDiscoveredGateway() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(shouldPresent)
    }

    @Test func quickSetupDoesNotPresentWhenAlreadyConnected() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: true,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }
}
