import AppKit
import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class DashboardCookieNavigationObserver: NSObject, WKNavigationDelegate {
    private(set) var navigationCount = 0
    private(set) var cookiesAtNavigation: [HTTPCookie]?

    func webView(
        _ webView: WKWebView,
        decidePolicyFor _: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        self.navigationCount += 1
        Task { @MainActor in
            self.cookiesAtNavigation = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
            // Observe admission without making any network request to the synthetic origin.
            decisionHandler(.cancel)
        }
    }
}

@Suite(.serialized)
@MainActor
struct DashboardBrowserSessionTests {
    private func session(_ token: String, subject: String = "fixture-account") throws -> GatewayBrowserSession {
        try GatewayBrowserSession(
            origin: #require(URL(string: "https://gateway.example/")),
            issuer: #require(URL(string: "https://identity.cloudflareaccess.com/")),
            audience: "dashboard-fixture",
            subject: subject,
            token: token,
            expiresAt: Date().addingTimeInterval(300))
    }

    @Test func `browser sign-in cookie is installed before the first dashboard navigation`() async throws {
        let session = try self.session("first-session")
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let lease = store.lease(for: session)
        let url = try #require(URL(string: "https://gateway.example/control/"))
        let controller = self.controller(url: url, store: store, lease: lease)
        defer { controller.closeDashboard() }
        let observer = DashboardCookieNavigationObserver()
        controller.webView.navigationDelegate = observer

        controller.show(url: url, auth: controller.auth)
        let deadline = ContinuousClock.now + .seconds(5)
        while observer.cookiesAtNavigation == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let cookies = try #require(observer.cookiesAtNavigation)
        let cookie = try #require(cookies.first { $0.name == "CF_Authorization" })
        #expect(observer.navigationCount == 1)
        #expect(cookie.value == "first-session")
        #expect(cookie.isSecure)
        #expect(cookie.isHTTPOnly)
        #expect(cookie.domain == "gateway.example")
        #expect(controller._testUserScripts.allSatisfy { !$0.source.contains("first-session") })
        #expect(controller._testLinkBrowserDataStore !== store.dataStore)
        #expect(!controller._testLinkBrowserDataStore.isPersistent)
        #expect(await controller._testLinkBrowserDataStore.httpCookieStore.allCookies().isEmpty)
    }

    @Test(arguments: [false, true])
    func `closing or replacing a window cancels navigation awaiting its cookie`(_ replacing: Bool) async throws {
        let session = try self.session("closed-session")
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let lease = store.lease(for: session)
        let url = try #require(URL(string: "https://gateway.example/control/"))
        let controller = self.controller(url: url, store: store, lease: lease)
        let observer = DashboardCookieNavigationObserver()
        controller.webView.navigationDelegate = observer
        controller.show(url: url, auth: controller.auth)
        if replacing {
            controller.detachWindowForReplacement()?.close()
        } else {
            controller.closeDashboard()
        }

        try await lease.prepare(for: url, in: controller.webView.configuration.userContentController)
        // Drain the cancelled navigation task after WebKit acknowledges the cookie.
        await Task.yield()
        #expect(observer.navigationCount == 0)
        #expect(controller.webView.url == nil)
        #expect(!controller.isWindowOpen)
    }

    @Test func `profile stores isolate accounts and replacement retires an older cookie write`() async throws {
        let first = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let second = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let oldSession = try session("old-account")
        let newSession = try session("new-account", subject: "replacement-account")
        let otherSession = try session("other-profile")
        let stale = first.lease(for: oldSession)
        let current = first.lease(for: newSession)
        let other = second.lease(for: otherSession)

        await #expect(throws: GatewayBrowserSessionError.superseded) {
            try await stale.prepare(for: oldSession.origin, in: WKUserContentController())
        }
        try await current.prepare(for: newSession.origin, in: WKUserContentController())
        try await other.prepare(for: otherSession.origin, in: WKUserContentController())
        #expect(await first.dataStore.httpCookieStore.allCookies().map(\.value) == ["new-account"])
        #expect(await second.dataStore.httpCookieStore.allCookies().map(\.value) == ["other-profile"])

