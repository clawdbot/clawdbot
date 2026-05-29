import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct OnboardingStateStoreTests {
    @Test @MainActor func shouldPresentWhenFreshAndDisconnected() {
        let testDefaults = self.makeDefaults()
        let defaults = testDefaults.defaults
        defer { self.reset(testDefaults) }

        let appModel = NodeAppModel()
        appModel.gatewayServerName = nil
        #expect(OnboardingStateStore.shouldPresentOnLaunch(
            appModel: appModel,
            defaults: defaults,
            hasSavedGatewayConnection: false))
    }

    @Test @MainActor func doesNotPresentWhenConnected() {
        let testDefaults = self.makeDefaults()
        let defaults = testDefaults.defaults
        defer { self.reset(testDefaults) }

        let appModel = NodeAppModel()
        appModel.gatewayServerName = "gateway"
        #expect(!OnboardingStateStore.shouldPresentOnLaunch(
            appModel: appModel,
            defaults: defaults,
            hasSavedGatewayConnection: false))
    }

    @Test @MainActor func doesNotPresentForSavedGatewayBeforeReconnectCompletes() {
        let testDefaults = self.makeDefaults()
        let defaults = testDefaults.defaults
        defer { self.reset(testDefaults) }

        let appModel = NodeAppModel()
        appModel.gatewayServerName = nil
        #expect(!OnboardingStateStore.shouldPresentOnLaunch(
            appModel: appModel,
            defaults: defaults,
            hasSavedGatewayConnection: true))
    }

    @Test @MainActor func markCompletedPersistsMode() {
        let testDefaults = self.makeDefaults()
        let defaults = testDefaults.defaults
        defer { self.reset(testDefaults) }

        let appModel = NodeAppModel()
        appModel.gatewayServerName = nil

        OnboardingStateStore.markCompleted(mode: .remoteDomain, defaults: defaults)
        #expect(OnboardingStateStore.lastMode(defaults: defaults) == .remoteDomain)
        #expect(!OnboardingStateStore.shouldPresentOnLaunch(
            appModel: appModel,
            defaults: defaults,
            hasSavedGatewayConnection: false))

        OnboardingStateStore.markIncomplete(defaults: defaults)
        #expect(OnboardingStateStore.shouldPresentOnLaunch(
            appModel: appModel,
            defaults: defaults,
            hasSavedGatewayConnection: false))
    }

    @Test func firstRunIntroDefaultsToVisibleThenPersists() {
        let testDefaults = self.makeDefaults()
        let defaults = testDefaults.defaults
        defer { self.reset(testDefaults) }

        #expect(OnboardingStateStore.shouldPresentFirstRunIntro(defaults: defaults))

        OnboardingStateStore.markFirstRunIntroSeen(defaults: defaults)
        #expect(!OnboardingStateStore.shouldPresentFirstRunIntro(defaults: defaults))
    }

    @Test @MainActor func resetClearsCompletionAndIntroSeen() {
        let testDefaults = self.makeDefaults()
        let defaults = testDefaults.defaults
        defer { self.reset(testDefaults) }

        OnboardingStateStore.markCompleted(mode: .homeNetwork, defaults: defaults)
        OnboardingStateStore.markFirstRunIntroSeen(defaults: defaults)

        OnboardingStateStore.reset(defaults: defaults)

        let appModel = NodeAppModel()
        appModel.gatewayServerName = nil

        #expect(OnboardingStateStore.shouldPresentOnLaunch(
            appModel: appModel,
            defaults: defaults,
            hasSavedGatewayConnection: false))
        #expect(OnboardingStateStore.shouldPresentFirstRunIntro(defaults: defaults))
        #expect(OnboardingStateStore.lastMode(defaults: defaults) == .homeNetwork)
    }

    private struct TestDefaults {
        var suiteName: String
        var defaults: UserDefaults
    }

    private func makeDefaults() -> TestDefaults {
        let suiteName = "OnboardingStateStoreTests.\(UUID().uuidString)"
        return TestDefaults(
            suiteName: suiteName,
            defaults: UserDefaults(suiteName: suiteName) ?? .standard)
    }

    private func reset(_ defaults: TestDefaults) {
        defaults.defaults.removePersistentDomain(forName: defaults.suiteName)
    }
}
