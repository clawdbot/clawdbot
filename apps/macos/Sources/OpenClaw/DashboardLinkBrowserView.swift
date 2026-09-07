import AppKit
import Foundation
import WebKit

@MainActor
final class DashboardLinkBrowserView: NSView {
    var activeWebView: WKWebView? {
        self.activeTab?.webView
    }

    weak var webViewNavigationDelegate: WKNavigationDelegate? {
        didSet {
            self.tabs.forEach { $0.webView.navigationDelegate = self.webViewNavigationDelegate }
        }
    }

    weak var webViewUIDelegate: WKUIDelegate? {
        didSet {
            self.tabs.forEach { $0.webView.uiDelegate = self.webViewUIDelegate }
        }
    }

    var onClose: (() -> Void)?
    var onOpenExternal: ((URL) -> Void)?

    private let websiteDataStore: WKWebsiteDataStore
    private var tabs: [DashboardBrowserTab] = []
    private var activeTabID: UUID?
    private let toolbar = NSVisualEffectView()
    private let tabBar = DashboardLinkBrowserTabBar()
    private lazy var toolbarHeightConstraint = self.toolbar.heightAnchor.constraint(
        equalToConstant: DashboardWindowLayout.linkBrowserToolbarHeight)
    private lazy var tabBarHeightConstraint = self.tabBar.heightAnchor.constraint(
        equalToConstant: 0)
    private let backButton = DashboardLinkBrowserView.makeButton(symbol: "chevron.left", label: "Back")
    private let forwardButton = DashboardLinkBrowserView.makeButton(symbol: "chevron.right", label: "Forward")
    private let reloadButton = DashboardLinkBrowserView.makeButton(symbol: "arrow.clockwise", label: "Reload")
    private let externalButton = DashboardLinkBrowserView.makeButton(
        symbol: "arrow.up.right.square",
        label: "Open in Default Browser")
    private let closeButton = DashboardLinkBrowserView.makeButton(symbol: "xmark", label: "Close Sidebar")
    private let addressLabel: NSTextField = {
        let label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }()

    private var activeTab: DashboardBrowserTab? {
        guard let activeTabID else { return nil }
        return self.tabs.first { $0.id == activeTabID }
    }

