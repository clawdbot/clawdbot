import AppKit
import Foundation
import Testing
import WebKit
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

private final class DashboardWindowGestureSpy: NSWindow {
    private(set) var dragCount = 0
    private(set) var zoomCount = 0

    override func performDrag(with _: NSEvent) {
        self.dragCount += 1
    }

    override func performZoom(_: Any?) {
        self.zoomCount += 1
    }
}

@Suite(.serialized)
@MainActor
struct DashboardWindowSmokeTests {
    @Test func `dashboard frame routes single click to drag and double click to zoom`() throws {
        let window = DashboardWindowGestureSpy(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .resizable],
            backing: .buffered,
            defer: false)
        let dragRegion = DashboardWindowDragRegionView(
            frame: NSRect(x: 0, y: 0, width: 300, height: 12))
        window.contentView = dragRegion
        let mouseDownEvent: (Int) -> NSEvent? = { clickCount in
            NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: NSPoint(x: 100, y: 6),
                modifierFlags: [],
                timestamp: 0,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: clickCount,
                clickCount: clickCount,
                pressure: 1)
        }

        try dragRegion.mouseDown(with: #require(mouseDownEvent(1)))

        #expect(window.dragCount == 1)
        #expect(window.zoomCount == 0)

        try dragRegion.mouseDown(with: #require(mouseDownEvent(2)))

        #expect(window.dragCount == 1)
        #expect(window.zoomCount == 1)
    }

    @Test func `dashboard window controller shows and closes`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/control/#token=device-token")
        let windowAutosaveName = "OpenClawDashboardWindow-Test-\(UUID().uuidString)"
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/control/").absoluteString,
                token: "device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: windowAutosaveName,
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        #expect(controller.window?.styleMask.contains(.titled) == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        #expect(controller.window?.isRestorable == false)
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
        #expect(controller.window?.frameAutosaveName == windowAutosaveName)
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

    @Test func `dashboard native command queues before page load`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/control/")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })

        defer { controller.closeDashboard() }
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
            dashboardURL: dashboard,
            isMainFrame: true))
        #expect(try !DashboardWindowController.shouldAllowNavigation(
            to: #require(URL(string: "https://docs.openclaw.ai/")),
            dashboardURL: dashboard,
            isMainFrame: true))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: staleEndpoint,
            dashboardURL: dashboard,
            isMainFrame: true))
        #expect(!DashboardWindowController.shouldOpenExternalDashboardNavigation(
            staleEndpoint,
            navigationType: .backForward,
            buttonNumber: 1))
    }

    @Test func `dashboard permits only trusted ClickClack discussion subframes`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let channel = try #require(URL(string: "http://127.0.0.1:18890/embed/channel/T01/C01"))
        let thread = try #require(URL(string: "http://127.0.0.1:18890/embed/thread/T01/M01"))
        let hostnameAlias = try #require(URL(string: "http://localhost:18890/embed/channel/T01/C01"))
        let ipv6Alias = try #require(URL(string: "http://[::1]:18890/embed/thread/T01/M01"))
        let credentialedFrame = try #require(URL(string: "http://user:pass@localhost:18890/embed/channel/T01/C01"))
        let unrelatedPath = try #require(URL(string: "http://127.0.0.1:18890/admin"))
        let externalFrame = try #require(URL(string: "https://clickclack.example/embed/channel/T01/C01"))
        let externalHTTPFrame = try #require(URL(string: "http://clickclack.example/embed/thread/T01/M01"))
        let localFile = try #require(URL(string: "file:///tmp/discussion.html"))

        #expect(DashboardWindowController.shouldAllowNavigation(
            to: channel, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(DashboardWindowController.shouldAllowNavigation(
            to: thread, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(DashboardWindowController.shouldAllowNavigation(
            to: hostnameAlias, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(DashboardWindowController.shouldAllowNavigation(
            to: ipv6Alias, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(DashboardWindowController.shouldAllowNavigation(
            to: externalFrame, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(DashboardWindowController.shouldAllowNavigation(
            to: externalHTTPFrame, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: channel, dashboardURL: dashboard, isMainFrame: true))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: credentialedFrame, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: unrelatedPath, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: externalFrame, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: false))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: localFile, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
    }

    @Test func `dashboard navigation shortcuts target the focused browser`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let readerServer = try await DashboardHTTPFixture.start()
        defer { readerServer.stop() }
        let dashboard = server.url("/control/")
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        #expect(controller._testNavigationWebViewIdentity == controller._testDashboardWebViewIdentity)

        try controller.nativeBrowser.open(tabId: "mac-focused", url: readerServer.url("/docs/"))
        let readingWebView = try #require(controller.nativeBrowser.webView(for: "mac-focused"))
        try controller.nativeBrowser.present(
            scope: "focus-test", tabId: "mac-focused",
            rect: .init(x: 0, y: 0, width: 300, height: 200), visible: true)
        #expect(controller.window?.makeFirstResponder(readingWebView) == true)
        #expect(controller._testNavigationWebViewIdentity == ObjectIdentifier(readingWebView))
        #expect(controller.window?.makeFirstResponder(controller.webView) == true)
        #expect(controller._testNavigationWebViewIdentity == controller._testDashboardWebViewIdentity)
    }

    @Test func `first Mac tab requests browser import and retries until the offer completes`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let readerServer = try await DashboardHTTPFixture.start()
        defer { readerServer.stop() }
        let dashboard = server.url("/control/")
        var requestCount = 0
        var firstRequestContinuation: CheckedContinuation<Bool, Never>?
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
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

        let link = readerServer.url("/docs/")
        try controller.nativeBrowser.open(tabId: "mac-import", url: link)
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

        try controller.nativeBrowser.close(tabId: "mac-import")
        try controller.nativeBrowser.open(tabId: "mac-import", url: link)
        for _ in 0..<10 {
            await Task.yield()
        }
        #expect(requestCount == 2)
    }

    @Test func `browser import offer retries when onboarding completes with browser open`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let readerServer = try await DashboardHTTPFixture.start()
        defer { readerServer.stop() }
        let dashboard = server.url("/control/")
        let gate = DashboardBrowserImportGate()
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in gate.request() })
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        let link = readerServer.url("/docs/")
        try controller.nativeBrowser.open(tabId: "mac-import", url: link)
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

    @Test func `closing the last Mac tab invalidates an in-flight import offer`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let readerServer = try await DashboardHTTPFixture.start()
        defer { readerServer.stop() }
        let dashboard = server.url("/control/")
        var requestCount = 0
        var firstRequestContinuation: CheckedContinuation<Void, Never>?
        var firstRequestApplied: Bool?
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
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

        let link = readerServer.url("/docs/")
        try controller.nativeBrowser.open(tabId: "mac-import", url: link)
        for _ in 0..<200 where firstRequestContinuation == nil {
            await Task.yield()
        }
        #expect(requestCount == 1)

        try controller.nativeBrowser.close(tabId: "mac-import")
        firstRequestContinuation?.resume()
        for _ in 0..<200 where firstRequestApplied == nil {
            await Task.yield()
        }
        #expect(firstRequestApplied == false)

        try controller.nativeBrowser.open(tabId: "mac-import", url: link)
        for _ in 0..<200 where requestCount == 1 {
            await Task.yield()
        }
        #expect(requestCount == 2)
    }

    @Test(arguments: ["close", "invalidate", "replacement"])
    func `retiring a dashboard disposes its Mac tabs without affecting another window`(
        _ transition: String) async throws
    {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let dashboard = server.url("/control/")
        let dataStore = WKWebsiteDataStore.nonPersistent()
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: dataStore, windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let other = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: dataStore, windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { other.closeDashboard() }
        #expect(!controller.nativeBrowser.hasTabs)
        let url = server.url("/reader/first")
        try controller.nativeBrowser.open(tabId: "mac-first", url: url)
        try controller.nativeBrowser.open(tabId: "mac-second", url: server.url("/reader/second"))
        try other.nativeBrowser.open(tabId: "mac-first", url: url)
        let first = try #require(controller.nativeBrowser.webView(for: "mac-first"))
        let second = try #require(controller.nativeBrowser.webView(for: "mac-second"))
        let otherTab = try #require(other.nativeBrowser.webView(for: "mac-first"))
        #expect(first !== otherTab)
        #expect(first.configuration.websiteDataStore === dataStore)
        #expect(first.configuration.userContentController.userScripts.isEmpty)
        #expect(!first.configuration.preferences.javaScriptCanOpenWindowsAutomatically)
        #expect(first.configuration.preferences.tabFocusesLinks)
        #expect(first.navigationDelegate === controller)
        #expect(first.uiDelegate === controller)
        #expect(first.superview != nil)
        try controller.nativeBrowser.present(
            scope: "lifecycle", tabId: "mac-first",
            rect: .init(x: 0, y: 0, width: 300, height: 200), visible: true)
        #expect(!first.isHidden)

        switch transition {
        case "close": controller.closeDashboard()
        case "invalidate": controller.invalidateBrowserSession()
        default: controller.detachWindowForReplacement()?.close()
        }
        #expect(!controller.nativeBrowser.hasTabs)
        for webView in [first, second] {
            #expect(webView.superview == nil)
            #expect(webView.navigationDelegate == nil)
            #expect(webView.uiDelegate == nil)
            #expect(!controller.nativeBrowser.owns(webView))
        }
        #expect(other.nativeBrowser.webView(for: "mac-first") === otherTab)
        #expect(otherTab.superview != nil)
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
}

