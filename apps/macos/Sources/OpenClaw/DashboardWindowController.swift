import AppKit
import Foundation
import WebKit

private final class DashboardWindowContentView: NSView {
    override var mouseDownCanMoveWindow: Bool {
        true
    }
}

/// The dashboard's empty unified toolbar exists only to grow the titlebar to
/// 52pt so the traffic lights align with the hosted web chrome. `View > Hide
/// Toolbar` (and ⌥⌘T) would collapse the titlebar while the web inset stays
/// pinned at `--openclaw-native-titlebar-height`, resurrecting the traffic-light
/// misalignment. Refusing the toggle keeps the two heights in lockstep.
private final class DashboardWindow: NSWindow {
    override func toggleToolbarShown(_: Any?) {}

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(NSWindow.toggleToolbarShown(_:)) { return false }
        return super.validateUserInterfaceItem(item)
    }
}

private final class DashboardWindowDragRegionView: NSView {
    override var mouseDownCanMoveWindow: Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

@MainActor
private final class DashboardLinkMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardWindowController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        self.owner?.receiveLinkMessage(message)
    }
}

@MainActor
private final class DashboardWindowDragMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardWindowController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        self.owner?.receiveWindowDragMessage(message)
    }
}

@MainActor
private final class DashboardUpdateMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardWindowController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        self.owner?.receiveUpdateMessage(message)
    }
}

