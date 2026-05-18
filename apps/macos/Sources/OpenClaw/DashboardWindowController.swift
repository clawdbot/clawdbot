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
        self.window?.performDrag(with: event)
    }
}

@MainActor
final class DashboardWindowController: NSWindowController, WKNavigationDelegate, NSWindowDelegate {
    private let webView: WKWebView
    private var currentURL: URL
    private var auth: DashboardWindowAuth

    init(url: URL, auth: DashboardWindowAuth) {
        self.currentURL = url
        self.auth = auth

        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController = WKUserContentController()
        Self.installNativeChromeScript(into: config.userContentController)
        Self.installNativeAuthScript(into: config.userContentController, url: url, auth: auth)

        self.webView = WKWebView(
            frame: NSRect(origin: .zero, size: DashboardWindowLayout.windowSize),
            configuration: config)
        self.webView.setValue(true, forKey: "drawsBackground")

        let window = Self.makeWindow(contentView: self.webView)
        super.init(window: window)

        self.webView.navigationDelegate = self
        self.window?.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(url: URL, auth: DashboardWindowAuth) {
        self.currentURL = url
        self.auth = auth
        self.refreshNativeAuthScript(url: url, auth: auth)
        self.load(url)
        self.show()
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
        self.showWindow(nil)
        self.window?.makeKeyAndOrderFront(nil)
        self.window?.makeFirstResponder(self.webView)
        self.window?.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func closeDashboard() {
        self.window?.performClose(nil)
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
        dashboardWindowLogger.debug("dashboard load \(url.absoluteString, privacy: .public)")
        self.webView.load(URLRequest(url: url))
    }

    private func refreshNativeAuthScript(url: URL, auth: DashboardWindowAuth) {
        let controller = self.webView.configuration.userContentController
        controller.removeAllUserScripts()
        Self.installNativeChromeScript(into: controller)
        Self.installNativeAuthScript(into: controller, url: url, auth: auth)
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
            topDragRegion.heightAnchor.constraint(equalToConstant: 28),
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
          html.openclaw-native-macos .sidebar-shell {
            padding-top: max(14px, var(--openclaw-native-titlebar-height)) !important;
          }
          html.openclaw-native-macos .sidebar-shell__header {
            padding-left: 10px !important;
            padding-right: 8px !important;
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

    private static func allowedPath(for url: URL) -> String {
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
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if Self.shouldAllowNavigation(to: url, dashboardURL: self.currentURL) {
            decisionHandler(.allow)
            return
        }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.showLoadFailure(error)
    }

    func webView(_: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.showLoadFailure(error)
    }

    static func shouldAllowNavigation(to url: URL, dashboardURL: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if scheme == "about" || scheme == "blob" || scheme == "data" { return true }
        guard scheme == "http" || scheme == "https" else { return false }
        return url.scheme?.lowercased() == dashboardURL.scheme?.lowercased() &&
            url.host?.lowercased() == dashboardURL.host?.lowercased() &&
            url.port == dashboardURL.port
    }

    func windowWillClose(_: Notification) {
        self.webView.stopLoading()
    }

    private func showLoadFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
        dashboardWindowLogger.error(
            "dashboard load failed url=\(self.currentURL.absoluteString, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
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
