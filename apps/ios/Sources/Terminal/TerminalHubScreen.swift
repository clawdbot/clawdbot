import OpenClawKit
import SwiftUI
import WebKit

/// Control-hub Terminal destination: embeds the gateway-served terminal page
/// (`/?view=terminal`, the ghostty-web surface shared with the Control UI) in a
/// WKWebView, authenticated with the stored gateway credentials.
struct TerminalHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let usesNativeNavigationChrome: Bool
    let gatewayAction: (() -> Void)?

    init(
        usesNativeNavigationChrome: Bool = false,
        gatewayAction: (() -> Void)? = nil)
    {
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.gatewayAction = gatewayAction
    }

    var body: some View {
        let config = self.appModel.activeGatewayConnectConfig
        let storedOperatorToken = Self.storedOperatorToken(config: config)
        ZStack {
            OpenClawProBackground()
            if let url = Self.terminalURL(config: config) {
                TerminalWebView(
                    url: url,
                    authScript: Self.terminalAuthUserScript(
                        config: config,
                        storedOperatorToken: storedOperatorToken))
                    // Recreate the web view only when the connection inputs
                    // change; SwiftUI update passes must not restart live shells.
                        .id(Self.webContentIdentity(
                            config: config,
                            storedOperatorToken: storedOperatorToken))
                        .ignoresSafeArea(.container, edges: .bottom)
            } else {
                self.unavailableCard
            }
        }
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(self.usesNativeNavigationChrome ? .visible : .hidden, for: .navigationBar)
        .toolbar {
            if self.usesNativeNavigationChrome, let gatewayAction {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: gatewayAction) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .accessibilityLabel("Gateway settings")
                }
            }
        }
    }

    private var unavailableCard: some View {
        VStack(spacing: 12) {
            ProIconBadge(systemName: "terminal", color: OpenClawBrand.accent)
            Text("Terminal needs a connected gateway")
                .font(OpenClawType.subheadSemiBold)
            Text("Connect to your gateway to open a shell in the agent workspace.")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let gatewayAction {
                Button(action: gatewayAction) {
                    Text("Open Gateway Settings")
                        .font(OpenClawType.subheadSemiBold)
                }
                .buttonStyle(.borderedProminent)
                .tint(OpenClawBrand.accent)
            }
        }
        .padding(24)
    }

    /// Derives the terminal page URL from the active gateway connection: the
    /// WS endpoint flips to HTTP(S) and only `view=terminal` rides in the URL.
    /// Credentials never enter the URL — they are injected as a document-start
    /// user script (see `terminalAuthUserScript`), matching the macOS Dashboard.
    static func terminalURL(config: GatewayConnectConfig?) -> URL? {
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
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "view", value: "terminal")]
        return components.url
    }

    /// Origin-gated document-start script that hands the gateway credentials to
    /// the Control UI via its `__OPENCLAW_NATIVE_CONTROL_AUTH__` startup contract
    /// (the same mechanism the macOS Dashboard window uses), so the token never
    /// appears in the page URL, WebKit history, or gateway request logs.
    static func terminalAuthUserScript(config: GatewayConnectConfig?) -> String? {
        self.terminalAuthUserScript(
            config: config,
            storedOperatorToken: self.storedOperatorToken(config: config))
    }

    static func terminalAuthUserScript(
        config: GatewayConnectConfig?,
        storedOperatorToken: String?) -> String?
    {
        guard let config, let pageURL = terminalURL(config: config) else {
            return nil
        }
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
        guard payload["token"] != nil || payload["password"] != nil else {
            return nil
        }
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

    /// Identity for the embedded web view: recreate it only when the gateway
    /// endpoint or credentials actually change.
    static func webContentIdentity(config: GatewayConnectConfig?, storedOperatorToken: String?) -> Int {
        var hasher = Hasher()
        hasher.combine(config?.url)
        hasher.combine(config?.token)
        hasher.combine(config?.password)
        hasher.combine(storedOperatorToken?.trimmingCharacters(in: .whitespacesAndNewlines))
        return hasher.finalize()
    }

    private static func storedOperatorToken(config: GatewayConnectConfig?) -> String? {
        guard let config else { return nil }
        // Endpoint handoffs may explicitly suppress device-token reuse; every auth surface
        // must honor that boundary or a stale token can override the supplied password.
        guard config.nodeOptions.allowStoredDeviceAuth else { return nil }
        let gatewayID = config.nodeOptions.deviceAuthGatewayID ?? config.effectiveStableID
        let identity = DeviceIdentityStore.loadOrCreate()
        return DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "operator",
            gatewayID: gatewayID)?
            .token
    }

    static func originString(for url: URL) -> String {
        guard let scheme = url.scheme, let host = url.host else {
            return ""
        }
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
}

/// Minimal WKWebView host for the terminal page. Unlike the canvas WebView it
/// needs no script bridges or deep-link routing — the page is self-contained.
private struct TerminalWebView: UIViewRepresentable {
    let url: URL
    let authScript: String?

    func makeUIView(context _: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Ephemeral store: credentials arrive per load via the auth user
        // script; nothing needs to persist across loads.
        config.websiteDataStore = .nonPersistent()
        if let authScript {
            config.userContentController.addUserScript(WKUserScript(
                source: authScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = true
        webView.backgroundColor = .black

        let scrollView = webView.scrollView
        scrollView.backgroundColor = .black
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentInset = .zero
        scrollView.verticalScrollIndicatorInsets = .zero
        scrollView.horizontalScrollIndicatorInsets = .zero
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false

        webView.load(URLRequest(url: self.url))
        return webView
    }

    func updateUIView(_: WKWebView, context _: Context) {
        // Connection changes recreate the view via `.id(webContentIdentity)`;
        // reloading here would restart live shell sessions on unrelated passes.
    }
}
