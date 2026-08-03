import SwiftUI

struct UsageMenuLabelView: View {
    let row: UsageRow
    let width: CGFloat
    var showsChevron: Bool = false
    @Environment(\.menuItemHighlighted) private var isHighlighted
    private let paddingLeading: CGFloat = 22
    private let paddingTrailing: CGFloat = 14
    private let barHeight: CGFloat = 6

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
                    .foregroundStyle(MenuItemHighlightColors.primary(self.isHighlighted))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)

                Spacer(minLength: 4)

                Text(self.row.detailText())
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(MenuItemHighlightColors.secondary(self.isHighlighted))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(2)

                if self.showsChevron {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(MenuItemHighlightColors.secondary(self.isHighlighted))
                        .padding(.leading, 2)
                }
            }
        }
        .padding(.vertical, 10)
        .padding(.leading, self.paddingLeading)
        .padding(.trailing, self.paddingTrailing)
    }
}
