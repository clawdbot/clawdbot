import AppKit
import Foundation
import WebKit

@MainActor
final class DashboardBrowserTab {
    /// WebKit preserves one WKNavigation identity across a redirect chain.
    /// A different identity means the opened-link alias is no longer current.
    private enum RequestAliasPhase {
        case awaitingNavigation
        case loading(AnyObject)
        case retained
        case retired
    }

    let webView: WKWebView
    let requestedURL: URL
    var representedURL: URL?
    var title: String?
    var navigationWasUserActivated = false
    var observations: [NSKeyValueObservation] = []
    private var requestAliasPhase: RequestAliasPhase = .awaitingNavigation

    init(websiteDataStore: WKWebsiteDataStore, requestedURL: URL) {
        // Reading tabs share browser sessions, never the dashboard's privileged
        // scripts, auth injection, or message handlers.
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = websiteDataStore
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.tabFocusesLinks = true
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        self.webView.setValue(true, forKey: "drawsBackground")
        self.requestedURL = requestedURL
        self.representedURL = requestedURL
    }

    var requestedURLAlias: URL? {
        if case .retired = self.requestAliasPhase {
            nil
        } else {
            self.requestedURL
        }
    }

    func startNavigation(_ navigation: AnyObject) {
        switch self.requestAliasPhase {
        case .awaitingNavigation:
            self.requestAliasPhase = .loading(navigation)
        case let .loading(initial) where initial !== navigation:
            self.requestAliasPhase = .retired
        case .retained:
            self.requestAliasPhase = .retired
        case .loading, .retired:
            break
        }
    }

    func updateRepresentedURL(_ url: URL?) {
        // Initial redirects keep the opened link reusable. Once that chain
        // finishes, a distinct navigation retires the now-stale alias.
        if case .retained = self.requestAliasPhase, let url, url != self.representedURL {
            self.requestAliasPhase = .retired
        }
        self.representedURL = url
    }

    func finishNavigation(_ navigation: AnyObject?, at url: URL?, title: String?) {
        self.updateRepresentedURL(url)
        self.title = title
        guard let navigation else { return }
        switch self.requestAliasPhase {
        case .awaitingNavigation:
            self.requestAliasPhase = .retained
        case let .loading(initial) where initial === navigation:
            self.requestAliasPhase = .retained
        case .loading:
            self.requestAliasPhase = .retired
        case .retained, .retired:
            break
        }
    }

    func failNavigation() {
        // A failed initial chain has no reusable page. Retire its alias so
        // opening the original link again starts a fresh load.
        self.requestAliasPhase = .retired
    }

    func observeNavigationState(onChange: @escaping @MainActor () -> Void) {
        // KVO catches late WebKit updates and same-document SPA navigation.
        self.observations = [
            self.webView.observe(\.canGoBack, options: [.new]) { _, _ in
                Task { @MainActor in onChange() }
            },
            self.webView.observe(\.canGoForward, options: [.new]) { _, _ in
                Task { @MainActor in onChange() }
            },
            self.webView.observe(\.isLoading, options: [.new]) { _, _ in
                Task { @MainActor in onChange() }
            },
            self.webView.observe(\.url, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.updateRepresentedURL(self.webView.url)
                    onChange()
                }
            },
            self.webView.observe(\.title, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.title = self.webView.title
                    onChange()
                }
            },
        ]
    }

    func dispose() {
        self.observations.forEach { $0.invalidate() }
        self.observations.removeAll()
        self.webView.navigationDelegate = nil
        self.webView.uiDelegate = nil
        self.webView.stopLoading()
        self.webView.removeFromSuperview()
    }
}