@MainActor
final class DashboardWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    private static let linkMessageHandlerName = "openclawLink"
    private static let windowDragMessageHandlerName = "openclawWindowDrag"
    private static let updateMessageHandlerName = "openclawUpdate"

    private let webView: WKWebView
    private let linkBrowser: DashboardLinkBrowserView
    private let linkBrowserItem: NSSplitViewItem
    private let splitViewController: NSSplitViewController
    private let updateMessageHandler: DashboardUpdateMessageHandler
    private(set) var currentURL: URL
    private var auth: DashboardWindowAuth
    private let updater: UpdaterProviding?
    private var updateBridgeEnabled: Bool
    private let requestBrowserProfileImportOffer:
        @MainActor (@escaping @MainActor () -> Bool) async -> Bool
    private var canGoBackObservation: NSKeyValueObservation?
    private var canGoForwardObservation: NSKeyValueObservation?
    private var didRequestBrowserProfileImportOffer = false
    private var browserProfileImportOfferIsArmed = false
    private var browserProfileImportOfferRequestIsInFlight = false
    private var browserProfileImportOfferRetryPending = false

    init(
        url: URL,
        auth: DashboardWindowAuth,
        updater: UpdaterProviding? = nil,
        updateBridgeEnabled: Bool = true,
        requestBrowserProfileImportOffer:
        @escaping @MainActor (@escaping @MainActor () -> Bool) async -> Bool = { shouldApply in
            await BrowserProfileImportModel.shared.requestAutomaticOfferIfEligible(while: shouldApply)
        })
    {
        let shouldEnableUpdateBridge = updater?.isAvailable == true && updateBridgeEnabled
        self.currentURL = url
        self.auth = auth
        self.updater = updater
        self.updateBridgeEnabled = shouldEnableUpdateBridge
        self.requestBrowserProfileImportOffer = requestBrowserProfileImportOffer

        let dataStore = WKWebsiteDataStore.default()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController = WKUserContentController()
        let linkMessageHandler = DashboardLinkMessageHandler()
        config.userContentController.add(linkMessageHandler, name: Self.linkMessageHandlerName)
        let windowDragMessageHandler = DashboardWindowDragMessageHandler()
        config.userContentController.add(windowDragMessageHandler, name: Self.windowDragMessageHandlerName)
        let updateMessageHandler = DashboardUpdateMessageHandler()
        self.updateMessageHandler = updateMessageHandler
        if shouldEnableUpdateBridge {
            // Handler presence is the Control UI feature probe; unsigned builds
            // and remote dashboards must not advertise a local app update.
            config.userContentController.add(updateMessageHandler, name: Self.updateMessageHandlerName)
        }
        Self.installNativeChromeScript(into: config.userContentController)
        Self.installNativeAuthScript(into: config.userContentController, url: url, auth: auth)

        self.webView = WKWebView(
            frame: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize),
            configuration: config)
        self.webView.setValue(true, forKey: "drawsBackground")
        // The Control UI routes via pushState, so WKWebView's back-forward list
        // carries in-app navigation; the web titlebar buttons use this list.
        self.webView.allowsBackForwardNavigationGestures = true

        let linkBrowser = DashboardLinkBrowserView(websiteDataStore: dataStore)
        let splitViewController = NSSplitViewController()
        splitViewController.splitView.isVertical = true
        splitViewController.splitView.dividerStyle = .thin
        splitViewController.splitView.autosaveName = DashboardWindowLayout.linkBrowserSplitAutosaveName

        let dashboardViewController = NSViewController()
        dashboardViewController.view = BrowserProfileImportBannerView.makeDashboardPane(webView: self.webView)
        let dashboardItem = NSSplitViewItem(viewController: dashboardViewController)
        dashboardItem.minimumThickness = DashboardWindowLayout.mainBrowserMinWidth

        let linkBrowserViewController = NSViewController()
        linkBrowserViewController.view = linkBrowser
        let linkBrowserItem = NSSplitViewItem(viewController: linkBrowserViewController)
        linkBrowserItem.minimumThickness = DashboardWindowLayout.linkBrowserMinWidth
        linkBrowserItem.maximumThickness = DashboardWindowLayout.linkBrowserMaxWidth
        linkBrowserItem.preferredThicknessFraction = DashboardWindowLayout.linkBrowserPreferredFraction
        // Keep the sidebar width stable while staying below AppKit's divider-drag
        // priority; the dashboard absorbs window resizing first.
        linkBrowserItem.holdingPriority = NSLayoutConstraint.Priority(rawValue: 251)
        linkBrowserItem.canCollapse = true
        linkBrowserItem.isCollapsed = true

        splitViewController.addSplitViewItem(dashboardItem)
        splitViewController.addSplitViewItem(linkBrowserItem)

        self.linkBrowser = linkBrowser
        self.linkBrowserItem = linkBrowserItem
        self.splitViewController = splitViewController

        let window = Self.makeWindow(contentView: splitViewController.view)
        super.init(window: window)

        // Width is autosaved, while each new dashboard window starts with the
        // optional browser collapsed until a link explicitly opens it.
        self.linkBrowserItem.isCollapsed = true
        linkMessageHandler.owner = self
        windowDragMessageHandler.owner = self
        updateMessageHandler.owner = self
        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        self.linkBrowser.webViewNavigationDelegate = self
        self.linkBrowser.webViewUIDelegate = self
        self.linkBrowser.onClose = { [weak self] in self?.closeLinkBrowser() }
        self.linkBrowser.onOpenExternal = { [weak self] url in self?.openExternal(url) }
        self.window?.delegate = self
        self.installHistoryStateBridge()
    }

    func setUpdateBridgeEnabled(_ enabled: Bool) {
        let nextEnabled = self.updater?.isAvailable == true && enabled
        guard nextEnabled != self.updateBridgeEnabled else { return }
        self.updateBridgeEnabled = nextEnabled
        let controller = self.webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.updateMessageHandlerName)
        if nextEnabled {
            controller.add(self.updateMessageHandler, name: Self.updateMessageHandlerName)
        }
    }

    // MARK: - WKUIDelegate

    /// Bridges JavaScript `window.confirm` calls in the embedded Control UI to a
    /// native confirmation sheet; without this callback, WebKit treats every
    /// confirm as Cancel and destructive dashboard actions silently stop.
    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void)
    {
        guard webView === self.webView || self.linkBrowser.owns(webView) else {
            completionHandler(false)
            return
        }
        let alert = Self.makeJavaScriptConfirmAlert(
            message: message,
            host: frame.request.url?.host)
        if let window {
            alert.beginSheetModal(for: window) { response in
                completionHandler(Self.javaScriptConfirmResult(for: response))
            }
            return
        }
        completionHandler(Self.javaScriptConfirmResult(for: alert.runModal()))
    }

    /// Bridges `<input type="file">` clicks in the embedded Control UI to a native
    /// `NSOpenPanel`; without a `WKUIDelegate`, WebKit silently drops the request
    /// and "Choose image" / file-picker buttons do nothing.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame _: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void)
    {
        guard webView === self.webView || self.linkBrowser.owns(webView) else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        if let window {
            panel.beginSheetModal(for: window) { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
            return
        }
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith _: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures _: WKWindowFeatures) -> WKWebView?
    {
        // WebKit reaches this callback only for user-allowed new-window requests;
        // every configuration disables automatic JavaScript windows.
        guard navigationAction.targetFrame == nil,
              webView === self.webView || self.linkBrowser.owns(webView)
        else {
            return nil
        }
        // Sidebar target=_blank links become tabs; dashboard requests preserve
        // the existing handoff to the default browser.
        switch Self.newWindowAction(
            for: navigationAction.request.url,
            sourceIsLinkBrowser: self.linkBrowser.owns(webView))
        {
        case let .openTab(url):
            self.linkBrowser.openInNewTab(url)
        case let .openExternal(url):
            self.openExternal(url)
        case .ignore:
            break
        }
        return nil
    }

    private static func makeJavaScriptConfirmAlert(message: String, host: String?) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "OpenClaw Dashboard"
        if let host, !host.isEmpty {
            alert.informativeText = "\(host) is asking:\n\n\(message)"
        } else {
            alert.informativeText = message
        }
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert
    }

    private static func javaScriptConfirmResult(
        for response: NSApplication.ModalResponse)
        -> Bool
    {
        response == .alertFirstButtonReturn
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(url: URL, auth: DashboardWindowAuth, updateBridgeEnabled: Bool? = nil) {
        self.update(url: url, auth: auth, updateBridgeEnabled: updateBridgeEnabled)
        self.show()
    }

    /// Swap the dashboard to a new gateway endpoint without reordering the window:
    /// re-injects the native auth script for the new origin and reloads. Used when
    /// the remote tunnel is recreated on a new local port while the window stays
    /// open; ordering the window front here would steal focus on background
    /// tunnel recreation.
    func update(url: URL, auth: DashboardWindowAuth, updateBridgeEnabled: Bool? = nil) {
        self.currentURL = url
        self.auth = auth
        self.refreshNativeAuthScript(url: url, auth: auth)
        if let updateBridgeEnabled {
            self.setUpdateBridgeEnabled(updateBridgeEnabled)
        }
        self.load(url)
        self.requestBrowserProfileImportOfferIfNeeded()
    }

    /// Miniaturized windows report `isVisible == false` but must still follow
    /// endpoint changes so deminiaturizing does not land on a dead port.
    var isWindowOpen: Bool {
        guard let window else { return false }
        return window.isVisible || window.isMiniaturized
    }

    func show() {
        if let window {
            let frame = window.frame
            if frame.width < DashboardWindowLayout.windowMinSize.width ||
                frame.height < DashboardWindowLayout.windowMinSize.height
            {
                window.setFrame(WindowPlacement.centeredFrame(size: DashboardWindowLayout.windowSize), display: false)
            }
        }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(self.webView)
        window?.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func closeDashboard() {
        window?.performClose(nil)
    }

    func showFailure(title: String, message: String, detail: String? = nil) {
        self.currentURL = URL(string: "about:blank")!
        self.auth = DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        self.setUpdateBridgeEnabled(false)
        self.refreshNativeAuthScript(url: self.currentURL, auth: self.auth)
        self.webView.stopLoading()
        self.webView.loadHTMLString(
            DashboardFailurePage.html(title: title, message: message, detail: detail, url: nil),
            baseURL: nil)
        self.show()
    }

    private func load(_ url: URL) {
        dashboardWindowLogger.debug("dashboard load \(dashboardLogString(for: url), privacy: .public)")
        self.webView.load(URLRequest(url: url))
    }

    private func openLinkBrowser(_ url: URL, requestBrowserProfileImportOffer: Bool = true) {
        self.linkBrowserItem.isCollapsed = false
        self.linkBrowser.open(url)
        window?.makeFirstResponder(self.linkBrowser.activeWebView)
        if requestBrowserProfileImportOffer {
            self.browserProfileImportOfferIsArmed = true
            self.requestBrowserProfileImportOfferIfNeeded()
        }
    }

    private func requestBrowserProfileImportOfferIfNeeded() {
        guard self.browserProfileImportOfferIsArmed,
              !self.linkBrowserItem.isCollapsed,
              !self.didRequestBrowserProfileImportOffer
        else { return }
        if self.browserProfileImportOfferRequestIsInFlight {
            // Gateway readiness can arrive while the status poll awaits transport.
            // Latch one retry so in-flight dedupe does not discard that reconnect signal.
            self.browserProfileImportOfferRetryPending = true
            return
        }
        self.browserProfileImportOfferRequestIsInFlight = true
        Task { [weak self] in
            guard let self else { return }
            let didApply = await self.requestBrowserProfileImportOffer { [weak self] in
                guard let self else { return false }
                return self.browserProfileImportOfferIsArmed &&
                    !self.linkBrowserItem.isCollapsed &&
                    !self.didRequestBrowserProfileImportOffer
            }
            self.browserProfileImportOfferRequestIsInFlight = false
            let shouldRetry = self.browserProfileImportOfferRetryPending && !didApply
            self.browserProfileImportOfferRetryPending = false
            if didApply {
                self.didRequestBrowserProfileImportOffer = true
            } else if shouldRetry {
                self.requestBrowserProfileImportOfferIfNeeded()
            }
        }
    }

    func handleOnboardingCompletion() {
        // A pre-onboarding inline browser leaves the one-shot armed. Retry at
        // the eligibility transition so it does not depend on later navigation.
        self.requestBrowserProfileImportOfferIfNeeded()
    }

    private func closeLinkBrowser(focusDashboard: Bool = true) {
        self.linkBrowser.closeBrowser()
        self.linkBrowserItem.isCollapsed = true
        if focusDashboard {
            window?.makeFirstResponder(self.webView)
        }
    }

    private func openExternal(_ url: URL) {
        guard Self.isExternalURL(url) || Self.isEditorURL(url) else { return }
        NSWorkspace.shared.open(url)
    }

    fileprivate func receiveLinkMessage(_ message: WKScriptMessage) {
        // The page-world handler is privileged. Accept only the main frame of
        // the current Control UI path; the sibling browser never receives it.
        guard message.name == Self.linkMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              let request = Self.linkRequest(from: message.body)
        else {
            return
        }

        switch request.target {
        case .inline:
            self.openLinkBrowser(request.url)
        case .external:
            self.openExternal(request.url)
        }
    }

    /// The Control UI posts this from mousedown on passive pane-header chrome
    /// (split-view session titles). WKWebView swallows titlebar-style drags, so
    /// the web side asks the window to take over the in-flight mouse gesture.
    fileprivate func receiveWindowDragMessage(_ message: WKScriptMessage) {
        guard message.name == Self.windowDragMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              Self.isWindowDragRequest(message.body),
              let window
        else {
            return
        }
        // The script message arrives async; during a press the app's current
        // event is still the initiating left-mouse-down (or a later drag). A
        // finished click leaves left-mouse-up here and starts no drag.
        guard let event = NSApp.currentEvent,
              event.type == .leftMouseDown || event.type == .leftMouseDragged,
              event.window === window
        else {
            return
        }
        window.performDrag(with: event)
    }

    static func isWindowDragRequest(_ body: Any) -> Bool {
        guard let payload = body as? [String: Any] else { return false }
        return payload["type"] as? String == "window-drag"
    }

    fileprivate func receiveUpdateMessage(_ message: WKScriptMessage) {
        guard message.name == Self.updateMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              Self.isStartUpdateRequest(message.body),
              let updater = self.updater
        else {
            return
        }
        // Eligibility is cached at window setup, but update.channel or launchd
        // ownership can change while the dashboard stays open. Revalidate here.
        guard DashboardManager.updateBridgeEnabled(mode: AppStateStore.shared.connectionMode) else {
            self.setUpdateBridgeEnabled(false)
            // JS treated its posted message as handled; return this click to
            // the gateway updater after withdrawing the native bridge.
            self.webView.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('openclaw:native-update-declined'))")
            return
        }
        updater.checkForUpdates(nil)
    }

    static func isStartUpdateRequest(_ body: Any) -> Bool {
        guard let payload = body as? [String: Any] else { return false }
        return payload["type"] as? String == "start-update"
    }

    static func linkRequest(from body: Any) -> DashboardLinkRequest? {
        guard let payload = body as? [String: Any],
              payload["type"] as? String == "open-link",
              let rawURL = payload["url"] as? String,
              let url = URL(string: rawURL),
              let rawTarget = payload["target"] as? String,
              let target = DashboardLinkTarget(rawValue: rawTarget)
        else {
            return nil
        }
        switch target {
        case .inline:
            guard self.isHTTPURL(url) else { return nil }
        case .external:
            guard self.isExternalURL(url) else { return nil }
        }
        return DashboardLinkRequest(url: url, target: target)
    }

    static func isTrustedLinkSource(_ sourceURL: URL?, dashboardURL: URL) -> Bool {
        guard let sourceURL, sameOrigin(sourceURL, dashboardURL) else { return false }
        let allowedPath = Self.allowedPath(for: dashboardURL)
        return allowedPath == "/" || sourceURL.path.hasPrefix(allowedPath)
    }

    static func shouldAllowEditorURLLaunch(
        from sourceURL: URL?,
        isMainFrame: Bool,
        dashboardURL: URL) -> Bool
    {
        isMainFrame && self.isTrustedLinkSource(sourceURL, dashboardURL: dashboardURL)
    }

    private static func isHTTPURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else {
            return false
        }
        return true
    }

    private static func isExternalURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "http" || scheme == "https" {
            return self.isHTTPURL(url)
        }
        return scheme == "mailto" || scheme == "tel"
    }

    private static func isEditorURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              url.host?.lowercased() == "file",
              !url.path.isEmpty
        else {
            return false
        }
        return scheme == "cursor" || scheme == "vscode" || scheme == "windsurf" || scheme == "zed"
    }

    private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme?.lowercased() == rhs.scheme?.lowercased() &&
            lhs.host?.lowercased() == rhs.host?.lowercased() &&
            lhs.port == rhs.port
    }

    private func refreshNativeAuthScript(url: URL, auth: DashboardWindowAuth) {
        let controller = self.webView.configuration.userContentController
        controller.removeAllUserScripts()
        Self.installNativeChromeScript(into: controller)
        Self.installNativeAuthScript(into: controller, url: url, auth: auth)
    }

    private func installHistoryStateBridge() {
        self.canGoBackObservation = self.webView.observe(\.canGoBack, options: [
            .initial,
            .new,
        ]) { [weak self] _, _ in
            Task { @MainActor in
                self?.publishNativeHistoryState()
            }
        }
        self.canGoForwardObservation = self.webView.observe(\.canGoForward, options: [
            .initial,
            .new,
        ]) { [weak self] _, _ in
            Task { @MainActor in
                self?.publishNativeHistoryState()
            }
        }
    }

    private func publishNativeHistoryState() {
        let canGoBack = self.webView.canGoBack ? "true" : "false"
        let canGoForward = self.webView.canGoForward ? "true" : "false"
        self.webView.evaluateJavaScript(
            """
            window.__OPENCLAW_NATIVE_HISTORY__ = {canGoBack:\(canGoBack),canGoForward:\(canGoForward)};
            window.dispatchEvent(new CustomEvent('openclaw:native-history-state', \
            {detail:window.__OPENCLAW_NATIVE_HISTORY__}));
            """)
    }

    func navigateBack() {
        self.activeNavigationWebView.goBack()
    }

    func navigateForward() {
        self.activeNavigationWebView.goForward()
    }

    private var activeNavigationWebView: WKWebView {
        guard let linkWebView = self.linkBrowser.activeWebView,
              let firstResponder = self.window?.firstResponder as? NSView,
              firstResponder === linkWebView || firstResponder.isDescendant(of: linkWebView)
        else {
            return self.webView
        }
        return linkWebView
    }

    private static func makeWindow(contentView: NSView) -> NSWindow {
        let window = DashboardWindow(
            contentRect: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        let container = DashboardWindowContentView(frame: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize))
        contentView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(contentView)
        let topDragRegion = DashboardWindowDragRegionView()
        topDragRegion.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(topDragRegion)
        let topRightDragRegion = DashboardWindowDragRegionView()
        topRightDragRegion.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(topRightDragRegion)
        NSLayoutConstraint.activate([
            contentView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            contentView.topAnchor.constraint(equalTo: container.topAnchor),
            contentView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            topDragRegion.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 78),
            topDragRegion.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -380),
            topDragRegion.topAnchor.constraint(equalTo: container.topAnchor),
            // Thin edge strip only: the web UI has no desktop topbar row, so a
            // taller region would swallow clicks meant for the top of the
            // content column (chat thread, page headers). The web titlebar
            // toolbar owns the larger drag surface beside the traffic lights.
            topDragRegion.heightAnchor.constraint(equalToConstant: 12),
            topRightDragRegion.leadingAnchor.constraint(equalTo: topDragRegion.trailingAnchor),
            topRightDragRegion.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            topRightDragRegion.topAnchor.constraint(equalTo: container.topAnchor),
            topRightDragRegion.heightAnchor.constraint(equalToConstant: 6),
        ])
        window.title = "OpenClaw"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // An empty unified toolbar grows the transparent titlebar to 52pt so the
        // traffic lights sit vertically centered against the web titlebar row
        // (--openclaw-native-titlebar-height); without it they hug the top edge.
        window.toolbar = NSToolbar(identifier: "DashboardWindowTitlebar")
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.hasShadow = true
        window.backgroundColor = .windowBackgroundColor
        window.isOpaque = true
        let viewController = NSViewController()
        viewController.view = container
        window.contentViewController = viewController
        window.center()
        window.minSize = DashboardWindowLayout.windowMinSize
        WindowPlacement.ensureOnScreen(window: window, defaultSize: DashboardWindowLayout.windowSize)
        return window
    }

    private static func installNativeChromeScript(into userContentController: WKUserContentController) {
        // Deliberately no native fallback for pages that ignore this flag
        // (older gateway bundles, failure pages): they keep their own in-page
        // toggles plus back/forward gestures and the Cmd-[/] menu items.
        let capabilityScript = "window.__OPENCLAW_NATIVE_WEB_CHROME__ = true;"
        userContentController.addUserScript(
            WKUserScript(source: capabilityScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Narrow widths need no rules here: the Control UI's own
        // `html.openclaw-native-macos` styles fold the titlebar clearance into
        // the drawer topbar row (layout.mobile.css); their body-qualified
        // !important selectors also outrank the rules older app builds inject.
        let css = """
        html.openclaw-native-macos {
          /* Matches the 52pt unified-toolbar titlebar so the web buttons and the
             traffic lights share one vertical center. */
          --openclaw-native-titlebar-height: 52px;
        }
        @media (min-width: 700px) {
          /* Both desktop navigation surfaces must clear AppKit's window controls
             and drag regions or their first interactive row becomes unreachable. */
          html.openclaw-native-macos .sidebar-shell,
          html.openclaw-native-macos .settings-sidebar__header {
            padding-top: max(14px, var(--openclaw-native-titlebar-height)) !important;
          }
        }
        """
        let script = """
        (() => {
          try {
            if (document.getElementById("openclaw-native-macos-chrome")) return;
            const style = document.createElement("style");
            style.id = "openclaw-native-macos-chrome";
            style.textContent = \(Self.jsStringLiteral(css));
            document.documentElement.classList.add("openclaw-native-macos", "openclaw-native-web-chrome");
            document.head.appendChild(style);
          } catch {}
        })();
        """
        userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    private static func installNativeAuthScript(
        into userContentController: WKUserContentController,
        url: URL,
        auth: DashboardWindowAuth)
    {
        guard auth.hasCredential else { return }
        let allowedOrigin = self.originString(for: url)
        let allowedPath = self.allowedPath(for: url)
        let payload: [String: Any?] = [
            "gatewayUrl": auth.gatewayUrl,
            "token": auth.token,
            "password": auth.password,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 }),
              let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        let script = """
        (() => {
          try {
            const allowedOrigin = \(Self.jsStringLiteral(allowedOrigin));
            const allowedPath = \(Self.jsStringLiteral(allowedPath));
            if (location.origin !== allowedOrigin) return;
            if (allowedPath !== "/" && !location.pathname.startsWith(allowedPath)) return;
            Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
              value: \(json),
              configurable: true,
            });
          } catch {}
        })();
        """
        userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    static func originString(for url: URL) -> String {
        guard let scheme = url.scheme, let host = url.host else { return "" }
        let hostPart = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        var out = "\(scheme)://\(hostPart)"
        if let port = url.port {
            out += ":\(port)"
        }
        return out
    }

    static func allowedPath(for url: URL) -> String {
        let path = url.path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return "/" }
        return path.hasSuffix("/") ? path : path + "/"
    }

    private static func jsStringLiteral(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let raw = String(data: data, encoding: .utf8),
              raw.hasPrefix("["),
              raw.hasSuffix("]")
        else {
            return "\"\""
        }
        return String(raw.dropFirst().dropLast())
    }

    static func shouldAllowNavigation(to url: URL, dashboardURL: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if scheme == "about" || scheme == "blob" || scheme == "data" {
            return true
        }
        guard scheme == "http" || scheme == "https" else { return false }
        return url.scheme?.lowercased() == dashboardURL.scheme?.lowercased() &&
            url.host?.lowercased() == dashboardURL.host?.lowercased() &&
            url.port == dashboardURL.port
    }

    static func shouldAllowBrowserNavigation(to url: URL, isMainFrame: Bool) -> Bool {
        if isMainFrame {
            return self.isHTTPURL(url)
        }
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "about" || scheme == "blob" || scheme == "data" || self.isHTTPURL(url)
    }

    static func shouldOpenExternalDashboardNavigation(
        _ url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int) -> Bool
    {
        // WebKit also labels synthetic anchor.click() as linkActivated. Its
        // action reports button 0; a physical primary click reports 1 here.
        navigationType == .linkActivated && buttonNumber > 0 && self.isExternalURL(url)
    }

    static func targetlessNavigationAction(
        for url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int,
        allowEditorURLs: Bool) -> DashboardTargetlessNavigationAction
    {
        if self.isHTTPURL(url) {
            return .allow
        }
        // The trusted Control UI's file sidebar opens these explicit editor URLs
        // with window.open(); never grant the same synthetic-launch path to web content.
        if allowEditorURLs, self.isEditorURL(url) {
            return .openExternal
        }
        if self.shouldOpenExternalDashboardNavigation(
            url,
            navigationType: navigationType,
            buttonNumber: buttonNumber)
        {
            return .openExternal
        }
        return .cancel
    }

    static func newWindowAction(for url: URL?, sourceIsLinkBrowser: Bool) -> DashboardNewWindowAction {
        guard let url, self.isHTTPURL(url) else { return .ignore }
        return sourceIsLinkBrowser ? .openTab(url) : .openExternal(url)
    }

    func windowWillClose(_: Notification) {
        self.webView.stopLoading()
        self.closeLinkBrowser(focusDashboard: false)
    }

    private func showLoadFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            return
        }
        dashboardWindowLogger.error(
            """
            dashboard load failed url=\(dashboardLogString(for: self.currentURL), privacy: .public) \
            error=\(error.localizedDescription, privacy: .public)
            """)
        let html = DashboardFailurePage.html(
            title: "Dashboard unavailable",
            message: error.localizedDescription,
            detail: "The dashboard window is open, but the web UI could not load from this endpoint.",
            url: self.currentURL)
        self.webView.loadHTMLString(html, baseURL: nil)
    }
}

