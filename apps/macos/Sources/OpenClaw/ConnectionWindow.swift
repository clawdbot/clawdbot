import SwiftUI

/// Standard macOS Settings window: toolbar tabs, fixed width, content-sized height per tab.
struct ConnectionWindow: View {
    static let width: CGFloat = 660

    @Bindable var state: AppState
    @Bindable var opener: ConnectionWindowOpener = .shared

    var body: some View {
        TabView(selection: self.$opener.selectedTab) {
            Tab("Connection", systemImage: "point.3.connected.trianglepath.dotted", value: ConnectionTab.connection) {
                ConnectionSettingsView(state: self.state, isActive: self.opener.selectedTab == .connection)
                    .frame(width: Self.width, height: 700)
            }
            Tab("Gateways", systemImage: "server.rack", value: ConnectionTab.gateways) {
                GatewaySettings()
                    .frame(width: Self.width, height: 360)
            }
            if self.state.debugPaneEnabled {
                Tab("Debug", systemImage: "ladybug", value: ConnectionTab.debug) {
                    DebugSettings(state: self.state)
                        .frame(width: Self.width, height: 720)
                }
            }
        }
        .defaultAppStorage(AppDefaults.standard)
        .onChange(of: self.state.debugPaneEnabled, initial: true) { _, enabled in
            if !enabled, self.opener.selectedTab == .debug {
                self.opener.selectedTab = .connection
            }
        }
    }
}
