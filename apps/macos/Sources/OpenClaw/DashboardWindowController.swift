import AppKit
import Foundation
import WebKit

private final class DashboardWindowContentView: NSView {
    override var mouseDownCanMoveWindow: Bool {
        true
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
final class DashboardWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    private static let linkMessageHandlerName = "openclawLink"

    private let webView: WKWebView
    private let linkBrowser: DashboardLinkBrowserView
    private let linkBrowserItem: NSSplitViewItem
    private let splitViewController: NSSplitViewController
    private(set) var currentURL: URL
    private var auth: DashboardWindowAuth
    private var backButton: NSButton?
    private var forwardButton: NSButton?
    private var canGoBackObservation: NSKeyValueObservation?
    private var canGoForwardObservation: NSKeyValueObservation?

    init(url: URL, auth: DashboardWindowAuth) {
        self.currentURL = url
        self.auth = auth

        let dataStore = WKWebsiteDataStore.default()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController = WKUserContentController()
        let linkMessageHandler = DashboardLinkMessageHandler()
        config.userContentController.add(linkMessageHandler, name: Self.linkMessageHandlerName)
        Self.installNativeChromeScript(into: config.userContentController)
        Self.installNativeAuthScript(into: config.userContentController, url: url, auth: auth)

        self.webView = WKWebView(
            frame: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize),
            configuration: config)
        self.webView.setValue(true, forKey: "drawsBackground")
        // The Control UI routes via pushState, so WKWebView's back-forward list
        // carries in-app navigation; without this (and the titlebar buttons
        // below) the dashboard window has no way back.
        self.webView.allowsBackForwardNavigationGestures = true

        let linkBrowser = DashboardLinkBrowserView(websiteDataStore: dataStore)
        let splitViewController = NSSplitViewController()
        splitViewController.splitView.isVertical = true
        splitViewController.splitView.dividerStyle = .thin
        splitViewController.splitView.autosaveName = DashboardWindowLayout.linkBrowserSplitAutosaveName

        let dashboardViewController = NSViewController()
        dashboardViewController.view = self.webView
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
        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        self.linkBrowser.webViewNavigationDelegate = self
        self.linkBrowser.webViewUIDelegate = self
        self.linkBrowser.onClose = { [weak self] in self?.closeLinkBrowser() }
        self.linkBrowser.onOpenExternal = { [weak self] url in self?.openExternal(url) }
        self.window?.delegate = self
        self.installNavigationControls()
    }

    // MARK: - WKUIDelegate

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

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(url: URL, auth: DashboardWindowAuth) {
        self.update(url: url, auth: auth)
        self.show()
    }

    /// Swap the dashboard to a new gateway endpoint without reordering the window:
    /// re-injects the native auth script for the new origin and reloads. Used when
    /// the remote tunnel is recreated on a new local port while the window stays
    /// open; ordering the window front here would steal focus on background
    /// tunnel recreation.
    func update(url: URL, auth: DashboardWindowAuth) {
        self.currentURL = url
        self.auth = auth
        self.refreshNativeAuthScript(url: url, auth: auth)
        self.load(url)
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
        self.refreshNativeAuthScript(url: self.currentURL, auth: self.auth)
        self.webView.stopLoading()
        self.webView.loadHTMLString(
            Self.failureHTML(title: title, message: message, detail: detail, url: nil),
            baseURL: nil)
        self.show()
    }

    private func load(_ url: URL) {
        dashboardWindowLogger.debug("dashboard load \(dashboardLogString(for: url), privacy: .public)")
        self.webView.load(URLRequest(url: url))
    }

