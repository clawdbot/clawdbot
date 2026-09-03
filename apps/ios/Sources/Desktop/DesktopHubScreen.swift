import OpenClawKit
import SwiftUI

/// Control-hub Desktop destination: embeds the gateway-served desktop page in
/// the same authenticated, origin-locked WKWebView used by other Control UI pages.
struct DesktopHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let source: String?
    let session: String?
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let gatewayAction: (() -> Void)?

    init(
        source: String? = nil,
        session: String? = nil,
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        gatewayAction: (() -> Void)? = nil)
    {
        self.source = source
        self.session = session
        self.headerSidebarAction = headerSidebarAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.gatewayAction = gatewayAction
    }

    var body: some View {
        let config = self.appModel.activeGatewayConnectConfig
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: config)
        ZStack {
            OpenClawProBackground()
            if let url = Self.desktopURL(config: config, source: self.source, session: self.session) {
                AuthenticatedControlUIWebView(
                    url: url,
                    authScript: Self.desktopAuthUserScript(
                        config: config,
                        source: self.source,
                        session: self.session,
                        storedOperatorToken: storedOperatorToken),
                    tls: config?.tls)
                    .id(Self.webContentIdentity(
                        config: config,
                        source: self.source,
                        session: self.session,
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
    static func desktopURL(
        config: GatewayConnectConfig?,
        source: String?,
        session: String? = nil) -> URL?
    {
        guard let path = self.desktopPath(source: source, session: session) else { return nil }
        return AuthenticatedControlUI.pageURL(
            config: config,
            path: path,
            queryItems: [])
    }

    static func desktopAuthUserScript(
        config: GatewayConnectConfig?,
        source: String?,
        session: String? = nil) -> String?
    {
        self.desktopAuthUserScript(
            config: config,
            source: source,
            session: session,
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config))
    }

    static func desktopAuthUserScript(
        config: GatewayConnectConfig?,
        source: String?,
        session: String? = nil,
        storedOperatorToken: String?) -> String?
    {
        AuthenticatedControlUI.authUserScript(
            config: config,
            pageURL: self.desktopURL(config: config, source: source, session: session),
            storedOperatorToken: storedOperatorToken)
    }

    static func webContentIdentity(
        config: GatewayConnectConfig?,
        source: String?,
        session: String? = nil,
        storedOperatorToken: String?) -> Int
    {
        var hasher = Hasher()
        hasher.combine(AuthenticatedControlUI.webContentIdentity(
            config: config,
            storedOperatorToken: storedOperatorToken))
        hasher.combine(self.desktopPath(source: source, session: session))
        return hasher.finalize()
    }

    private static func desktopPath(source: String?, session: String?) -> String? {
        let basePath = "/focus/desktop"
        if let source = self.normalizedValue(source) {
            guard let encoded = AuthenticatedControlUI.percentEncodedPathSegment(source) else { return nil }
            return "\(basePath)/source/\(encoded)"
        }
        if let session = self.normalizedValue(session) {
            guard let encoded = AuthenticatedControlUI.percentEncodedPathSegment(session) else { return nil }
            return "\(basePath)/session/\(encoded)"
        }
        return basePath
    }

    private static func normalizedValue(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
