import Testing
@testable import OpenClaw

@Suite struct SettingsNetworkingHelpersTests {
    @Test func diagnosticsIssuesNameEachReviewerVisibleCheck() {
        #expect(
            SettingsDiagnostics.issues(
                gatewayConnected: false,
                discoveredGatewayCount: 0,
                talkConfigLoaded: false,
                notificationsAllowed: false) == [
                    .gatewayOffline,
                    .discoveryUnavailable,
                    .notificationsUnavailable,
                ])
    }

    @Test func diagnosticsIssuesRequireTalkConfigOnlyAfterGatewayConnects() {
        #expect(
            SettingsDiagnostics.issues(
                gatewayConnected: true,
                discoveredGatewayCount: 1,
                talkConfigLoaded: false,
                notificationsAllowed: true) == [.talkConfigMissing])
        #expect(
            SettingsDiagnostics.issueCount(
                gatewayConnected: true,
                discoveredGatewayCount: 1,
                talkConfigLoaded: true,
                notificationsAllowed: true) == 0)
    }
}
