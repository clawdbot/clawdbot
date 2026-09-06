import ConcurrencyExtras
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor DashboardReconnectAuthGate {
    private var token: String?

    func authToken() -> String? {
        self.token
    }

    func replaceToken(_ token: String) {
        self.token = token
    }
}

@Suite(.serialized)
@MainActor
struct DashboardReconnectTests {
    @Test func `primary discovery failure preserves commands owned by a pending picker`() async throws {
        let discoveryGate = DashboardWindowOwnershipPresentationGate()
        let profileGate = DashboardWindowOwnershipPresentationGate()
        let failDiscovery = LockIsolated(false)
        let server = try await DashboardHTTPFixture.start(
            html: """
            <html><body><script>
            window.commandEvents = [];
            window.addEventListener('openclaw:native-new-session', () => window.commandEvents.push('new-session'));
            window.addEventListener('openclaw:native-toggle-search', event => {
              event.preventDefault(); window.commandEvents.push('palette');
            });
            window.__OPENCLAW_NATIVE_COMMANDS_READY__ = true;
            window.dispatchEvent(new Event('openclaw:native-commands-state'));
            </script></body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let target = DashboardGatewayTarget.profile("secondary")
        let manager = DashboardManager._testMake(
            browserIdentityURLProvider: { selected, _ in
                if selected == .primary, failDiscovery.value {
                    await discoveryGate.waitForRelease()
                    throw URLError(.cannotConnectToHost)
                }
                return nil
            },
            primaryEndpointProvider: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
            },
            profileEndpointProvider: { _ in
                await profileGate.waitForRelease()
                return GatewayConnection.EndpointSnapshot(
                    config: (url: server.websocketURL(), token: "secondary", password: nil), routeAuthority: nil)
            },
            gatewayEntriesProvider: {
                [DashboardGatewayEntry(
                    id: target.bridgeID,
                    name: "Secondary",
                    kind: "remote",
                    isPrimary: false,
                    canPromote: true,
                    health: .unknown)]
            })
        var discovery: Task<Void, Never>?
        var selection: Task<Void, Never>?
        let result: Result<Void, Error>
        do {
            await manager._testOpenWindow(for: .primary)
            let original = try #require(manager._testAuxiliaryWindows().first?.controller)
            let window = try #require(original.window)
            failDiscovery.setValue(true)
            discovery = Task {
                await manager.handleEndpointState(.ready(
                    mode: .remote,
                    url: server.websocketURL(),
                    token: "primary",
                    password: nil,
                    routeRevision: 1))
            }
            await discoveryGate.waitUntilRequested()
            selection = Task { await manager._testSwitchTarget(target, in: original) }
            await profileGate.waitUntilRequested()
            manager.dispatchNativeCommand(.newSession)
            manager.dispatchNativeCommand(.commandPalette)
            manager.dispatchNativeCommand(.commandPalette)
            let commands: [DashboardNativeCommand] = [.newSession, .commandPalette, .commandPalette]
            try #require(original._testPendingNativeCommands == commands)

            await discoveryGate.release()
            await discovery?.value
            #expect(original.pendingGatewaySwitch?.target == target)
            #expect(original._testPendingNativeCommands == commands)
            await profileGate.release()
            await selection?.value
            let replacement = try #require(window.windowController as? DashboardWindowController)
            let expected = ["new-session", "palette", "palette"]
            var events: [String] = []
            let deadline = ContinuousClock.now + .seconds(5)
            repeat {
                events = await (try? replacement.webView.evaluateJavaScript("window.commandEvents") as? [String]) ?? []
                if !replacement.webView.isLoading, events == expected { break }
                try await Task.sleep(for: .milliseconds(10))
            } while ContinuousClock.now < deadline
            #expect(manager._testAuxiliaryWindows().first?.target == target)
            #expect(replacement !== original)
            #expect(replacement.auth.token == "secondary")
            #expect(events == expected)
            result = .success(())
        } catch {
            result = .failure(error)
        }
        await discoveryGate.release()
        await profileGate.release()
        await discovery?.value
        await selection?.value
        manager.close()
        try result.get()
    }

    @Test(arguments: [false, true])
    func `endpoint discovery cannot overwrite a reopened main window`(fails: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = previousMode }
            let holdNextLookup = LockIsolated(false)
            let staleLookup = DashboardWindowOwnershipPresentationGate()
            let manager = DashboardManager._testMake(
                browserIdentityURLProvider: { _, _ in
                    if holdNextLookup.withValue({ armed in
                        defer { armed = false }
                        return armed
                    }) {
                        await staleLookup.waitForRelease()
                        if fails { throw URLError(.cannotConnectToHost) }
                        return server.url("/identity/")
                    }
                    return nil
                },
                primaryEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
                })
            var pending: Task<Void, Never>?
            let result: Result<Void, Error>
            do {
                try await manager.show()
                let original = try #require(manager._testController())
                let originalURL = original.currentURL
                let window = try #require(original.window)
                await manager._testOpenWindow(for: .primary)
                let auxiliary = try #require(manager._testAuxiliaryWindows().first?.controller.window)
                holdNextLookup.setValue(true)
                pending = Task {
                    await manager.handleEndpointState(.ready(
                        mode: .remote,
                        url: server.websocketURL(),
                        token: "primary",
                        password: nil,
                        routeRevision: 1))
                }
                await staleLookup.waitUntilRequested()
                window.performClose(nil)
                try await manager.show()
                try #require(manager._testController() === original, "The reopened native shell reuses its controller")
                await staleLookup.release()
                await pending?.value

                #expect(manager._testController() === original)
                #expect(original.window === window)
                #expect(original.isWindowOpen)
                #expect(original.currentURL == originalURL)
                #expect(original.auth.token == "primary")
                let currentAuxiliary = try #require(auxiliary.windowController as? DashboardWindowController)
                #expect(currentAuxiliary.isWindowOpen)
                #expect(currentAuxiliary.currentURL == (fails ? URL(string: "about:blank")! : server.url("/identity/")))
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await staleLookup.release()
            await pending?.value
            manager.close()
            try result.get()
        }
    }

    @Test func `reopening personal sign in does not inherit the native websocket TLS policy`() async throws {
        try await TestIsolation.withIsolatedState {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let state = AppStateStore.shared
            let originalMode = state.connectionMode
            state.connectionMode = .remote
            defer { state.connectionMode = originalMode }
            let identityURL = server.url("/dashboard/")
            let nativeURL = try #require(URL(string: "wss://native.example.test:443/"))
            let nativeTLS = GatewayTLSParams(
                required: true,
                expectedFingerprint: String(repeating: "a", count: 64),
                allowTOFU: false,
                storeKey: "fixture-native")
            let manager = DashboardManager._testMake(
                browserIdentityURLProvider: { _, _ in identityURL },
                primaryEndpointProvider: { _ in
                    GatewayConnection.EndpointSnapshot(
                        config: (nativeURL, "native-owner-token", nil),
                        tls: GatewayTLSRoute(params: nativeTLS, allowsTrustedPinReplacement: false),
                        routeAuthority: 1,
                        revision: 1)
                })
            defer { manager.close() }
            try await manager.show()
            let first = try #require(manager._testController())
            let loginURL = server.url("/login")
            first.webView.load(URLRequest(url: loginURL))
            let deadline = ContinuousClock.now + .seconds(10)
            while !first.canDeliverNativeCommands || first.webView.isLoading || first.webView.url != loginURL,
                  ContinuousClock.now < deadline
            {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(first.webView.url == loginURL)
            #expect(!first.webView.isLoading)
            try await manager.show()
            let reopened = try #require(manager._testController())
            #expect(reopened === first)
            #expect(reopened.webView.url == loginURL)
            #expect(reopened.hasTLSParams(nil))
            #expect(reopened.auth.usesBrowserIdentity)
        }
    }

    @Test func `remote dashboard uses verified browser identity across tunnel reconnects`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let identityURL = try #require(URL(string: "https://team.example/dashboard/"))
        let controller = DashboardWindowController(
            url: server.url("/"),
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "shared-owner-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        controller.show()
        let manager = DashboardManager._testMake(browserIdentityURLProvider: { _, _ in identityURL })
        manager._testSetController(controller)
        defer { manager.close() }

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: server.websocketURL("/"),
            token: "shared-owner-token",
            password: "shared-password",
            routeRevision: 1))

        let identified = try #require(manager._testController())
        #expect(identified.currentURL == identityURL)
        #expect(identified.auth == .browserIdentity(gatewayUrl: "wss://team.example/dashboard/"))
        #expect(identified.auth.token == nil)
        #expect(identified.auth.password == nil)
        #expect(identified.hasTLSParams(nil))

        let nextTunnel = try #require(URL(string: "ws://127.0.0.1:29876"))
        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: nextTunnel,
            token: "next-owner-token",
            password: nil,
            routeRevision: 2))

        let reconnected = try #require(manager._testController())
        #expect(reconnected.currentURL == identityURL)
        #expect(reconnected.auth == identified.auth)
    }

    @Test func `authenticated control reconnect recovers unchanged ready route`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let url = server.url("/#token=route-a-device-token")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "route-a-device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let authGate = DashboardReconnectAuthGate()
        let socketURL = replacementServer.websocketURL("")
        let endpointState = GatewayEndpointState.ready(
            mode: .remote,
            url: socketURL,
            token: nil,
            password: nil,
            routeRevision: 2)
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in await authGate.authToken() },
            endpointStateProvider: { endpointState })
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }

        await manager.handleEndpointState(endpointState)
        let failureController = try #require(manager._testController())
        #expect(failureController !== controller)
        #expect(failureController.currentURL == URL(string: "about:blank"))

        await manager.handleEndpointState(endpointState)
        #expect(manager._testController() === failureController)

        await authGate.replaceToken("route-b-device-token")
        await manager._testHandleControlChannelStateChange(.connecting)
        #expect(manager._testController() === failureController)

        await manager._testHandleControlChannelStateChange(.connected)

        let recoveredController = try #require(manager._testController())
        #expect(recoveredController !== failureController)
        #expect(!failureController.isWindowOpen)
        #expect(recoveredController.currentURL.absoluteString ==
            replacementServer.url("/#token=route-b-device-token").absoluteString)
    }
}