    init(websiteDataStore: WKWebsiteDataStore) {
        self.websiteDataStore = websiteDataStore
        super.init(frame: .zero)

        self.configureActions()
        self.buildView()
        self.updateChrome()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func owns(_ webView: WKWebView) -> Bool {
        self.tabs.contains { $0.webView === webView }
    }

    func open(_ url: URL) {
        // Keep the original request as a stable dedupe key across redirects while
        // also reusing a tab that has since navigated to the requested target.
        let tab = self.tabs.first(where: { $0.representedURL == url }) ??
            self.tabs.first(where: { $0.requestedURLAlias == url })
        if let tab {
            self.activateTab(id: tab.id)
            return
        }
        self.openInNewTab(url)
    }

    func openInNewTab(_ url: URL) {
        let tab = self.makeTab(requestedURL: url)
        self.tabs.append(tab)
        self.tabBar.appendTab(id: tab.id, title: self.displayTitle(for: tab), toolTip: url.absoluteString)
        self.updateTabBarVisibility()
        self.activateTab(id: tab.id)
        let webView = tab.webView
        // Let the installed tab become observable before navigation starts.
        // An immediate close then cancels the pending load without retaining it.
        Task { @MainActor [weak self, weak webView] in
            guard let self, let webView, self.owns(webView) else { return }
            webView.load(URLRequest(url: url))
        }
    }

    func closeTab(id: UUID) {
        guard let index = self.tabs.firstIndex(where: { $0.id == id }) else { return }
        let wasActive = self.activeTabID == id
        let tab = self.tabs.remove(at: index)
        tab.dispose()
        self.tabBar.removeTab(id: id)
        self.updateTabBarVisibility()

        guard !self.tabs.isEmpty else {
            self.activeTabID = nil
            self.tabBar.setActiveTab(id: nil)
            self.updateChrome()
            self.onClose?()
            return
        }
        if wasActive {
            let nextIndex = min(index, self.tabs.count - 1)
            self.activateTab(id: self.tabs[nextIndex].id)
        }
    }

    func closeOtherTabs(keeping id: UUID) {
        guard let keptTab = self.tabs.first(where: { $0.id == id }) else { return }
        let removedTabs = self.tabs.filter { $0.id != id }
        for tab in removedTabs {
            tab.dispose()
            self.tabBar.removeTab(id: tab.id)
        }
        self.tabs = [keptTab]
        self.updateTabBarVisibility()
        self.activateTab(id: id)
    }

    func moveTab(fromIndex: Int, toIndex: Int) {
        guard self.tabs.indices.contains(fromIndex), toIndex >= 0, toIndex < self.tabs.count else { return }
        let tab = self.tabs.remove(at: fromIndex)
        self.tabs.insert(tab, at: toIndex)
        self.tabBar.moveTab(id: tab.id, toIndex: toIndex)
    }

    func closeBrowser() {
        let tabs = self.tabs
        self.tabs.removeAll()
        self.activeTabID = nil
        for tab in tabs {
            tab.dispose()
            self.tabBar.removeTab(id: tab.id)
        }
        self.tabBar.setActiveTab(id: nil)
        self.updateTabBarVisibility()
        self.updateChrome()
    }

    func updateChrome() {
        let tab = self.activeTab
        let url = tab?.representedURL
        self.addressLabel.stringValue = url?.host(percentEncoded: false) ?? url?.absoluteString ?? ""
        self.addressLabel.toolTip = url?.absoluteString
        self.backButton.isEnabled = tab?.webView.canGoBack == true
        self.forwardButton.isEnabled = tab?.webView.canGoForward == true
        self.reloadButton.isEnabled = url != nil
        self.externalButton.isEnabled = url.flatMap(Self.httpURL) != nil
    }

    func navigationWillStart(_ url: URL, in webView: WKWebView) {
        guard let tab = self.tab(owning: webView) else { return }
        tab.updateRepresentedURL(url)
        self.refreshTab(tab)
    }

    func navigationDidStart(_ navigation: WKNavigation?, in webView: WKWebView) {
        guard let navigation, let tab = self.tab(owning: webView) else { return }
        tab.startNavigation(navigation)
    }

    func navigationDidFinish(_ navigation: WKNavigation?, for webView: WKWebView) {
        self.finishNavigation(navigation, at: webView.url, title: webView.title, in: webView)
    }

    func navigationDidFail(for webView: WKWebView) {
        guard let tab = self.tab(owning: webView) else { return }
        tab.failNavigation()
        self.updateChrome()
    }

    func navigationURLDidChange(for webView: WKWebView) {
        guard let tab = self.tab(owning: webView) else { return }
        tab.updateRepresentedURL(webView.url)
        self.refreshTab(tab)
    }

    private func finishNavigation(
        _ navigation: AnyObject?,
        at url: URL?,
        title: String?,
        in webView: WKWebView)
    {
        guard let tab = self.tab(owning: webView) else { return }
        tab.finishNavigation(navigation, at: url, title: title)
        self.refreshTab(tab)
    }

    func contextMenu(forTabAt index: Int) -> NSMenu? {
        guard self.tabs.indices.contains(index) else { return nil }
        return self.contextMenu(for: self.tabs[index])
    }

    private func makeTab(requestedURL: URL) -> DashboardBrowserTab {
        let tab = DashboardBrowserTab(websiteDataStore: self.websiteDataStore, requestedURL: requestedURL)
        tab.webView.navigationDelegate = self.webViewNavigationDelegate
        tab.webView.uiDelegate = self.webViewUIDelegate
        self.installWebView(tab.webView)
        tab.observeNavigationState { [weak self, weak tab] in
            guard let self, let tab else { return }
            self.refreshTab(tab)
        }
        return tab
    }

    private func tab(owning webView: WKWebView) -> DashboardBrowserTab? {
        self.tabs.first { $0.webView === webView }
    }

    private func activateTab(id: UUID) {
        guard self.tabs.contains(where: { $0.id == id }) else { return }
        self.activeTabID = id
        for tab in self.tabs {
            tab.webView.isHidden = tab.id != id
        }
        self.tabBar.setActiveTab(id: id)
        self.updateChrome()
        if self.window != nil {
            self.window?.makeFirstResponder(self.activeWebView)
        }
    }

    private func refreshTab(_ tab: DashboardBrowserTab) {
        self.tabBar.updateTab(
            id: tab.id,
            title: self.displayTitle(for: tab),
            toolTip: tab.representedURL?.absoluteString)
        if tab.id == self.activeTabID {
            self.updateChrome()
        }
    }

    private func displayTitle(for tab: DashboardBrowserTab) -> String {
        if let title = tab.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            return title
        }
        return tab.representedURL?.host(percentEncoded: false) ?? "New Tab"
    }

    private func configureActions() {
        self.backButton.target = self
        self.backButton.action = #selector(self.goBack)
        self.forwardButton.target = self
        self.forwardButton.action = #selector(self.goForward)
        self.reloadButton.target = self
        self.reloadButton.action = #selector(self.reload)
        self.externalButton.target = self
        self.externalButton.action = #selector(self.openExternal)
        self.closeButton.target = self
        self.closeButton.action = #selector(self.close)
        self.tabBar.delegate = self
    }

