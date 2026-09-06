import SwiftUI

@MainActor
struct DashboardGatewayCommands: Commands {
    var body: some Commands {
        CommandMenu("Gateways") {
            Button("Manage Gateways…") {
                AppNavigationActions.openConnection(tab: .gateways)
            }
        }
    }
}
