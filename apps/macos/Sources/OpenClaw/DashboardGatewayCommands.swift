import SwiftUI

@MainActor
struct DashboardGatewayCommands: Commands {
    @Bindable private var dashboardManager: DashboardManager

    init(dashboardManager: DashboardManager) {
        self._dashboardManager = Bindable(wrappedValue: dashboardManager)
    }

    var body: some Commands {
        let items = DashboardGatewayMenuModel.items(from: self.dashboardManager.gatewayEntries)
        CommandMenu("Gateways") {
            ForEach(items) { item in
                Toggle(item.name, isOn: self.selectionBinding(for: item.target))
                    .keyboardShortcut(item.shortcutNumber.map {
                        KeyboardShortcut(KeyEquivalent(Character(String($0))), modifiers: .command)
                    })
                    .modifierKeyAlternate(.option) {
                        Button(String(format: String(localized: "New %@ Window"), item.name)) {
                            self.dashboardManager.openNewDashboardWindow(for: item.target)
                        }
                        .keyboardShortcut(item.shortcutNumber.map {
                            KeyboardShortcut(KeyEquivalent(Character(String($0))), modifiers: [.command, .option])
                        })
                    }
                if item.isPrimary, items.contains(where: { !$0.isPrimary }) {
                    Divider()
                }
            }
            if !items.isEmpty {
                Divider()
            }
            Button("Manage Gateways…") {
                AppNavigationActions.openConnection(tab: .gateways)
            }
        }
    }

    private func selectionBinding(for target: DashboardGatewayTarget) -> Binding<Bool> {
        Binding(
            get: { self.dashboardManager.frontmostDashboardTarget == target },
            set: { _ in self.dashboardManager.openOrFocusDashboard(for: target) })
    }
}
