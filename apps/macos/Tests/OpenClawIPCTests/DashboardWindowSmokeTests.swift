import AppKit
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardWindowSmokeTests {
    @Test func `dashboard window controller shows and closes`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:18789/control/",
                token: "device-token",
                password: nil))
        controller.show()
        #expect(controller.window?.styleMask.contains(.titled) == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        #expect(controller.window?.contentViewController != nil)
        #expect(controller.window?.standardWindowButton(.closeButton) != nil)
        #expect((controller.window?.frame.width ?? 0) >= DashboardWindowLayout.windowMinSize.width)
        #expect((controller.window?.frame.height ?? 0) >= DashboardWindowLayout.windowMinSize.height)
        controller.closeDashboard()
    }

    @Test func `dashboard navigation stays on same endpoint`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let staleEndpoint = try #require(URL(string: "http://127.0.0.1:18790/control/chat"))
        #expect(try DashboardWindowController.shouldAllowNavigation(
            to: #require(URL(string: "http://127.0.0.1:18789/control/chat")),
            dashboardURL: dashboard))
        #expect(try !DashboardWindowController.shouldAllowNavigation(
            to: #require(URL(string: "https://docs.openclaw.ai/")),
            dashboardURL: dashboard))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: staleEndpoint,
            dashboardURL: dashboard))
        #expect(!DashboardWindowController.shouldOpenExternalDashboardNavigation(
            staleEndpoint,
            navigationType: .backForward,
            buttonNumber: 1))
    }

    @Test func `dashboard parses only bounded native link requests`() throws {
        let request = DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "https://docs.openclaw.ai/platforms/macos",
            "target": "inline",
        ])
        #expect(try request == DashboardLinkRequest(
            url: #require(URL(string: "https://docs.openclaw.ai/platforms/macos")),
            target: .inline))

        #expect(DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "file:///tmp/private",
            "target": "inline",
        ]) == nil)
        #expect(DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "https://docs.openclaw.ai/",
            "target": "unknown",
        ]) == nil)
        #expect(DashboardWindowController.linkRequest(from: [
            "type": "other",
            "url": "https://docs.openclaw.ai/",
            "target": "external",
        ]) == nil)
        #expect(try DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "mailto:hello@example.com",
            "target": "external",
        ]) == DashboardLinkRequest(
            url: #require(URL(string: "mailto:hello@example.com")),
            target: .external))
        #expect(DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "mailto:hello@example.com",
            "target": "inline",
        ]) == nil)
        #expect(DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "https:hostless",
            "target": "external",
        ]) == nil)
    }

    @Test func `dashboard accepts only typed window drag requests`() {
        #expect(DashboardWindowController.isWindowDragRequest(["type": "window-drag"]))
        #expect(!DashboardWindowController.isWindowDragRequest(["type": "open-link"]))
        #expect(!DashboardWindowController.isWindowDragRequest(["type": 1]))
        #expect(!DashboardWindowController.isWindowDragRequest("window-drag"))
    }

    @Test func `dashboard trusts only its main control path for link messages`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let trusted = try #require(URL(string: "http://127.0.0.1:18789/control/chat"))
        let wrongPath = try #require(URL(string: "http://127.0.0.1:18789/control-room"))
        let wrongPort = try #require(URL(string: "http://127.0.0.1:18790/control/"))
        #expect(DashboardWindowController.isTrustedLinkSource(trusted, dashboardURL: dashboard))
        #expect(!DashboardWindowController.isTrustedLinkSource(wrongPath, dashboardURL: dashboard))
        #expect(!DashboardWindowController.isTrustedLinkSource(wrongPort, dashboardURL: dashboard))
        #expect(!DashboardWindowController.isTrustedLinkSource(nil, dashboardURL: dashboard))
        #expect(DashboardWindowController.shouldAllowEditorURLLaunch(
            from: trusted,
            isMainFrame: true,
            dashboardURL: dashboard))
        #expect(!DashboardWindowController.shouldAllowEditorURLLaunch(
            from: wrongPath,
            isMainFrame: true,
            dashboardURL: dashboard))
        #expect(!DashboardWindowController.shouldAllowEditorURLLaunch(
            from: trusted,
            isMainFrame: false,
            dashboardURL: dashboard))
    }

    @Test func `dashboard link browser tabs preserve isolation and lifecycle`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        #expect(controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserTabCount == 0)
        #expect(controller._testLinkBrowserActiveTabIndex == nil)
        #expect(controller._testLinkBrowserWebViewIdentity == nil)
        #expect(controller._testLinkBrowserDataStore === controller._testDashboardDataStore)
        #expect(!controller._testCanOpenWindowsAutomatically)
        #expect(controller._testLinkBrowserNavigationObservationCount == 0)
        #expect(controller._testSplitAutosaveName == DashboardWindowLayout.linkBrowserSplitAutosaveName)

        let urlA = try #require(URL(string: "http://127.0.0.1:1/a"))
        let urlB = try #require(URL(string: "http://127.0.0.1:1/b"))
        controller._testOpenLinkBrowser(urlA)
        #expect(controller._testLinkBrowserTabCount == 1)
        #expect(controller._testLinkBrowserTabURLs == [urlA])
        #expect(controller._testLinkBrowserActiveTabIndex == 0)
        #expect(!controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserRepresentedURL == urlA)
        #expect(!controller._testCanOpenWindowsAutomatically)

        controller._testOpenLinkBrowser(urlB)
        #expect(controller._testLinkBrowserTabURLs == [urlA, urlB])
        #expect(controller._testLinkBrowserActiveTabIndex == 1)
        controller._testOpenLinkBrowser(urlA)
        #expect(controller._testLinkBrowserTabURLs == [urlA, urlB])
        #expect(controller._testLinkBrowserActiveTabIndex == 0)

        controller._testLinkBrowserOpenInNewTab(urlA)
        #expect(controller._testLinkBrowserTabURLs == [urlA, urlB, urlA])
        #expect(controller._testLinkBrowserActiveTabIndex == 2)
        controller._testLinkBrowserSelectTab(at: 1)
        controller._testLinkBrowserCloseTab(at: 1)
        #expect(controller._testLinkBrowserTabURLs == [urlA, urlA])
        #expect(controller._testLinkBrowserActiveTabIndex == 1)
        controller._testLinkBrowserCloseTab(at: 0)
        controller._testLinkBrowserCloseTab(at: 0)
        #expect(controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserTabCount == 0)
        #expect(controller._testLinkBrowserRepresentedURL == nil)

        controller._testOpenLinkBrowser(urlB)
        #expect(!controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserTabCount == 1)
        #expect(controller._testLinkBrowserWebViewURL == nil)
        #expect(controller._testLinkBrowserHistoryIsEmpty)
        #expect(controller._testLinkBrowserDelegatesAreInstalled)
        #expect(controller._testLinkBrowserWebViewIsInstalled)
        #expect(controller._testLinkBrowserNavigationObservationCount == 4)
        #expect(controller._testLinkBrowserDataStore === controller._testDashboardDataStore)
        controller._testLinkBrowserOpenInNewTab(urlA)
        #expect(controller._testLinkBrowserTabCount == 2)
        controller._testCloseLinkBrowser()
        #expect(controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserTabCount == 0)
        #expect(controller._testLinkBrowserRepresentedURL == nil)
    }

    @Test func `dashboard link browser reorders and closes other tabs`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        let urlA = try #require(URL(string: "https://127.0.0.1:1/a"))
        let urlB = try #require(URL(string: "https://127.0.0.1:1/b"))
        let urlC = try #require(URL(string: "https://127.0.0.1:1/c"))
        controller._testOpenLinkBrowser(urlA)
        controller._testOpenLinkBrowser(urlB)
        controller._testOpenLinkBrowser(urlC)
        controller._testLinkBrowserSelectTab(at: 1)
        let activeIdentity = controller._testLinkBrowserWebViewIdentity

        controller._testLinkBrowserMoveTab(from: 0, to: 2)
        #expect(controller._testLinkBrowserTabURLs == [urlB, urlC, urlA])
        #expect(controller._testLinkBrowserActiveTabIndex == 0)
        #expect(controller._testLinkBrowserWebViewIdentity == activeIdentity)

        let menu = try #require(controller._testLinkBrowserContextMenu(forTabAt: 2))
        #expect(menu.items.map(\.title) == [
            "Open in Default Browser",
            "Copy Link",
            "Reload",
            "",
            "Close Tab",
            "Close Other Tabs",
        ])
        #expect(menu.items[0].isEnabled)
        #expect(menu.items[1].isEnabled)
        #expect(menu.items[2].isEnabled)
        #expect(menu.items[4].isEnabled)
        #expect(menu.items[5].isEnabled)
        menu.performActionForItem(at: 5)
        #expect(controller._testLinkBrowserTabURLs == [urlA])
        #expect(controller._testLinkBrowserActiveTabIndex == 0)
    }

    @Test func `dashboard link browser calculates final drag insertion indexes`() {
        let midpoints: [CGFloat] = [50, 150, 250]
        let cases: [(currentIndex: Int, locationX: CGFloat, targetIndex: Int?, order: [Int])] = [
            (0, 100, nil, [0, 1, 2]),
            (0, 150, 1, [1, 0, 2]),
            (0, 200, 1, [1, 0, 2]),
            (0, 300, 2, [1, 2, 0]),
            (2, 100, 1, [0, 2, 1]),
            (2, 0, 0, [2, 0, 1]),
            (1, 150, nil, [0, 1, 2]),
        ]
        for testCase in cases {
            let targetIndex = DashboardLinkBrowserTabBar.dropIndex(
                currentIndex: testCase.currentIndex,
                itemMidpoints: midpoints,
                locationX: testCase.locationX)
            #expect(targetIndex == testCase.targetIndex)

            var order = Array(midpoints.indices)
            if let targetIndex {
                let moved = order.remove(at: testCase.currentIndex)
                order.insert(moved, at: targetIndex)
            }
            #expect(order == testCase.order)
        }
    }

    @Test func `dashboard link browser retires initial URL after later navigation`() throws {
        let view = DashboardLinkBrowserView(websiteDataStore: .default())
        defer { view.closeBrowser() }
        let requestedURL = try #require(URL(string: "http://127.0.0.1:1/short"))
        let currentURL = try #require(URL(string: "http://127.0.0.1:1/final"))
        view.open(requestedURL)
        let webView = try #require(view._testActiveWebView)
        let initialNavigation = NSObject()
        view._testStartNavigation(initialNavigation, in: webView)
        view.navigationWillStart(currentURL, in: webView)

        view.open(requestedURL)
        #expect(view._testTabCount == 1)
        #expect(view._testActiveWebView === webView)

        view.open(currentURL)
        #expect(view._testTabCount == 1)
        #expect(view._testActiveWebView === webView)

        view._testFinishNavigation(initialNavigation, at: currentURL, in: webView)
        view.open(requestedURL)
        #expect(view._testTabCount == 1)
        #expect(view._testActiveWebView === webView)

        view._testStartNavigation(NSObject(), in: webView)
        view.navigationWillStart(currentURL, in: webView)
        view.open(requestedURL)
        #expect(view._testTabCount == 2)
        #expect(view._testActiveWebView !== webView)
    }

    @Test func `dashboard link browser retires initial URL when navigation is replaced`() throws {
        let view = DashboardLinkBrowserView(websiteDataStore: .default())
        defer { view.closeBrowser() }
        let requestedURL = try #require(URL(string: "http://127.0.0.1:1/short"))
        let redirectURL = try #require(URL(string: "http://127.0.0.1:1/redirect"))
        let replacementURL = try #require(URL(string: "http://127.0.0.1:1/replacement"))
        view.open(requestedURL)
        let webView = try #require(view._testActiveWebView)
        view._testStartNavigation(NSObject(), in: webView)
        view.navigationWillStart(redirectURL, in: webView)
        view._testStartNavigation(NSObject(), in: webView)
        view.navigationWillStart(replacementURL, in: webView)

        view.open(requestedURL)

        #expect(view._testTabCount == 2)
        #expect(view._testActiveWebView !== webView)
    }

    @Test func `dashboard link browser retires initial URL when redirected navigation fails`() throws {
        let view = DashboardLinkBrowserView(websiteDataStore: .default())
        defer { view.closeBrowser() }
        let requestedURL = try #require(URL(string: "http://127.0.0.1:1/short"))
        let redirectURL = try #require(URL(string: "http://127.0.0.1:1/redirect"))
        view.open(requestedURL)
        let webView = try #require(view._testActiveWebView)
        view._testStartNavigation(NSObject(), in: webView)
        view.navigationWillStart(redirectURL, in: webView)
        view.navigationDidFail(for: webView)

        view.open(requestedURL)

        #expect(view._testTabCount == 2)
        #expect(view._testActiveWebView !== webView)
    }

    @Test func `dashboard link browser prefers current URL over initial alias`() throws {
        let view = DashboardLinkBrowserView(websiteDataStore: .default())
        defer { view.closeBrowser() }
        let requestedURL = try #require(URL(string: "http://127.0.0.1:1/short"))
        let currentURL = try #require(URL(string: "http://127.0.0.1:1/final"))
        view.open(requestedURL)
        let redirectedWebView = try #require(view._testActiveWebView)
        view.navigationWillStart(currentURL, in: redirectedWebView)
        view._testOpenInNewTab(requestedURL)
        let currentWebView = try #require(view._testActiveWebView)
        view._testSelectTab(at: 0)

        view.open(requestedURL)

        #expect(view._testTabCount == 2)
        #expect(view._testActiveWebView === currentWebView)
    }

    @Test func `dashboard link browser menu disables URL actions for blank tab`() throws {
        let view = DashboardLinkBrowserView(websiteDataStore: .default())
        let url = try #require(URL(string: "http://127.0.0.1:1/blank"))
        view.open(url)
        let webView = try #require(view._testActiveWebView)
        #expect(webView.url == nil)
        view.navigationURLDidChange(for: webView)
        let menu = try #require(view._testContextMenu(forTabAt: 0))
        #expect(!menu.items[0].isEnabled)
        #expect(!menu.items[1].isEnabled)
        #expect(!menu.items[2].isEnabled)
        #expect(menu.items[4].isEnabled)
        #expect(!menu.items[5].isEnabled)
        view.closeBrowser()
    }

    @Test func `dashboard new windows route by source browser`() throws {
        let url = try #require(URL(string: "https://127.0.0.1:1/new"))
        let fileURL = try #require(URL(string: "file:///tmp/private"))
        #expect(DashboardWindowController.newWindowAction(
            for: url,
            sourceIsLinkBrowser: true) == .openTab(url))
        #expect(DashboardWindowController.newWindowAction(
            for: url,
            sourceIsLinkBrowser: false) == .openExternal(url))
        #expect(DashboardWindowController.newWindowAction(
            for: fileURL,
            sourceIsLinkBrowser: true) == .ignore)
        #expect(DashboardWindowController.newWindowAction(
            for: nil,
            sourceIsLinkBrowser: false) == .ignore)
    }

    @Test func `sidebar browser reserves auxiliary schemes for subframes`() throws {
        let webURL = try #require(URL(string: "https://github.com/openclaw/openclaw"))
        let blankURL = try #require(URL(string: "about:blank"))
        let fileURL = try #require(URL(string: "file:///tmp/private"))
        let mailURL = try #require(URL(string: "mailto:hello@example.com"))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: webURL, isMainFrame: true))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: webURL, isMainFrame: false))
        #expect(!DashboardWindowController.shouldAllowBrowserNavigation(to: blankURL, isMainFrame: true))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: blankURL, isMainFrame: false))
        #expect(!DashboardWindowController.shouldAllowBrowserNavigation(to: fileURL, isMainFrame: false))
        #expect(!DashboardWindowController.shouldAllowBrowserNavigation(to: mailURL, isMainFrame: false))
    }

    @Test func `external pointer fallback rejects synthetic link activation`() throws {
        let webURL = try #require(URL(string: "https://docs.openclaw.ai/"))
        let mailURL = try #require(URL(string: "mailto:hello@example.com"))
        #expect(DashboardWindowController.shouldOpenExternalDashboardNavigation(
            webURL,
            navigationType: .linkActivated,
            buttonNumber: 1))
        #expect(DashboardWindowController.shouldOpenExternalDashboardNavigation(
            mailURL,
            navigationType: .linkActivated,
            buttonNumber: 1))
        #expect(!DashboardWindowController.shouldOpenExternalDashboardNavigation(
            webURL,
            navigationType: .linkActivated,
            buttonNumber: 0))
        #expect(!DashboardWindowController.shouldOpenExternalDashboardNavigation(
            mailURL,
            navigationType: .other,
            buttonNumber: 1))

        #expect(DashboardWindowController.targetlessNavigationAction(
            for: webURL,
            navigationType: .linkActivated,
            buttonNumber: 1,
            allowEditorURLs: false) == .allow)
        #expect(DashboardWindowController.targetlessNavigationAction(
            for: mailURL,
            navigationType: .linkActivated,
            buttonNumber: 1,
            allowEditorURLs: false) == .openExternal)
        #expect(DashboardWindowController.targetlessNavigationAction(
            for: mailURL,
            navigationType: .linkActivated,
            buttonNumber: 0,
            allowEditorURLs: false) == .cancel)

        let editorURL = try #require(URL(string: "vscode://file/workspace/src/foo.ts"))
        #expect(DashboardWindowController.targetlessNavigationAction(
            for: editorURL,
            navigationType: .other,
            buttonNumber: 0,
            allowEditorURLs: true) == .openExternal)
        #expect(DashboardWindowController.targetlessNavigationAction(
            for: editorURL,
            navigationType: .other,
            buttonNumber: 0,
            allowEditorURLs: false) == .cancel)
    }

    @Test func `dashboard origin brackets ipv6 literals`() throws {
        let url = try #require(URL(string: "http://[fd12:3456:789a::1]:18789/control/"))
        #expect(DashboardWindowController.originString(for: url) == "http://[fd12:3456:789a::1]:18789")
    }

    @Test func `dashboard log string strips token fragment`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/#token=sekret")) // pragma: allowlist secret
        #expect(dashboardLogString(for: url) == "http://127.0.0.1:18789/control/")
    }

    @Test func `dashboard native chrome clears both desktop sidebars`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        let chromeScript = try #require(controller._testUserScripts.first {
            $0.source.contains("openclaw-native-macos-chrome")
        })

        // Narrow widths are styled by the Control UI's own compact drawer-row
        // rules (layout.mobile.css); only the desktop sidebar surfaces need
        // native padding injected here.
        #expect(chromeScript.source.contains(".sidebar-shell"))
        #expect(chromeScript.source.contains(".settings-sidebar__header"))
        #expect(chromeScript.source.contains("min-width: 700px"))
        #expect(chromeScript.source.contains("--openclaw-native-titlebar-height"))
        #expect(!chromeScript.source.contains("max-width: 1100px"))
    }

    @Test func `dashboard titlebar hosts back and forward controls`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        let accessories = try #require(controller.window?.titlebarAccessoryViewControllers)
        let buttons = accessories.flatMap { accessory in
            accessory.view.subviews.compactMap { $0 as? NSButton }
        }
        let back = try #require(buttons.first { $0.accessibilityLabel() == "Back" })
        let forward = try #require(buttons.first { $0.accessibilityLabel() == "Forward" })
        // Nothing to traverse on a fresh webview: both stay disabled until the
        // back-forward list gains entries (the SPA pushes history entries).
        #expect(!back.isEnabled)
        #expect(!forward.isEnabled)
        #expect(controller._testAllowsBackForwardGestures)
    }

    @Test func `dashboard failure state opens in dashboard window`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        controller.showFailure(
            title: "Dashboard unavailable",
            message: "Remote control tunnel failed",
            detail: "Reset the remote tunnel and try again.")
        #expect(controller.window?.isVisible == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        controller.closeDashboard()
    }

    private func makeShownController() throws -> DashboardWindowController {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "device-token",
                password: nil))
        controller.show()
        return controller
    }

    @Test func `dashboard follows ready endpoint to a new tunnel port`() async throws {
        let controller = try makeShownController()
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002")),
            token: "device-token",
            password: nil))

        #expect(controller.currentURL.absoluteString == "http://127.0.0.1:60002/#token=device-token")
        let authScripts = controller._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        // JSONSerialization escapes "/" so match on host:port, not the full origin.
        #expect(authScripts.first?.source.contains("127.0.0.1:60002") == true)
        #expect(authScripts.first?.source.contains("60001") == false)
    }

    @Test func `dashboard keeps endpoint when ready state matches current URL`() async throws {
        let controller = try makeShownController()
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        let scriptsBefore = controller._testUserScripts

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60001")),
            token: "device-token",
            password: nil))
        await manager.handleEndpointState(.connecting(mode: .remote, detail: "Connecting…"))
        await manager.handleEndpointState(.unavailable(mode: .remote, reason: "tunnel down"))

        #expect(controller.currentURL.absoluteString == "http://127.0.0.1:60001/#token=device-token")
        // Identity check: an unchanged endpoint must not re-inject scripts or reload.
        #expect(controller._testUserScripts.elementsEqual(scriptsBefore) { $0 === $1 })
    }

    @Test func `dashboard ignores endpoint changes while window is closed`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "device-token",
                password: nil))
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002")),
            token: "device-token",
            password: nil))

        #expect(controller.currentURL == url)
    }
}
