import SwiftUI

@MainActor
struct DashboardGatewayCommands: Commands {
    @Bindable private var dashboardManager: DashboardManager

    init(dashboardManager: DashboardManager) {
        self._dashboardManager = Bindable(wrappedValue: dashboardManager)
    }

    var body: some Commands {
        let items = DashboardGatewayMenuModel.items(from: self.dashboardManager.gatewayEntries)
        if !items.isEmpty {
            CommandMenu("Gateways") {
                ForEach(items) { item in
                    if let shortcutNumber = item.shortcutNumber {
                        Toggle(item.name, isOn: self.selectionBinding(for: item.target))
                            .keyboardShortcut(
                                KeyEquivalent(Character(String(shortcutNumber))),
                                modifiers: .command)
                    } else {
                        Toggle(item.name, isOn: self.selectionBinding(for: item.target))
                    }
                }
            }
        }
    }

    private func selectionBinding(for target: DashboardGatewayTarget) -> Binding<Bool> {
        Binding(
            get: { self.dashboardManager.frontmostDashboardTarget == target },
            set: { _ in self.dashboardManager.switchFrontmostDashboard(to: target) })
    }
}
