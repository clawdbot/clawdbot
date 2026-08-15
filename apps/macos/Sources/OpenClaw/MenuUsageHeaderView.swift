import SwiftUI

struct MenuUsageHeaderView: View {
    let count: Int

    var body: some View {
        MenuHeaderCard(
            title: "Usage",
            subtitle: self.subtitle)
    }

    private var subtitle: String {
        if self.count == 1 { return "1 provider" }
        return "\(self.count) providers"
    }
}
