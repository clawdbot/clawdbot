import OpenClawKit
import SwiftUI

/// Session-scoped dashboard rendered by the gateway Control UI.
struct SessionDashboardScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var showsDesktop = false
    let sessionKey: String

    var body: some View {
        let config = self.appModel.activeGatewayConnectConfig
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: config)
        ZStack {
            OpenClawProBackground()
            if let url = Self.dashboardURL(config: config, sessionKey: self.sessionKey) {
                AuthenticatedControlUIWebView(
                    url: url,
                    authScript: AuthenticatedControlUI.authUserScript(
                        config: config,
                        pageURL: url,
                        storedOperatorToken: storedOperatorToken,
                        usesNativeNavigationChrome: true),
                    tls: config?.tls,
                    allowedMainFramePathPrefix: Self.dashboardPathPrefix(config: config),
                    onMainFrameNavigationOutsideScope: {
                        self.dismiss()
                    })
                    .id(AuthenticatedControlUI.webContentIdentity(
                        config: config,
                        storedOperatorToken: storedOperatorToken))
                    .ignoresSafeArea(.container, edges: .bottom)
            } else {
                self.unavailableCard
            }
        }
        .navigationTitle("Dashboard")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if self.appModel.isDesktopObserveAvailable {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.showsDesktop = true
                    } label: {
                        Image(systemName: "display")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .accessibilityLabel("Open Desktop")
                    .accessibilityIdentifier("SessionDashboard.Desktop")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    self.dismiss()
                } label: {
                    Text("Done")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
        }
        .navigationDestination(isPresented: self.$showsDesktop) {
            DesktopHubScreen(session: self.sessionKey, usesNativeNavigationChrome: true)
        }
    }

    private var unavailableCard: some View {
        VStack(spacing: 12) {
            ProIconBadge(systemName: "rectangle.grid.2x2", color: OpenClawBrand.accent)
            Text("Dashboard needs a connected gateway")
                .font(OpenClawType.subheadSemiBold)
            Text("Connect to your gateway to open this session dashboard.")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
    }

    /// Converts the active gateway WebSocket endpoint into the shell-free
    /// dashboard focus route. Credentials stay in the startup script.
    static func dashboardURL(config: GatewayConnectConfig?, sessionKey: String) -> URL? {
        let parts = sessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3,
              parts[0].lowercased() == "agent",
              parts.dropFirst().allSatisfy({ !$0.isEmpty })
        else { return nil }

        let encodedSegments = parts.dropFirst().map { part -> String? in
            if part == "." {
                return "~dot"
            }
            if part == ".." {
                return "~dotdot"
            }
            guard let encoded = AuthenticatedControlUI.percentEncodedPathSegment(String(part)) else {
                return nil
            }
            let escaped = encoded.replacingOccurrences(of: ".", with: "%2E")
            return escaped.hasPrefix("~") ? "~\(escaped)" : escaped
        }
        let routeSegments = encodedSegments.compactMap(\.self)
        guard routeSegments.count == encodedSegments.count,
              let encodedAgent = routeSegments.first
        else { return nil }
        let route = (["focus", "dashboard", encodedAgent, "~key"] + routeSegments.dropFirst())
            .joined(separator: "/")
        return AuthenticatedControlUI.pageURL(
            config: config,
            path: route,
            queryItems: [])
    }

    static func dashboardPathPrefix(config: GatewayConnectConfig?) -> String? {
        AuthenticatedControlUI.pageURL(
            config: config,
            path: "focus/dashboard",
            queryItems: [])?.path
    }
}
