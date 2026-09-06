import AppKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
extension DashboardWindowOwnershipTests {
    @Test(arguments: [
        "replacement", "committed", "provisional", "close", "cancel-domains", "cancel-profile", "normalize-profile",
        "revoke-domains", "revoke-session",
    ])
    func `device settings promises settle with consent and retire with their document`(
        _ transition: String) async throws
    {
        try await TestIsolation.withIsolatedState(defaults: [
            connectionModeKey: nil,
            cookieSyncEnabledKey: nil,
            cookieSyncDomainsKey: nil,
            cookieSyncIntoProfileKey: nil,
        ]) {
            try await Self.checkDeviceSettingsSettlement(transition)
        }
    }

    private static func checkDeviceSettingsSettlement(_ transition: String) async throws {
        _ = AppKitTestSupport.application
        let state = AppStateStore.shared
        let previous = (
            state.connectionMode,
            state.cookieSyncEnabled,
            state.cookieSyncDomains,
            state.cookieSyncIntoProfile)
        state.connectionMode = .unconfigured
        state.cookieSyncEnabled = true
        state.cookieSyncDomains = ["existing.test"]
        state.cookieSyncIntoProfile = "imported"
        defer {
            state.cookieSyncEnabled = previous.1
            state.cookieSyncDomains = previous.2
            state.cookieSyncIntoProfile = previous.3
            state.connectionMode = previous.0
        }
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let autosaveName = "OpenClawDashboardWindow-Test-\(UUID().uuidString)"
        defer { NSWindow.removeFrame(usingName: autosaveName) }
        let auth = DashboardWindowAuth(gatewayUrl: server.websocketURL().absoluteString, token: nil, password: nil)
        let sessionStore = transition == "revoke-session" ? DashboardBrowserSessionStore(dataStore: .nonPersistent()) :
            nil
        let controller = DashboardWindowController(
            url: server.url(),
            auth: auth,
            websiteDataStore: sessionStore?.dataStore ?? .nonPersistent(),
            browserSessionLease: sessionStore?.lease(for: nil),
            windowAutosaveName: autosaveName,
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show(url: server.url(), auth: auth)
        try #require(await Self.waitForDashboardDocument(controller))
        let window = try #require(controller.window)
        defer {
            if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }
        }
        let changesProfile = transition.hasSuffix("profile")
        let key = changesProfile ? "browser.cookieSync.targetProfile" : "browser.cookieSync.domains"
        let value = changesProfile ? #"" work ""# : #"["existing.test", "added.test"]"#
        _ = try await controller.webView.evaluateJavaScript("""
        window.deviceReplies = [];
        function recordDeviceReply(type, request) {
          window.webkit.messageHandlers.openclawDeviceSettings.postMessage(request).then(
            value => window.deviceReplies.push({type, value}),
            error => window.deviceReplies.push({type, error: error.message}));
        }
        recordDeviceReply('set', {type: 'set', key: '\(key)', value: \(value)});
        recordDeviceReply('status', {type: 'status'});
        null;
        """)
        try #require(await Self.waitForConsentState { window.attachedSheet != nil })

        var replacement: DashboardWindowController?
        defer { replacement?.closeDashboard() }
        var other: DashboardWindowController?
        var sessionRetirement: Task<Void, Error>?
        let otherAutosaveName = autosaveName + "-other"
        defer {
            other?.closeDashboard()
            NSWindow.removeFrame(usingName: otherAutosaveName)
        }
        switch transition {
        case "revoke-session":
            // Renewal revokes the lease synchronously, before cookie cleanup replaces the document.
            sessionRetirement = try #require(sessionStore).invalidate()
        case "revoke-domains":
            let second = DashboardWindowController(
                url: server.url(),
                auth: auth,
                websiteDataStore: .nonPersistent(),
                windowAutosaveName: otherAutosaveName,
                requestBrowserProfileImportOffer: { _ in false })
            other = second
            second.show(url: server.url(), auth: auth)
            try #require(await Self.waitForDashboardDocument(second))
            _ = try await second.webView.callAsyncJavaScript("""
            return await window.webkit.messageHandlers.openclawDeviceSettings.postMessage({
              type: 'set', key: 'browser.cookieSync.domains', value: []
            });
            """, in: nil, contentWorld: .page)
            #expect(state.cookieSyncDomains.isEmpty)
        case "replacement":
            let transferred = try #require(controller.detachWindowForReplacement())
            replacement = DashboardWindowController(
                url: server.url(),
                auth: auth,
                websiteDataStore: .nonPersistent(),
                windowAutosaveName: autosaveName,
                reusingWindow: transferred,
                requestBrowserProfileImportOffer: { _ in false })
            #expect(replacement?.window === window)
            replacement?.show(url: server.url(), auth: auth)
        case "committed": controller.webView(controller.webView, didCommit: nil)
        case "provisional": controller.webView(controller.webView, didStartProvisionalNavigation: nil)
        case "close":
            controller.closeDashboard()
            #expect(!controller.isWindowOpen)
        default: break
        }

        let retired = ["replacement", "committed", "close"].contains(transition)
        let allowed = transition == "provisional" || transition == "normalize-profile"
        if retired {
            #expect(await Self.waitForConsentState { window.attachedSheet == nil })
        } else {
            #expect(window.attachedSheet != nil)
        }
        // Join even a regressed, still-attached sheet: stale Allow must not survive retirement.
        if let sheet = window.attachedSheet {
            window.endSheet(
                sheet,
                returnCode: retired || allowed || transition == "revoke-domains" || transition == "revoke-session"
                    ? .alertSecondButtonReturn : .alertFirstButtonReturn)
        }
        let replies = try await self.waitForDeviceReplies(controller.webView)
        try await sessionRetirement?.value
        #expect(replies.count == 2)
        let expectedDomains = transition == "revoke-domains"
            ? [] : allowed && !changesProfile ? ["existing.test", "added.test"] : ["existing.test"]
        if retired || transition == "revoke-session" {
            #expect(replies.allSatisfy { $0["error"] is String && $0["value"] == nil })
        } else {
            let reply = try #require(replies.first { $0["type"] as? String == "set" })
            let snapshot = try #require(reply["value"] as? [String: Any])
            let browser = try #require(snapshot["browser"] as? [String: Any])
            let sync = try #require(browser["cookieSync"] as? [String: Any])
            #expect(snapshot["contract"] as? Int == 1)
            #expect(sync["domains"] as? [String] == expectedDomains)
            #expect(sync["targetProfile"] as? String == (allowed && changesProfile ? "work" : "imported"))
            #expect(replies.first { $0["type"] as? String == "status" }?["value"] is NSNull)
        }
        #expect(state.cookieSyncDomains == expectedDomains)
        #expect(state.cookieSyncIntoProfile == (allowed && changesProfile ? "work" : "imported"))

        guard transition != "close" else { return }
        let current = replacement ?? controller
        if replacement != nil {
            try #require(await Self.waitForDashboardDocument(current))
        }
        let fresh = Task { await current.deviceSettingsMessageHandler.confirm(.activityReporting) }
        defer {
            if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }
            fresh.cancel()
        }
        try #require(await Self.waitForConsentState { window.attachedSheet != nil })
        let freshSheet = try #require(window.attachedSheet)
        window.endSheet(freshSheet, returnCode: .alertFirstButtonReturn)
        #expect(await fresh.value == false)
    }

    private static func waitForDashboardDocument(_ controller: DashboardWindowController) async -> Bool {
        // Lease-backed loads report deliverable before the document exists; requests from the
        // interim blank page are untrusted, so wait for the real dashboard page to finish.
        await self.waitForConsentState {
            controller.webView.url != nil && !controller.webView.isLoading && controller.canDeliverNativeCommands
        }
    }

    private static func waitForDeviceReplies(_ webView: WKWebView) async throws -> [[String: Any]] {
        let deadline = ContinuousClock.now + .seconds(5)
        repeat {
            let replies = try #require(try await webView.evaluateJavaScript("window.deviceReplies") as? [[String: Any]])
            if replies.count == 2 { return replies }
            try await Task.sleep(for: .milliseconds(10))
        } while ContinuousClock.now < deadline
        throw URLError(.timedOut)
    }

    private static func waitForConsentState(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }
}
