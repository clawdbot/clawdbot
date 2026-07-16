import AppKit
import Foundation
import Testing
@testable import OpenClaw

private actor DashboardRouteAuthGate {
    private var token: String?
    private var ready = false
    private var probeCount = 0

    init(token: String?) {
        self.token = token
    }

    func authToken() -> String? {
        self.ready ? self.token : nil
    }

    func probe() {
        self.ready = true
        self.probeCount += 1
    }

    func replaceToken(_ token: String?) {
        self.token = token
    }

    func probes() -> Int {
        self.probeCount
    }
}

@MainActor
private final class DashboardBrowserImportGate {
    var isOnboarded = false
    private(set) var requestCount = 0

    func request() -> Bool {
        self.requestCount += 1
        return self.isOnboarded
    }
}

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
        // The empty unified toolbar is what grows the titlebar to 52pt so the
        // traffic lights center against the web titlebar row; without it they
        // hug the top edge and misalign with the hosted web buttons.
        #expect(controller.window?.toolbar != nil)
        #expect(controller.window?.toolbarStyle == .unified)
        // The toolbar only exists to size the titlebar, so View > Hide Toolbar
        // (⌥⌘T) must be refused; otherwise hiding it desyncs the 52pt web inset.
        controller.window?.toggleToolbarShown(nil)
        #expect(controller.window?.toolbar?.isVisible == true)
        #expect((controller.window?.frame.width ?? 0) >= DashboardWindowLayout.windowMinSize.width)
        #expect((controller.window?.frame.height ?? 0) >= DashboardWindowLayout.windowMinSize.height)
        #expect(controller.window?.frameAutosaveName == DashboardWindowLayout.windowFrameAutosaveName)
        controller.closeDashboard()
    }

    @Test func `dashboard context menu removes browser items and collapses separators`() {
        let hiddenIdentifiers = [
            "WKMenuItemIdentifierReload",
            "WKMenuItemIdentifierOpenLinkInNewWindow",
            "WKMenuItemIdentifierOpenImageInNewWindow",
            "WKMenuItemIdentifierOpenMediaInNewWindow",
            "WKMenuItemIdentifierOpenFrameInNewWindow",
            "WKMenuItemIdentifierDownloadLinkedFile",
            "WKMenuItemIdentifierDownloadImage",
            "WKMenuItemIdentifierDownloadMedia",
        ]
        let hiddenItems = hiddenIdentifiers.map { identifier in
            let item = NSMenuItem(title: identifier, action: nil, keyEquivalent: "")
            item.identifier = NSUserInterfaceItemIdentifier(identifier)
            return item
        }
        let copy = NSMenuItem(title: "Copy", action: nil, keyEquivalent: "")
        let inspect = NSMenuItem(title: "Inspect Element", action: nil, keyEquivalent: "")
        let filtered = DashboardWebView.filteredContextMenuItems([
            .separator(),
            hiddenItems[0],
            .separator(),
            copy,
            .separator(),
            .separator(),
            hiddenItems[1],
            hiddenItems[2],
            hiddenItems[3],
            hiddenItems[4],
            hiddenItems[5],
            hiddenItems[6],
            hiddenItems[7],
            .separator(),
            inspect,
            .separator(),
        ])

        #expect(filtered.map(\.title) == ["Copy", "", "Inspect Element"])
        #expect(filtered[1].isSeparatorItem)
        #expect(!filtered.contains { hiddenIdentifiers.contains($0.identifier?.rawValue ?? "") })
    }

    @Test func `dashboard reload decision preserves live same URL content`() throws {
        let current = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let replacement = try #require(URL(string: "http://127.0.0.1:18790/control/"))
        let auth = DashboardWindowAuth(
            gatewayUrl: "ws://127.0.0.1:18789/control/",
            token: nil,
            password: "secret")
        let rotatedAuth = DashboardWindowAuth(
            gatewayUrl: "ws://127.0.0.1:18789/control/",
            token: nil,
            password: "rotated")

        #expect(!DashboardWindowController.shouldReloadDashboard(
            currentURL: current,
            newURL: current,
            currentAuth: auth,
            newAuth: auth,
            hasUsableDocument: true,
            isShowingFailurePage: false))
        #expect(DashboardWindowController.shouldReloadDashboard(
            currentURL: current,
            newURL: current,
            currentAuth: auth,
            newAuth: auth,
            hasUsableDocument: false,
            isShowingFailurePage: false))
        #expect(DashboardWindowController.shouldReloadDashboard(
            currentURL: current,
            newURL: replacement,
            currentAuth: auth,
            newAuth: auth,
            hasUsableDocument: true,
            isShowingFailurePage: false))
        // Password-only auth keeps the URL identical; rotation must reload.
        #expect(DashboardWindowController.shouldReloadDashboard(
            currentURL: current,
            newURL: current,
            currentAuth: auth,
            newAuth: rotatedAuth,
            hasUsableDocument: true,
            isShowingFailurePage: false))
        // An in-flight failure page is never a usable document to keep.
        #expect(DashboardWindowController.shouldReloadDashboard(
            currentURL: current,
            newURL: current,
            currentAuth: auth,
            newAuth: auth,
            hasUsableDocument: true,
            isShowingFailurePage: true))
    }

    @Test func `dashboard native command queues before page load`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))

        controller.dispatchNativeCommand(.newSession)
        controller.dispatchNativeCommand(.commandPalette)
        controller.dispatchNativeCommand(.commandPalette)

        #expect(controller._testPendingNativeCommands == [.newSession, .commandPalette, .commandPalette])

        // A terminal failure drops moment-bound intent instead of replaying it
        // after a later recovery reload.
        controller.showFailure(title: "Dashboard unavailable", message: "offline")
        #expect(controller._testPendingNativeCommands.isEmpty)
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

    @Test func `dashboard navigation shortcuts target the focused browser`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        #expect(controller._testNavigationWebViewIdentity == controller._testDashboardWebViewIdentity)

        try controller._testOpenLinkBrowser(#require(URL(string: "https://docs.openclaw.ai/")))
        let linkWebView = try #require(controller._testLinkBrowserWebViewIdentity)
        #expect(controller._testFocusLinkBrowser())
        #expect(controller._testNavigationWebViewIdentity == linkWebView)
    }

    @Test func `browser import offer retries until the first completed inline browser request`() async throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        var requestCount = 0
        var firstRequestContinuation: CheckedContinuation<Bool, Never>?
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            requestBrowserProfileImportOffer: { _ in
                requestCount += 1
                if requestCount == 1 {
                    return await withCheckedContinuation { continuation in
                        firstRequestContinuation = continuation
                    }
                }
                return true
            })
        defer { controller.closeDashboard() }

        controller.show()
        #expect(requestCount == 0)

        let link = try #require(URL(string: "https://docs.openclaw.ai/"))
        controller._testOpenLinkBrowser(link)
        controller.update(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        #expect(requestCount == 0)

        controller._testOpenLinkBrowser(link, requestBrowserProfileImportOffer: true)
        for _ in 0..<200 where firstRequestContinuation == nil {
            await Task.yield()
        }
        #expect(requestCount == 1)

        controller.update(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        firstRequestContinuation?.resume(returning: false)
        firstRequestContinuation = nil
        for _ in 0..<200 where requestCount == 1 {
            await Task.yield()
        }
        #expect(requestCount == 2)

        controller._testCloseLinkBrowser()
        controller._testOpenLinkBrowser(link, requestBrowserProfileImportOffer: true)
        for _ in 0..<10 {
            await Task.yield()
        }
        #expect(requestCount == 2)
    }

    @Test func `browser import offer retries when onboarding completes with browser open`() async throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let gate = DashboardBrowserImportGate()
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            requestBrowserProfileImportOffer: { _ in gate.request() })
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        let link = try #require(URL(string: "https://docs.openclaw.ai/"))
        controller._testOpenLinkBrowser(link, requestBrowserProfileImportOffer: true)
        for _ in 0..<200 where gate.requestCount == 0 {
            await Task.yield()
        }
        #expect(gate.requestCount == 1)

        gate.isOnboarded = true
        manager.handleOnboardingCompletion()
        for _ in 0..<200 where gate.requestCount == 1 {
            await Task.yield()
        }
        #expect(gate.requestCount == 2)

        manager.handleOnboardingCompletion()
        for _ in 0..<10 {
            await Task.yield()
        }
        #expect(gate.requestCount == 2)
    }

    @Test func `closing inline browser invalidates an in-flight import offer`() async throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        var requestCount = 0
        var firstRequestContinuation: CheckedContinuation<Void, Never>?
        var firstRequestApplied: Bool?
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            requestBrowserProfileImportOffer: { shouldApply in
                requestCount += 1
                if requestCount == 1 {
                    await withCheckedContinuation { continuation in
                        firstRequestContinuation = continuation
                    }
                    firstRequestApplied = shouldApply()
                    return firstRequestApplied == true
                }
                return shouldApply()
            })
        defer { controller.closeDashboard() }

        let link = try #require(URL(string: "https://docs.openclaw.ai/"))
        controller._testOpenLinkBrowser(link, requestBrowserProfileImportOffer: true)
        for _ in 0..<200 where firstRequestContinuation == nil {
            await Task.yield()
        }
        #expect(requestCount == 1)

        controller._testCloseLinkBrowser()
        firstRequestContinuation?.resume()
        for _ in 0..<200 where firstRequestApplied == nil {
            await Task.yield()
        }
        #expect(firstRequestApplied == false)

        controller._testOpenLinkBrowser(link, requestBrowserProfileImportOffer: true)
        for _ in 0..<200 where requestCount == 1 {
            await Task.yield()
        }
        #expect(requestCount == 2)
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
        #expect(controller._testLinkBrowserTabBarIsHidden)
        #expect(controller._testLinkBrowserTabBarHeight == 0)
        #expect(controller._testLinkBrowserToolbarHeight == DashboardWindowLayout.linkBrowserToolbarHeight)

        let urlA = try #require(URL(string: "http://127.0.0.1:1/a"))
        let urlB = try #require(URL(string: "http://127.0.0.1:1/b"))
        controller._testOpenLinkBrowser(urlA)
        #expect(controller._testLinkBrowserTabCount == 1)
        #expect(controller._testLinkBrowserTabURLs == [urlA])
        #expect(controller._testLinkBrowserActiveTabIndex == 0)
        #expect(!controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserRepresentedURL == urlA)
        #expect(!controller._testCanOpenWindowsAutomatically)
        #expect(controller._testLinkBrowserTabBarIsHidden)
        #expect(controller._testLinkBrowserTabBarHeight == 0)
        #expect(controller._testLinkBrowserToolbarHeight == DashboardWindowLayout.linkBrowserToolbarHeight)

        controller._testOpenLinkBrowser(urlB)
        #expect(controller._testLinkBrowserTabURLs == [urlA, urlB])
        #expect(controller._testLinkBrowserActiveTabIndex == 1)
        #expect(!controller._testLinkBrowserTabBarIsHidden)
        #expect(controller._testLinkBrowserTabBarHeight == DashboardWindowLayout.linkBrowserTabBarHeight)
        #expect(
            controller._testLinkBrowserToolbarHeight ==
                DashboardWindowLayout.linkBrowserToolbarWithTabsHeight)
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
        #expect(controller._testLinkBrowserTabBarIsHidden)
        #expect(controller._testLinkBrowserTabBarHeight == 0)
        #expect(controller._testLinkBrowserToolbarHeight == DashboardWindowLayout.linkBrowserToolbarHeight)
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

    @Test func `dashboard link browser opens half width and remembers resizable pane width`() throws {
        #expect(!DashboardWindowLayout.dividerMoved(from: nil, to: 100))
        #expect(!DashboardWindowLayout.dividerMoved(from: 100, to: 100))
        #expect(DashboardWindowLayout.dividerMoved(from: 100, to: 101))
        #expect(DashboardWindowLayout.linkBrowserWidth(
            splitWidth: 1241,
            dividerThickness: 1,
            persistedWidth: nil) == 620)
        #expect(DashboardWindowLayout.linkBrowserWidth(
            splitWidth: 1241,
            dividerThickness: 1,
            persistedWidth: 400) == 400)

        let defaults = UserDefaults.standard
        let key = DashboardWindowLayout.linkBrowserWidthDefaultsKey
        let originalValue = defaults.object(forKey: key)
        defaults.removeObject(forKey: key)
        defer {
            if let originalValue {
                defaults.set(originalValue, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }

        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let link = try #require(URL(string: "http://127.0.0.1:1/half-width"))
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        controller.show()
        defer { controller.closeDashboard() }
        controller.window?.setContentSize(DashboardWindowLayout.windowSize)

        controller._testOpenLinkBrowser(link)
        let openedSplitWidth = controller._testLinkBrowserSplitWidth
        let dividerThickness = controller._testLinkBrowserDividerThickness
        let openedLinkBrowserWidth = controller._testLinkBrowserWidth
        let expectedWidth = DashboardWindowLayout.linkBrowserWidth(
            splitWidth: openedSplitWidth,
            dividerThickness: dividerThickness,
            persistedWidth: nil)
        #expect(abs(openedLinkBrowserWidth - expectedWidth) < 1)
        #expect(
            openedSplitWidth - dividerThickness - openedLinkBrowserWidth >=
                DashboardWindowLayout.mainBrowserMinWidth)
        #expect(controller._testLinkBrowserMaximumThickness == NSSplitViewItem.unspecifiedDimension)

        defaults.set(Double(openedLinkBrowserWidth + 37), forKey: key)
        controller._testCompleteLinkBrowserDividerDrag()
        let resizedWidth = controller._testLinkBrowserWidth
        #expect(abs(CGFloat(defaults.double(forKey: key)) - resizedWidth) < 1)
        #expect(abs(CGFloat(defaults.double(forKey: key)) - openedLinkBrowserWidth - 37) >= 1)

        controller._testCloseLinkBrowser()
        controller.window?.setContentSize(DashboardWindowLayout.windowMinSize)
        controller._testOpenLinkBrowser(link)
        let compactExpectedWidth = DashboardWindowLayout.linkBrowserWidth(
            splitWidth: controller._testLinkBrowserSplitWidth,
            dividerThickness: controller._testLinkBrowserDividerThickness,
            persistedWidth: resizedWidth)
        #expect(abs(controller._testLinkBrowserWidth - compactExpectedWidth) < 1)
        #expect(abs(CGFloat(defaults.double(forKey: key)) - resizedWidth) < 1)

        controller._testCloseLinkBrowser()
        controller.window?.setContentSize(DashboardWindowLayout.windowSize)
        controller._testOpenLinkBrowser(link)
        let restoredExpectedWidth = DashboardWindowLayout.linkBrowserWidth(
            splitWidth: controller._testLinkBrowserSplitWidth,
            dividerThickness: controller._testLinkBrowserDividerThickness,
            persistedWidth: resizedWidth)
        #expect(abs(controller._testLinkBrowserWidth - restoredExpectedWidth) < 1)
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
        // Keep the injected titlebar height in lockstep with the 52pt unified
        // toolbar in makeWindow(); the two must match for the traffic lights and
        // the hosted web buttons to share one vertical center.
        #expect(chromeScript.source.contains("--openclaw-native-titlebar-height: 52px"))
        #expect(!chromeScript.source.contains("max-width: 1100px"))
        #expect(chromeScript.source.contains("openclaw-native-web-chrome"))
        #expect(!chromeScript.source.contains("openclaw-native-nav"))
        #expect(chromeScript.injectionTime == .atDocumentEnd)
        #expect(chromeScript.isForMainFrameOnly)
    }

    @Test func `dashboard advertises web titlebar chrome before document load`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil))
        let capabilityScript = try #require(controller._testUserScripts.first {
            $0.source.contains("__OPENCLAW_NATIVE_WEB_CHROME__")
        })

        #expect(capabilityScript.injectionTime == .atDocumentStart)
        #expect(capabilityScript.isForMainFrameOnly)
        #expect(controller.window?.titlebarAccessoryViewControllers.isEmpty == true)
        #expect(controller._testAllowsBackForwardGestures)
    }

    @Test func `dashboard javascript confirm alert maps actions`() {
        let alert = DashboardWindowController._testJavaScriptConfirmAlert(
            message: "Delete 1 session?",
            host: "127.0.0.1")

        #expect(alert.messageText == "OpenClaw Dashboard")
        #expect(alert.informativeText.contains("127.0.0.1 is asking:"))
        #expect(alert.informativeText.contains("Delete 1 session?"))
        #expect(alert.buttons.map(\.title) == ["OK", "Cancel"])
        #expect(DashboardWindowController._testJavaScriptConfirmResult(
            for: .alertFirstButtonReturn))
        #expect(!DashboardWindowController._testJavaScriptConfirmResult(
            for: .alertSecondButtonReturn))
        #expect(!DashboardWindowController._testJavaScriptConfirmResult(for: .cancel))
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
        #expect(!controller.canDeliverNativeCommands)
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

    @Test func `dashboard retires its web view while endpoint is unavailable`() async throws {
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

        let replacement = try #require(manager._testController())
        #expect(replacement !== controller)
        #expect(replacement.currentURL == URL(string: "about:blank"))
        #expect(!controller.isWindowOpen)
        #expect(!replacement._testUserScripts.elementsEqual(scriptsBefore) { $0 === $1 })
    }

    @Test func `same URL route revision recreates dashboard without prior token`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=route-a-device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "route-a-device-token",
                password: nil))
        controller.show()
        let authGate = DashboardRouteAuthGate(token: "route-a-device-token")
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in await authGate.authToken() },
            routeProbe: { await authGate.probe() })
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }
        let socketURL = try #require(URL(string: "ws://127.0.0.1:60001"))

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: socketURL,
            token: nil,
            password: nil,
            routeRevision: 1))
        let routeAController = try #require(manager._testController())
        #expect(routeAController !== controller)
        #expect(await authGate.probes() == 1)

        await authGate.replaceToken("route-b-device-token")
        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: socketURL,
            token: nil,
            password: nil,
            routeRevision: 2))

        let routeBController = try #require(manager._testController())
        #expect(routeBController !== routeAController)
        #expect(!routeAController.isWindowOpen)
        #expect(routeBController.currentURL.absoluteString ==
            "http://127.0.0.1:60001/#token=route-b-device-token")
        let scripts = routeBController._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(scripts.count == 1)
        #expect(scripts[0].source.contains("route-b-device-token"))
        #expect(!scripts[0].source.contains("route-a-device-token"))
    }

    @Test func `route change without fresh credential blanks prior dashboard`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=route-a-device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "route-a-device-token",
                password: nil))
        controller.show()
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in nil },
            routeProbe: {})
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60001")),
            token: nil,
            password: nil,
            routeRevision: 2))

        let replacement = try #require(manager._testController())
        #expect(replacement !== controller)
        #expect(!controller.isWindowOpen)
        #expect(replacement.currentURL == URL(string: "about:blank"))
        let scripts = replacement._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(!scripts.contains { $0.source.contains("route-a-device-token") })
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
