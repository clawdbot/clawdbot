import OpenClawKit
import SwiftUI

/// Control-hub Desktop destination: embeds the gateway-served desktop page in
/// the same authenticated, origin-locked WKWebView used by other Control UI pages.
struct DesktopHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let source: String?
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let gatewayAction: (() -> Void)?

    init(
        source: String? = nil,
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        gatewayAction: (() -> Void)? = nil)
    {
        self.source = source
        self.headerSidebarAction = headerSidebarAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.gatewayAction = gatewayAction
    }

    var body: some View {
        let config = self.appModel.activeGatewayConnectConfig
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: config)
        ZStack {
            OpenClawProBackground()
            if let url = Self.desktopURL(config: config, source: self.source) {
                AuthenticatedControlUIWebView(
                    url: url,
                    authScript: Self.desktopAuthUserScript(
                        config: config,
                        source: self.source,
                        storedOperatorToken: storedOperatorToken),
                    tls: config?.tls)
                    .id(Self.webContentIdentity(
                        config: config,
                        source: self.source,
                        storedOperatorToken: storedOperatorToken))
                    .ignoresSafeArea(.container, edges: .bottom)
            } else {
                self.unavailableCard
            }
        }
        .navigationTitle("Desktop")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(
            self.usesNativeNavigationChrome || self.headerSidebarAction != nil ? .visible : .hidden,
            for: .navigationBar)
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
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(
                    action: headerSidebarAction,
                    placement: .topBarLeading)
            }
        }
    }

    private var unavailableCard: some View {
        VStack(spacing: 12) {
            ProIconBadge(systemName: "display", color: OpenClawBrand.accent)
            Text("Desktop needs a connected gateway")
                .font(OpenClawType.subheadSemiBold)
            Text("Connect to your gateway to view an observable machine.")
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

    /// Credentials never enter this URL; the document-start user script carries
    /// them through the Control UI's native-auth contract.
    static func desktopURL(config: GatewayConnectConfig?, source: String?) -> URL? {
        var queryItems = [URLQueryItem(name: "view", value: "desktop")]
        if let source = self.normalizedSource(source) {
            queryItems.append(URLQueryItem(name: "source", value: source))
        }
        return AuthenticatedControlUI.pageURL(
            config: config,
            path: "/",
            queryItems: queryItems)
    }

    static func desktopAuthUserScript(config: GatewayConnectConfig?, source: String?) -> String? {
        self.desktopAuthUserScript(
            config: config,
            source: source,
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config))
    }

    static func desktopAuthUserScript(
        config: GatewayConnectConfig?,
        source: String?,
        storedOperatorToken: String?) -> String?
    {
        AuthenticatedControlUI.authUserScript(
            config: config,
            pageURL: self.desktopURL(config: config, source: source),
            storedOperatorToken: storedOperatorToken)
    }

    static func webContentIdentity(
        config: GatewayConnectConfig?,
        source: String?,
        storedOperatorToken: String?) -> Int
    {
        var hasher = Hasher()
        hasher.combine(AuthenticatedControlUI.webContentIdentity(
            config: config,
            storedOperatorToken: storedOperatorToken))
        hasher.combine(self.normalizedSource(source))
        return hasher.finalize()
    }

    private static func normalizedSource(_ source: String?) -> String? {
        let trimmed = source?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