extension DashboardWindowSmokeTests {
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

    @Test func `dashboard native chrome clears both desktop sidebars`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/control/")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
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

    @Test func `dashboard advertises web titlebar chrome before document load`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/control/")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
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

    @Test func `dashboard failure state opens in dashboard window`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/control/")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.showFailure(
            title: "Dashboard unavailable",
            message: "Remote control tunnel failed",
            detail: "Reset the remote tunnel and try again.")
        #expect(controller.window?.isVisible == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        #expect(!controller.canDeliverNativeCommands)
        controller.closeDashboard()
    }

    private func makeShownController(server: DashboardHTTPFixture) -> DashboardWindowController {
        let url = server.url("/#token=device-token")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        controller.show()
        return controller
    }

    @Test func `dashboard follows ready endpoint to a new tunnel port`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let controller = self.makeShownController(server: server)
        let window = try #require(controller.window)
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        defer { manager.close() }

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: replacementServer.websocketURL(""),
            token: "device-token",
            password: nil))

        let replacement = try #require(manager._testController())
        #expect(replacement !== controller)
        #expect(replacement.window === window)
        #expect(window.isVisible)
        #expect(replacement.currentURL.absoluteString == replacementServer.url("/#token=device-token").absoluteString)
        let authScripts = replacement._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        // JSONSerialization escapes "/" so match on host:port, not the full origin.
        #expect(authScripts.first?.source.contains("127.0.0.1:\(replacementServer.port)") == true)
        #expect(authScripts.first?.source.contains(String(server.port)) == false)
    }

    @Test func `dashboard retires its web view while endpoint is unavailable`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let controller = self.makeShownController(server: server)
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        defer { manager.close() }
        let scriptsBefore = controller._testUserScripts

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: server.websocketURL(""),
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
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/#token=route-a-device-token")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "route-a-device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        controller.show()
        let authGate = DashboardRouteAuthGate(token: "route-a-device-token")
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in await authGate.authToken() },
            routeProbe: { purpose in
                #expect(purpose == .authentication)
                await authGate.probe()
            })
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }
        let socketURL = server.websocketURL("")

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
            server.url("/#token=route-b-device-token").absoluteString)
        let scripts = routeBController._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(scripts.count == 1)
        #expect(scripts[0].source.contains("route-b-device-token"))
        #expect(!scripts[0].source.contains("route-a-device-token"))
    }

    @Test func `route change without fresh credential blanks prior dashboard`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let url = server.url("/#token=route-a-device-token")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "route-a-device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        controller.show()
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in nil },
            routeProbe: { purpose in #expect(purpose == .authentication) })
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: server.websocketURL(""),
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
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let url = server.url("/#token=device-token")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        await manager.handleEndpointState(.ready(
            mode: .remote,
            url: replacementServer.websocketURL(""),
            token: "device-token",
            password: nil))

        #expect(controller.currentURL == url)
    }
}