    private func buildView() {
        self.toolbar.material = .headerView
        self.toolbar.blendingMode = .withinWindow
        self.toolbar.state = .active
        self.toolbar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(self.toolbar)

        let controls = NSStackView(views: [
            backButton,
            forwardButton,
            reloadButton,
            addressLabel,
            externalButton,
            closeButton,
        ])
        controls.orientation = .horizontal
        controls.alignment = .centerY
        controls.distribution = .fill
        controls.spacing = 4
        controls.setCustomSpacing(10, after: self.reloadButton)
        controls.setCustomSpacing(10, after: self.addressLabel)
        controls.translatesAutoresizingMaskIntoConstraints = false
        self.toolbar.addSubview(controls)

        self.tabBar.translatesAutoresizingMaskIntoConstraints = false
        self.toolbar.addSubview(self.tabBar)

        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        self.toolbar.addSubview(separator)

        NSLayoutConstraint.activate([
            self.toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
            self.toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
            self.toolbar.topAnchor.constraint(equalTo: topAnchor),
            self.toolbarHeightConstraint,
            // Browser-style header: tabs on top, navigation controls below.
            // 12pt top inset clears the window's 12pt drag overlay (it reaches
            // into wide sidebars), keeping every tab pixel clickable.
            self.tabBar.leadingAnchor.constraint(equalTo: self.toolbar.leadingAnchor),
            self.tabBar.trailingAnchor.constraint(equalTo: self.toolbar.trailingAnchor),
            self.tabBar.topAnchor.constraint(equalTo: self.toolbar.topAnchor, constant: 12),
            self.tabBarHeightConstraint,
            controls.leadingAnchor.constraint(equalTo: self.toolbar.leadingAnchor, constant: 10),
            controls.trailingAnchor.constraint(equalTo: self.toolbar.trailingAnchor, constant: -10),
            controls.bottomAnchor.constraint(equalTo: self.toolbar.bottomAnchor, constant: -4),
            controls.heightAnchor.constraint(equalToConstant: 28),
            separator.leadingAnchor.constraint(equalTo: self.toolbar.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: self.toolbar.trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: self.toolbar.bottomAnchor),
        ])
        self.updateTabBarVisibility()
    }

    private func updateTabBarVisibility() {
        let showsTabs = self.tabs.count > 1
        self.tabBar.isHidden = !showsTabs
        self.tabBarHeightConstraint.constant = showsTabs ? DashboardWindowLayout.linkBrowserTabBarHeight : 0
        self.toolbarHeightConstraint.constant = showsTabs
            ? DashboardWindowLayout.linkBrowserToolbarWithTabsHeight
            : DashboardWindowLayout.linkBrowserToolbarHeight
    }

    private func installWebView(_ webView: WKWebView) {
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true
        addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: self.toolbar.bottomAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func contextMenu(for tab: DashboardBrowserTab) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let externalURL = tab.representedURL.flatMap(Self.httpURL)
        menu.addItem(self.menuItem(
            title: "Open in Default Browser",
            action: #selector(self.openTabExternal(_:)),
            tabID: tab.id,
            isEnabled: externalURL != nil))
        menu.addItem(self.menuItem(
            title: "Copy Link",
            action: #selector(self.copyTabLink(_:)),
            tabID: tab.id,
            isEnabled: tab.representedURL != nil))
        menu.addItem(self.menuItem(
            title: "Reload",
            action: #selector(self.reloadTab(_:)),
            tabID: tab.id,
            isEnabled: tab.representedURL != nil))
        menu.addItem(.separator())
        menu.addItem(self.menuItem(
            title: "Close Tab",
            action: #selector(self.closeTabFromMenu(_:)),
            tabID: tab.id,
            isEnabled: true))
        menu.addItem(self.menuItem(
            title: "Close Other Tabs",
            action: #selector(self.closeOtherTabsFromMenu(_:)),
            tabID: tab.id,
            isEnabled: self.tabs.count > 1))
        return menu
    }

    private func menuItem(
        title: String,
        action: Selector,
        tabID: UUID,
        isEnabled: Bool) -> NSMenuItem
    {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.representedObject = tabID as NSUUID
        item.isEnabled = isEnabled
        return item
    }

    private func tab(for menuItem: NSMenuItem) -> DashboardBrowserTab? {
        guard let id = menuItem.representedObject as? UUID else { return nil }
        return self.tabs.first { $0.id == id }
    }

    private static func makeButton(symbol: String, label: String) -> NSButton {
        let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(configuration) ?? NSImage(size: NSSize(width: 16, height: 16))
        let button = NSButton(image: image, target: nil, action: nil)
        button.isBordered = false
        button.bezelStyle = .regularSquare
        button.imageScaling = .scaleProportionallyDown
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.widthAnchor.constraint(equalToConstant: 26).isActive = true
        button.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return button
    }

