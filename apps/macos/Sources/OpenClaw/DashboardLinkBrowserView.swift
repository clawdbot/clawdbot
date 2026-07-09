import AppKit
import Foundation
import WebKit

@MainActor
final class DashboardLinkBrowserView: NSView {
    private(set) var webView: WKWebView
    var onClose: (() -> Void)?
    var onOpenExternal: ((URL) -> Void)?

    private let websiteDataStore: WKWebsiteDataStore
    private let toolbar = NSVisualEffectView()
    private let backButton = DashboardLinkBrowserView.makeButton(symbol: "chevron.left", label: "Back")
    private let forwardButton = DashboardLinkBrowserView.makeButton(symbol: "chevron.right", label: "Forward")
    private let reloadButton = DashboardLinkBrowserView.makeButton(symbol: "arrow.clockwise", label: "Reload")
    private let externalButton = DashboardLinkBrowserView.makeButton(
        symbol: "arrow.up.right.square",
        label: "Open in Default Browser")
    private let closeButton = DashboardLinkBrowserView.makeButton(symbol: "xmark", label: "Close Sidebar")
    private var navigationObservations: [NSKeyValueObservation] = []
    private var webViewConstraints: [NSLayoutConstraint] = []
    private var representedURL: URL?
    private let addressLabel: NSTextField = {
        let label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }()

    init(websiteDataStore: WKWebsiteDataStore) {
        self.websiteDataStore = websiteDataStore
        self.webView = Self.makeWebView(websiteDataStore: websiteDataStore)
        super.init(frame: .zero)

        self.configureActions()
        self.buildView()
        self.observeNavigationState()
        self.updateChrome()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func open(_ url: URL) {
        self.navigationWillStart(url)
        self.webView.load(URLRequest(url: url))
    }

    func closeBrowser() {
        self.representedURL = nil
        self.replaceWebView()
        self.updateChrome()
    }

    func updateChrome() {
        let url = self.representedURL
        self.addressLabel.stringValue = url?.host(percentEncoded: false) ?? url?.absoluteString ?? ""
        self.addressLabel.toolTip = url?.absoluteString
        self.backButton.isEnabled = self.webView.canGoBack
        self.forwardButton.isEnabled = self.webView.canGoForward
        self.reloadButton.isEnabled = url != nil
        self.externalButton.isEnabled = url.flatMap(Self.httpURL) != nil
    }

    func navigationWillStart(_ url: URL) {
        self.representedURL = url
        self.updateChrome()
    }

    func navigationDidFinish() {
        self.representedURL = self.webView.url
        self.updateChrome()
    }

    private static func makeWebView(websiteDataStore: WKWebsiteDataStore) -> WKWebView {
        // External pages share persisted browser sessions, but never inherit the
        // dashboard's auth scripts or privileged message handler.
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = websiteDataStore
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.setValue(true, forKey: "drawsBackground")
        return webView
    }

    private func replaceWebView() {
        let previousWebView = self.webView
        let navigationDelegate = previousWebView.navigationDelegate
        let uiDelegate = previousWebView.uiDelegate
        let replacement = Self.makeWebView(websiteDataStore: self.websiteDataStore)

        self.navigationObservations.forEach { $0.invalidate() }
        self.navigationObservations.removeAll()
        NSLayoutConstraint.deactivate(self.webViewConstraints)
        previousWebView.navigationDelegate = nil
        previousWebView.uiDelegate = nil
        previousWebView.stopLoading()
        previousWebView.removeFromSuperview()

        self.webView = replacement
        self.installWebView()
        replacement.navigationDelegate = navigationDelegate
        replacement.uiDelegate = uiDelegate
        self.observeNavigationState()
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
    }

    private func observeNavigationState() {
        // WebKit updates these properties after some navigation delegate callbacks.
        // KVO also catches same-document SPA URL changes that skip didFinish.
        self.navigationObservations = [
            self.webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    self?.updateChrome()
                }
            },
            self.webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    self?.updateChrome()
                }
            },
            self.webView.observe(\.url, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    self?.navigationDidFinish()
                }
            },
        ]
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

        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        self.toolbar.addSubview(separator)
        self.installWebView()

        NSLayoutConstraint.activate([
            self.toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
            self.toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
            self.toolbar.topAnchor.constraint(equalTo: topAnchor),
            // The top 32 points stay clear of the dashboard window's drag overlay.
            self.toolbar.heightAnchor.constraint(equalToConstant: 68),

            controls.leadingAnchor.constraint(equalTo: self.toolbar.leadingAnchor, constant: 10),
            controls.trailingAnchor.constraint(equalTo: self.toolbar.trailingAnchor, constant: -10),
            controls.bottomAnchor.constraint(equalTo: self.toolbar.bottomAnchor, constant: -8),
            controls.heightAnchor.constraint(equalToConstant: 28),

            separator.leadingAnchor.constraint(equalTo: self.toolbar.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: self.toolbar.trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: self.toolbar.bottomAnchor),
        ])
    }

    private func installWebView() {
        self.webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(self.webView)
        self.webViewConstraints = [
            self.webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            self.webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            self.webView.topAnchor.constraint(equalTo: self.toolbar.bottomAnchor),
            self.webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ]
        NSLayoutConstraint.activate(self.webViewConstraints)
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
        self.webView.goBack()
    }

    @objc private func goForward() {
        self.webView.goForward()
    }

    @objc private func reload() {
        self.webView.reload()
    }

    @objc private func openExternal() {
        guard let url = representedURL.flatMap(Self.httpURL) else { return }
        self.onOpenExternal?(url)
    }

    @objc private func close() {
        self.onClose?()
    }
}

#if DEBUG
extension DashboardLinkBrowserView {
    var _testRepresentedURL: URL? {
        self.representedURL
    }

    var _testNavigationObservationCount: Int {
        self.navigationObservations.count
    }
}
#endif
