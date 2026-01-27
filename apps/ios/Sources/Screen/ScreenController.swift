import MoltbotKit
import Observation
import SwiftUI
import WebKit

@MainActor
@Observable
final class ScreenController {
    let webView: WKWebView
    private let navigationDelegate: ScreenNavigationDelegate
    private let a2uiActionHandler: CanvasA2UIActionMessageHandler

    var urlString: String = ""
    var errorText: String?

    /// Callback invoked when a moltbot:// deep link is tapped in the canvas
    var onDeepLink: ((URL) -> Void)?

    /// Callback invoked when the user clicks an A2UI action (e.g. button) inside the canvas web UI.
    var onA2UIAction: (([String: Any]) -> Void)?

    private var debugStatusEnabled: Bool = false
    private var debugStatusTitle: String?
    private var debugStatusSubtitle: String?

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let a2uiActionHandler = CanvasA2UIActionMessageHandler()
        let userContentController = WKUserContentController()
        for name in CanvasA2UIActionMessageHandler.handlerNames {
            userContentController.add(a2uiActionHandler, name: name)
        }
        config.userContentController = userContentController
        self.navigationDelegate = ScreenNavigationDelegate()
        self.a2uiActionHandler = a2uiActionHandler
        self.webView = WKWebView(frame: .zero, configuration: config)
        // Canvas scaffold is a fully self-contained HTML page; avoid relying on transparency underlays.
        self.webView.isOpaque = true
        self.webView.backgroundColor = .black
        self.webView.scrollView.backgroundColor = .black
        self.webView.scrollView.contentInsetAdjustmentBehavior = .never
        self.webView.scrollView.contentInset = .zero
        self.webView.scrollView.scrollIndicatorInsets = .zero
        self.webView.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        self.applyScrollBehavior()
        self.webView.navigationDelegate = self.navigationDelegate
        self.navigationDelegate.controller = self
        a2uiActionHandler.controller = self
        self.reload()
    }

    func navigate(to urlString: String) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        self.urlString = (trimmed == "/" ? "" : trimmed)
        self.reload()
    }

    func reload() {
        let trimmed = self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        self.applyScrollBehavior()
        if trimmed.isEmpty {
            guard let url = Self.canvasScaffoldURL else { return }
            self.errorText = nil
            self.webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            return
        } else {
            guard let url = URL(string: trimmed) else {
                self.errorText = "Invalid URL: \(trimmed)"
                return
            }
            self.errorText = nil
            if url.isFileURL {
                self.webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            } else {
                self.webView.load(URLRequest(url: url))
            }
        }
    }

    func showDefaultCanvas() {
        self.urlString = ""
        self.reload()
    }

    func setDebugStatusEnabled(_ enabled: Bool) {
        self.debugStatusEnabled = enabled
        self.applyDebugStatusIfNeeded()
    }

    func updateDebugStatus(title: String?, subtitle: String?) {
        self.debugStatusTitle = title
        self.debugStatusSubtitle = subtitle
        self.applyDebugStatusIfNeeded()
    }

    fileprivate func applyDebugStatusIfNeeded() {
        let enabled = self.debugStatusEnabled
        let title = self.debugStatusTitle
        let subtitle = self.debugStatusSubtitle
        let js = """
        (() => {
          try {
            const api = globalThis.__moltbot;
            if (!api) return;
            if (typeof api.setDebugStatusEnabled === 'function') {
              api.setDebugStatusEnabled(\(enabled ? "true" : "false"));
            }
            if (!\(enabled ? "true" : "false")) return;
            if (typeof api.setStatus === 'function') {
              api.setStatus(\(Self.jsValue(title)), \(Self.jsValue(subtitle)));
            }
          } catch (_) {}
        })()
        """
        self.webView.evaluateJavaScript(js) { _, _ in }
    }

    func waitForA2UIReady(timeoutMs: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(timeoutMs))
        while clock.now < deadline {
            do {
                let res = try await self.eval(javaScript: """
                (() => {
                  try {
                    return !!globalThis.clawdbotA2UI && typeof globalThis.clawdbotA2UI.applyMessages === 'function';
                  } catch (_) { return false; }
                })()
                """)
                let trimmed = res.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if trimmed == "true" || trimmed == "1" { return true }
            } catch {
                // ignore; page likely still loading
            }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        return false
    }

    func eval(javaScript: String) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            self.webView.evaluateJavaScript(javaScript) { result, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if let result {
                    cont.resume(returning: String(describing: result))
                } else {
                    cont.resume(returning: "")
                }
            }
        }
    }

    func snapshotPNGBase64(maxWidth: CGFloat? = nil) async throws -> String {
        let config = WKSnapshotConfiguration()
        if let maxWidth {
            config.snapshotWidth = NSNumber(value: Double(maxWidth))
        }
        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            self.webView.takeSnapshot(with: config) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Screen", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot failed",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }
        guard let data = image.pngData() else {
            throw NSError(domain: "Screen", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }
        return data.base64EncodedString()
    }

    func snapshotBase64(
        maxWidth: CGFloat? = nil,
        format: MoltbotCanvasSnapshotFormat,
        quality: Double? = nil) async throws -> String
    {
        let config = WKSnapshotConfiguration()
        if let maxWidth {
            config.snapshotWidth = NSNumber(value: Double(maxWidth))
        }
        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            self.webView.takeSnapshot(with: config) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Screen", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot failed",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }

        let data: Data?
        switch format {
        case .png:
            data = image.pngData()
        case .jpeg:
            let q = (quality ?? 0.82).clamped(to: 0.1...1.0)
            data = image.jpegData(compressionQuality: q)
        }
        guard let data else {
            throw NSError(domain: "Screen", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }
        return data.base64EncodedString()
    }

    private static func bundledResourceURL(
        name: String,
        ext: String,
        subdirectory: String)
        -> URL?
    {
        let bundle = MoltbotKitResources.bundle
        return bundle.url(forResource: name, withExtension: ext, subdirectory: subdirectory)
            ?? bundle.url(forResource: name, withExtension: ext)
    }

    private static let canvasScaffoldURL: URL? = ScreenController.bundledResourceURL(
        name: "scaffold",
        ext: "html",
        subdirectory: "CanvasScaffold")
    func isTrustedCanvasUIURL(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        let std = url.standardizedFileURL
        if let expected = Self.canvasScaffoldURL,
           std == expected.standardizedFileURL
        {
            return true
        }
        return false
    }

    private func applyScrollBehavior() {
        let trimmed = self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowScroll = !trimmed.isEmpty
        let scrollView = self.webView.scrollView
        // Default canvas needs raw touch events; external pages should scroll.
        scrollView.isScrollEnabled = allowScroll
        scrollView.bounces = allowScroll
    }

    private static func jsValue(_ value: String?) -> String {
        guard let value else { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: [value]),
           let encoded = String(data: data, encoding: .utf8),
           encoded.count >= 2
        {
            return String(encoded.dropFirst().dropLast())
        }
        return "null"
    }

    func isLocalNetworkCanvasURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
            return false
        }
        if host == "localhost" { return true }
        if host.hasSuffix(".local") { return true }
        if host.hasSuffix(".ts.net") { return true }
        if host.hasSuffix(".tailscale.net") { return true }
        // Allow MagicDNS / LAN hostnames like "peters-mac-studio-1".
        if !host.contains("."), !host.contains(":") { return true }
        if let ipv4 = Self.parseIPv4(host) {
            return Self.isLocalNetworkIPv4(ipv4)
        }
        return false
    }

    private static func parseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let bytes: [UInt8] = parts.compactMap { UInt8($0) }
        guard bytes.count == 4 else { return nil }
        return (bytes[0], bytes[1], bytes[2], bytes[3])
    }

    private static func isLocalNetworkIPv4(_ ip: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        let (a, b, _, _) = ip
        // 10.0.0.0/8
        if a == 10 { return true }
        // 172.16.0.0/12
        if a == 172, (16...31).contains(Int(b)) { return true }
        // 192.168.0.0/16
        if a == 192, b == 168 { return true }
        // 127.0.0.0/8
        if a == 127 { return true }
        // 169.254.0.0/16 (link-local)
        if a == 169, b == 254 { return true }
        // Tailscale: 100.64.0.0/10
        if a == 100, (64...127).contains(Int(b)) { return true }
        return false
    }

    nonisolated static func parseA2UIActionBody(_ body: Any) -> [String: Any]? {
        if let dict = body as? [String: Any] { return dict.isEmpty ? nil : dict }
        if let str = body as? String,
           let data = str.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            return json.isEmpty ? nil : json
        }
        if let dict = body as? [AnyHashable: Any] {
            let mapped = dict.reduce(into: [String: Any]()) { acc, pair in
                guard let key = pair.key as? String else { return }
                acc[key] = pair.value
            }
            return mapped.isEmpty ? nil : mapped
        }
        return nil
    }
}

