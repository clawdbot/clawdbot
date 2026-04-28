import Observation
import OpenClawKit
import UIKit
import WebKit

@MainActor
@Observable
final class ScreenController {
    private weak var activeWebView: WKWebView?
    private var trustedRemoteA2UIURL: URL?

    var urlString: String = ""
    var errorText: String?

    /// Callback invoked when an openclaw:// deep link is tapped in the canvas
    var onDeepLink: ((URL) -> Void)?

    /// Callback invoked when the user clicks an A2UI action (e.g. button) inside the canvas web UI.
    var onA2UIAction: (([String: Any]) -> Void)?

    private var debugStatusEnabled: Bool = false
    private var debugStatusTitle: String?
    private var debugStatusSubtitle: String?
    private var homeCanvasStateJSON: String?

    init() {
        self.reload()
    }

    func navigate(to urlString: String, trustA2UIActions: Bool = false) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            self.urlString = ""
            self.trustedRemoteA2UIURL = nil
            self.reload()
            return
        }
        if let url = URL(string: trimmed),
           !url.isFileURL,
           let host = url.host,
           LoopbackHost.isLoopback(host)
        {
            // Never try to load loopback URLs from a remote gateway.
            self.showDefaultCanvas()
            return
        }
        self.urlString = (trimmed == "/" ? "" : trimmed)
        self.trustedRemoteA2UIURL = trustA2UIActions ? Self.normalizeTrustedRemoteA2UIURL(from: trimmed) : nil
        self.reload()
    }

    func reload() {
        self.applyScrollBehavior()
        guard let webView = self.activeWebView else { return }

        let trimmed = self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            guard let url = Self.canvasScaffoldURL else { return }
            self.errorText = nil
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            return
        }

        guard let url = URL(string: trimmed) else {
            self.errorText = "Invalid URL: \(trimmed)"
            return
        }
        self.errorText = nil
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    func showDefaultCanvas() {
        self.urlString = ""
        self.trustedRemoteA2UIURL = nil
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

    func applyDebugStatusIfNeeded() {
        guard let webView = self.activeWebView else { return }
        WebViewJavaScriptSupport.applyDebugStatus(
            webView: webView,
            enabled: self.debugStatusEnabled,
            title: self.debugStatusTitle,
            subtitle: self.debugStatusSubtitle)
    }

    func updateHomeCanvasState(json: String?) {
        self.homeCanvasStateJSON = json
        self.applyHomeCanvasStateIfNeeded()
    }

    func applyHomeCanvasStateIfNeeded() {
        guard let webView = self.activeWebView else { return }
        let payload = self.homeCanvasStateJSON ?? "null"
        let js = """
        (() => {
          try {
            const api = globalThis.__openclaw;
            if (!api || typeof api.renderHome !== 'function') return;
            api.renderHome(\(payload));
          } catch (_) {}
        })()
        """
        webView.evaluateJavaScript(js) { _, _ in }
    }

    func waitForA2UIReady(timeoutMs: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(timeoutMs))
        while clock.now < deadline {
            do {
                let res = try await self.eval(javaScript: """
                (() => {
                  try {
                    const host = globalThis.openclawA2UI;
                    return !!host && typeof host.applyMessages === 'function';
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
        guard let webView = self.activeWebView else {
            throw NSError(domain: "Screen", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "web view unavailable",
            ])
        }
        return try await WebViewJavaScriptSupport.evaluateToString(webView: webView, javaScript: javaScript)
    }

    func snapshotPNGBase64(maxWidth: CGFloat? = nil) async throws -> String {
        let image = try await self.snapshotImage(maxWidth: maxWidth)
        guard let data = image.pngData() else {
            throw NSError(domain: "Screen", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }
        return data.base64EncodedString()
    }

    func snapshotBase64(
        maxWidth: CGFloat? = nil,
        format: OpenClawCanvasSnapshotFormat,
        quality: Double? = nil) async throws -> String
    {
        let image = try await self.snapshotImage(maxWidth: maxWidth)

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

    private func snapshotImage(maxWidth: CGFloat?) async throws -> UIImage {
        let config = WKSnapshotConfiguration()
        if let maxWidth {
            config.snapshotWidth = NSNumber(value: Double(maxWidth))
        }
        guard let webView = self.activeWebView else {
            throw NSError(domain: "Screen", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "web view unavailable",
            ])
        }
        return try await withCheckedThrowingContinuation { cont in
            webView.takeSnapshot(with: config) { image, error in
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
    }

    func attachWebView(_ webView: WKWebView) {
        self.activeWebView = webView
        self.reload()
        self.applyDebugStatusIfNeeded()
        self.applyHomeCanvasStateIfNeeded()
    }

    func detachWebView(_ webView: WKWebView) {
        guard self.activeWebView === webView else { return }
        self.activeWebView = nil
    }

    private static func bundledResourceURL(
        name: String,
        ext: String,
        subdirectory: String)
        -> URL?
    {
        let bundle = OpenClawKitResources.bundle
        return bundle.url(forResource: name, withExtension: ext, subdirectory: subdirectory)
            ?? bundle.url(forResource: name, withExtension: ext)
    }

    private static let canvasScaffoldURL: URL? = ScreenController.bundledResourceURL(
        name: "scaffold",
        ext: "html",
        subdirectory: "CanvasScaffold")

    func isTrustedCanvasUIURL(_ url: URL) -> Bool {
        if url.isFileURL {
            let std = url.standardizedFileURL
            if let expected = Self.canvasScaffoldURL,
               std == expected.standardizedFileURL
            {
                return true
            }
            return false
        }
        guard let trusted = self.trustedRemoteA2UIURL else { return false }
        return Self.normalizeTrustedRemoteA2UIURL(from: url) == trusted
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

    private func applyScrollBehavior() {
        guard let webView = self.activeWebView else { return }
        let trimmed = self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowScroll = !trimmed.isEmpty
        let scrollView = webView.scrollView
        // Default canvas needs raw touch events; external pages should scroll.
        scrollView.isScrollEnabled = allowScroll
        scrollView.bounces = allowScroll
    }

    private static func normalizeTrustedRemoteA2UIURL(from raw: String) -> URL? {
        guard let url = URL(string: raw) else { return nil }
        return self.normalizeTrustedRemoteA2UIURL(from: url)
    }

    private static func normalizeTrustedRemoteA2UIURL(from url: URL) -> URL? {
        guard !url.isFileURL else { return nil }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
            return nil
        }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.scheme = scheme
        components?.host = host.lowercased()
        components?.fragment = nil
        return components?.url
    }
}

extension Double {
    fileprivate func clamped(to range: ClosedRange<Double>) -> Double {
        if self < range.lowerBound { return range.lowerBound }
        if self > range.upperBound { return range.upperBound }
        return self
    }
}
