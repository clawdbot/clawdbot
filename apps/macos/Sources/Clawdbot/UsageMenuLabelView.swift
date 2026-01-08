import SwiftUI

struct UsageMenuLabelView: View {
    let row: UsageRow
    let width: CGFloat
    private let paddingLeading: CGFloat = 22
    private let paddingTrailing: CGFloat = 14
    private let barHeight: CGFloat = 6

    private var primaryTextColor: Color { .primary }
    private var secondaryTextColor: Color { .secondary }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let used = row.usedPercent {
                ContextUsageBar(
                    usedTokens: Int(round(used)),
                    contextTokens: 100,
                    width: max(1, self.width - (self.paddingLeading + self.paddingTrailing)),
                    height: self.barHeight)
            }

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(self.row.titleText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.primaryTextColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)

                Spacer(minLength: 4)

                Text(self.row.detailText())
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(self.secondaryTextColor)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(2)
            }
        }
        .padding(.vertical, 10)
        .padding(.leading, self.paddingLeading)
        .padding(.trailing, self.paddingTrailing)
    }
}