extension Double {
    fileprivate func clamped(to range: ClosedRange<Double>) -> Double {
        if self < range.lowerBound { return range.lowerBound }
        if self > range.upperBound { return range.upperBound }
        return self
    }
}

// MARK: - Navigation Delegate

/// Handles navigation policy to intercept moltbot:// deep links from canvas
@MainActor
private final class ScreenNavigationDelegate: NSObject, WKNavigationDelegate {
    weak var controller: ScreenController?

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        // Intercept moltbot:// deep links
        if url.scheme == "moltbot" {
            decisionHandler(.cancel)
            self.controller?.onDeepLink?(url)
            return
        }

        decisionHandler(.allow)
    }

    func webView(
        _: WKWebView,
        didFailProvisionalNavigation _: WKNavigation?,
        withError error: any Error)
    {
        self.controller?.errorText = error.localizedDescription
    }

    func webView(_: WKWebView, didFinish _: WKNavigation?) {
        self.controller?.errorText = nil
        self.controller?.applyDebugStatusIfNeeded()
    }

    func webView(_: WKWebView, didFail _: WKNavigation?, withError error: any Error) {
        self.controller?.errorText = error.localizedDescription
    }
}

private final class CanvasA2UIActionMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "moltbotCanvasA2UIAction"
    static let legacyMessageNames = ["canvas", "a2ui", "userAction", "action"]
    static let handlerNames = [messageName] + legacyMessageNames

    weak var controller: ScreenController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName else { return }
        guard let controller else { return }

        guard let url = message.webView?.url else { return }
        if url.isFileURL {
            guard controller.isTrustedCanvasUIURL(url) else { return }
        } else {
            // For security, only accept actions from local-network pages (e.g. the canvas host).
            guard controller.isLocalNetworkCanvasURL(url) else { return }
        }

        guard let body = ScreenController.parseA2UIActionBody(message.body) else { return }

        controller.onA2UIAction?(body)
    }
}
