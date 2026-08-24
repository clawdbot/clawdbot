import SwiftUI

struct DashboardHandoffSettingsView: View {
    let tab: SettingsTab
    let dashboardRoute: String

    var body: some View {
        VStack(spacing: 18) {
            Spacer()

            Image(systemName: self.tab.systemImage)
                .font(.system(size: 42, weight: .medium))
                .foregroundStyle(.secondary)

            VStack(spacing: 7) {
                Text(self.tab.title)
                    .font(.title2.weight(.semibold))
                Text("This configuration lives on your gateway and is managed in the Dashboard.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button("Open in Dashboard") {
                Task { await DashboardManager.shared.show(atPath: self.dashboardRoute) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Text("The legacy native pane can be re-enabled in Settings > Debug.")
                .font(.caption)
                .foregroundStyle(.tertiary)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}
