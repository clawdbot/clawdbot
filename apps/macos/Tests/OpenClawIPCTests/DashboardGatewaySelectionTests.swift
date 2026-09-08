import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardGatewaySelectionTests {
    @Test(arguments: [AppState.ConnectionMode.local, .remote, .unconfigured])
    func `explicit saved Gateway selection survives a fresh dashboard owner`(_ mode: AppState
        .ConnectionMode) async throws
    {
        try await withIsolatedWebChatProfile { _, profile in
            let suiteName = "DashboardGatewaySelectionTests.\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }
            let selection = MacGatewaySelectionPreferences(defaults: defaults)
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = mode
            defer { state.connectionMode = previousMode }
            let makeManager = {
                DashboardManager._testMake(
                    selection: selection,
                    primaryEndpointProvider: { _ in .init(
                        config: (url: profile.url, token: "machine-owner", password: nil), routeAuthority: nil)
                    },
                    profileEndpointProvider: { id in
                        guard id == profile.id else { throw CancellationError() }
                        return .init(
                            config: (url: profile.url, token: "personal-account", password: nil), routeAuthority: nil)
                    })
            }
            let first = makeManager()
            await first._testOpenWindow(for: .profile(profile.id))
            #expect(selection.profileID == profile.id)
            #expect(defaults.string(forKey: "openclaw.webchat.lastGatewayProfileID") == profile.id)
            await first._testOpenWindow(for: .profile("cancelled-selection"))
            #expect(selection.profileID == profile.id)
            first.close()

            let restored = makeManager()
            defer { restored.close() }
            restored.preloadIfConfigured()
            #expect(restored._testController() == nil)
            #expect(!restored.showConfiguredWindowIfPossible())
            try await restored.show()
            let controller = try #require(restored._testController())
            #expect(restored._testMainTarget() == .profile(profile.id))
            #expect(controller.auth.token == "personal-account")
            #expect(state.connectionMode == mode)
            if mode != .unconfigured {
                await restored._testSwitchTarget(.primary, in: controller)
                #expect(selection.profileID == nil)
                restored.close()
                let primary = makeManager()
                defer { primary.close() }
                try await primary.show()
                #expect(primary._testMainTarget() == .primary)
                #expect(primary._testController()?.auth.token == "machine-owner")
            }
        }
    }

    @Test func `a stale saved selection returns to the configured Primary`() async throws {
        try await TestIsolation.withIsolatedState {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let suiteName = "DashboardGatewaySelectionTests.\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }
            let selection = MacGatewaySelectionPreferences(defaults: defaults)
            selection.select(.profile("missing-\(UUID().uuidString)"))
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = previousMode }
            let manager = DashboardManager._testMake(
                selection: selection,
                primaryEndpointProvider: { _ in .init(
                    config: (url: server.websocketURL(), token: "configured-primary", password: nil),
                    routeAuthority: nil)
                })
            defer { manager.close() }
            try await manager.show()
            #expect(selection.profileID == nil)
            #expect(manager._testMainTarget() == .primary)
            #expect(manager._testController()?.auth.token == "configured-primary")
        }
    }
}
