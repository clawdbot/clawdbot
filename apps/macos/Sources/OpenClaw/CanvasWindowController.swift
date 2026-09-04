import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import WebKit

@MainActor
final class CanvasWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    let sessionKey: String
    private let root: URL
    private let sessionDir: URL
    private let schemeHandler: CanvasSchemeHandler
    let webView: WKWebView
    private let watcher: CanvasFileWatcher
    private let container: HoverChromeContainerView
    let presentation: CanvasPresentation
    var preferredPlacement: CanvasPlacement?
    private var debugStatusEnabled = false
    private var debugStatusTitle: String?
    private var debugStatusSubtitle: String?
    private var canvasVisible = false
    private var watchesLocalCanvasFiles = false

    var onVisibilityChanged: ((Bool) -> Void)?

    init(sessionKey: String, root: URL, presentation: CanvasPresentation) throws {
        self.sessionKey = sessionKey
        self.root = root
        self.presentation = presentation

        canvasWindowLogger.debug("CanvasWindowController init start session=\(sessionKey, privacy: .public)")
        let safeSessionKey = CanvasWindowController.sanitizeSessionKey(sessionKey)
        canvasWindowLogger.debug("CanvasWindowController init sanitized session=\(safeSessionKey, privacy: .public)")
        self.sessionDir = root.appendingPathComponent(safeSessionKey, isDirectory: true)
        try FileManager().createDirectory(at: self.sessionDir, withIntermediateDirectories: true)
        canvasWindowLogger.debug("CanvasWindowController init session dir ready")

        self.schemeHandler = CanvasSchemeHandler(root: root)
        canvasWindowLogger.debug("CanvasWindowController init scheme handler ready")

        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.tabFocusesLinks = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        canvasWindowLogger.debug("CanvasWindowController init config ready")
        for scheme in CanvasScheme.allSchemes {
            config.setURLSchemeHandler(self.schemeHandler, forURLScheme: scheme)
        }
        canvasWindowLogger.debug("CanvasWindowController init scheme handler installed")

        canvasWindowLogger.debug("CanvasWindowController init creating WKWebView")
        self.webView = WKWebView(frame: .zero, configuration: config)
        // Presented documents render against an opaque surface.
        self.webView.setValue(true, forKey: "drawsBackground")

        let sessionDir = self.sessionDir
        let webView = self.webView
        self.watcher = CanvasFileWatcher(url: sessionDir) { [weak webView] in
            Task { @MainActor in
                guard let webView else { return }

                // Only auto-reload when we are showing local canvas content.
                guard let scheme = webView.url?.scheme,
                      CanvasScheme.allSchemes.contains(scheme) else { return }

                let path = webView.url?.path ?? ""
                if path == "/" || path.isEmpty {
                    let indexA = sessionDir.appendingPathComponent("index.html", isDirectory: false)
                    let indexB = sessionDir.appendingPathComponent("index.htm", isDirectory: false)
                    if !FileManager().fileExists(atPath: indexA.path),
                       !FileManager().fileExists(atPath: indexB.path)
                    {
                        return
                    }
                }

                webView.reload()
            }
        }

        self.container = HoverChromeContainerView(containing: self.webView)
        let window = Self.makeWindow(for: presentation, contentView: self.container)
        canvasWindowLogger.debug("CanvasWindowController init makeWindow done")
        super.init(window: window)

        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        self.window?.delegate = self
        self.container.onClose = { [weak self] in
            self?.hideCanvas()
        }

        // Keep event delivery active while hidden so file changes are not lost.
        // The recursive polling fallback is enabled only for visible local Canvas content.
        self.watcher.startEventStream()
        canvasWindowLogger.debug("CanvasWindowController init done")
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @MainActor deinit {
        self.watcher.stop()
    }

    func applyPreferredPlacement(_ placement: CanvasPlacement?) {
        self.preferredPlacement = placement
    }

    func showCanvas(path: String? = nil) {
        if case let .panel(anchorProvider) = presentation {
            presentAnchoredPanel(anchorProvider: anchorProvider)
            if let path {
                self.load(target: path)
            }
            return
        }

        // The window is built in init, so skip showWindow(_:); it would make the
        // window key and steal focus from the user's current window.
        window?.orderFrontRegardless()
        if let path {
            self.load(target: path)
        }
        self.setCanvasVisible(true)
    }

    func hideCanvas() {
        if case .panel = self.presentation {
            persistFrameIfPanel()
        }
        window?.orderOut(nil)
        self.setCanvasVisible(false)
    }

    func load(target: String) {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)

        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            if CanvasScheme.allSchemes.contains(scheme) {
                canvasWindowLogger.debug("canvas load app-local URL")
                self.webView.load(URLRequest(url: url))
                return
            }
            if scheme == "https" || scheme == "http" {
                canvasWindowLogger.debug(
                    "canvas load web scheme=\(scheme, privacy: .public) host=\(url.host ?? "-", privacy: .public)")
                self.webView.load(URLRequest(url: url))
                return
            }
        }

        guard let url = CanvasScheme.makeURL(
            session: CanvasWindowController.sanitizeSessionKey(sessionKey),
            path: trimmed)
        else {
            canvasWindowLogger
                .error(
                    "invalid canvas url session=\(self.sessionKey, privacy: .public)")
            return
        }
        canvasWindowLogger.debug("canvas load local canvas")
        self.webView.load(URLRequest(url: url))
    }

    func setCanvasVisible(_ visible: Bool) {
        self.canvasVisible = visible
        self.updateFilePolling()
        self.onVisibilityChanged?(visible)
    }

    func updateFilePollingForCommittedNavigation(to url: URL) {
        // Requested navigations can fail or redirect, so polling follows the
        // committed main-frame document rather than the requested target.
        self.watchesLocalCanvasFiles = CanvasScheme.allSchemes.contains(url.scheme?.lowercased() ?? "")
        self.updateFilePolling()
    }

    private func updateFilePolling() {
        self.watcher.setPollingEnabled(self.canvasVisible && self.watchesLocalCanvasFiles)
    }

    var _testIsFilePollingActive: Bool {
        self.watcher.isPolling
    }

    func updateDebugStatus(enabled: Bool, title: String?, subtitle: String?) {
        self.debugStatusEnabled = enabled
        self.debugStatusTitle = title
        self.debugStatusSubtitle = subtitle
        self.applyDebugStatusIfNeeded()
    }

    func applyDebugStatusIfNeeded() {
        WebViewJavaScriptSupport.applyDebugStatus(
            webView: self.webView,
            enabled: self.debugStatusEnabled,
            title: self.debugStatusTitle,
            subtitle: self.debugStatusSubtitle)
    }

    var directoryPath: String {
        self.sessionDir.path
    }
}