    private func openLinkBrowser(_ url: URL) {
        self.linkBrowserItem.isCollapsed = false
        self.linkBrowser.open(url)
        window?.makeFirstResponder(self.linkBrowser.activeWebView)
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

    /// Back/forward buttons next to the traffic lights. The window has no
    /// native toolbar (full-size content view with the web UI's own chrome), so
    /// a leading titlebar accessory is the only native slot for them.
    private func installNavigationControls() {
        guard let window = self.window else { return }
        let back = Self.makeNavigationButton(
            symbolName: "chevron.left",
            label: "Back",
            action: #selector(self.navigateBack(_:)),
            target: self)
        let forward = Self.makeNavigationButton(
            symbolName: "chevron.right",
            label: "Forward",
            action: #selector(self.navigateForward(_:)),
            target: self)
        self.backButton = back
        self.forwardButton = forward

        let stack = NSStackView(views: [back, forward])
        stack.orientation = .horizontal
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 8, bottom: 0, right: 0)
        stack.setFrameSize(NSSize(width: 68, height: 28))

        let accessory = NSTitlebarAccessoryViewController()
        accessory.view = stack
        accessory.layoutAttribute = .leading
        window.addTitlebarAccessoryViewController(accessory)

        self.canGoBackObservation = self.webView.observe(\.canGoBack, options: [
            .initial,
            .new,
        ]) { [weak self] webView, _ in
            let canGoBack = webView.canGoBack
            Task { @MainActor in
                self?.backButton?.isEnabled = canGoBack
            }
        }
        self.canGoForwardObservation = self.webView.observe(\.canGoForward, options: [
            .initial,
            .new,
        ]) { [weak self] webView, _ in
            let canGoForward = webView.canGoForward
            Task { @MainActor in
                self?.forwardButton?.isEnabled = canGoForward
            }
        }
    }

