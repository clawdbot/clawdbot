import OpenClawKit
import SwiftUI

/// Session-scoped dashboard rendered by the gateway Control UI.
struct SessionDashboardScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
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
                        storedOperatorToken: storedOperatorToken))
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
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    self.dismiss()
                } label: {
                    Text("Done")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
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

    /// Converts the active gateway WebSocket endpoint into the one-shot
    /// authenticated Control UI route. Credentials stay in the startup script.
    static func dashboardURL(config: GatewayConnectConfig?, sessionKey: String) -> URL? {
        AuthenticatedControlUI.pageURL(
            config: config,
            path: "/chat",
            queryItems: [
                URLQueryItem(name: "session", value: sessionKey),
                URLQueryItem(name: "face", value: "dashboard"),
            ])
    }
}
