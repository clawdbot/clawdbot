import Foundation
import OpenClawKit
import SwiftUI
import WebKit

/// URL, credential, and WebView plumbing shared by authenticated Control UI pages.
enum AuthenticatedControlUI {
    private static let queryComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static func pageURL(
        config: GatewayConnectConfig?,
        path: String,
        queryItems: [URLQueryItem]) -> URL?
    {
        guard let config,
              var components = URLComponents(url: config.url, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "wss", "https":
            components.scheme = "https"
        default:
            components.scheme = "http"
        }
        components.percentEncodedPath = self.pagePath(basePath: components.percentEncodedPath, path: path)
        components.fragment = nil
        let encodedItems = queryItems.compactMap { item -> String? in
            guard let name = Self.percentEncodedQueryComponent(item.name) else { return nil }
            guard let value = item.value else { return name }
            guard let encodedValue = Self.percentEncodedQueryComponent(value) else { return nil }
            return "\(name)=\(encodedValue)"
        }
        guard encodedItems.count == queryItems.count else { return nil }
        components.percentEncodedQuery = encodedItems.joined(separator: "&")
        return components.url
    }

    /// Origin-gated document-start script for the Control UI native-auth contract.
    static func authUserScript(
        config: GatewayConnectConfig?,
        pageURL: URL?,
        storedOperatorToken: String?) -> String?
    {
        guard let config, let pageURL else { return nil }
        var payload: [String: String] = ["gatewayUrl": config.url.absoluteString]
        let token = config.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let storedToken = storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let password = config.password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !token.isEmpty {
            payload["token"] = token
        } else if !storedToken.isEmpty {
            payload["token"] = storedToken
        }
        if !password.isEmpty {
            payload["password"] = password
        }
        guard payload["token"] != nil || payload["password"] != nil else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        let allowedOrigin = Self.jsStringLiteral(Self.originString(for: pageURL))
        return """
        (() => {
          try {
            if (location.origin !== \(allowedOrigin)) return;
            Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
              value: \(json),
              configurable: true,
            });
          } catch {}
        })();
        """
    }

    static func storedOperatorToken(config: GatewayConnectConfig?) -> String? {
        guard let config else { return nil }
        // Endpoint handoffs may explicitly suppress device-token reuse; every auth surface
        // must honor that boundary or a stale token can override the supplied password.
        guard config.nodeOptions.allowStoredDeviceAuth else { return nil }
        let gatewayID = config.nodeOptions.deviceAuthGatewayID ?? config.effectiveStableID
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted() else { return nil }
        return DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "operator",
            gatewayID: gatewayID)?
            .token
    }

    static func webContentIdentity(config: GatewayConnectConfig?, storedOperatorToken: String?) -> Int {
        var hasher = Hasher()
        hasher.combine(config?.url)
        hasher.combine(config?.token)
        hasher.combine(config?.password)
        hasher.combine(storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines))
        return hasher.finalize()
    }

    private static func percentEncodedQueryComponent(_ value: String) -> String? {
        value.addingPercentEncoding(withAllowedCharacters: self.queryComponentAllowed)
    }

    private static func originString(for url: URL) -> String {
        guard let scheme = url.scheme, let host = url.host else { return "" }
        let hostPart = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        var origin = "\(scheme)://\(hostPart)"
        if let port = url.port {
            origin += ":\(port)"
        }
        return origin
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

    private static func pagePath(basePath rawPath: String, path: String) -> String {
        let withLeadingSlash = rawPath.isEmpty || rawPath.hasPrefix("/") ? rawPath : "/" + rawPath
        let basePath = withLeadingSlash.isEmpty || withLeadingSlash == "/"
            ? "/"
            : withLeadingSlash.hasSuffix("/") ? withLeadingSlash : withLeadingSlash + "/"
        let relativePath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return relativePath.isEmpty ? basePath : basePath + relativePath
    }
}

/// Ephemeral, script-hardened WKWebView for a self-contained Control UI page.
struct AuthenticatedControlUIWebView: UIViewRepresentable {
    let url: URL
    let authScript: String?

    func makeUIView(context _: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        if let authScript {
            configuration.userContentController.addUserScript(WKUserScript(
                source: authScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = true
        webView.backgroundColor = .black
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = true

        let scrollView = webView.scrollView
        scrollView.backgroundColor = .black
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentInset = .zero
        scrollView.verticalScrollIndicatorInsets = .zero
        scrollView.horizontalScrollIndicatorInsets = .zero
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false

        webView.load(URLRequest(url: self.url, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_: WKWebView, context _: Context) {
        // Connection changes recreate the view via `.id`; unrelated SwiftUI passes must not reload it.
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator _: Void) {
        webView.stopLoading()
    }
}
