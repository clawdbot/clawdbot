import AppKit
import WebKit

extension CanvasWindowController {
    // MARK: - WKNavigationDelegate

    @MainActor
    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let scheme = url.scheme?.lowercased()

        // Deep links: allow local Canvas content to invoke the agent without bouncing through NSWorkspace.
        if scheme == "moltbot" {
            if self.webView.url?.scheme == CanvasScheme.scheme {
                Task { await DeepLinkHandler.shared.handle(url: url) }
            } else {
                canvasWindowLogger
                    .debug("ignoring deep link from non-canvas page \(url.absoluteString, privacy: .public)")
            }
            decisionHandler(.cancel)
            return
        }

        // Keep web content inside the panel when reasonable.
        // `about:blank` and friends are common internal navigations for WKWebView; never send them to NSWorkspace.
        if scheme == CanvasScheme.scheme
            || scheme == "https"
            || scheme == "http"
            || scheme == "about"
            || scheme == "blob"
            || scheme == "data"
            || scheme == "javascript"
        {
            decisionHandler(.allow)
            return
        }

        // Only open external URLs when there is a registered handler, otherwise macOS will show a confusing
        // "There is no application set to open the URL ..." alert (e.g. for about:blank).
        if let appURL = NSWorkspace.shared.urlForApplication(toOpen: url) {
            NSWorkspace.shared.open(
                [url],
                withApplicationAt: appURL,
                configuration: NSWorkspace.OpenConfiguration(),
                completionHandler: nil)
        } else {
            canvasWindowLogger.debug("no application to open url \(url.absoluteString, privacy: .public)")
        }
        decisionHandler(.cancel)
    }

    func webView(_: WKWebView, didFinish _: WKNavigation?) {
        self.applyDebugStatusIfNeeded()
    }
}
