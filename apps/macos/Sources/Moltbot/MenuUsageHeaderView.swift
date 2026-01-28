import SwiftUI

struct MenuUsageHeaderView: View {
    let count: Int

    private let paddingTop: CGFloat = 8
    private let paddingBottom: CGFloat = 6
    private let paddingTrailing: CGFloat = 10
    private let paddingLeading: CGFloat = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Usage")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 10)
                Text(self.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, self.paddingTop)
        .padding(.bottom, self.paddingBottom)
        .padding(.leading, self.paddingLeading)
        .padding(.trailing, self.paddingTrailing)
        .frame(minWidth: 300, maxWidth: .infinity, alignment: .leading)
        .transaction { txn in txn.animation = nil }
    }

    private var subtitle: String {
        if self.count == 1 { return "1 provider" }
        return "\(self.count) providers"
    }
}