        let preference = try #require(HTTPCookie(properties: [
            .name: "ui-theme", .value: "dark", .originURL: newSession.origin, .path: "/",
        ]))
        await first.dataStore.httpCookieStore.setCookie(preference)
        first.invalidate()
        let renewal = try self.session("renewed-account", subject: "replacement-account")
        let renewalLease = first.lease(for: renewal)
        try await renewalLease.prepare(for: renewal.origin, in: WKUserContentController())
        first.expire(newSession)
        first.expire(renewal)
        #expect(renewalLease.isCurrent)
        #expect(await first.dataStore.httpCookieStore.allCookies().first {
            $0.name == "CF_Authorization"
        }?.value == "renewed-account")
        #expect(await first.dataStore.httpCookieStore.allCookies().first { $0.name == "ui-theme" }?.value == "dark")
        let replacement = try self.session("different-account", subject: "another-account")
        try await first.lease(for: replacement).prepare(for: replacement.origin, in: WKUserContentController())
        #expect(await first.dataStore.httpCookieStore.allCookies().contains { $0.name == "ui-theme" } == false)
        await first.dataStore.httpCookieStore.setCookie(preference)
        first.removeData()
        try await first.lease(for: nil).prepare(for: newSession.origin, in: WKUserContentController())
        await #expect(throws: GatewayBrowserSessionError.superseded) {
            try await current.prepare(for: newSession.origin, in: WKUserContentController())
        }
        #expect(await first.dataStore.httpCookieStore.allCookies().isEmpty)
        #expect(await second.dataStore.httpCookieStore.allCookies().map(\.value) == ["other-profile"])
    }

    @Test func `manual profile changes fence a first open and retain the existing browser store`() async throws {
        try await TestIsolation.withIsolatedState {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let source = GatewayConnectionEndpointSource(url: server.websocketURL(), token: "before")
            let fixture = try DashboardIdentityFixture(announcement: nil, source: source)
            let lookup = DashboardWindowOwnershipPresentationGate()
            let primaryStore = WKWebsiteDataStore.nonPersistent()
            var profileName = "first-open"
            let target = DashboardGatewayTarget.profile("first-open")
            let manager = DashboardManager._testMake(
                websiteDataStore: primaryStore,
                connectionProvider: { _ in fixture.connection },
                browserIdentityURLProvider: { _, _ in
                    await lookup.waitForRelease()
                    return nil
                },
                observeGatewayChanges: true,
                profileEndpointProvider: { _ in source.snapshot() },
                gatewayEntriesProvider: { ["first-open", "same-origin"].map {
                    DashboardGatewayEntry(
                        id: "profile:\($0)",
                        name: $0 == "first-open" ? profileName : $0,
                        kind: "remote",
                        isPrimary: false,
                        canPromote: false,
                        health: .unknown)
                } })
            let pending = Task { @MainActor in await manager._testOpenWindow(for: target) }
            await lookup.waitUntilRequested()
            source.setEndpoint(.init(
                config: (url: server.websocketURL(), token: "after", password: nil), routeAuthority: nil))
            NotificationCenter.default.post(
                name: MacGatewayProfileStore.didChangeNotification,
                object: nil,
                userInfo: [MacGatewayProfileStore.changedProfileIDKey: "first-open"])
            await lookup.release()
            await pending.value

            let result: Result<Void, Error>
            do {
                let opened = try #require(manager._testAuxiliaryWindows().first?.controller)
                #expect(opened.auth.token == "after")
                #expect(opened._testDashboardDataStore === primaryStore)
                await manager._testOpenWindow(for: target)
                await manager._testOpenWindow(for: .profile("same-origin"))
                let windows = manager._testAuxiliaryWindows()
                let sameProfile = windows.filter { $0.target == target }
                #expect(sameProfile.count == 2)
                #expect(sameProfile.allSatisfy {
                    $0.controller._testDashboardDataStore === opened._testDashboardDataStore
                })
                let other = try #require(windows.first { $0.target != target }?.controller)
                #expect(other._testDashboardDataStore === primaryStore)
                let readyDeadline = ContinuousClock.now + .seconds(5)
                while await (try? opened.webView.evaluateJavaScript("document.body.innerText")) as? String != "Ready",
                      ContinuousClock.now < readyDeadline
                {
                    try await Task.sleep(for: .milliseconds(10))
                }
                _ = try await opened.webView.evaluateJavaScript(
                    "document.body.innerText = 'Before save'; localStorage.setItem('ui-theme', 'dark')")
                profileName = "Renamed"
                NotificationCenter.default.post(
                    name: MacGatewayProfileStore.didChangeNotification,
                    object: nil,
                    userInfo: [MacGatewayProfileStore.changedProfileIDKey: "first-open"])
                let refreshedDeadline = ContinuousClock.now + .seconds(5)
                while opened.gatewaySnapshot?.gateways.first(where: { $0.id == target.bridgeID })?.name != "Renamed",
                      ContinuousClock.now < refreshedDeadline
                {
                    try await Task.sleep(for: .milliseconds(10))
                }
                #expect(opened.gatewaySnapshot?.gateways.first { $0.id == target.bridgeID }?.name == "Renamed")
                #expect(try await opened.webView
                    .evaluateJavaScript("document.body.innerText") as? String == "Before save")
                #expect(try await opened.webView
                    .evaluateJavaScript("localStorage.getItem('ui-theme')") as? String == "dark")
                #expect(opened.isWindowOpen)

                result = .success(())
            } catch {
                result = .failure(error)
            }
            manager.close()
            await fixture.connection.shutdown()
            try result.get()
        }
    }

    private func controller(
        url: URL,
        store: DashboardBrowserSessionStore,
        lease: DashboardBrowserSessionStore.Lease) -> DashboardWindowController
    {
        DashboardWindowController(
            url: url,
            auth: .browserIdentity(gatewayUrl: "wss://gateway.example/control/"),
            websiteDataStore: store.dataStore,
            browserSessionLease: lease,
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
    }

    @Test(arguments: [false, true])
    func `only browser sign-in profiles use an isolated website store`(_ browserSignIn: Bool) async throws {
        let tls = try DashboardTLSFixture()
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity)
        defer { server.stop() }
        let session = try GatewayBrowserSession(
            origin: server.url(),
            issuer: #require(URL(string: "https://issuer.example/")),
            audience: "fixture",
            subject: "account",
            token: "synthetic",
            expiresAt: Date().addingTimeInterval(300))
        let existingStore = WKWebsiteDataStore.nonPersistent()
        let manager = DashboardManager._testMake(
            websiteDataStore: existingStore,
            profileEndpointProvider: { _ in .init(
                config: (url: server.websocketURL(), token: "manual-token", password: nil),
                routeAuthority: nil,
                browserSession: browserSignIn ? session : nil)
            })
        defer { manager.close() }
        await manager._testOpenWindow(for: .profile("storage-owner"))
        let controller = try #require(manager._testAuxiliaryWindows().first?.controller)
        #expect((controller._testDashboardDataStore === existingStore) == !browserSignIn)
    }

    @Test func `browser-only setup reopens its Gateway without configuring machine integrations`() async throws {
        try await TestIsolation.withIsolatedState(defaults: [connectionModeKey: "unconfigured"]) {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .unconfigured
            defer { state.connectionMode = previousMode }
            for _ in 0..<2 {
                let manager = DashboardManager._testMake(
                    primaryEndpointProvider: { _ in throw URLError(.cannotConnectToHost) },
                    profileEndpointProvider: { _ in .init(
                        config: (url: server.websocketURL(), token: "personal-route", password: nil),
                        routeAuthority: nil)
                    },
                    gatewayEntriesProvider: { [.init(
                        id: "profile:only",
                        name: "Saved",
                        kind: "remote",
                        isPrimary: false,
                        canPromote: false,
                        health: .unknown)] })
                defer { manager.close() }
                try await manager.show()
                let first = try #require(manager._testController())
                #expect(manager._testMainTarget() == .profile("only"))
                #expect(first.auth.token == "personal-route")
                first.closeDashboard()
                try await manager.show()
                #expect(manager._testController()?.isWindowOpen == true)
                #expect(manager._testMainTarget() == .profile("only"))
                #expect(state.connectionMode == .unconfigured)
                manager.close()
            }
        }
    }

    @Test func `removal closes every profile window and fences a pending open`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let lookup = DashboardWindowOwnershipPresentationGate(released: true)
        let connection = GatewayConnection(testEndpointProvider: { throw CancellationError() })
        let manager = DashboardManager._testMake(
            connectionProvider: { _ in connection },
            observeGatewayChanges: true,
            profileEndpointProvider: { _ in
                await lookup.waitForRelease()
                return .init(config: (url: server.websocketURL(), token: "saved", password: nil), routeAuthority: nil)
            },
            gatewayEntriesProvider: { [.init(
                id: "profile:removed",
                name: "Saved",
                kind: "remote",
                isPrimary: false,
                canPromote: false,
                health: .unknown)] })
        defer { manager.close() }
        await manager._testOpenWindow(for: .profile("removed"))
        await manager._testOpenWindow(for: .profile("removed"))
        let windows = manager._testAuxiliaryWindows().map(\.controller)
        #expect(windows.count == 2)
        await lookup.hold()
        let pending = Task { @MainActor in await manager._testOpenWindow(for: .profile("removed")) }
        await lookup.waitUntilRequested()
        let removalID = self.postRemoval(profileID: "removed")
        try await manager.finishGatewayRemoval(profileID: "removed", removalID: removalID)
        await lookup.release()
        await pending.value
        #expect(manager._testAuxiliaryWindows().isEmpty)
        #expect(windows.allSatisfy { !$0.isWindowOpen && !$0.canDeliverNativeCommands })
        NotificationCenter.default.post(
            name: MacGatewayProfileStore.didChangeNotification,
            object: nil,
            userInfo: [MacGatewayProfileStore.changedProfileIDKey: "removed"])
        await manager._testOpenWindow(for: .profile("removed"))
        let successor = try #require(manager._testAuxiliaryWindows().first?.controller)
        try await manager.finishGatewayRemoval(profileID: "removed", removalID: removalID)
        #expect(successor.isWindowOpen)
        await connection.shutdown()
    }

    @Test func `removal clears a persisted browser session before any window opens in this process`() async throws {
        let profileID = "forgotten-\(UUID().uuidString)"
        let identifier = DashboardBrowserSessionStore.identifier(
            profileID: profileID, registryNamespace: MacGatewayProfileStore.service)

        do {
            try await self.verifyPersistedSessionRemoval(profileID: profileID, identifier: identifier)
        } catch {
            do {
                try await WKWebsiteDataStore.remove(forIdentifier: identifier)
            } catch {
                Issue.record(error, "Could not remove the test's persistent WebKit store")
            }
            throw error
        }
        try await WKWebsiteDataStore.remove(forIdentifier: identifier)
    }

    private func verifyPersistedSessionRemoval(profileID: String, identifier: UUID) async throws {
        // Release both owners before removing the store directory: WebKit rejects
        // removal while a live data store still owns its network session.
        let store = WKWebsiteDataStore(forIdentifier: identifier)
        let session = try self.session("previous-process")
        try await store.httpCookieStore.setCookie(session.cookie())
        let connection = GatewayConnection(testEndpointProvider: { throw CancellationError() })
        let manager = DashboardManager._testMake(
            websiteDataStore: .default(),
            connectionProvider: { _ in connection },
            observeGatewayChanges: true)
        defer { manager.close() }
        let removalID = self.postRemoval(profileID: profileID)
        try await manager.finishGatewayRemoval(profileID: profileID, removalID: removalID)
        #expect(await store.httpCookieStore.allCookies().isEmpty)
        #expect(manager._testController() == nil)
        #expect(manager._testAuxiliaryWindows().isEmpty)
        await connection.shutdown()
    }

    @Test func `named app registries isolate persisted cookies for the same Gateway`() async throws {
        let service = "openclaw.browser-isolation-test.\(UUID().uuidString)"
        let identifiers = ["work", "personal"].map { name in
            DashboardBrowserSessionStore.identifier(
                profileID: "same-gateway",
                registryNamespace: AppProfile(environment: ["OPENCLAW_PROFILE": name]).keychainService(base: service))
        }
        let result: Result<Void, Error>
        do {
            try await self.verifyIsolatedRegistryCookies(identifiers)
            result = .success(())
        } catch {
            result = .failure(error)
        }
        // The helper releases every store owner before WebKit removes its directory.
        for identifier in Set(identifiers) {
            do {
                try await WKWebsiteDataStore.remove(forIdentifier: identifier)
            } catch {
                Issue.record(error, "Could not remove the test's isolated WebKit store")
            }
        }
        try result.get()
    }

    @Test func `registry principal restores cookie-free preferences and respects pending removal`() async throws {
        let namespace = "cold-browser-registry-\(UUID().uuidString)"
        let identifier = DashboardBrowserSessionStore.identifier(profileID: "gateway", registryNamespace: namespace)
        let result: Result<Void, Error>
        do {
            try await self.verifyColdPrincipalRestore(namespace: namespace, identifier: identifier)
            result = .success(())
        } catch {
            result = .failure(error)
        }
        try await WKWebsiteDataStore.remove(forIdentifier: identifier)
        try result.get()
    }

    private func verifyColdPrincipalRestore(namespace: String, identifier: UUID) async throws {
        let dataStore = WKWebsiteDataStore(forIdentifier: identifier)
        let session = try self.session("current-keychain-session")
        let preference = try #require(HTTPCookie(properties: [
            .name: "ui-theme", .value: "dark", .originURL: session.origin, .path: "/",
        ]))
        await dataStore.httpCookieStore.setCookie(preference)
        let owner = DashboardBrowserSessionStore.persistent(
            profileID: "gateway", registryNamespace: namespace, currentSession: session)
        try await owner.lease(for: session).prepare(for: session.origin, in: WKUserContentController())
        #expect(await dataStore.httpCookieStore.allCookies().first { $0.name == "ui-theme" }?.value == "dark")
        owner.removeData()
        let reopened = DashboardBrowserSessionStore.persistent(
            profileID: "gateway", registryNamespace: namespace, currentSession: session)
        try await reopened.lease(for: session).prepare(for: session.origin, in: WKUserContentController())
        #expect(await dataStore.httpCookieStore.allCookies().contains { $0.name == "ui-theme" } == false)
    }

    private func verifyIsolatedRegistryCookies(_ identifiers: [UUID]) async throws {
        let work = DashboardBrowserSessionStore(dataStore: WKWebsiteDataStore(forIdentifier: identifiers[0]))
        let personal = DashboardBrowserSessionStore(dataStore: WKWebsiteDataStore(forIdentifier: identifiers[1]))
        let workSession = try self.session("work-account-cookie")
        let personalSession = try self.session("personal-account-cookie")
        try await work.lease(for: workSession).prepare(for: workSession.origin, in: WKUserContentController())
        try await personal.lease(for: personalSession).prepare(
            for: personalSession.origin,
            in: WKUserContentController())
        #expect(await work.dataStore.httpCookieStore.allCookies().map(\.value) == ["work-account-cookie"])
        #expect(await personal.dataStore.httpCookieStore.allCookies().map(\.value) == ["personal-account-cookie"])
        try await work.removeData().value
        #expect(await work.dataStore.httpCookieStore.allCookies().isEmpty)
        #expect(await personal.dataStore.httpCookieStore.allCookies().map(\.value) == ["personal-account-cookie"])
    }

    private func postRemoval(profileID: String) -> UUID {
        let removalID = UUID()
        NotificationCenter.default.post(
            name: MacGatewayProfileStore.didChangeNotification,
            object: nil,
            userInfo: [
                MacGatewayProfileStore.changedProfileIDKey: profileID,
                MacGatewayProfileStore.removedProfileKey: true,
                MacGatewayProfileStore.changeIDKey: removalID,
            ])
        return removalID
    }

    @Test func `expired browser sign-in is terminal and explains how to reconnect`() async throws {
        let session = try self.session("expired-page")
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let controller = self.controller(url: session.origin, store: store, lease: store.lease(for: session))
        defer { controller.closeDashboard() }
        controller.invalidateBrowserSession(error: .expired)
        var text = ""
        let deadline = ContinuousClock.now + .seconds(5)
        while !text.contains("Settings"), ContinuousClock.now < deadline {
            text = await (try? controller.webView.evaluateJavaScript("document.body.innerText")) as? String ?? ""
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(text.contains("expired"))
        #expect(text.contains("Settings"))
        #expect(!controller.canDeliverNativeCommands)
    }
}
