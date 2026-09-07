import AppKit
import Foundation
import WebKit

struct DashboardBrowserTabState: Codable, Equatable, Sendable {
    let id: String
    let url: String
    let title: String
    let loading: Bool
    let canGoBack: Bool
    let canGoForward: Bool
    let openedBy: String
    let openerTabId: String?
}

struct DashboardBrowserState: Codable, Equatable, Sendable {
    let revision: Int
    let tabs: [DashboardBrowserTabState]
}

/// Tabs belong to the window. A panel scope owns only its current presentation.
@MainActor
final class DashboardNativeBrowserHost {
    private struct Tab {
        let id: String
        let browser: DashboardBrowserTab
        let openedBy: String
        let openerTabId: String?
    }

    private struct Presentation {
        let tabId: String
        let rect: DashboardBrowserRect
        let order: UInt64
    }

    weak var navigationDelegate: WKNavigationDelegate? {
        didSet { self.tabs.forEach { $0.browser.webView.navigationDelegate = self.navigationDelegate } }
    }

    weak var uiDelegate: WKUIDelegate? {
        didSet { self.tabs.forEach { $0.browser.webView.uiDelegate = self.uiDelegate } }
    }

    var onOpen: (() -> Void)?
    private weak var dashboardWebView: WKWebView?
    private weak var container: NSView?
    private let websiteDataStore: WKWebsiteDataStore
    private let onStateChange: (DashboardBrowserState) -> Void
    private var tabs: [Tab] = []
    private var presentations: [String: Presentation] = [:]
    private var presentationOrder: UInt64 = 0
    private var revision = 0
    private var pushScheduled = false
    private var frameObserver: NSObjectProtocol?

    init(
        dashboardWebView: WKWebView,
        container: NSView,
        websiteDataStore: WKWebsiteDataStore,
        onStateChange: @escaping (DashboardBrowserState) -> Void)
    {
        self.dashboardWebView = dashboardWebView
        self.container = container
        self.websiteDataStore = websiteDataStore
        self.onStateChange = onStateChange
        dashboardWebView.postsFrameChangedNotifications = true
        self.frameObserver = NotificationCenter.default.addObserver(
            forName: NSView.frameDidChangeNotification, object: dashboardWebView, queue: .main)
        { [weak self] _ in
            MainActor.assumeIsolated { self?.updatePresentations() }
        }
    }

    isolated deinit {
        if let frameObserver { NotificationCenter.default.removeObserver(frameObserver) }
        self.tabs.forEach { $0.browser.dispose() }
    }

    var hasTabs: Bool {
        !self.tabs.isEmpty
    }

    var state: DashboardBrowserState {
        DashboardBrowserState(revision: self.revision, tabs: self.tabs.map { tab in
            let browser = tab.browser
            return DashboardBrowserTabState(
                id: tab.id,
                url: browser.representedURL?.absoluteString ?? browser.requestedURL.absoluteString,
                title: browser.title ?? "",
                loading: browser.webView.isLoading,
                canGoBack: browser.webView.canGoBack,
                canGoForward: browser.webView.canGoForward,
                openedBy: tab.openedBy,
                openerTabId: tab.openerTabId)
        })
    }

    func owns(_ webView: WKWebView) -> Bool {
        self.tabs.contains { $0.browser.webView === webView }
    }

    func browserTab(for webView: WKWebView) -> DashboardBrowserTab? {
        self.tabs.first { $0.browser.webView === webView }?.browser
    }

    func webView(for tabId: String) -> WKWebView? {
        self.tabs.first { $0.id == tabId }?.browser.webView
    }

    @discardableResult
    func open(tabId: String, url: URL) throws -> String {
        let requestedURL = try DashboardBrowserMessageHandler.url(url.absoluteString)
        // Prefer the page currently at this URL over another tab's initial redirect alias.
        // An explicit blank new tab must never collapse onto an existing blank tab.
        if requestedURL.absoluteString != "about:blank",
           let existing = self.tabs.first(where: { $0.browser.representedURL == requestedURL }) ??
           self.tabs.first(where: { $0.browser.requestedURLAlias == requestedURL })
        {
            self.onOpen?()
            self.scheduleStatePush()
            return existing.id
        }
        try self.createTab(tabId: tabId, url: requestedURL, openedBy: "web", openerTabId: nil)
        return tabId
    }

    private func createTab(tabId: String, url: URL, openedBy: String, openerTabId: String?) throws {
        guard self.webView(for: tabId) == nil else { throw DashboardBrowserError.duplicateTab }
        guard let container, let dashboardWebView else { throw DashboardBrowserError.unavailable }
        let browser = DashboardBrowserTab(websiteDataStore: self.websiteDataStore, requestedURL: url)
        browser.webView.navigationDelegate = self.navigationDelegate
        browser.webView.uiDelegate = self.uiDelegate
        browser.webView.isHidden = true
        container.addSubview(browser.webView, positioned: .above, relativeTo: dashboardWebView)
        self.tabs.append(Tab(id: tabId, browser: browser, openedBy: openedBy, openerTabId: openerTabId))
        browser.observeNavigationState { [weak self, weak browser] in
            guard let self, let browser, self.owns(browser.webView) else { return }
            self.scheduleStatePush()
        }
        self.scheduleStatePush()
        self.onOpen?()
        browser.webView.load(URLRequest(url: url))
    }

    func navigate(tabId: String, url: URL) throws {
        _ = try DashboardBrowserMessageHandler.url(url.absoluteString)
        let webView = try self.requireWebView(tabId)
        webView.load(URLRequest(url: url))
    }