    private static func httpURL(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    @objc private func goBack() {
        self.activeWebView?.goBack()
    }

    @objc private func goForward() {
        self.activeWebView?.goForward()
    }

    @objc private func reload() {
        self.activeWebView?.reload()
    }

    @objc private func openExternal() {
        guard let url = self.activeTab?.representedURL.flatMap(Self.httpURL) else { return }
        self.onOpenExternal?(url)
    }

    @objc private func close() {
        self.onClose?()
    }

    @objc private func openTabExternal(_ sender: NSMenuItem) {
        guard let url = self.tab(for: sender)?.representedURL.flatMap(Self.httpURL) else { return }
        self.onOpenExternal?(url)
    }

    @objc private func copyTabLink(_ sender: NSMenuItem) {
        guard let url = self.tab(for: sender)?.representedURL else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.writeObjects([url as NSURL])
        pasteboard.setString(url.absoluteString, forType: .string)
    }

    @objc private func reloadTab(_ sender: NSMenuItem) {
        self.tab(for: sender)?.webView.reload()
    }

    @objc private func closeTabFromMenu(_ sender: NSMenuItem) {
        guard let id = (sender.representedObject as? UUID) else { return }
        self.closeTab(id: id)
    }

    @objc private func closeOtherTabsFromMenu(_ sender: NSMenuItem) {
        guard let id = (sender.representedObject as? UUID) else { return }
        self.closeOtherTabs(keeping: id)
    }
}

extension DashboardLinkBrowserView: DashboardLinkBrowserTabBarDelegate {
    func tabBar(_: DashboardLinkBrowserTabBar, didSelectTab id: UUID) {
        self.activateTab(id: id)
    }

    func tabBar(_: DashboardLinkBrowserTabBar, didCloseTab id: UUID) {
        self.closeTab(id: id)
    }

    func tabBar(_: DashboardLinkBrowserTabBar, didMoveTab id: UUID, toIndex: Int) {
        guard let fromIndex = self.tabs.firstIndex(where: { $0.id == id }) else { return }
        self.moveTab(fromIndex: fromIndex, toIndex: toIndex)
    }

    func tabBar(_: DashboardLinkBrowserTabBar, contextMenuForTab id: UUID) -> NSMenu? {
        guard let tab = self.tabs.first(where: { $0.id == id }) else { return nil }
        return self.contextMenu(for: tab)
    }
}

#if DEBUG
extension DashboardLinkBrowserView {
    var _testTabCount: Int {
        self.tabs.count
    }

    var _testTabURLs: [URL?] {
        self.tabs.map(\.representedURL)
    }

    var _testActiveTabIndex: Int? {
        guard let activeTabID else { return nil }
        return self.tabs.firstIndex { $0.id == activeTabID }
    }

    var _testActiveWebView: WKWebView? {
        self.activeWebView
    }

    var _testRepresentedURL: URL? {
        self.activeTab?.representedURL
    }

    var _testNavigationObservationCount: Int {
        self.activeTab?.observations.count ?? 0
    }

    var _testWebsiteDataStore: WKWebsiteDataStore {
        self.websiteDataStore
    }

    var _testAllWebViews: [WKWebView] {
        self.tabs.map(\.webView)
    }

    var _testTabBarIsHidden: Bool {
        self.tabBar.isHidden
    }

    var _testToolbarHeight: CGFloat {
        self.toolbarHeightConstraint.constant
    }

    var _testTabBarHeight: CGFloat {
        self.tabBarHeightConstraint.constant
    }

    func _testSelectTab(at index: Int) {
        guard self.tabs.indices.contains(index) else { return }
        self.activateTab(id: self.tabs[index].id)
    }

    func _testCloseTab(at index: Int) {
        guard self.tabs.indices.contains(index) else { return }
        self.closeTab(id: self.tabs[index].id)
    }

    func _testMoveTab(from fromIndex: Int, to toIndex: Int) {
        self.moveTab(fromIndex: fromIndex, toIndex: toIndex)
    }

    func _testOpenInNewTab(_ url: URL) {
        self.openInNewTab(url)
    }

    func _testStartNavigation(_ navigation: AnyObject, in webView: WKWebView) {
        guard let tab = self.tab(owning: webView) else { return }
        tab.startNavigation(navigation)
    }

    func _testFinishNavigation(_ navigation: AnyObject, at url: URL?, in webView: WKWebView) {
        self.finishNavigation(navigation, at: url, title: webView.title, in: webView)
    }

    func _testContextMenu(forTabAt index: Int) -> NSMenu? {
        self.contextMenu(forTabAt: index)
    }
}
#endif
