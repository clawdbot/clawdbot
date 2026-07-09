import Foundation
#if canImport(WebKit)
import WebKit

public enum WebViewJavaScriptSupport {
    @MainActor
    public static func applyDebugStatus(
        webView: WKWebView,
        enabled: Bool,
        title: String?,
        subtitle: String?)
    {
        let js = """
        (() => {
          try {
            const api = globalThis.__openclaw;
            if (!api) return;
            if (typeof api.setDebugStatusEnabled === 'function') {
              api.setDebugStatusEnabled(\(enabled ? "true" : "false"));
            }
            if (!\(enabled ? "true" : "false")) return;
            if (typeof api.setStatus === 'function') {
              api.setStatus(\(self.jsValue(title)), \(self.jsValue(subtitle)));
            }
          } catch (_) {}
        })()
        """
        webView.evaluateJavaScript(js) { _, _ in }
    }

    @MainActor
    public static func evaluateToString(webView: WKWebView, javaScript: String) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            webView.evaluateJavaScript(javaScript) { result, error in
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

    public static func jsValue(_ value: String?) -> String {
        guard let value else { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: [value]),
           let encoded = String(data: data, encoding: .utf8),
           encoded.count >= 2
        {
            return String(encoded.dropFirst().dropLast())
        }
        return "null"
    }
}
#endif
