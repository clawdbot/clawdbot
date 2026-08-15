import SwiftUI

struct SettingsRefreshButton: View {
    let isLoading: Bool
    let action: () -> Void

    var body: some View {
        if self.isLoading {
            ProgressView()
        } else {
            Button(action: self.action) {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .help("Refresh")
        }
    }
}
