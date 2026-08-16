import SwiftUI

struct MenuSessionsHeaderView: View {
    let count: Int
    let statusText: String?

    var body: some View {
        MenuHeaderCard(
            title: "Context",
            subtitle: self.subtitle,
            statusText: self.statusText)
    }

    private var subtitle: String {
        if self.count == 1 { return "1 thread · 24h" }
        return "\(self.count) threads · 24h"
    }
}