    func perform(_ action: DashboardBrowserAction, tabId: String) throws {
        let webView = try self.requireWebView(tabId)
        switch action {
        case .back: webView.goBack()
        case .forward: webView.goForward()
        case .reload: webView.reload()
        case .stop: webView.stopLoading()
        case .close: try self.close(tabId: tabId)
        case .snapshot: throw DashboardBrowserError.invalidRequest
        }
        self.scheduleStatePush()
    }

    func close(tabId: String) throws {
        guard let index = self.tabs.firstIndex(where: { $0.id == tabId }) else {
            throw DashboardBrowserError.unknownTab
        }
        self.tabs.remove(at: index).browser.dispose()
        self.presentations = self.presentations.filter { $0.value.tabId != tabId }
        self.updatePresentations()
        self.scheduleStatePush()
    }

    func present(scope: String, tabId: String?, rect: DashboardBrowserRect?, visible: Bool) throws {
        if visible, let tabId, let rect {
            _ = try self.requireWebView(tabId)
            self.presentationOrder &+= 1
            self.presentations[scope] = Presentation(tabId: tabId, rect: rect, order: self.presentationOrder)
        } else {
            self.presentations.removeValue(forKey: scope)
        }
        self.updatePresentations()
    }

    func releaseScope(_ scope: String) {
        self.presentations.removeValue(forKey: scope)
        self.updatePresentations()
    }

    func releaseAllScopes() {
        self.presentations.removeAll()
        self.updatePresentations()
    }

    func openNewWindow(_ url: URL, opener: WKWebView) {
        guard let tab = self.tabs.first(where: { $0.browser.webView === opener }),
              let requestedURL = try? DashboardBrowserMessageHandler.url(url.absoluteString)
        else { return }
        try? self.createTab(
            tabId: "mac-" + UUID().uuidString, url: requestedURL, openedBy: "native", openerTabId: tab.id)
    }

    func navigationWillStart(_ url: URL, in webView: WKWebView) {
        self.tabs.first { $0.browser.webView === webView }?.browser.updateRepresentedURL(url)
        self.scheduleStatePush()
    }

    func navigationDidStart(_ navigation: WKNavigation?, in webView: WKWebView) {
        if let navigation {
            self.tabs.first { $0.browser.webView === webView }?.browser.startNavigation(navigation)
        }
        self.scheduleStatePush()
    }

    func navigationDidFinish(_ navigation: WKNavigation?, for webView: WKWebView) {
        self.tabs.first { $0.browser.webView === webView }?.browser.finishNavigation(
            navigation, at: webView.url, title: webView.title)
        self.scheduleStatePush()
    }

    func navigationDidFail(for webView: WKWebView) {
        self.tabs.first { $0.browser.webView === webView }?.browser.failNavigation()
        self.scheduleStatePush()
    }

    func dispose() {
        self.releaseAllScopes()
        self.tabs.forEach { $0.browser.dispose() }
        self.tabs.removeAll()
        self.scheduleStatePush()
    }

    func scheduleStatePush() {
        guard !self.pushScheduled else { return }
        self.pushScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pushScheduled = false
            self.revision += 1
            self.onStateChange(self.state)
        }
    }

    nonisolated static func mappedFrame(rect: DashboardBrowserRect, dashboardFrame: CGRect) -> CGRect {
        guard rect.x.isFinite, rect.y.isFinite, rect.width.isFinite, rect.height.isFinite,
              rect.width > 0, rect.height > 0 else { return .zero }
        let frame = CGRect(
            x: dashboardFrame.minX + rect.x,
            y: dashboardFrame.maxY - rect.y - rect.height,
            width: rect.width,
            height: rect.height).intersection(dashboardFrame)
        return frame.isNull || frame.isEmpty ? .zero : frame
    }

    private func updatePresentations() {
        guard let dashboardWebView else { return }
        for tab in self.tabs {
            // One WKWebView cannot be in two scopes: the newest presenter wins.
            // Releasing it restores the older scope if that scope is still visible.
            let presentation = self.presentations.values.filter { $0.tabId == tab.id }.max { $0.order < $1.order }
            guard let presentation else {
                tab.browser.webView.isHidden = true
                continue
            }
            let frame = Self.mappedFrame(rect: presentation.rect, dashboardFrame: dashboardWebView.frame)
            tab.browser.webView.frame = frame
            tab.browser.webView.isHidden = frame.isEmpty
        }
    }

    private func requireWebView(_ tabId: String) throws -> WKWebView {
        guard let webView = self.webView(for: tabId) else { throw DashboardBrowserError.unknownTab }
        return webView
    }
}

extension DashboardNativeBrowserHost {
    func snapshot(tabId: String) async throws -> [String: Any] {
        let webView = try self.requireWebView(tabId)
        let size = webView.bounds.size
        guard size.width > 0, size.height > 0 else { throw DashboardBrowserError.captureFailed }
        let image = try await webView.takeSnapshot(configuration: nil)
        guard self.webView(for: tabId) === webView,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else { throw DashboardBrowserError.captureFailed }
        return [
            "ok": true,
            "dataUrl": "data:image/png;base64," + png.base64EncodedString(),
            "cssWidth": size.width,
            "cssHeight": size.height,
        ]
    }

    func inspect(tabId: String, x: Double, y: Double) async throws -> [String: Any] {
        let webView = try self.requireWebView(tabId)
        guard x.isFinite, y.isFinite, x >= 0, y >= 0 else { throw DashboardBrowserError.invalidRequest }
        let script = BrowserInspectScript.source
        let node = try await webView.evaluateJavaScript("(\(script))(\(x), \(y))")
        guard self.webView(for: tabId) === webView else { throw DashboardBrowserError.unknownTab }
        return ["ok": true, "node": node ?? NSNull()]
    }
}
