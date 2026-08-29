import Foundation
import OpenClawKit
import SwiftUI
import WebKit

/// URL, credential, and WebView plumbing shared by authenticated Control UI pages.
enum AuthenticatedControlUI {
    private struct StoredOperatorAuthorization {
        let identity: DeviceIdentity
        let entry: DeviceAuthEntry
    }

    private static let queryComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    private static let pathSegmentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!'()*")

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
        components.percentEncodedQuery = encodedItems.isEmpty
            ? nil
            : encodedItems.joined(separator: "&")
        return components.url
    }

    static func percentEncodedPathSegment(_ value: String) -> String? {
        value.addingPercentEncoding(withAllowedCharacters: self.pathSegmentAllowed)
    }

    /// Origin-gated document-start script for the Control UI native-auth contract.
    static func authUserScript(
        config: GatewayConnectConfig?,
        pageURL: URL?,
        storedOperatorToken: String?,
        usesNativeNavigationChrome: Bool = false) -> String?
    {
        guard let config, let pageURL else { return nil }
        var payload: [String: Any] = ["gatewayUrl": config.url.absoluteString]
        let token = config.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let storedToken = storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let password = config.password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let storedAuthorization = Self.storedOperatorAuthorization(
            config: config,
            expectedToken: storedToken)
        if let storedAuthorization {
            payload["client"] = [
                "id": config.nodeOptions.clientId,
                "mode": "ui",
                "platform": InstanceIdentity.platformString,
                "deviceFamily": InstanceIdentity.deviceFamily,
                "instanceId": InstanceIdentity.instanceId,
                "scopes": storedAuthorization.entry.scopes,
            ]
        }
        if storedAuthorization == nil, !token.isEmpty {
            payload["token"] = token
        } else if storedAuthorization == nil, !storedToken.isEmpty {
            payload["token"] = storedToken
        }
        if storedAuthorization == nil, !password.isEmpty {
            payload["password"] = password
        }
        guard payload["token"] != nil || payload["password"] != nil || storedAuthorization != nil else {
            return nil
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        let deviceAuthSeed = storedAuthorization.flatMap { Self.deviceAuthSeed(
            gatewayURL: config.url,
            authorization: $0)
        } ?? "null"
        let allowedOrigin = Self.jsStringLiteral(Self.originString(for: pageURL))
        return """
        (() => {
          try {
            if (location.origin !== \(allowedOrigin)) return;
            const deviceAuthSeed = \(deviceAuthSeed);
            if (deviceAuthSeed) {
              const gateway = new URL(deviceAuthSeed.gatewayUrl, location.href);
              gateway.hash = "";
              const path = gateway.pathname === "/"
                ? ""
                : gateway.pathname.replace(/\\/+$/, "") || gateway.pathname;
              const scope = `${gateway.protocol}//${gateway.host}${path}${gateway.search}`;
              localStorage.setItem(
                "openclaw-device-identity-v1",
                JSON.stringify(deviceAuthSeed.identity));
              localStorage.setItem(
                `openclaw.device.auth.v1:${scope}`,
                JSON.stringify(deviceAuthSeed.authorization));
              localStorage.removeItem("openclaw.device.auth.v1");
            }
            if (\(usesNativeNavigationChrome)) {
              Object.defineProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__", {
                value: true,
                configurable: true,
              });
            }
            Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
              value: \(json),
              configurable: true,
            });
          } catch {}
        })();
        """
    }

    static func storedOperatorToken(config: GatewayConnectConfig?) -> String? {
        self.storedOperatorAuthorization(config: config)?.entry.token
    }

    static func webContentIdentity(config: GatewayConnectConfig?, storedOperatorToken: String?) -> Int {
        var hasher = Hasher()
        hasher.combine(config?.url)
        hasher.combine(config?.tls?.required)
        hasher.combine(config?.tls?.expectedFingerprint)
        hasher.combine(config?.tls?.allowTOFU)
        hasher.combine(config?.tls?.storeKey)
        hasher.combine(config?.token)
        hasher.combine(config?.password)
        hasher.combine(storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines))
        return hasher.finalize()
    }

    private static func percentEncodedQueryComponent(_ value: String) -> String? {
        value.addingPercentEncoding(withAllowedCharacters: self.queryComponentAllowed)
    }

    private static func originString(for url: URL) -> String {
        GatewayTLSAuthority(url: url)?.serialized ?? ""
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

    private static func storedOperatorAuthorization(
        config: GatewayConnectConfig?,
        expectedToken: String? = nil) -> StoredOperatorAuthorization?
    {
        guard let config else { return nil }
        // Endpoint handoffs may explicitly suppress device-token reuse; every auth surface
        // must honor that boundary or a stale token can override the supplied password.
        guard config.nodeOptions.includeDeviceIdentity,
              config.nodeOptions.allowStoredDeviceAuth
        else { return nil }
        let profile = config.nodeOptions.deviceIdentityProfile
        let gatewayID = config.nodeOptions.deviceAuthGatewayID ?? config.effectiveStableID
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: profile),
              let entry = DeviceAuthStore.loadToken(
                  deviceId: identity.deviceId,
                  role: "operator",
                  gatewayID: gatewayID,
                  profile: profile)
        else { return nil }
        if let expectedToken,
           entry.token.trimmingCharacters(in: .whitespacesAndNewlines) != expectedToken
        {
            return nil
        }
        return StoredOperatorAuthorization(identity: identity, entry: entry)
    }

    private static func deviceAuthSeed(
        gatewayURL: URL,
        authorization: StoredOperatorAuthorization) -> String?
    {
        guard let publicKey = base64URL(authorization.identity.publicKey),
              let privateKey = base64URL(authorization.identity.privateKey)
        else { return nil }
        let identity: [String: Any] = [
            "version": 1,
            "deviceId": authorization.identity.deviceId,
            "publicKey": publicKey,
            "privateKey": privateKey,
            "createdAtMs": authorization.identity.createdAtMs,
        ]
        let entry: [String: Any] = [
            "token": authorization.entry.token,
            "role": "operator",
            "scopes": authorization.entry.scopes,
            "updatedAtMs": authorization.entry.updatedAtMs,
        ]
        let seed: [String: Any] = [
            "gatewayUrl": gatewayURL.absoluteString,
            "identity": identity,
            "authorization": [
                "version": 1,
                "deviceId": authorization.identity.deviceId,
                "tokens": ["operator": entry],
            ],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: seed) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func base64URL(_ value: String) -> String? {
        guard let data = Data(base64Encoded: value) else { return nil }
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
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

@MainActor
enum AuthenticatedControlUIWebViewNavigationDecision: Equatable {
    case allow
    case cancel
    case cancelAndExitScope
}

@MainActor
final class AuthenticatedControlUIWebViewCoordinator: NSObject, WKNavigationDelegate {
    private let expectedOrigin: GatewayTLSAuthority?
    private let allowedMainFramePathPrefix: String?
    private let onMainFrameNavigationOutsideScope: (() -> Void)?
    private let tls: GatewayTLSParams?
    private var hasExitedNavigationScope = false

    init(
        url: URL,
        tls: GatewayTLSParams?,
        allowedMainFramePathPrefix: String? = nil,
        onMainFrameNavigationOutsideScope: (() -> Void)? = nil)
    {
        self.expectedOrigin = GatewayTLSAuthority(url: url)
        self.allowedMainFramePathPrefix = allowedMainFramePathPrefix.map(Self.normalizedPath)
        self.onMainFrameNavigationOutsideScope = onMainFrameNavigationOutsideScope
        self.tls = tls
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        let decision = self.navigationDecision(
            to: navigationAction.request.url,
            isMainFrame: navigationAction.targetFrame?.isMainFrame)
        decisionHandler(decision == .allow ? .allow : .cancel)
        if decision == .cancelAndExitScope, !self.hasExitedNavigationScope {
            self.hasExitedNavigationScope = true
            self.onMainFrameNavigationOutsideScope?()
        }
    }

    func webView(
        _: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition,
            URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let tls
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard self.matchesExpectedAuthority(
            host: challenge.protectionSpace.host,
            port: challenge.protectionSpace.port)
        else {
            // Cross-origin main-frame loads are already cancelled by navigation policy.
            // Other authorities may belong to embedded content and do not inherit the Gateway pin.
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        switch GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: challenge.protectionSpace.host,
            port: challenge.protectionSpace.port,
            params: tls)
        {
        case .accept:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .reject:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func allowsNavigation(to candidateURL: URL?, isMainFrame: Bool?) -> Bool {
        self.navigationDecision(to: candidateURL, isMainFrame: isMainFrame) == .allow
    }

    func navigationDecision(
        to candidateURL: URL?,
        isMainFrame: Bool?) -> AuthenticatedControlUIWebViewNavigationDecision
    {
        if isMainFrame == false {
            return .allow
        }
        guard isMainFrame == true, let candidateURL else { return .cancel }
        guard GatewayTLSAuthority(url: candidateURL) == self.expectedOrigin else { return .cancel }
        guard let allowedMainFramePathPrefix else { return .allow }
        let candidatePath = Self.normalizedPath(candidateURL.path)
        guard allowedMainFramePathPrefix != "/" else { return .allow }
        return candidatePath == allowedMainFramePathPrefix ||
            candidatePath.hasPrefix(allowedMainFramePathPrefix + "/")
            ? .allow
            : .cancelAndExitScope
    }

    func matchesExpectedAuthority(host: String, port: Int) -> Bool {
        self.expectedOrigin?.matches(host: host, port: port) == true
    }

    private static func normalizedPath(_ path: String) -> String {
        var segments: [Substring] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            switch segment {
            case ".":
                continue
            case "..":
                if !segments.isEmpty {
                    segments.removeLast()
                }
            default:
                segments.append(segment)
            }
        }
        return "/" + segments.joined(separator: "/")
    }
}

/// Ephemeral, script-hardened WKWebView for a self-contained Control UI page.
struct AuthenticatedControlUIWebView: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme

    let url: URL
    let authScript: String?
    let tls: GatewayTLSParams?
    let allowedMainFramePathPrefix: String?
    let onMainFrameNavigationOutsideScope: (() -> Void)?

    init(
        url: URL,
        authScript: String?,
        tls: GatewayTLSParams?,
        allowedMainFramePathPrefix: String? = nil,
        onMainFrameNavigationOutsideScope: (() -> Void)? = nil)
    {
        self.url = url
        self.authScript = authScript
        self.tls = tls
        self.allowedMainFramePathPrefix = allowedMainFramePathPrefix
        self.onMainFrameNavigationOutsideScope = onMainFrameNavigationOutsideScope
    }

    func makeCoordinator() -> AuthenticatedControlUIWebViewCoordinator {
        AuthenticatedControlUIWebViewCoordinator(
            url: self.url,
            tls: self.tls,
            allowedMainFramePathPrefix: self.allowedMainFramePathPrefix,
            onMainFrameNavigationOutsideScope: self.onMainFrameNavigationOutsideScope)
    }

    func makeUIView(context: Context) -> WKWebView {
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
        self.applyAppearance(to: webView)
        webView.navigationDelegate = context.coordinator
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

    func updateUIView(_ webView: WKWebView, context _: Context) {
        self.applyAppearance(to: webView)
        // Connection changes recreate the view via `.id`; unrelated SwiftUI passes must not reload it.
    }

    private func applyAppearance(to webView: WKWebView) {
        webView.overrideUserInterfaceStyle = self.colorScheme == .dark ? .dark : .light
    }

    static func dismantleUIView(
        _ webView: WKWebView,
        coordinator _: AuthenticatedControlUIWebViewCoordinator)
    {
        webView.stopLoading()
        webView.navigationDelegate = nil
    }
}