    private static func makeNavigationButton(
        symbolName: String,
        label: String,
        action: Selector,
        target: AnyObject) -> NSButton
    {
        let button = NSButton()
        button.bezelStyle = .accessoryBarAction
        button.isBordered = false
        button.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: label)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
        button.imagePosition = .imageOnly
        button.contentTintColor = .secondaryLabelColor
        button.target = target
        button.action = action
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.isEnabled = false
        return button
    }

    @objc private func navigateBack(_: Any?) {
        self.webView.goBack()
    }

    @objc private func navigateForward(_: Any?) {
        self.webView.goForward()
    }

    private static func makeWindow(contentView: NSView) -> NSWindow {
        let window = NSWindow(
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
        let sidebarDragRegion = DashboardWindowDragRegionView()
        sidebarDragRegion.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(sidebarDragRegion)
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
            // content column (chat thread, page headers). The sidebar region
            // below stays the primary drag surface — it floats over the 50px
            // strip the native chrome CSS reserves in the web sidebar.
            topDragRegion.heightAnchor.constraint(equalToConstant: 12),
            topRightDragRegion.leadingAnchor.constraint(equalTo: topDragRegion.trailingAnchor),
            topRightDragRegion.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            topRightDragRegion.topAnchor.constraint(equalTo: container.topAnchor),
            topRightDragRegion.heightAnchor.constraint(equalToConstant: 6),
            sidebarDragRegion.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 78),
            sidebarDragRegion.topAnchor.constraint(equalTo: container.topAnchor),
            sidebarDragRegion.widthAnchor.constraint(equalToConstant: 176),
            sidebarDragRegion.heightAnchor.constraint(equalToConstant: 46),
        ])
        window.title = "OpenClaw"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
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
        let css = """
        html.openclaw-native-macos {
          --openclaw-native-titlebar-height: 50px;
        }
        @media (min-width: 700px) {
          /* Both desktop navigation surfaces must clear AppKit's window controls
             and drag regions or their first interactive row becomes unreachable. */
          html.openclaw-native-macos .sidebar-shell,
          html.openclaw-native-macos .settings-sidebar__header {
            padding-top: max(14px, var(--openclaw-native-titlebar-height)) !important;
          }
        }
        @media (max-width: 1100px) {
          /* The responsive topbar replaces the sidebar below this breakpoint.
             Move its controls below AppKit's traffic lights and drag overlay. */
          html.openclaw-native-macos .shell {
            --shell-topbar-height: calc(58px + var(--openclaw-native-titlebar-height));
          }
          html.openclaw-native-macos .topbar {
            padding: var(--openclaw-native-titlebar-height) 12px 0 !important;
          }
          html.openclaw-native-macos .topnav-shell {
            min-height: 58px;
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
            document.documentElement.classList.add("openclaw-native-macos");
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

    func webView(_ webView: WKWebView, didStartProvisionalNavigation _: WKNavigation!) {
        if self.linkBrowser.owns(webView) {
            self.linkBrowser.updateChrome()
        }
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        if self.linkBrowser.owns(webView) {
            self.linkBrowser.navigationDidFinish(for: webView)
        }
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        if self.linkBrowser.owns(webView) {
            self.linkBrowser.updateChrome()
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
            self.linkBrowser.updateChrome()
            return
        }
        guard webView === self.webView else { return }
        self.showLoadFailure(error)
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
            "dashboard load failed url=\(dashboardLogString(for: self.currentURL), privacy: .public) error=\(error.localizedDescription, privacy: .public)")
        let html = Self.failureHTML(
            title: "Dashboard unavailable",
            message: error.localizedDescription,
            detail: "The dashboard window is open, but the web UI could not load from this endpoint.",
            url: self.currentURL)
        self.webView.loadHTMLString(html, baseURL: nil)
    }

    private static func failureHTML(title: String, message: String, detail: String?, url: URL?) -> String {
        let detailHTML = detail.map { "<p class=\"detail\">\(self.htmlEscape($0))</p>" } ?? ""
        let urlHTML = url.map { "<code>\(self.htmlEscape($0.absoluteString))</code>" } ?? ""
        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            :root { color-scheme: light dark; }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              background: #101114;
              color: rgba(255,255,255,.92);
              font: 15px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
            }
            main {
              width: min(540px, calc(100vw - 72px));
              padding: 34px;
              border: 1px solid rgba(255,255,255,.12);
              border-radius: 22px;
              background: rgba(255,255,255,.035);
              box-shadow: 0 28px 90px rgba(0,0,0,.36);
              line-height: 1.45;
            }
            .badge {
              width: 44px;
              height: 44px;
              display: grid;
              place-items: center;
              margin-bottom: 20px;
              border-radius: 14px;
              background: rgba(255,255,255,.07);
              color: #ff746b;
              font-size: 24px;
            }
            h1 {
              margin: 0 0 12px;
              font-size: 24px;
              line-height: 1.16;
              font-weight: 700;
              letter-spacing: 0;
            }
            p {
              margin: 0;
              color: rgba(255,255,255,.76);
              font-size: 16px;
            }
            .detail {
              margin-top: 14px;
              color: rgba(255,255,255,.56);
              font-size: 13px;
            }
            code {
              display: block;
              margin-top: 18px;
              padding: 12px;
              border: 1px solid rgba(255,255,255,.08);
              border-radius: 10px;
              background: rgba(0,0,0,.26);
              color: rgba(255,255,255,.76);
              overflow-wrap: anywhere;
              font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
            }
            @media (prefers-color-scheme: light) {
              body { background: #f5f6f8; color: rgba(0,0,0,.86); }
              main {
                background: rgba(255,255,255,.84);
                border-color: rgba(0,0,0,.1);
                box-shadow: 0 28px 90px rgba(0,0,0,.12);
              }
              .badge { background: rgba(0,0,0,.06); }
              p { color: rgba(0,0,0,.68); }
              .detail { color: rgba(0,0,0,.54); }
              code {
                background: rgba(0,0,0,.05);
                border-color: rgba(0,0,0,.08);
                color: rgba(0,0,0,.68);
              }
            }
          </style>
        </head>
        <body>
          <main>
            <div class="badge">!</div>
            <h1>\(self.htmlEscape(title))</h1>
            <p>\(self.htmlEscape(message))</p>
            \(detailHTML)
            \(urlHTML)
          </main>
        </body>
        </html>
        """
    }

    private static func htmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}

#if DEBUG
extension DashboardWindowController {
    var _testUserScripts: [WKUserScript] {
        self.webView.configuration.userContentController.userScripts
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

    func _testOpenLinkBrowser(_ url: URL) {
        self.openLinkBrowser(url)
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
}
#endif