/// WKNavigationDelegate policy lives in an extension to keep the class
/// body inside the swiftlint type_body_length budget.
extension DashboardWindowController {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        let isDashboardWebView = webView === self.webView
        let isLinkBrowserWebView = self.linkBrowser.owns(webView)
        guard isDashboardWebView || isLinkBrowserWebView else {
            decisionHandler(.cancel)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(isDashboardWebView ? .allow : .cancel)
            return
        }
        if isLinkBrowserWebView {
            // The lightweight sidebar has no download destination UI. Preserve
            // direct pointer-activated downloads by handing them to the default browser.
            if navigationAction.shouldPerformDownload {
                if Self.shouldOpenExternalDashboardNavigation(
                    url,
                    navigationType: navigationAction.navigationType,
                    buttonNumber: navigationAction.buttonNumber)
                {
                    self.openExternal(url)
                }
                decisionHandler(.cancel)
                return
            }
            if navigationAction.targetFrame == nil {
                self.decideTargetlessNavigation(
                    url,
                    navigationType: navigationAction.navigationType,
                    buttonNumber: navigationAction.buttonNumber,
                    allowEditorURLs: false,
                    decisionHandler: decisionHandler)
                return
            }
            let isMainFrame = navigationAction.targetFrame?.isMainFrame == true
            if Self.shouldAllowBrowserNavigation(to: url, isMainFrame: isMainFrame) {
                if isMainFrame {
                    self.linkBrowser.navigationWillStart(url, in: webView)
                }
                decisionHandler(.allow)
                return
            }
            // The sidebar is an HTTP(S) reading surface. Only the trusted
            // dashboard bridge may ask macOS to launch mail or phone URLs.
            decisionHandler(.cancel)
            return
        }
        if navigationAction.targetFrame == nil {
            let allowEditorURLs = Self.shouldAllowEditorURLLaunch(
                from: navigationAction.sourceFrame.request.url,
                isMainFrame: navigationAction.sourceFrame.isMainFrame,
                dashboardURL: self.currentURL)
            self.decideTargetlessNavigation(
                url,
                navigationType: navigationAction.navigationType,
                buttonNumber: navigationAction.buttonNumber,
                allowEditorURLs: allowEditorURLs,
                decisionHandler: decisionHandler)
            return
        }
        if Self.shouldAllowNavigation(to: url, dashboardURL: self.currentURL) {
            decisionHandler(.allow)
            return
        }
        // Back/forward can reach entries from a previous gateway endpoint after
        // a tunnel/port swap; opening those externally would launch a dead URL
        // in the browser, so swallow the traversal instead.
        if navigationAction.navigationType == .backForward {
            decisionHandler(.cancel)
            return
        }
        if Self.shouldOpenExternalDashboardNavigation(
            url,
            navigationType: navigationAction.navigationType,
            buttonNumber: navigationAction.buttonNumber)
        {
            self.openExternal(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if self.linkBrowser.owns(webView) {
            self.linkBrowser.navigationDidStart(navigation, in: webView)
            self.linkBrowser.updateChrome()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if self.linkBrowser.owns(webView) {
            self.linkBrowser.navigationDidFinish(navigation, for: webView)
        } else if webView === self.webView {
            self.publishNativeHistoryState()
        }
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        if self.linkBrowser.owns(webView) {
            self.linkBrowser.navigationDidFail(for: webView)
            return
        }
        guard webView === self.webView else { return }
        self.showLoadFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation _: WKNavigation!,
        withError error: Error)
    {
        if self.linkBrowser.owns(webView) {
            self.linkBrowser.navigationDidFail(for: webView)
            return
        }
        guard webView === self.webView else { return }
        self.showLoadFailure(error)
    }

    private func decideTargetlessNavigation(
        _ url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int,
        allowEditorURLs: Bool,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        switch Self.targetlessNavigationAction(
            for: url,
            navigationType: navigationType,
            buttonNumber: buttonNumber,
            allowEditorURLs: allowEditorURLs)
        {
        case .allow:
            decisionHandler(.allow)
        case .openExternal:
            self.openExternal(url)
            decisionHandler(.cancel)
        case .cancel:
            decisionHandler(.cancel)
        }
    }
}

#if DEBUG
extension DashboardWindowController {
    var _testUserScripts: [WKUserScript] {
        self.webView.configuration.userContentController.userScripts
    }

    var _testUpdateBridgeAvailable: Bool {
        self.updateBridgeEnabled
    }

    var _testLinkBrowserIsCollapsed: Bool {
        self.linkBrowserItem.isCollapsed
    }

    var _testLinkBrowserDataStore: WKWebsiteDataStore {
        // Prefer the active tab's configured store so tests catch a tab that
        // was built with the wrong (non-shared) data store.
        self.linkBrowser.activeWebView?.configuration.websiteDataStore
            ?? self.linkBrowser._testWebsiteDataStore
    }

    var _testLinkBrowserRepresentedURL: URL? {
        self.linkBrowser._testRepresentedURL
    }

    var _testLinkBrowserNavigationObservationCount: Int {
        self.linkBrowser._testNavigationObservationCount
    }

    var _testLinkBrowserWebViewIdentity: ObjectIdentifier? {
        self.linkBrowser.activeWebView.map(ObjectIdentifier.init)
    }

    var _testLinkBrowserWebViewURL: URL? {
        self.linkBrowser.activeWebView?.url
    }

    var _testLinkBrowserHistoryIsEmpty: Bool {
        guard let history = self.linkBrowser.activeWebView?.backForwardList else { return true }
        return history.currentItem == nil && history.backItem == nil && history.forwardItem == nil
    }

    var _testLinkBrowserDelegatesAreInstalled: Bool {
        guard let webView = self.linkBrowser.activeWebView else { return false }
        return webView.navigationDelegate === self && webView.uiDelegate === self
    }

    var _testLinkBrowserWebViewIsInstalled: Bool {
        self.linkBrowser.activeWebView?.superview === self.linkBrowser
    }

    var _testDashboardDataStore: WKWebsiteDataStore {
        self.webView.configuration.websiteDataStore
    }

    var _testCanOpenWindowsAutomatically: Bool {
        self.webView.configuration.preferences.javaScriptCanOpenWindowsAutomatically ||
            self.linkBrowser._testAllWebViews.contains {
                $0.configuration.preferences.javaScriptCanOpenWindowsAutomatically
            }
    }

    var _testSplitAutosaveName: String? {
        self.splitViewController.splitView.autosaveName
    }

    func _testOpenLinkBrowser(_ url: URL, requestBrowserProfileImportOffer: Bool = false) {
        self.openLinkBrowser(url, requestBrowserProfileImportOffer: requestBrowserProfileImportOffer)
    }

    func _testCloseLinkBrowser() {
        self.closeLinkBrowser()
    }

    var _testLinkBrowserTabCount: Int {
        self.linkBrowser._testTabCount
    }

    var _testLinkBrowserTabURLs: [URL?] {
        self.linkBrowser._testTabURLs
    }

    var _testLinkBrowserActiveTabIndex: Int? {
        self.linkBrowser._testActiveTabIndex
    }

    func _testLinkBrowserOpenInNewTab(_ url: URL) {
        self.linkBrowser.openInNewTab(url)
    }

    func _testLinkBrowserCloseTab(at index: Int) {
        self.linkBrowser._testCloseTab(at: index)
    }

    func _testLinkBrowserMoveTab(from fromIndex: Int, to toIndex: Int) {
        self.linkBrowser._testMoveTab(from: fromIndex, to: toIndex)
    }

    func _testLinkBrowserSelectTab(at index: Int) {
        self.linkBrowser._testSelectTab(at: index)
    }

    func _testLinkBrowserContextMenu(forTabAt index: Int) -> NSMenu? {
        self.linkBrowser._testContextMenu(forTabAt: index)
    }

    var _testAllowsBackForwardGestures: Bool {
        self.webView.allowsBackForwardNavigationGestures
    }

    var _testNavigationWebViewIdentity: ObjectIdentifier {
        ObjectIdentifier(self.activeNavigationWebView)
    }

    var _testDashboardWebViewIdentity: ObjectIdentifier {
        ObjectIdentifier(self.webView)
    }

    func _testFocusLinkBrowser() -> Bool {
        guard let webView = self.linkBrowser.activeWebView else { return false }
        return self.window?.makeFirstResponder(webView) == true
    }

    static func _testJavaScriptConfirmAlert(message: String, host: String?) -> NSAlert {
        self.makeJavaScriptConfirmAlert(message: message, host: host)
    }

    static func _testJavaScriptConfirmResult(for response: NSApplication.ModalResponse) -> Bool {
        self.javaScriptConfirmResult(for: response)
    }
}
#endif
