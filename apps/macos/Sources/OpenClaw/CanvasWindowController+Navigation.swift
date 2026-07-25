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
        if scheme == "openclaw" {
            if let currentScheme = self.webView.url?.scheme,
               CanvasScheme.allSchemes.contains(currentScheme)
            {
                Task { await DeepLinkHandler.shared.handle(url: url) }
            } else {
                canvasWindowLogger.debug("ignoring deep link from non-canvas page")
            }
            decisionHandler(.cancel)
            return
        }

        // Keep web content inside the panel when reasonable.
        // `about:blank` and friends are common internal navigations for WKWebView; never send them to NSWorkspace.
        if CanvasScheme.allSchemes.contains(scheme ?? "")
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
            canvasWindowLogger.debug("no application to open scheme=\(scheme ?? "-", privacy: .public)")
        }
        decisionHandler(.cancel)
    }

    @MainActor
    func webView(
        _: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        // Revoke only once navigation produces a response. Requests canceled
        // above leave the original trusted A2UI document active.
        if navigationResponse.isForMainFrame, let url = navigationResponse.response.url {
            self.updateA2UITrustForMainFrameNavigation(to: url)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit _: WKNavigation?) {
        if let url = webView.url {
            self.updateA2UITrustForMainFrameNavigation(to: url)
        }
    }

    func webView(_: WKWebView, didFinish _: WKNavigation?) {
        self.applyDebugStatusIfNeeded()
    }
}
