import SwiftUI

struct ConnectionWindow: View {
    static let width: CGFloat = 840
    static let height: CGFloat = 640

    @Bindable var state: AppState
    @Bindable var opener: ConnectionWindowOpener = .shared

    var body: some View {
        Group {
            switch self.opener.selectedTab {
            case .connection:
                ConnectionSettingsView(state: self.state)
            case .gateways:
                GatewaySettings()
            case .debug:
                if self.state.debugPaneEnabled {
                    DebugSettings(state: self.state)
                }
            }
        }
        .padding(20)
        .frame(minWidth: 780, maxWidth: .infinity, minHeight: 520, maxHeight: .infinity)
        .defaultAppStorage(AppDefaults.standard)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Connection tabs", selection: self.$opener.selectedTab) {
                    Text("Connection").tag(ConnectionTab.connection)
                    Text("Gateways").tag(ConnectionTab.gateways)
                    if self.state.debugPaneEnabled {
                        Text("Debug").tag(ConnectionTab.debug)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
        }
        .onChange(of: self.state.debugPaneEnabled, initial: true) { _, enabled in
            if !enabled, self.opener.selectedTab == .debug {
                self.opener.selectedTab = .connection
            }
        }
    }
}
