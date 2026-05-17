import SwiftUI

struct MenuHeaderCard<Content: View>: View {
    let title: String
    let subtitle: String
    let statusText: String?
    let paddingBottom: CGFloat
    @ViewBuilder var content: Content

    init(
        title: String,
        subtitle: String,
        statusText: String? = nil,
        paddingBottom: CGFloat = 6,
        @ViewBuilder content: () -> Content = { EmptyView() })
    {
        self.title = title
        self.subtitle = subtitle
        self.statusText = statusText
        self.paddingBottom = paddingBottom
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(self.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 10)
                Text(self.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let statusText, !statusText.isEmpty {
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(3)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
            }
            self.content
        }
        .padding(.top, 8)
        .padding(.bottom, self.paddingBottom)
        .padding(.leading, 20)
        .padding(.trailing, 10)
        .frame(minWidth: 300, maxWidth: .infinity, alignment: .leading)
        .transaction { txn in txn.animation = nil }
    }
}
